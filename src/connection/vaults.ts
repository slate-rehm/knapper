/**
 * Obsidian's vault registry and global settings, read straight from
 * `obsidian.json` in the userData directory.
 *
 * This file is also where the global `cli` toggle lives, which is why the doctor
 * and the CLI-enable tool both read it here rather than asking the app.
 */

import { lstat, readFile, mkdir, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, resolve, sep, dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { knapperHome, obsidianConfigPath, userFlagsPath } from "../config.js";
import { writeJsonAtomic } from "../util/atomic-json.js";
import { UobError } from "../util/errors.js";
import { withFileLock } from "../util/filelock.js";
import { withVaultLifecycleLock, withVaultTransaction } from "./vault-transaction.js";

export interface VaultEntry {
  id: string;
  path: string;
  name: string;
  /** Obsidian sets this on the vault whose window is open. */
  open: boolean;
  /** Last-focused timestamp, used by the CLI to pick a default vault. */
  ts?: number;
}

export interface ObsidianGlobalConfig {
  /** Whether the command line interface is enabled. Absent means disabled. */
  cli: boolean;
  vaults: VaultEntry[];
  /** Raw parsed contents, for fields we do not model. */
  raw: Record<string, unknown>;
}

interface RawVault {
  path?: string;
  ts?: number;
  open?: boolean;
}

export interface VaultLifecycleOptions {
  /** Test hook that throws at a durable transaction phase. */
  fault?: (phase: string) => void | Promise<void>;
}

export async function readGlobalConfig(
  path = obsidianConfigPath(),
): Promise<ObsidianGlobalConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const rawVaults = (parsed.vaults ?? {}) as Record<string, RawVault>;
  const vaults: VaultEntry[] = Object.entries(rawVaults).map(([id, entry]) => ({
    id,
    path: entry.path ?? "",
    name: entry.path ? basename(entry.path) : id,
    open: entry.open === true,
    ...(entry.ts !== undefined ? { ts: entry.ts } : {}),
  }));

  return {
    cli: parsed.cli === true,
    vaults,
    raw: parsed,
  };
}

/**
 * Set the global `cli` flag by editing `obsidian.json` directly.
 *
 * Only safe while Obsidian is not running — a live instance holds this config in
 * memory and rewrites the file on exit, silently discarding the edit. Callers
 * should prefer the renderer-side `ipcRenderer` bootstrap when the app is up.
 */
export async function writeCliFlag(enabled: boolean, path = obsidianConfigPath()): Promise<void> {
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (enabled) parsed.cli = true;
  else delete parsed.cli;
  await writeJsonAtomic(path, parsed);
}

/** Resolve a vault by name or id, matching names case-insensitively. */
export function findVaultEntry(
  vaults: readonly VaultEntry[],
  nameOrId: string,
): VaultEntry | undefined {
  const wanted = nameOrId.toLowerCase();
  return vaults.find((v) => v.id === nameOrId || v.name.toLowerCase() === wanted);
}

/** Resolve a vault by name or id within a parsed `obsidian.json`. */
export function findVault(config: ObsidianGlobalConfig, nameOrId: string): VaultEntry | undefined {
  return findVaultEntry(config.vaults, nameOrId);
}

/** Legacy marker name. These files no longer grant access or deletion. */
export const MANAGED_MARKER = ".knapper-managed";
/** Non-authorizing nonce that binds an external grant to one directory instance. */
export const KNAPPER_IDENTITY = ".knapper-identity";

/**
 * How Knapper came to authorize a vault.
 *
 * `created` — `obsidian_create_vault` made the directory. This records provenance
 * but does not grant deletion.
 * `adopted` — the user ran `knapper authorize` against a vault they already
 * owned. Grants the right to *operate* in it and never the right to *delete* it,
 * because the notes in it are real.
 *
 * The names stay stable for callers that display the authorization type.
 */
export type MarkerGrant = "created" | "adopted";

export interface ManagedMarker {
  managedBy: "knapper";
  createdAt: string;
  grant: MarkerGrant;
  authorizedAt?: string;
  note: string;
}

interface StoredVaultAuthorization extends ManagedMarker {
  path: string;
  /** Literal authorized path, retained so revocation still works after deletion or move. */
  literalPath?: string;
  device: string;
  inode: string;
  /** Filesystem birth time prevents an inode-reused replacement from inheriting access. */
  birthtime?: string;
  /** Matches the Knapper-created nonce in the vault. The external record remains authoritative. */
  token?: string;
}

