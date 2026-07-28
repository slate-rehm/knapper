/**
 * Session lifecycle: create, close, restart, list.
 *
 * A session is one Obsidian instance with a private profile, a private CLI socket,
 * a scratch vault, and a descriptor tying them together. Two agents each holding
 * one can drive Obsidian concurrently without seeing each other at all.
 *
 * Every mutation here is scoped to the session's own `--user-data-dir`. That is not
 * tidiness: before sessions existed, quitting meant SIGTERMing every Obsidian on
 * the machine, and left unscoped it would make one agent's restart destroy every
 * other agent's work.
 */

import { rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  cliIsolationFor,
  cliSocketPathFor,
  defaultObsidianUserDataDir,
  registryLockPath,
  sessionPaths,
  type CliIsolation,
} from "../config.js";
import { launchObsidian, quitObsidian } from "../connection/launch.js";
import { isPidStillObsidian, type ProcessScope } from "../connection/health.js";
import { readGlobalConfig, removeManagedVault } from "../connection/vaults.js";
import { UobError } from "../util/errors.js";
import { withFileLock } from "../util/filelock.js";
import type { Logger } from "../util/logger.js";
import { seedSessionProfile } from "./bootstrap.js";
import { linkPlugin, unlinkPluginIfPresent } from "./plugin-link.js";
import { mintSessionKey } from "./key.js";
import {
  listDescriptors,
  readDescriptor,
  removeDescriptor,
  writeDescriptor,
  SESSION_SCHEMA_VERSION,
  type SessionDescriptor,
} from "./descriptor.js";

export interface CreateSessionOptions {
  label?: string;
  vaultPath?: string;
  adoptVault?: string;
  pluginSourceDir?: string;
  pluginId?: string;
  cdpPort?: number;
  obsidianBin: string;
  cwd?: string;
  branch?: string;
  timeoutMs?: number;
  logger?: Logger;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

/** Process scope for a session, so callers cannot accidentally build a wider one. */
export function scopeOf(descriptor: SessionDescriptor): ProcessScope {
  return { userDataDir: descriptor.instance.userDataDir };
}

/**
 * Provision a session: seed a profile, link a plugin, launch Obsidian, record it.
 *
 * Serialized against other knapper processes so two concurrent creations cannot
 * interleave their reads of the sessions directory. The lock is *not* reentrant,
 * so the internal `-Unlocked` variants exist for the reaper, which already holds
 * it while it closes what it collected.
 */
export async function createSession(opts: CreateSessionOptions): Promise<SessionDescriptor> {
  return withFileLock(registryLockPath(opts.env ?? process.env), () => createSessionUnlocked(opts));
}

async function createSessionUnlocked(opts: CreateSessionOptions): Promise<SessionDescriptor> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();

  if (process.platform === "win32") {
    throw new UobError("INVALID_ARGUMENT", "knapper sessions are not supported on Windows.", {
      remediation:
        "Obsidian keys its CLI pipe on the username with no environment input, so a per-session " +
        "instance cannot be addressed. Use the single-instance tools instead.",
    });
  }

  const label = opts.label ?? basename(opts.cwd ?? process.cwd());
  const key = mintSessionKey(label, env);
  const paths = sessionPaths(key, env);

