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

import { access, lstat, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  cliIsolationFor,
  cliSocketPathFor,
  defaultObsidianUserDataDir,
  registryLockPath,
  sessionPaths,
  trashDir,
  type CliIsolation,
} from "../config.js";
import { launchObsidian, quitObsidian, readDevToolsPortFile } from "../connection/launch.js";
import { probeCdp } from "../connection/cdp/discover.js";
import {
  findObsidianPids,
  isPidStillObsidian,
  readPidStartTime,
  type ProcessScope,
} from "../connection/health.js";
import { UobError } from "../util/errors.js";
import { withFileLock } from "../util/filelock.js";
import type { Logger } from "../util/logger.js";
import {
  SESSION_IDENTITY_PLUGIN_ID,
  seedSessionProfile,
  trustDisposableVault,
  verifyDisposableVaultReadiness,
} from "./bootstrap.js";
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
  agentHandle?: string;
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isIncompleteLaunch(error: unknown): error is UobError {
  return (
    error instanceof UobError &&
    (error.code === "TIMEOUT" || error.code === "OBSIDIAN_LAUNCH_FAILED")
  );
}

async function verifyRestartReadiness(
  descriptor: SessionDescriptor,
  cdpUrl: string,
  logger?: Logger,
): Promise<Pick<SessionDescriptor, "plugin" | "visualIdentity">> {
  const warnings: string[] = [];
  try {
    if (descriptor.vault !== undefined) {
      await trustDisposableVault(cdpUrl, descriptor.vault.id);
    }
  } catch (error) {
    warnings.push(
      `Could not grant plugin trust: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let probe;
  try {
    probe = await verifyDisposableVaultReadiness(cdpUrl, descriptor.key, descriptor.plugin?.id);
    if (!probe.identityLoaded) warnings.push("Identity plugin is not loaded.");
    if (!probe.identityVisible) warnings.push("Session banner is not visible.");
    if (!probe.titleIdentified) warnings.push("Window title is not identified.");
    if (!probe.desktopIdentified)
      warnings.push("Desktop icon or application identity is degraded.");
  } catch (error) {
    warnings.push(
      `Could not verify visual identity: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    probe === undefined ||
    !probe.identityLoaded ||
    !probe.identityVisible ||
    !probe.titleIdentified ||
    !probe.desktopIdentified
  ) {
    throw new UobError(
      "APP_UNAVAILABLE",
      `Session ${descriptor.key} could not prove its private-profile visual identity after restart.`,
      {
        remediation: "Review the launch logs and desktop integration, then restart the workspace.",
        fixedBy: "obsidian_workspace_restart",
        details: { session: descriptor.key, readiness: probe ?? null, warnings },
      },
    );
  }

  let plugin = descriptor.plugin;
  if (plugin !== undefined) {
    const requested = probe?.requestedPlugin;
    plugin = { ...plugin, preEnabled: requested?.enabled === true };
    if (requested?.exists !== true || requested.enabled !== true || requested.loaded !== true) {
      throw new UobError(
        "APP_UNAVAILABLE",
        `Plugin "${plugin.id}" did not become installed, enabled, and loaded after restart.`,
        {
          remediation: "Review the plugin manifest and launch logs, then restart the workspace.",
          fixedBy: "obsidian_workspace_restart",
          details: { session: descriptor.key, pluginId: plugin.id, readiness: requested ?? null },
        },
      );
    }
  }

  const visualIdentity: SessionDescriptor["visualIdentity"] = {
    state: warnings.length === 0 ? "ready" : "degraded",
    warnings,
  };
  if (warnings.length > 0) {
    logger?.warn("private session visual identity is degraded after restart", {
      session: descriptor.key,
      warnings,
    });
  }
  return { ...(plugin !== undefined ? { plugin } : {}), visualIdentity };
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
  let provisional: SessionDescriptor | undefined;
  try {
    seeded = await seedSessionProfile({
      key,
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
      plugin = {
        id: linked.pluginId,
        sourceDir: linked.sourceDir,
        linkPath: linked.linkPath,
        artifacts: linked.artifacts,
        preEnabled: true,
      };
      await writeFile(
        `${seeded.vault.path}/.obsidian/community-plugins.json`,
        `${JSON.stringify([SESSION_IDENTITY_PLUGIN_ID, linked.pluginId], null, 2)}\n`,
        "utf8",
      );
    }

    const [rootIdentity, vaultIdentity] = await Promise.all([
      stat(paths.root),
      stat(seeded.vault.path),
    ]);

    const spawnedAt = new Date();
    provisional = {
      schema: SESSION_SCHEMA_VERSION,
      key,
      createdAt: now.toISOString(),
      heartbeatAt: now.toISOString(),
      readiness: {
        phase: "starting",
        spawnedAt: spawnedAt.toISOString(),
        requestedPort: opts.cdpPort ?? 0,
      },
      origin: {
        cwd: opts.cwd ?? process.cwd(),
        ...(opts.branch !== undefined ? { branch: opts.branch } : {}),
        label,
      },
      ...(opts.agentHandle !== undefined ? { agentHandle: opts.agentHandle } : {}),
      ownership: {
        rootPath: await realpath(paths.root),
        vaultPath: await realpath(seeded.vault.path),
        rootDevice: rootIdentity.dev,
        rootInode: rootIdentity.ino,
        vaultDevice: vaultIdentity.dev,
        vaultInode: vaultIdentity.ino,
      },
      instance: {
        userDataDir: paths.userDataDir,
        runtimeDir: paths.runtimeDir,
        outputDir: paths.outputDir,
        obsidianBin: opts.obsidianBin,
      },
      vault: seeded.vault,
      ...(plugin !== undefined ? { plugin } : {}),
    };
    await writeDescriptor(provisional, env);

    const launched = await launchObsidian({
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
    const identityWarnings: string[] = [];
    try {
      await trustDisposableVault(launched.cdpUrl, seeded.vault.id);
    } catch (error) {
      identityWarnings.push(
        `Could not grant plugin trust: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let readinessProbe;
    try {
      readinessProbe = await verifyDisposableVaultReadiness(launched.cdpUrl, key, plugin?.id);
      if (!readinessProbe.identityLoaded) identityWarnings.push("Identity plugin is not loaded.");
      if (!readinessProbe.identityVisible) identityWarnings.push("Session banner is not visible.");
      if (!readinessProbe.titleIdentified) identityWarnings.push("Window title is not identified.");
      if (!readinessProbe.desktopIdentified)
        identityWarnings.push("Desktop icon or application identity is degraded.");
    } catch (error) {
      identityWarnings.push(
        `Could not verify visual identity: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (
      readinessProbe === undefined ||
      !readinessProbe.identityLoaded ||
      !readinessProbe.identityVisible ||
      !readinessProbe.titleIdentified ||
      !readinessProbe.desktopIdentified
    ) {
      throw new UobError(
        "APP_UNAVAILABLE",
        `Session ${key} could not prove its private-profile visual identity.`,
        {
          remediation:
            "Review the launch logs and desktop integration, then create a new workspace.",
          fixedBy: "obsidian_workspace_create",
          details: { session: key, readiness: readinessProbe ?? null, warnings: identityWarnings },
        },
      );
    }

    if (plugin !== undefined) {
      const requested = readinessProbe?.requestedPlugin;
      plugin = { ...plugin, preEnabled: requested?.enabled === true };
      provisional = { ...provisional, plugin };
      if (requested?.exists !== true || requested.enabled !== true || requested.loaded !== true) {
        throw new UobError(
          "APP_UNAVAILABLE",
          `Plugin "${plugin.id}" did not become installed, enabled, and loaded.`,
          {
            remediation:
              "Review the plugin manifest and launch logs, then create a new workspace after fixing the plugin.",
            fixedBy: "obsidian_workspace_create",
            details: {
              session: key,
              pluginId: plugin.id,
              readiness: requested ?? null,
            },
          },
        );
      }
    }

    const visualIdentity: SessionDescriptor["visualIdentity"] = {
      state: identityWarnings.length === 0 ? "ready" : "degraded",
      warnings: identityWarnings,
    };
    if (identityWarnings.length > 0) {
      opts.logger?.warn("private session visual identity is degraded", {
        session: key,
        warnings: identityWarnings,
      });
    }

    const descriptor: SessionDescriptor = {
      ...provisional,
      visualIdentity,
      readiness: { phase: "ready", readyAt: new Date().toISOString() },
      instance: {
        ...provisional.instance,
        cdpPort: launched.port,
        cdpUrl: launched.cdpUrl,
        ...(launched.browserId !== undefined ? { browserId: launched.browserId } : {}),
        ...(launched.pid !== undefined ? { pid: launched.pid } : {}),
        ...(launched.pidStartTime !== undefined ? { pidStartTime: launched.pidStartTime } : {}),
      },
    };
    await writeDescriptor(descriptor, env);
    return descriptor;
  } catch (e) {
    if (provisional !== undefined && isIncompleteLaunch(e)) {
      const pids = await findObsidianPids(scopeOf(provisional));
      const pid = pids[0];
      if (e.code === "TIMEOUT" && pid !== undefined) {
        const pidStartTime = await readPidStartTime(pid);
        const starting: SessionDescriptor = {
          ...provisional,
          heartbeatAt: new Date().toISOString(),
          instance: {
            ...provisional.instance,
            pid,
            ...(pidStartTime !== undefined ? { pidStartTime } : {}),
          },
        };
        await writeDescriptor(starting, env);
        return starting;
      }
      const failed: SessionDescriptor = {
        ...provisional,
        readiness: {
          phase: "failed",
          failedAt: new Date().toISOString(),
          reason: e.message,
        },
      };
      await writeDescriptor(failed, env);
      throw new UobError("SESSION_NOT_RUNNING", `Session ${key} failed to start.`, {
        remediation:
          "Review the launch details, then retry obsidian_workspace_create. Knapper retains the failed scratch descriptor for diagnosis.",
        fixedBy: "obsidian_workspace_create",
        details: {
          session: key,
          launchError: e.toJSON(),
          diagnostics: await sessionDiagnostics(failed),
        },
        cause: e,
      });
    }
    // Leave nothing half-provisioned: a session that failed anywhere before its
    // descriptor exists would otherwise sit on disk forever, since the reaper's
    // "no live process" rule alone cannot tell it apart from one merely stopped.
    // Only the session's own root is removed — a vault the caller pointed outside
    // it is not ours to clean up, and this path runs on the argument-validation
    // failures where it is most likely to be someone's real directory.
    if (provisional === undefined) {
      await rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
    } else {
      const stopped = await quitObsidian(scopeOf(provisional), opts.timeoutMs ?? 15_000).catch(
        () => false,
      );
      if (!stopped) {
        opts.logger?.warn("failed session creation left an instance that could not be stopped", {
          session: provisional.key,
        });
      }
      await writeDescriptor(
        {
          ...provisional,
          readiness: {
            phase: "failed",
            failedAt: new Date().toISOString(),
            reason: e instanceof Error ? e.message : String(e),
          },
        },
        env,
      );
    }
    throw e;
  }
}

export async function waitSession(
  key: string,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<SessionDescriptor> {
  const env = opts.env ?? process.env;
  let descriptor = await requireDescriptor(key, env);
  if (descriptor.readiness.phase === "ready") return descriptor;
  if (descriptor.readiness.phase === "failed") {
    throw new UobError("SESSION_NOT_RUNNING", `Session ${key} failed to start.`, {
      remediation: "Restart the session or close it and create a new one.",
      details: { session: key, reason: descriptor.readiness.reason },
    });
  }
  if (descriptor.readiness.phase === "stopped") {
    throw new UobError("SESSION_NOT_RUNNING", `Session ${key} is stopped.`, {
      remediation: "Restart the session before you use it.",
      fixedBy: "obsidian_workspace_restart",
      details: { session: key },
    });
  }

  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  let starting = descriptor.readiness;
  const spawnedAt = Date.parse(starting.spawnedAt);
  while (Date.now() < deadline) {
    const pids = await findObsidianPids(scopeOf(descriptor));
    if (pids.length === 0) {
      descriptor = {
        ...descriptor,
        readiness: {
          phase: "failed",
          failedAt: new Date().toISOString(),
          reason: "The scoped Obsidian process exited before CDP became ready.",
        },
      };
      await writeDescriptor(descriptor, env);
      throw new UobError("SESSION_NOT_RUNNING", `Session ${key} is not running.`, {
        remediation: "Restart the session or close it and create a new one.",
      });
    }

    const portFile = await readDevToolsPortFile(descriptor.instance.userDataDir);
    const fresh = portFile !== undefined && portFile.mtimeMs >= spawnedAt;
    const port = fresh
      ? portFile.port
      : starting.requestedPort !== 0
        ? starting.requestedPort
        : undefined;
    if (port !== undefined && (await probeCdp(`http://127.0.0.1:${port}`)) !== undefined) {
      const pid = pids[0];
      descriptor = {
        ...descriptor,
        heartbeatAt: new Date().toISOString(),
        readiness: { phase: "ready", readyAt: new Date().toISOString() },
        instance: {
          ...descriptor.instance,
          cdpPort: port,
          cdpUrl: `http://127.0.0.1:${port}`,
          ...(portFile?.browserId ? { browserId: portFile.browserId } : {}),
          ...(pid !== undefined ? { pid, pidStartTime: await readPidStartTime(pid) } : {}),
        },
      };
      await writeDescriptor(descriptor, env);
      return descriptor;
    }
    starting = { ...starting, lastProbeAt: new Date().toISOString() };
    descriptor = {
      ...descriptor,
      readiness: starting,
    };
    await writeDescriptor(descriptor, env);
    await sleep(400);
  }

  throw new UobError("TIMEOUT", `Session ${key} is still starting.`, {
    remediation:
      "Retry obsidian_workspace_create after checking the launch diagnostics. Knapper cleans up the failed workspace before it returns the error.",
    fixedBy: "obsidian_workspace_create",
    details: await sessionDiagnostics(descriptor),
  });
}

export async function sessionDiagnostics(
  descriptor: SessionDescriptor,
): Promise<Record<string, unknown>> {
  const portFile = await readDevToolsPortFile(descriptor.instance.userDataDir);
  const socket = cliSocketPathFor(descriptor.instance.runtimeDir);
  const pids = await findObsidianPids(scopeOf(descriptor));
  const cdpUrl =
    descriptor.instance.cdpUrl ??
    (portFile !== undefined ? `http://127.0.0.1:${portFile.port}` : undefined);
  return {
    phase: descriptor.readiness.phase,
    processIds: pids,
    processStartTime: pids[0] !== undefined ? await readPidStartTime(pids[0]) : undefined,
    requestedPort:
      descriptor.readiness.phase === "starting" ? descriptor.readiness.requestedPort : undefined,
    devToolsPortFilePresent: portFile !== undefined,
    devToolsPortFileMtime: portFile?.mtimeMs,
    devToolsPort: portFile?.port,
    browserId: portFile?.browserId,
    cdpReachable: cdpUrl !== undefined && (await probeCdp(cdpUrl)) !== undefined,
    cliSocket: socket,
    cliSocketPresent: await access(socket).then(
      () => true,
      () => false,
    ),
    userDataDir: descriptor.instance.userDataDir,
    runtimeDir: descriptor.instance.runtimeDir,
    vaultPath: descriptor.vault?.path,
    visualIdentity: descriptor.visualIdentity ?? {
      state: "degraded",
      warnings: ["Not recorded."],
    },
    elapsedMs:
      descriptor.readiness.phase === "starting"
        ? Date.now() - Date.parse(descriptor.readiness.spawnedAt)
        : undefined,
  };
}

export interface RestartSessionResult {
  descriptor: SessionDescriptor;
  quit: boolean;
}

export type StopSessionState = "notRunning" | "quitSucceeded" | "quitFailed";

export interface StopSessionResult {
  key: string;
  state: StopSessionState;
  quit: boolean;
}

export interface StopSessionOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export async function stopSession(
  key: string,
  opts: StopSessionOptions = {},
): Promise<StopSessionResult> {
  return withFileLock(registryLockPath(opts.env ?? process.env), () =>
    stopSessionUnlocked(key, opts),
  );
}

/** Stop without taking the registry lock, for callers that already hold it. */
export async function stopSessionUnlocked(
  key: string,
  opts: StopSessionOptions = {},
): Promise<StopSessionResult> {
  const env = opts.env ?? process.env;
  const descriptor = await requireDescriptor(key, env);
  const running = (await findObsidianPids(scopeOf(descriptor))).length > 0;
  if (!running) {
    await markSessionStopped(descriptor, env);
    return { key, state: "notRunning", quit: false };
  }

  const quit = await quitObsidian(scopeOf(descriptor), opts.timeoutMs ?? 15_000);
  if (!quit) return { key, state: "quitFailed", quit: false };

  await markSessionStopped(descriptor, env);
  return { key, state: "quitSucceeded", quit: true };
}

async function markSessionStopped(
  descriptor: SessionDescriptor,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const stoppedAt = new Date().toISOString();
  await writeDescriptor(
    {
      ...descriptor,
      heartbeatAt: stoppedAt,
      readiness: { phase: "stopped", stoppedAt },
      instance: {
        ...descriptor.instance,
        cdpPort: undefined,
        cdpUrl: undefined,
        browserId: undefined,
        pid: undefined,
        pidStartTime: undefined,
      },
      ...(descriptor.owner === undefined
        ? {}
        : { owner: { ...descriptor.owner, exitedAt: stoppedAt } }),
    },
    env,
  );
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
  return withFileLock(registryLockPath(env), () => restartSessionUnlocked(key, opts));
}

async function restartSessionUnlocked(
  key: string,
  opts: { timeoutMs?: number; logger?: Logger; env?: NodeJS.ProcessEnv },
): Promise<RestartSessionResult> {
  const env = opts.env ?? process.env;
  const descriptor = await requireDescriptor(key, env);
  const scope = scopeOf(descriptor);
  const stop = await stopSessionUnlocked(key, opts);
  if (stop.state === "quitFailed") {
    throw new UobError("TIMEOUT", `Session ${key} did not stop.`, {
      remediation: "Retry the restart after the scoped Obsidian instance stops.",
      details: { session: key, userDataDir: descriptor.instance.userDataDir },
    });
  }

  const starting: SessionDescriptor = {
    ...descriptor,
    heartbeatAt: new Date().toISOString(),
    readiness: {
      phase: "starting",
      spawnedAt: new Date().toISOString(),
      requestedPort: 0,
    },
    instance: {
      ...descriptor.instance,
      cdpPort: undefined,
      cdpUrl: undefined,
      browserId: undefined,
      pid: undefined,
      pidStartTime: undefined,
    },
  };
  await writeDescriptor(starting, env);

  let launched;
  try {
    launched = await launchObsidian({
      obsidianBin: descriptor.instance.obsidianBin,
      userDataDir: descriptor.instance.userDataDir,
      ...(descriptor.instance.runtimeDir !== undefined
        ? { runtimeDir: descriptor.instance.runtimeDir }
        : {}),
      port: 0,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
    });
  } catch (error) {
    if (isIncompleteLaunch(error)) {
      const pids = await findObsidianPids(scope);
      const pid = pids[0];
      if (error.code === "TIMEOUT" && pid !== undefined) {
        const pending = {
          ...starting,
          instance: {
            ...starting.instance,
            pid,
            pidStartTime: await readPidStartTime(pid),
          },
        };
        await writeDescriptor(pending, env);
        return { descriptor: pending, quit: stop.quit };
      }
      await writeDescriptor(
        {
          ...starting,
          readiness: {
            phase: "failed",
            failedAt: new Date().toISOString(),
            reason: error.message,
          },
        },
        env,
      );
      const failed = await requireDescriptor(key, env);
      throw new UobError("SESSION_NOT_RUNNING", `Session ${key} failed to restart.`, {
        remediation: "Review the launch details, then restart or close the session.",
        fixedBy: "obsidian_workspace_restart",
        details: {
          session: key,
          launchError: error.toJSON(),
          diagnostics: await sessionDiagnostics(failed),
        },
        cause: error,
      });
    }
    throw error;
  }

  try {
    const verified = await verifyRestartReadiness(descriptor, launched.cdpUrl, opts.logger);
    const next: SessionDescriptor = {
      ...descriptor,
      ...verified,
      heartbeatAt: new Date().toISOString(),
      readiness: { phase: "ready", readyAt: new Date().toISOString() },
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
    return { descriptor: next, quit: stop.quit };
  } catch (error) {
    const failed: SessionDescriptor = {
      ...descriptor,
      heartbeatAt: new Date().toISOString(),
      readiness: {
        phase: "failed",
        failedAt: new Date().toISOString(),
        reason: error instanceof Error ? error.message : String(error),
      },
      instance: {
        ...descriptor.instance,
        cdpPort: launched.port,
        cdpUrl: launched.cdpUrl,
        ...(launched.pid !== undefined ? { pid: launched.pid } : {}),
        ...(launched.pidStartTime !== undefined ? { pidStartTime: launched.pidStartTime } : {}),
      },
    };
    await writeDescriptor(failed, env);
    throw error;
  }
}

export interface DisposeSessionOptions {
  env?: NodeJS.ProcessEnv;
}

export interface CloseSessionResult {
  key: string;
  quit: boolean;
  unlinkedPlugin: boolean;
  vaultRemoved: boolean;
  vaultDeleted: boolean;
  rootDeleted: boolean;
  quarantinedPath?: string;
  notes: string[];
}

export async function releaseSession(
  key: string,
  opts: DisposeSessionOptions = {},
): Promise<CloseSessionResult> {
  return withFileLock(registryLockPath(opts.env ?? process.env), () =>
    releaseSessionUnlocked(key, opts),
  );
}

/** Release without taking the registry lock, for callers that already hold it. */
export async function releaseSessionUnlocked(
  key: string,
  opts: DisposeSessionOptions = {},
): Promise<CloseSessionResult> {
  const env = opts.env ?? process.env;
  const descriptor = await requireDescriptor(key, env);
  const notes: string[] = [];
  await refuseLiveCleanup(descriptor);

  const unlinkedPlugin =
    descriptor.plugin !== undefined && descriptor.vault !== undefined
      ? await unlinkPluginIfPresent(descriptor.vault.path, descriptor.plugin.id)
      : false;

  await removeSessionRuntime(descriptor, env, notes);
  await removeDescriptor(key, env);

  return {
    key,
    quit: false,
    unlinkedPlugin,
    vaultRemoved: false,
    vaultDeleted: false,
    rootDeleted: false,
    notes,
  };
}

export async function quarantineSession(
  key: string,
  opts: DisposeSessionOptions = {},
): Promise<CloseSessionResult> {
  return withFileLock(registryLockPath(opts.env ?? process.env), () =>
    quarantineSessionUnlocked(key, opts),
  );
}

/** Quarantine without taking the registry lock, for callers that already hold it. */
export async function quarantineSessionUnlocked(
  key: string,
  opts: DisposeSessionOptions = {},
): Promise<CloseSessionResult> {
  const env = opts.env ?? process.env;
  const descriptor = await requireDescriptor(key, env);
  await refuseLiveCleanup(descriptor);
  const quarantinedPath = await quarantineOwnedSession(descriptor, env);
  return {
    key,
    quit: false,
    unlinkedPlugin: false,
    vaultRemoved: false,
    vaultDeleted: false,
    rootDeleted: true,
    quarantinedPath,
    notes: [
      `Moved the complete scratch workspace to ${quarantinedPath}. Move it back before another workspace reuses the key to restore it.`,
    ],
  };
}

async function refuseLiveCleanup(descriptor: SessionDescriptor): Promise<void> {
  if ((await findObsidianPids(scopeOf(descriptor))).length === 0) return;
  throw new UobError("INVALID_ARGUMENT", `Session ${descriptor.key} is still running.`, {
    remediation: "Stop the workspace, then retry this operation.",
    fixedBy: "obsidian_workspace_stop",
    details: {
      session: descriptor.key,
      userDataDir: descriptor.instance.userDataDir,
    },
  });
}

/** Compatibility wrapper for internal callers that still perform both phases. */
export async function closeSession(
  key: string,
  opts: {
    deleteVault?: boolean;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<CloseSessionResult> {
  const stop = await stopSession(key, opts);
  if (stop.state === "quitFailed") {
    throw new UobError("TIMEOUT", `Session ${key} did not stop.`, {
      remediation:
        "Close the scoped Obsidian instance, then retry. Knapper did not unlink or remove anything.",
      details: { session: key },
    });
  }
  return opts.deleteVault === true ? quarantineSession(key, opts) : releaseSession(key, opts);
}

async function quarantineOwnedSession(
  descriptor: SessionDescriptor,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const paths = sessionPaths(descriptor.key, env);
  const ownership = descriptor.ownership;
  if (
    ownership === undefined ||
    descriptor.vault === undefined ||
    descriptor.vault.grant !== "created" ||
    resolve(descriptor.vault.path) !== resolve(paths.vaultDir) ||
    resolve(descriptor.instance.userDataDir) !== resolve(paths.userDataDir) ||
    resolve(descriptor.instance.userDataDir) === resolve(defaultObsidianUserDataDir())
  ) {
    throw new UobError("VAULT_NOT_MANAGED", "Knapper refused to quarantine this workspace.", {
      remediation:
        "Keep the workspace and inspect its descriptor. Only an exact Knapper scratch layout can be quarantined.",
      details: { session: descriptor.key },
    });
  }

  const [rootLink, vaultLink, rootPath, vaultPath, rootIdentity, vaultIdentity] = await Promise.all(
    [
      lstat(paths.root),
      lstat(paths.vaultDir),
      realpath(paths.root),
      realpath(paths.vaultDir),
      stat(paths.root),
      stat(paths.vaultDir),
    ],
  );
  if (
    rootLink.isSymbolicLink() ||
    vaultLink.isSymbolicLink() ||
    rootPath !== ownership.rootPath ||
    vaultPath !== ownership.vaultPath ||
    rootIdentity.dev !== ownership.rootDevice ||
    rootIdentity.ino !== ownership.rootInode ||
    vaultIdentity.dev !== ownership.vaultDevice ||
    vaultIdentity.ino !== ownership.vaultInode
  ) {
    throw new UobError("VAULT_NOT_MANAGED", "The scratch workspace identity changed.", {
      remediation:
        "Keep the workspace and inspect it manually. Knapper will not follow a replacement path or symlink during cleanup.",
      details: { session: descriptor.key },
    });
  }

  const destinationRoot = trashDir(env);
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  const destination = `${destinationRoot}/${descriptor.key}-${Date.now()}-${process.pid}`;
  await rename(paths.root, destination);
  return destination;
}

/** Remove runtime data while retaining the scratch vault and its parent. */
async function removeSessionRuntime(
  descriptor: SessionDescriptor,
  env: NodeJS.ProcessEnv,
  notes: string[],
): Promise<void> {
  if (resolve(descriptor.instance.userDataDir) === resolve(defaultObsidianUserDataDir())) {
    notes.push("Refused to remove runtime data because it points at your Obsidian profile.");
    return;
  }

  const paths = sessionPaths(descriptor.key, env);
  if (resolve(descriptor.instance.userDataDir) !== resolve(paths.userDataDir)) {
    notes.push("Refused to remove runtime data because the session layout does not match.");
    return;
  }
  for (const path of [paths.userDataDir, paths.outputDir, paths.runtimeDir, paths.lock]) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
  if (descriptor.vault !== undefined) {
    notes.push(`Vault kept at ${descriptor.vault.path}; its parent directory was left in place.`);
  }
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

/** Whether the MCP process recorded as this session's owner still exists. */
export async function sessionOwnerAlive(descriptor: SessionDescriptor): Promise<boolean> {
  const owner = descriptor.owner;
  if (owner === undefined || owner.exitedAt !== undefined) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (owner.pidStartTime === undefined || process.platform !== "linux") return true;
  return (await readPidStartTime(owner.pid)) === owner.pidStartTime;
}

export function sessionCleanupEligibleAt(
  descriptor: SessionDescriptor,
  idleTimeoutMs: number,
): string | undefined {
  const heartbeat = Date.parse(descriptor.heartbeatAt);
  if (!Number.isFinite(heartbeat)) return undefined;
  return new Date(heartbeat + idleTimeoutMs).toISOString();
}

export function sessionCleanupExpired(
  descriptor: SessionDescriptor,
  now: Date,
  idleTimeoutMs: number,
): boolean {
  const eligibleAt = sessionCleanupEligibleAt(descriptor, idleTimeoutMs);
  return eligibleAt !== undefined && Date.parse(eligibleAt) <= now.getTime();
}

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
      remediation: "List durable workspace handles with obsidian_workspace_list.",
      fixedBy: "obsidian_workspace_list",
      details: { session: key },
    });
  }
  return descriptor;
}