interface VaultAuthorizationRegistry {
  schema: 1;
  authorizations: StoredVaultAuthorization[];
}

const AUTHORIZATION_SCHEMA = 1;

export function vaultAuthorizationRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(knapperHome(env), "vault-authorizations.json");
}

export function vaultAuthorizationLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(knapperHome(env), "vault-authorizations.lock");
}

export function markerPath(vaultPath: string): string {
  return resolve(vaultPath, MANAGED_MARKER);
}

/** Return the grant from a validated authorization record. */
export function markerGrant(marker: ManagedMarker): MarkerGrant {
  return marker.grant;
}

function isStoredAuthorization(value: unknown): value is StoredVaultAuthorization {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.managedBy === "knapper" &&
    typeof record.path === "string" &&
    (record.literalPath === undefined || typeof record.literalPath === "string") &&
    typeof record.device === "string" &&
    typeof record.inode === "string" &&
    (record.birthtime === undefined || typeof record.birthtime === "string") &&
    (record.token === undefined || typeof record.token === "string") &&
    typeof record.createdAt === "string" &&
    (record.grant === "created" || record.grant === "adopted") &&
    (record.authorizedAt === undefined || typeof record.authorizedAt === "string") &&
    typeof record.note === "string"
  );
}

function parseAuthorizationRegistry(value: unknown): VaultAuthorizationRegistry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schema !== AUTHORIZATION_SCHEMA || !Array.isArray(record.authorizations)) {
    return undefined;
  }
  if (!record.authorizations.every(isStoredAuthorization)) return undefined;
  const paths = record.authorizations.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) return undefined;
  return {
    schema: AUTHORIZATION_SCHEMA,
    authorizations: record.authorizations,
  };
}

async function readAuthorizationRegistry(
  env: NodeJS.ProcessEnv,
  strict: boolean,
): Promise<VaultAuthorizationRegistry> {
  const path = vaultAuthorizationRegistryPath(env);
  try {
    if (strict) {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== resolve(path)) {
        throw new Error("The registry path is not a direct regular file.");
      }
    }
    const parsed = parseAuthorizationRegistry(JSON.parse(await readFile(path, "utf8")));
    if (parsed !== undefined) return parsed;
    throw new Error("The registry has an unsupported or invalid schema.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema: AUTHORIZATION_SCHEMA, authorizations: [] };
    }
    if (!strict) return { schema: AUTHORIZATION_SCHEMA, authorizations: [] };
    throw new UobError(
      "INVALID_ARGUMENT",
      `Cannot read the vault authorization registry at ${path}.`,
      {
        remediation:
          "Repair or remove the invalid registry. Knapper will not change authorizations while it is invalid.",
        details: {
          path,
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readMutableObsidianRegistry(path: string): Promise<Record<string, unknown>> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new UobError("INVALID_ARGUMENT", `Cannot read the Obsidian registry at ${path}.`, {
      remediation: "Restore a valid obsidian.json file before you change the vault registry.",
      details: { path, cause: error instanceof Error ? error.message : String(error) },
    });
  }
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== resolve(path)) {
    throw new UobError(
      "INVALID_ARGUMENT",
      `The Obsidian registry path ${path} is not a regular file.`,
      {
        remediation: "Use the direct path to a valid obsidian.json file.",
        details: { path },
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new UobError("INVALID_ARGUMENT", `Cannot parse the Obsidian registry at ${path}.`, {
      remediation: "Repair obsidian.json before you change the vault registry.",
      details: { path, cause: error instanceof Error ? error.message : String(error) },
    });
  }
  if (!isRecord(parsed)) {
    throw new UobError("INVALID_ARGUMENT", `The Obsidian registry at ${path} is invalid.`, {
      remediation: "Repair obsidian.json before you change the vault registry.",
      details: { path },
    });
  }

  const vaults = parsed.vaults ?? {};
  if (!isRecord(vaults)) {
    throw new UobError("INVALID_ARGUMENT", `The vault registry at ${path} is invalid.`, {
      remediation: "Repair the vaults object in obsidian.json before you change it.",
      details: { path },
    });
  }
  for (const [id, value] of Object.entries(vaults)) {
    if (!isRecord(value) || (value.path !== undefined && typeof value.path !== "string")) {
      throw new UobError("INVALID_ARGUMENT", `Vault entry ${id} in ${path} is invalid.`, {
        remediation: "Repair the vault entry in obsidian.json before you change it.",
        details: { path, id },
      });
    }
  }
  return parsed;
}

async function validateVaultPath(path: string): Promise<"absent" | "directory"> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== resolve(path)) {
      throw new UobError("INVALID_ARGUMENT", `The vault path ${path} is not a direct directory.`, {
        remediation: "Use a direct directory path without symbolic links.",
        details: { path },
      });
    }
    return "directory";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw error;
  }
}

