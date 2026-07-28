/**
 * Cold-start Obsidian with a CDP debug port.
 *
 * Electron's single-instance lock means a second launch becomes a CLI client and
 * silently drops `--remote-debugging-port`. This module detects a running instance,
 * optionally quits it, spawns a fresh process, and polls until CDP answers.
 *
 * That same lock is keyed on the userData path, which is what makes N concurrent
 * instances possible: give each one its own `--user-data-dir` and each acquires its
 * own lock. Everything else here is scoped to match — process detection, quitting,
 * and the `DevToolsActivePort` read all take the profile they belong to, so one
 * session's restart cannot reach into another's.
 */

import { spawn } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultObsidianUserDataDir } from "../config.js";
import { childEnv } from "./cli/exec.js";
import { probeCdp } from "./cdp/discover.js";
import { isObsidianRunning, findObsidianPids, type ProcessScope } from "./health.js";
import { UobError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";

export interface LaunchOptions {
  obsidianBin: string;
  /**
   * Profile to launch against. This is the isolation primitive: Electron's
   * single-instance lock keys on the userData path, so two Obsidians with distinct
   * values here both acquire a lock and both run.
   */
  userDataDir?: string;
  /**
   * `XDG_RUNTIME_DIR` for the spawned process, which decides where it binds its CLI
   * socket. On Linux this must be set whenever `userDataDir` is not the default: the
   * app does `unlink(socket)` then `listen(socket)`, so instances sharing one runtime
   * dir silently steal each other's socket and every CLI call lands in whichever
   * booted last — with no error anywhere.
   */
  runtimeDir?: string;
  /** Explicit port, or 0 to let Chromium pick (read DevToolsActivePort). */
  port?: number;
  /** Quit a running instance before spawning. */
  force?: boolean;
  /** Alias for force — restart with debug flags. */
  restart?: boolean;
  timeoutMs?: number;
  logger?: Logger;
}

export interface LaunchResult {
  port: number;
  cdpUrl: string;
  restarted: boolean;
  /** Uuid path from `DevToolsActivePort` line 2, when it could be read. */
  browserId?: string;
  pid?: number;
  pidStartTime?: number;
}

const DEVTOOLS_PORT_FILE = "DevToolsActivePort";

export interface DevToolsPortFile {
  port: number;
  /** `/devtools/browser/<uuid>` — identity of the browser holding the port. */
  browserId: string;
  mtimeMs: number;
}

/**
 * Read `DevToolsActivePort` from a profile.
 *
 * The uuid on line 2 matters as much as the port. A session's *second* launch finds
 * the previous run's file still present; trusting the port alone can attach this
 * server to whatever now listens there — possibly another session's Obsidian.
 * Callers pair this with `mtimeMs` and a uuid comparison against
 * `/json/version`'s `webSocketDebuggerUrl` to prove identity.
 */
export async function readDevToolsPortFile(
  userDataDir: string,
): Promise<DevToolsPortFile | undefined> {
  const path = join(userDataDir, DEVTOOLS_PORT_FILE);
  try {
    const [text, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const [portLine, idLine] = text.split("\n");
    const port = Number(portLine?.trim());
    if (!Number.isFinite(port) || port <= 0) return undefined;
    return { port, browserId: (idLine ?? "").trim(), mtimeMs: st.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Quit the Obsidian instances matching `scope`.
 *
 * The scope is not optional decoration. Before sessions existed this swept every
 * Obsidian process on the machine, which was merely blunt when only one could run;
 * with per-profile instances it would mean one agent's restart killing every other
 * agent's app. An undefined `scope.userDataDir` still means "the default profile",
 * never "everything".
 */
export async function quitObsidian(scope: ProcessScope = {}, timeoutMs = 15_000): Promise<boolean> {
  if (!(await isObsidianRunning(scope))) return false;

  const pids = await findObsidianPids(scope);
  if (pids.length === 0) return false;

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isObsidianRunning(scope))) return true;
    await sleep(200);
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  await sleep(500);
  return !(await isObsidianRunning(scope));
}

/**
 * Build the launch argv.
 *
 * `--user-data-dir` is the isolation primitive and comes first. Passing it is what
 * lets a second instance exist at all: without it, Electron's single-instance lock
 * turns the launch into a CLI client and silently drops
 * `--remote-debugging-port`, so the caller gets a success with no debug port.
 */
function buildLaunchArgs(port: number, userDataDir?: string): string[] {
  const args: string[] = [];
  if (userDataDir !== undefined) args.push(`--user-data-dir=${userDataDir}`);
  args.push(`--remote-debugging-port=${port}`, "--remote-allow-origins=*");
  if (process.platform === "linux") {
    args.push("--ozone-platform-hint=auto");
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForCdp(port: number, timeoutMs: number): Promise<boolean> {
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = await probeCdp(url);
    if (version !== undefined) return true;
    await sleep(300);
  }
  return false;
}

/**
 * Launch Obsidian with CDP enabled.
 *
 * With no `userDataDir` this drives the user's own installation, exactly as before
 * sessions existed. With one, it becomes the mechanism that makes a second instance
 * possible at all — and then `runtimeDir` is mandatory, because a private profile
 * sharing the default CLI socket is a silent misroute rather than an error.
 */
export async function launchObsidian(opts: LaunchOptions): Promise<LaunchResult> {
  const logger = opts.logger;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const wantForce = opts.force === true || opts.restart === true;
  const requestedPort = opts.port ?? 0;
  const userDataDir = opts.userDataDir ?? defaultObsidianUserDataDir();
  const scope: ProcessScope = { userDataDir };

  // Refuse the silent-misroute configuration rather than produce it. On Linux a
  // private profile without a private runtime dir means this instance will unlink
  // and rebind the shared CLI socket, stealing it from every other instance — and
  // nothing anywhere reports an error when it happens.
  if (
    process.platform === "linux" &&
    opts.userDataDir !== undefined &&
    opts.userDataDir !== defaultObsidianUserDataDir() &&
    opts.runtimeDir === undefined
  ) {
    throw new UobError(
      "INVALID_ARGUMENT",
      "Refusing to launch an isolated Obsidian profile without an isolated XDG_RUNTIME_DIR.",
      {
        remediation:
          "Obsidian unlinks and rebinds $XDG_RUNTIME_DIR/.obsidian-cli.sock on startup, so this " +
          "instance would silently capture every other instance's CLI commands. Pass runtimeDir " +
          "alongside userDataDir.",
        details: { userDataDir: opts.userDataDir },
      },
    );
  }

  const running = await isObsidianRunning(scope);
  if (running && !wantForce) {
    const fromFile = await readDevToolsPortFile(userDataDir);
    const checkPort = requestedPort !== 0 ? requestedPort : (fromFile?.port ?? 9222);
    const cdpUrl = `http://127.0.0.1:${checkPort}`;
    const up = await probeCdp(cdpUrl);
    if (up !== undefined) {
      return {
        port: checkPort,
        cdpUrl,
        restarted: false,
        ...(fromFile?.browserId !== undefined ? { browserId: fromFile.browserId } : {}),
      };
    }
    throw new UobError(
      "OBSIDIAN_NOT_RUNNING",
      "Obsidian is already running but no CDP debug port is open.",
      {
        remediation:
          "Electron's single-instance lock drops `--remote-debugging-port` on a second launch. " +
          "Call obsidian_launch with restart=true (or force=true) to quit and cold-start with CDP.",
        fixedBy: "obsidian_launch",
        details: { running: true, cdpUrl },
      },
    );
  }

  let restarted = false;
  if (running && wantForce) {
    logger?.info("quitting running Obsidian before cold start", { userDataDir });
    const quit = await quitObsidian(scope, timeoutMs);
    if (!quit) {
      throw new UobError("TIMEOUT", "Timed out waiting for Obsidian to quit.", {
        remediation: "Close Obsidian manually, then call obsidian_launch again.",
      });
    }
    restarted = true;
    await sleep(1000);
  }

  // Delete the stale port file before spawning, and accept only one written after
  // this moment. A session's second launch would otherwise find the previous run's
  // file, probe a port that something else now owns, and silently attach this
  // server to a different instance.
  const spawnedAt = Date.now();
  await rm(join(userDataDir, DEVTOOLS_PORT_FILE), { force: true }).catch(() => undefined);

  const launchArgs = buildLaunchArgs(requestedPort, opts.userDataDir);
  logger?.info("spawning Obsidian", { bin: opts.obsidianBin, args: launchArgs });

  const child = spawn(opts.obsidianBin, launchArgs, {
    detached: true,
    stdio: "ignore",
    // Strips ELECTRON_RUN_AS_NODE (which would start Obsidian as a bare Node
    // process) and, when a runtime dir is given, redirects the CLI socket while
    // keeping the Wayland connection intact.
    env: childEnv(opts.runtimeDir),
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  let resolvedPort: number | undefined;
  let browserId: string | undefined;

  while (Date.now() < deadline) {
    if (requestedPort !== 0) {
      if (await waitForCdp(requestedPort, 500)) {
        resolvedPort = requestedPort;
        browserId = (await readDevToolsPortFile(userDataDir))?.browserId;
        break;
      }
    } else {
      const fromFile = await readDevToolsPortFile(userDataDir);
      if (
        fromFile !== undefined &&
        fromFile.mtimeMs >= spawnedAt &&
        (await waitForCdp(fromFile.port, 500))
      ) {
        resolvedPort = fromFile.port;
        browserId = fromFile.browserId;
        break;
      }
    }
    await sleep(400);
  }

  if (resolvedPort === undefined) {
    throw new UobError(
      "TIMEOUT",
      "Obsidian started but the CDP port did not become reachable in time.",
      {
        remediation:
          "Check /tmp or your nohup log for startup errors. Increase timeout or pass an explicit port.",
        details: { requestedPort, timeoutMs, userDataDir },
      },
    );
  }

  const cdpUrl = `http://127.0.0.1:${resolvedPort}`;
  const main = (await findObsidianPids(scope))[0];
  return {
    port: resolvedPort,
    cdpUrl,
    restarted,
    ...(browserId !== undefined && browserId !== "" ? { browserId } : {}),
    ...(main !== undefined ? { pid: main, ...(await pidStartTimeFields(main)) } : {}),
  };
}

async function pidStartTimeFields(pid: number): Promise<{ pidStartTime?: number }> {
  const { readPidStartTime } = await import("./health.js");
  const startTime = await readPidStartTime(pid);
  return startTime !== undefined ? { pidStartTime: startTime } : {};
}