  let seeded;
  let plugin: SessionDescriptor["plugin"];
  let launched;
  try {
    seeded = await seedSessionProfile({
      key,
      ...(opts.vaultPath !== undefined ? { vaultPath: opts.vaultPath } : {}),
      ...(opts.adoptVault !== undefined ? { vaultPath: opts.adoptVault, adopt: true } : {}),
      now,
      env,
    });

    // Link before launch so the plugin is present when Obsidian first enumerates
    // the vault, sparing the agent a reload it would otherwise have to know to do.
    if (opts.pluginSourceDir !== undefined) {
      const linked = await linkPlugin(
        seeded.vault.path,
        opts.pluginSourceDir,
        opts.pluginId ?? undefined,
      );
      plugin = { id: linked.pluginId, sourceDir: linked.sourceDir, linkPath: linked.linkPath };
    }

    launched = await launchObsidian({
      obsidianBin: opts.obsidianBin,
      userDataDir: paths.userDataDir,
      runtimeDir: paths.runtimeDir,
      // Port 0 by default: with a per-session profile, DevToolsActivePort is
      // per-session too, so the kernel can pick a free port race-free. No userland
      // allocator can close the window between "found free" and "child binds it".
      port: opts.cdpPort ?? 0,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
  } catch (e) {
    // Leave nothing half-provisioned: a session that failed anywhere before its
    // descriptor exists would otherwise sit on disk forever, since the reaper's
    // "no live process" rule alone cannot tell it apart from one merely stopped.
    // Only the session's own root is removed — a vault the caller pointed outside
    // it is not ours to clean up, and this path runs on the argument-validation
    // failures where it is most likely to be someone's real directory.
    await rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }

  const descriptor: SessionDescriptor = {
    schema: SESSION_SCHEMA_VERSION,
    key,
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    origin: {
      cwd: opts.cwd ?? process.cwd(),
      ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
      label,
    },
    instance: {
      userDataDir: paths.userDataDir,
      runtimeDir: paths.runtimeDir,
      outputDir: paths.outputDir,
      cdpPort: launched.port,
      cdpUrl: launched.cdpUrl,
      ...(launched.browserId !== undefined ? { browserId: launched.browserId } : {}),
      obsidianBin: opts.obsidianBin,
      ...(launched.pid !== undefined ? { pid: launched.pid } : {}),
      ...(launched.pidStartTime !== undefined ? { pidStartTime: launched.pidStartTime } : {}),
    },
    vault: seeded.vault,
    ...(plugin !== undefined ? { plugin } : {}),
    owner: { pid: process.pid, startedAt: now.toISOString() },
  };

  await writeDescriptor(descriptor, env);
  return descriptor;
}

export interface RestartSessionResult {
  descriptor: SessionDescriptor;
  quit: boolean;
}

/**
 * Cold-restart one session's Obsidian, and nothing else's.
 *
 * The port is re-read after the restart rather than assumed: with `port: 0` the
 * kernel picks a fresh one each boot, so the descriptor's old value is stale the
 * moment the process dies.
 */
export async function restartSession(
  key: string,
  opts: { timeoutMs?: number; logger?: Logger; env?: NodeJS.ProcessEnv } = {},
): Promise<RestartSessionResult> {
  const env = opts.env ?? process.env;
  const descriptor = await requireDescriptor(key, env);
  const scope = scopeOf(descriptor);

  const quit = await quitObsidian(scope, opts.timeoutMs ?? 15_000);

  const launched = await launchObsidian({
    obsidianBin: descriptor.instance.obsidianBin,
    userDataDir: descriptor.instance.userDataDir,
    ...(descriptor.instance.runtimeDir !== undefined
      ? { runtimeDir: descriptor.instance.runtimeDir }
      : {}),
    port: 0,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  });

  const next: SessionDescriptor = {
    ...descriptor,
    heartbeatAt: new Date().toISOString(),
    instance: {
      ...descriptor.instance,
      cdpPort: launched.port,
      cdpUrl: launched.cdpUrl,
      ...(launched.browserId !== undefined ? { browserId: launched.browserId } : {}),
      ...(launched.pid !== undefined ? { pid: launched.pid } : {}),
      ...(launched.pidStartTime !== undefined ? { pidStartTime: launched.pidStartTime } : {}),
    },
  };
  await writeDescriptor(next, env);
  return { descriptor: next, quit };
}

export interface CloseSessionOptions {
  deleteVault?: boolean;
  /**
   * Refuse to delete a vault that lives outside the session's own directory.
   *
   * Set by the reaper, which deletes with no agent in the loop. A vault inside the
   * session root was unambiguously made by `seedSessionProfile` for this session
   * and is disposable; one the caller pointed elsewhere is a directory a human
   * chose, and reclaiming a stale profile is never a reason to delete it. An agent
   * calling `obsidian_close_session` explicitly still gets the full behaviour.
   */
  onlyVaultInsideRoot?: boolean;
  keepInstance?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CloseSessionResult {
  key: string;
  quit: boolean;
  unlinkedPlugin: boolean;
  vaultRemoved: boolean;
  vaultDeleted: boolean;
  rootDeleted: boolean;
  notes: string[];
}

export async function closeSession(
  key: string,
  opts: CloseSessionOptions = {},
): Promise<CloseSessionResult> {
  return withFileLock(registryLockPath(opts.env ?? process.env), () =>
    closeSessionUnlocked(key, opts),
  );
}

/** Close without taking the registry lock, for callers that already hold it. */
export async function closeSessionUnlocked(
  key: string,
  opts: CloseSessionOptions = {},
): Promise<CloseSessionResult> {
  const env = opts.env ?? process.env;
  const descriptor = await requireDescriptor(key, env);
  const notes: string[] = [];

  const unlinkedPlugin =
    descriptor.plugin !== undefined && descriptor.vault !== undefined
      ? await unlinkPluginIfPresent(descriptor.vault.path, descriptor.plugin.id)
      : false;

  const quit =
    opts.keepInstance === true
      ? false
      : await quitObsidian(scopeOf(descriptor), opts.timeoutMs ?? 15_000);

  const paths = sessionPaths(descriptor.key, env);
  const vaultInsideRoot =
    descriptor.vault !== undefined &&
    resolve(descriptor.vault.path).startsWith(`${resolve(paths.root)}/`);

  let vaultRemoved = false;
  let vaultDeleted = false;
  if (descriptor.vault !== undefined && opts.deleteVault === true) {
    if (opts.onlyVaultInsideRoot === true && !vaultInsideRoot) {
      notes.push(
        `Vault kept at ${descriptor.vault.path}: it lives outside the session directory, and ` +
          "automatic cleanup only deletes a session's own scratch vault.",
      );
    } else {
      // Route through the real removal path rather than an rm: it independently
      // re-reads the marker and refuses an `adopted` grant, a forbidden root, or a
      // directory containing another registered vault. The descriptor saying "this
      // is mine" is not, on its own, permission to delete.
      try {
        const configPath = `${descriptor.instance.userDataDir}/obsidian.json`;
        const registry = await readGlobalConfig(configPath);
        const result = await removeManagedVault(
          descriptor.vault.path,
          registry?.vaults ?? [],
          true,
          configPath,
        );
        vaultRemoved = result.unregistered;
        vaultDeleted = result.deletedDirectory;
      } catch (e) {
        notes.push(`Vault left on disk: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const rootDeleted = await removeSessionRoot(descriptor, env, vaultDeleted, notes);
  await removeDescriptor(key, env);

  return { key, quit, unlinkedPlugin, vaultRemoved, vaultDeleted, rootDeleted, notes };
}

/**
 * Delete a session's own directory tree, without taking the vault with it.
 *
 * The subtlety worth its own function: a session's default vault lives *inside*
 * the session root, so an `rm -rf` of the root deletes the vault too — silently
 * overriding both `deleteVault: false` and `removeManagedVault`'s refusal of an
 * adopted grant, which is precisely the safety rule that must not be reachable
 * around. The disposable parts are therefore removed by name, and the root itself
 * only once nothing worth keeping remains inside it.
 *
 * Also refuses when the profile is somehow the user's real one. That should be
 * impossible, since `createSession` only ever writes paths under the session root,
 * but this is the one path that deletes with no agent in the loop and a descriptor
 * from an older or buggier build is exactly what would arrive here.
 */
async function removeSessionRoot(
  descriptor: SessionDescriptor,
  env: NodeJS.ProcessEnv,
  vaultWasDeleted: boolean,
  notes: string[],
): Promise<boolean> {
  if (resolve(descriptor.instance.userDataDir) === resolve(defaultObsidianUserDataDir())) {
    notes.push("Refused to delete the session directory: it points at your own Obsidian profile.");
    return false;
  }

  const paths = sessionPaths(descriptor.key, env);
  for (const path of [paths.userDataDir, paths.outputDir, paths.runtimeDir, paths.lock]) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }

  const vaultPath = descriptor.vault?.path;
  const vaultSurvives =
    !vaultWasDeleted &&
    vaultPath !== undefined &&
    resolve(vaultPath).startsWith(`${resolve(paths.root)}/`);

  if (vaultSurvives) {
    // Keep the root purely as the vault's container. The descriptor is removed by
    // the caller, so what is left is an ordinary directory of notes rather than a
    // half-dismantled session.
    notes.push(`Vault kept at ${vaultPath}; its parent directory was left in place.`);
    return false;
  }

  await rm(paths.root, { recursive: true, force: true });
  return true;
}

export type SessionState = "live" | "orphaned" | "stale";

export interface SessionStatus {
  descriptor: SessionDescriptor;
  state: SessionState;
  cliIsolation: CliIsolation;
  cliSocket?: string;
  isCurrent: boolean;
}

/** 30 minutes with no live process before an abandoned session is reapable. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

export async function sessionState(
  descriptor: SessionDescriptor,
  now: Date = new Date(),
): Promise<SessionState> {
  const { pid, pidStartTime } = descriptor.instance;
  if (pid !== undefined && (await isPidStillObsidian(pid, scopeOf(descriptor), pidStartTime))) {
    // A live process is never stale, however old its heartbeat: an agent that is
    // thinking for an hour has not abandoned its session.
    return "live";
  }
  const age = now.getTime() - Date.parse(descriptor.heartbeatAt);
  return Number.isFinite(age) && age > STALE_AFTER_MS ? "stale" : "orphaned";
}

export async function listSessions(
  opts: { currentKey?: string; now?: Date; env?: NodeJS.ProcessEnv } = {},
): Promise<SessionStatus[]> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const descriptors = await listDescriptors(env);

  return Promise.all(
    descriptors.map(async (descriptor) => {
      const runtimeDir = descriptor.instance.runtimeDir;
      return {
        descriptor,
        state: await sessionState(descriptor, now),
        cliIsolation: cliIsolationFor(runtimeDir),
        ...(runtimeDir !== undefined ? { cliSocket: cliSocketPathFor(runtimeDir) } : {}),
        isCurrent: descriptor.key === opts.currentKey,
      };
    }),
  );
}

async function requireDescriptor(key: string, env: NodeJS.ProcessEnv): Promise<SessionDescriptor> {
  const descriptor = await readDescriptor(key, env);
  if (descriptor === undefined) {
    throw new UobError("SESSION_NOT_FOUND", `No knapper session named "${key}".`, {
      remediation: "List live sessions with obsidian_list_sessions.",
      fixedBy: "obsidian_list_sessions",
      details: { session: key },
    });
  }
  return descriptor;
}