const CREATED_NOTE =
  "Knapper created this vault. This record does not grant permission to delete it.";

const ADOPTED_NOTE =
  "The user authorized this vault. Knapper can read and modify it, but cannot delete it.";

async function vaultIdentity(
  vaultPath: string,
): Promise<{ path: string; device: string; inode: string; birthtime: string } | undefined> {
  try {
    const path = await realpath(resolve(vaultPath));
    const info = await stat(path, { bigint: true });
    if (!info.isDirectory()) return undefined;
    return {
      path,
      device: info.dev.toString(),
      inode: info.ino.toString(),
      birthtime: info.birthtimeNs.toString(),
    };
  } catch {
    return undefined;
  }
}

interface VaultIdentityToken {
  schema: 1;
  managedBy: "knapper";
  token: string;
}

async function readVaultIdentityToken(vaultPath: string): Promise<VaultIdentityToken | undefined> {
  const path = resolve(vaultPath, KNAPPER_IDENTITY);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path)
      return undefined;
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<VaultIdentityToken>;
    if (
      parsed.schema !== 1 ||
      parsed.managedBy !== "knapper" ||
      typeof parsed.token !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.token)
    ) {
      return undefined;
    }
    return parsed as VaultIdentityToken;
  } catch {
    return undefined;
  }
}

