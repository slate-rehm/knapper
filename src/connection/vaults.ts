/**
 * Obsidian's vault registry and global settings, read straight from
 * `obsidian.json` in the userData directory.
 *
 * This file is also where the global `cli` toggle lives, which is why the doctor
 * and the CLI-enable tool both read it here rather than asking the app.
 */

import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { basename, resolve, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { obsidianConfigPath, userFlagsPath } from "../config.js";
import { UobError } from "../util/errors.js";

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
  await writeFile(path, JSON.stringify(parsed), "utf8");
}

/** Resolve a vault by name or id, matching names case-insensitively. */
export function findVault(config: ObsidianGlobalConfig, nameOrId: string): VaultEntry | undefined {
  const wanted = nameOrId.toLowerCase();
  return config.vaults.find((v) => v.id === nameOrId || v.name.toLowerCase() === wanted);
}

/**
 * Marker file written into every vault knapper creates.
 *
 * This is the whole safety contract for `obsidian_remove_vault`: a vault is
 * removable if and only if it carries this file. The marker lives inside the
 * vault rather than in `obsidian.json` on purpose — a user who copies, moves, or
 * re-registers the directory keeps the provenance with it, and a user's own vault
 * can never acquire one by accident.
 */
export const MANAGED_MARKER = ".knapper-managed";

export interface ManagedMarker {
  managedBy: "knapper";
  createdAt: string;
  note: string;
}

export function markerPath(vaultPath: string): string {
  return resolve(vaultPath, MANAGED_MARKER);
}

/** Read the marker, or undefined when this is not a knapper-created vault. */
export async function readManagedMarker(vaultPath: string): Promise<ManagedMarker | undefined> {
  try {
    const parsed = JSON.parse(await readFile(markerPath(vaultPath), "utf8")) as ManagedMarker;
    return parsed.managedBy === "knapper" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function writeManagedMarker(vaultPath: string, now: Date): Promise<ManagedMarker> {
  const marker: ManagedMarker = {
    managedBy: "knapper",
    createdAt: now.toISOString(),
    note: "Created by knapper as a disposable test vault. Deleting this file makes the vault permanent: obsidian_remove_vault will refuse to touch it.",
  };
  await writeFile(markerPath(vaultPath), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
  return marker;
}

/** Paths that must never be a vault root, regardless of any marker. */
function forbiddenRoot(path: string): string | undefined {
  const p = resolve(path);
  if (p === resolve(homedir())) return "your home directory";
  if (p === resolve("/")) return "the filesystem root";
  if (dirname(p) === p) return "a filesystem root";
  if (p.split(sep).filter(Boolean).length < 2) return "a top-level system directory";
  return undefined;
}

/**
 * Decide whether a vault may be removed. Throws with a precise reason otherwise.
 *
 * Ordering matters: the unmanaged check comes before anything cosmetic so that the
 * refusal an agent sees for a user's real vault is always the same one.
 */
export async function assertVaultRemovable(
  vaultPath: string,
  allVaults: readonly VaultEntry[],
): Promise<ManagedMarker> {
  const target = resolve(vaultPath);

  const forbidden = forbiddenRoot(target);
  if (forbidden !== undefined) {
    throw new UobError("INVALID_ARGUMENT", `Refusing to remove ${forbidden} (${target}).`, {
      remediation: "Point this at a disposable vault directory created by obsidian_create_vault.",
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

  const marker = await readManagedMarker(target);
  if (!marker) {
    throw new UobError(
      "VAULT_NOT_MANAGED",
      `Refusing to remove "${basename(target)}" — knapper did not create it.`,
      {
        remediation:
          `Only vaults carrying a ${MANAGED_MARKER} marker can be removed by this tool, which means ` +
          "only ones obsidian_create_vault made. Remove a real vault yourself from Obsidian's vault " +
          "switcher; this tool will not do it for you.",
        details: { path: target, marker: markerPath(target) },
      },
    );
  }

  return marker;
}

export interface CreateVaultResult {
  path: string;
  id: string;
  name: string;
  createdDirectory: boolean;
  marker: ManagedMarker;
}

/**
 * Create a disposable vault directory and register it in `obsidian.json`.
 *
 * The registry edit is only picked up on a cold start: a running Obsidian holds
 * this file in memory and rewrites it on exit, which would discard the entry. The
 * tool layer is responsible for telling the caller to restart.
 */
export async function createManagedVault(
  vaultPath: string,
  now: Date,
  configPath = obsidianConfigPath(),
): Promise<CreateVaultResult> {
  const target = resolve(vaultPath);

  const forbidden = forbiddenRoot(target);
  if (forbidden !== undefined) {
    throw new UobError("INVALID_ARGUMENT", `Refusing to create a vault at ${forbidden}.`, {
      remediation: "Choose a dedicated subdirectory, e.g. ~/obsidian-test-vaults/scratch.",
      details: { path: target },
    });
  }

  let createdDirectory = false;
  try {
    await readdir(target);
  } catch {
    await mkdir(target, { recursive: true });
    createdDirectory = true;
  }

  // Refuse to adopt a directory that already holds someone's notes.
  if (!createdDirectory && !(await readManagedMarker(target))) {
    const entries = (await readdir(target)).filter((e) => !e.startsWith("."));
    if (entries.length > 0) {
      throw new UobError(
        "INVALID_ARGUMENT",
        `Refusing to adopt non-empty directory ${target} as a test vault.`,
        {
          remediation:
            "Point at an empty or non-existent directory. Adopting existing content would make " +
            "someone's notes deletable by obsidian_remove_vault.",
          details: { path: target, entries: entries.slice(0, 10) },
        },
      );
    }
  }

  const marker = await writeManagedMarker(target, now);

  const text = await readFile(configPath, "utf8");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const vaults = (parsed.vaults ?? {}) as Record<string, RawVault>;

  const existing = Object.entries(vaults).find(([, v]) => resolve(v.path ?? "") === target);
  const id = existing?.[0] ?? randomBytes(8).toString("hex");
  vaults[id] = { path: target, ts: now.getTime(), open: false };
  parsed.vaults = vaults;
  await writeFile(configPath, JSON.stringify(parsed), "utf8");

  return { path: target, id, name: basename(target), createdDirectory, marker };
}

export interface RemoveVaultResult {
  path: string;
  unregistered: boolean;
  deletedDirectory: boolean;
}

/** Unregister a knapper-created vault, optionally deleting its files. */
export async function removeManagedVault(
  vaultPath: string,
  allVaults: readonly VaultEntry[],
  deleteFiles: boolean,
  configPath = obsidianConfigPath(),
): Promise<RemoveVaultResult> {
  const target = resolve(vaultPath);
  await assertVaultRemovable(target, allVaults);

  const text = await readFile(configPath, "utf8");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const vaults = (parsed.vaults ?? {}) as Record<string, RawVault>;
  let unregistered = false;
  for (const [id, entry] of Object.entries(vaults)) {
    if (resolve(entry.path ?? "") === target) {
      delete vaults[id];
      unregistered = true;
    }
  }
  if (unregistered) {
    parsed.vaults = vaults;
    await writeFile(configPath, JSON.stringify(parsed), "utf8");
  }

  let deletedDirectory = false;
  if (deleteFiles) {
    // assertVaultRemovable already proved the marker is present.
    await rm(target, { recursive: true, force: true });
    deletedDirectory = true;
  }

  return { path: target, unregistered, deletedDirectory };
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