async function createVaultIdentityToken(vaultPath: string): Promise<VaultIdentityToken> {
  const path = resolve(vaultPath, KNAPPER_IDENTITY);
  const existing = await readVaultIdentityToken(vaultPath);
  if (existing !== undefined) return existing;

  try {
    await lstat(path);
    throw new UobError("INVALID_ARGUMENT", `Refusing to replace ${path}.`, {
      remediation: `Move the existing ${KNAPPER_IDENTITY} file before you authorize this vault.`,
      details: { path },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const identity: VaultIdentityToken = {
    schema: 1,
    managedBy: "knapper",
    token: randomBytes(32).toString("hex"),
  };
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(identity)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return identity;
}

/** Read the external authorization record. Legacy vault markers are inactive. */
export async function readManagedMarker(
  vaultPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManagedMarker | undefined> {
  const identity = await vaultIdentity(vaultPath);
  if (identity === undefined) return undefined;
  const registry = await readAuthorizationRegistry(env, false);
  const vaultToken = await readVaultIdentityToken(vaultPath);
  const record = registry.authorizations.find(
    (entry) =>
      entry.path === identity.path &&
      entry.device === identity.device &&
      entry.inode === identity.inode &&
      entry.birthtime !== undefined &&
      entry.birthtime === identity.birthtime &&
      entry.token !== undefined &&
      entry.token === vaultToken?.token,
  );
  if (record === undefined) return undefined;
  const {
    path: _path,
    literalPath: _literalPath,
    device: _device,
    inode: _inode,
    birthtime: _birthtime,
    token: _token,
    ...authorization
  } = record;
  return authorization;
}

async function writeManagedMarkerUnlocked(
  vaultPath: string,
  now: Date,
  grant: MarkerGrant,
  env: NodeJS.ProcessEnv,
): Promise<ManagedMarker> {
  const identity = await vaultIdentity(vaultPath);
  if (identity === undefined) {
    throw new UobError("INVALID_ARGUMENT", `No vault directory exists at ${resolve(vaultPath)}.`, {
      remediation: "Create the vault directory before you authorize it.",
      details: { path: resolve(vaultPath) },
    });
  }
  const marker: ManagedMarker = {
    managedBy: "knapper",
    createdAt: now.toISOString(),
    grant,
    ...(grant === "adopted" ? { authorizedAt: now.toISOString() } : {}),
    note: grant === "adopted" ? ADOPTED_NOTE : CREATED_NOTE,
  };
  await withFileLock(vaultAuthorizationLockPath(env), async () => {
    const registry = await readAuthorizationRegistry(env, true);
    const existing = registry.authorizations.find((entry) => entry.path === identity.path);
    if (existing?.grant === "adopted" && grant === "created") {
      throw new UobError(
        "INVALID_ARGUMENT",
        `Refusing to make the authorized vault at ${identity.path} disposable.`,
        {
          remediation: "Keep the adopted authorization, or revoke it first.",
          details: { path: identity.path },
        },
      );
    }
    const priorIdentity = await readVaultIdentityToken(vaultPath);
    const vaultToken = priorIdentity ?? (await createVaultIdentityToken(vaultPath));
    const authorizations = registry.authorizations.filter((entry) => entry.path !== identity.path);
    authorizations.push({
      ...marker,
      ...identity,
      literalPath: resolve(vaultPath),
      token: vaultToken.token,
    });
    try {
      await writeJsonAtomic(
        vaultAuthorizationRegistryPath(env),
        {
          schema: AUTHORIZATION_SCHEMA,
          authorizations,
        } satisfies VaultAuthorizationRegistry,
        { mode: 0o600, directoryMode: 0o700 },
      );
    } catch (error) {
      if (priorIdentity === undefined)
        await rm(resolve(vaultPath, KNAPPER_IDENTITY), { force: true });
      throw error;
    }
  });
  return marker;
}

export async function writeManagedMarker(
  vaultPath: string,
  now: Date,
  grant: MarkerGrant = "created",
  env: NodeJS.ProcessEnv = process.env,
  configPath?: string,
): Promise<ManagedMarker> {
  return withVaultLifecycleLock(
    env,
    () => writeManagedMarkerUnlocked(vaultPath, now, grant, env),
    configPath === undefined
      ? undefined
      : { configPath, authorizationPath: vaultAuthorizationRegistryPath(env) },
  );
}

/** Withdraw access from the external registry. */
async function removeManagedMarkerUnlocked(
  vaultPath: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const identity = await vaultIdentity(vaultPath);
  const literal = resolve(vaultPath);
  const targets = new Set(identity === undefined ? [literal] : [identity.path, literal]);
  return withFileLock(vaultAuthorizationLockPath(env), async () => {
    const registry = await readAuthorizationRegistry(env, true);
    const removed = registry.authorizations.filter(
      (entry) => targets.has(entry.path) || targets.has(entry.literalPath ?? ""),
    );
    const authorizations = registry.authorizations.filter(
      (entry) => !targets.has(entry.path) && !targets.has(entry.literalPath ?? ""),
    );
    if (authorizations.length === registry.authorizations.length) return false;
    await writeJsonAtomic(
      vaultAuthorizationRegistryPath(env),
      {
        schema: AUTHORIZATION_SCHEMA,
        authorizations,
      } satisfies VaultAuthorizationRegistry,
      { mode: 0o600, directoryMode: 0o700 },
    );
    const vaultToken = await readVaultIdentityToken(vaultPath);
    if (vaultToken !== undefined && removed.some((entry) => entry.token === vaultToken.token)) {
      await rm(resolve(vaultPath, KNAPPER_IDENTITY), { force: true });
    }
    return true;
  });
}

export async function removeManagedMarker(
  vaultPath: string,
  env: NodeJS.ProcessEnv = process.env,
  configPath?: string,
): Promise<boolean> {
  return withVaultLifecycleLock(
    env,
    () => removeManagedMarkerUnlocked(vaultPath, env),
    configPath === undefined
      ? undefined
      : { configPath, authorizationPath: vaultAuthorizationRegistryPath(env) },
  );
}

/** Paths that must never be a vault root, regardless of authorization. */
export function forbiddenRoot(path: string): string | undefined {
  const p = resolve(path);
  if (p === resolve(homedir())) return "your home directory";
  if (p === resolve("/")) return "the filesystem root";
  if (dirname(p) === p) return "a filesystem root";
  if (p.split(sep).filter(Boolean).length < 2) return "a top-level system directory";
  return undefined;
}

/**
 * Reject file deletion through the external-vault lifecycle API.
 *
 * Session cleanup has separate descriptor and filesystem identity checks. An
 * authorization record cannot substitute for that ownership proof.
 */
export async function assertVaultRemovable(
  vaultPath: string,
  allVaults: readonly VaultEntry[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManagedMarker> {
  const target = resolve(vaultPath);

  const forbidden = forbiddenRoot(target);
  if (forbidden !== undefined) {
    throw new UobError("INVALID_ARGUMENT", `Refusing to remove ${forbidden} (${target}).`, {
      remediation: "Remove external vaults yourself in Obsidian.",
      details: { path: target },
    });
  }

  // A path that contains another registered vault would take that vault with it.
  const contained = allVaults
    .map((v) => resolve(v.path))
    .filter((p) => p !== target && p.startsWith(target + sep));
  if (contained.length > 0) {
    throw new UobError(
      "INVALID_ARGUMENT",
      `Refusing to remove ${target}: it contains ${contained.length} other registered vault(s).`,
      {
        remediation: "Remove the nested vaults first, or pick a directory that contains no others.",
        details: { path: target, contains: contained },
      },
    );
  }

  const marker = await readManagedMarker(target, env);
  if (!marker) {
    throw new UobError(
      "VAULT_NOT_MANAGED",
      `Refusing to remove "${basename(target)}" — knapper did not create it.`,
      {
        remediation:
          "Knapper does not delete external vaults. Remove this vault yourself in Obsidian.",
        details: {
          path: target,
          registry: vaultAuthorizationRegistryPath(env),
        },
      },
    );
  }

  // Authorization is not permission to delete. `knapper authorize` exists so a
  // user can point knapper at a vault of real notes; letting that same grant feed
  // the delete path would turn a consent step into a loaded gun.
  if (markerGrant(marker) === "adopted") {
    throw new UobError(
      "VAULT_NOT_MANAGED",
      `Refusing to remove "${basename(target)}" — it is an authorized vault, not one knapper created.`,
      {
        remediation:
          "The user authorized Knapper to read and modify this vault, not to delete it. " +
          "Delete this vault yourself in Obsidian if that is what you want.",
        details: {
          path: target,
          grant: "adopted",
          authorizedAt: marker.authorizedAt,
        },
      },
    );
  }

  throw new UobError(
    "VAULT_NOT_MANAGED",
    `Refusing to delete "${basename(target)}" — a vault authorization does not grant deletion.`,
    {
      remediation:
        "Delete an external vault yourself. Knapper only quarantines scratch workspaces with verified session ownership.",
      details: { path: target, grant: marker.grant },
    },
  );
}

export interface CreateVaultResult {
  path: string;
  id: string;
  name: string;
  createdDirectory: boolean;
  marker: ManagedMarker;
}

/**
 * Create an authorized test vault directory and register it in `obsidian.json`.
 *
 * The registry edit is only picked up on a cold start: a running Obsidian holds
 * this file in memory and rewrites it on exit, which would discard the entry. The
 * tool layer is responsible for telling the caller to restart.
 */
export async function createManagedVault(
  vaultPath: string,
  now: Date,
  configPath = obsidianConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
  options: VaultLifecycleOptions = {},
): Promise<CreateVaultResult> {
  const target = resolve(vaultPath);

  const forbidden = forbiddenRoot(target);
  if (forbidden !== undefined) {
    throw new UobError("INVALID_ARGUMENT", `Refusing to create a vault at ${forbidden}.`, {
      remediation: "Choose a dedicated subdirectory, e.g. ~/obsidian-test-vaults/scratch.",
      details: { path: target },
    });
  }

  let parsed!: Record<string, unknown>;
  let vaults!: Record<string, RawVault>;
  let existingAuthorization: ManagedMarker | undefined;
  let createdDirectory = false;
  let id = "";

  return withVaultTransaction(
    {
      env,
      configPath,
      authorizationPath: vaultAuthorizationRegistryPath(env),
      operation: "create",
      rollbackDirectory: () => (createdDirectory ? target : undefined),
      validate: async () => {
        parsed = await readMutableObsidianRegistry(configPath);
        await readAuthorizationRegistry(env, true);
        createdDirectory = (await validateVaultPath(target)) === "absent";
        existingAuthorization = createdDirectory ? undefined : await readManagedMarker(target, env);

        if (!createdDirectory && existingAuthorization === undefined) {
          const entries = await readdir(target);
          if (entries.length > 0) {
            throw new UobError(
              "INVALID_ARGUMENT",
              `Refusing to adopt non-empty directory ${target} as a test vault.`,
              {
                remediation:
                  "Point at an empty or non-existent directory. Existing content requires explicit user authorization.",
                details: { path: target, entries: entries.slice(0, 10) },
              },
            );
          }
        }

        vaults = (parsed.vaults ?? {}) as Record<string, RawVault>;
        const existing = Object.entries(vaults).find(
          ([, value]) => resolve(value.path ?? "") === target,
        );
        id = existing?.[0] ?? randomBytes(8).toString("hex");
      },
      ...(options.fault !== undefined ? { fault: options.fault } : {}),
    },
    async (transaction) => {
      if (createdDirectory) {
        await mkdir(target, { recursive: true });
        await transaction.recordCreatedDirectory(target);
      }

      vaults[id] = { path: target, ts: now.getTime(), open: false };
      parsed.vaults = vaults;
      await writeJsonAtomic(configPath, parsed);
      await transaction.checkpoint("obsidian-written");

      const marker =
        existingAuthorization ?? (await writeManagedMarkerUnlocked(target, now, "created", env));
      await transaction.checkpoint("authorization-written");

      return { path: target, id, name: basename(target), createdDirectory, marker };
    },
  );
}

export interface RemoveVaultResult {
  path: string;
  unregistered: boolean;
  deletedDirectory: boolean;
}

/** Unregister an authorized vault. The legacy delete option always fails closed. */
export async function removeManagedVault(
  vaultPath: string,
  allVaults: readonly VaultEntry[],
  deleteFiles: boolean,
  configPath = obsidianConfigPath(),
  env: NodeJS.ProcessEnv = process.env,
  options: VaultLifecycleOptions = {},
): Promise<RemoveVaultResult> {
  const target = resolve(vaultPath);
  if (deleteFiles) await assertVaultRemovable(target, allVaults, env);

  let parsed!: Record<string, unknown>;
  let vaults!: Record<string, RawVault>;
  let unregistered = false;
  return withVaultTransaction(
    {
      env,
      configPath,
      authorizationPath: vaultAuthorizationRegistryPath(env),
      operation: "unregister",
      validate: async () => {
        await readAuthorizationRegistry(env, true);
        const authorization = await readManagedMarker(target, env);
        if (authorization === undefined) {
          throw new UobError(
            "VAULT_NOT_MANAGED",
            `Refusing to unregister "${basename(target)}" — it is not authorized.`,
            {
              remediation: "Unregister this vault yourself in Obsidian.",
              details: { path: target },
            },
          );
        }
        parsed = await readMutableObsidianRegistry(configPath);
        await validateVaultPath(target);
        vaults = (parsed.vaults ?? {}) as Record<string, RawVault>;
        unregistered = false;
        for (const [id, entry] of Object.entries(vaults)) {
          if (resolve(entry.path ?? "") === target) {
            delete vaults[id];
            unregistered = true;
          }
        }
      },
      ...(options.fault !== undefined ? { fault: options.fault } : {}),
    },
    async (transaction) => {
      if (unregistered) {
        parsed.vaults = vaults;
        await writeJsonAtomic(configPath, parsed);
      }
      await transaction.checkpoint("unregister-written");
      return { path: target, unregistered, deletedDirectory: false };
    },
  );
}

export interface UserFlagsCheck {
  path: string;
  exists: boolean;
  /** Tokens that will corrupt CLI argv because they use a single dash. */
  corruptingTokens: string[];
  /** Every non-comment token in the file. */
  tokens: string[];
}

/**
 * Inspect the Linux launch-flags file used by distro wrapper scripts.
 *
 * Obsidian's argv normalizer strips only `--`-prefixed tokens, so a single-dash
 * token such as `-disable-gpu` survives the filter, lands in argv[0], and makes
 * every CLI invocation fail with `Command "-disable-gpu" not found.`
 */
export async function checkUserFlags(path = userFlagsPath()): Promise<UserFlagsCheck> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { path, exists: false, corruptingTokens: [], tokens: [] };
  }

  const tokens = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .flatMap((line) => line.split(/\s+/))
    .filter((t) => t !== "");

  const corruptingTokens = tokens.filter((t) => t.startsWith("-") && !t.startsWith("--"));

  return { path, exists: true, corruptingTokens, tokens };
}
