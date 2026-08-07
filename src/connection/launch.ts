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

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { defaultObsidianUserDataDir } from "../config.js";
import { childEnv } from "./cli/exec.js";
import { probeCdp } from "./cdp/discover.js";
import {
  isObsidianRunning,
  findObsidianPids,
  readPidStartTime,
  type ProcessScope,
} from "./health.js";
import {
  resolveDesktopEnvironment,
  type DesktopEnvironmentResult,
  type DesktopTransport,
} from "./desktop-env.js";
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
export function buildLaunchArgs(
  port: number,
  userDataDir: string | undefined,
  desktopTransport: DesktopTransport,
): string[] {
  const args: string[] = [];
  if (userDataDir !== undefined) args.push(`--user-data-dir=${userDataDir}`);
  args.push(`--remote-debugging-port=${port}`, "--remote-allow-origins=*");
  if (process.platform === "linux") {
    args.push(
      desktopTransport === "wayland" ? "--ozone-platform=wayland" : "--ozone-platform-hint=auto",
    );
    if (userDataDir !== undefined) args.push("--class=KnapperTestSession");
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

const OUTPUT_TAIL_BYTES = 8 * 1024;
const TERMINAL_CDP_GRACE_MS = 750;

const DURABLE_ENV_NAMES = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "DESKTOP_SESSION",
  "DBUS_SESSION_BUS_ADDRESS",
  "XAUTHORITY",
] as const;

/** Build a transient user-service command that escapes an MCP host's process tree. */
export function buildSystemdRunArgs(opts: {
  unit: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdoutLog: string;
  stderrLog: string;
}): string[] {
  const environment = DURABLE_ENV_NAMES.flatMap((name) => {
    const value = opts.env[name];
    return value === undefined ? [] : [`--setenv=${name}=${value}`];
  });
  return [
    "--user",
    "--quiet",
    "--collect",
    "--service-type=exec",
    `--unit=${opts.unit}`,
    `--property=StandardOutput=append:${opts.stdoutLog}`,
    `--property=StandardError=append:${opts.stderrLog}`,
    ...environment,
    "--",
    opts.command,
    ...opts.args,
  ];
}

function canUseSystemdUserService(runtimeDir: string | undefined): boolean {
  if (process.platform !== "linux" || runtimeDir === undefined) return false;
  const managerRuntime = process.env.XDG_RUNTIME_DIR;
  return (
    existsSync("/usr/bin/systemd-run") &&
    managerRuntime !== undefined &&
    existsSync(join(managerRuntime, "systemd", "private"))
  );
}

export interface LaunchDependencies {
  spawnProcess: typeof spawn;
  resolveDesktop: typeof resolveDesktopEnvironment;
  isRunning: typeof isObsidianRunning;
  quit: typeof quitObsidian;
  findPids: typeof findObsidianPids;
  readPortFile: typeof readDevToolsPortFile;
  readStartTime: typeof readPidStartTime;
  probe: typeof probeCdp;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  removePortFile(userDataDir: string): Promise<void>;
}

const defaultDependencies: LaunchDependencies = {
  spawnProcess: spawn,
  resolveDesktop: resolveDesktopEnvironment,
  isRunning: isObsidianRunning,
  quit: quitObsidian,
  findPids: findObsidianPids,
  readPortFile: readDevToolsPortFile,
  readStartTime: readPidStartTime,
  probe: probeCdp,
  sleep,
  now: Date.now,
  removePortFile: async (userDataDir) => {
    await rm(join(userDataDir, DEVTOOLS_PORT_FILE), { force: true }).catch(() => undefined);
  },
};

type ProcessOutcome =
  | { kind: "error"; error: Error; observedAt: number }
  | {
      kind: "exit";
      code: number | null;
      signal: NodeJS.Signals | null;
      observedAt: number;
    };

interface OutputCapture {
  text(): string;
  stop(): void;
}

function captureOutput(stream: Readable | null): OutputCapture {
  let tail = Buffer.alloc(0);
  let active = true;
  if (stream !== null) {
    stream.on("data", (chunk: Buffer | string) => {
      if (!active) return;
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const boundedNext =
        next.length > OUTPUT_TAIL_BYTES ? next.subarray(next.length - OUTPUT_TAIL_BYTES) : next;
      tail = Buffer.concat([tail, boundedNext]);
      if (tail.length > OUTPUT_TAIL_BYTES) tail = tail.subarray(tail.length - OUTPUT_TAIL_BYTES);
    });
    const unref = (stream as Readable & { unref?: () => void }).unref;
    unref?.call(stream);
  }
  return {
    text: () => tail.toString("utf8"),
    stop: () => {
      active = false;
      tail = Buffer.alloc(0);
    },
  };
}

function outcomeDetails(
  outcome: ProcessOutcome | undefined,
  stdout: OutputCapture,
  stderr: OutputCapture,
  desktop: DesktopEnvironmentResult,
): Record<string, unknown> {
  const stdoutTail = stdout.text();
  const stderrTail = stderr.text();
  return {
    ...(outcome?.kind === "exit" && outcome.code !== null ? { exitCode: outcome.code } : {}),
    ...(outcome?.kind === "exit" && outcome.signal !== null ? { signal: outcome.signal } : {}),
    ...(outcome?.kind === "error" ? { spawnError: outcome.error.message } : {}),
    ...(stdoutTail !== "" ? { stdoutTail } : {}),
    ...(stderrTail !== "" ? { stderrTail } : {}),
    desktopEnvSource: desktop.source,
    desktopTransport: desktop.transport,
    recoveredDesktopVariables: desktop.recovered,
  };
}

function launchFailed(
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): UobError {
  return new UobError("OBSIDIAN_LAUNCH_FAILED", message, {
    remediation:
      "Review the captured launch output, correct the reported startup problem, then launch Obsidian again.",
    fixedBy: "obsidian_launch",
    details,
    ...(cause !== undefined ? { cause } : {}),
  });
}

async function waitForCdpWith(
  port: number,
  timeoutMs: number,
  deps: LaunchDependencies,
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}`;
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    if ((await deps.probe(url)) !== undefined) return true;
    await deps.sleep(300);
  }
  return false;
}

/** Create a launcher with injectable process and discovery dependencies for tests. */
export function createObsidianLauncher(
  overrides: Partial<LaunchDependencies> = {},
): (opts: LaunchOptions) => Promise<LaunchResult> {
  const deps: LaunchDependencies = { ...defaultDependencies, ...overrides };
  return (opts) => launchObsidianWithDependencies(opts, deps);
}

/**
 * Launch Obsidian with CDP enabled.
 *
 * With no `userDataDir` this drives the user's own installation, exactly as before
 * sessions existed. With one, it becomes the mechanism that makes a second instance
 * possible at all — and then `runtimeDir` is mandatory, because a private profile
 * sharing the default CLI socket is a silent misroute rather than an error.
 */
async function launchObsidianWithDependencies(
  opts: LaunchOptions,
  deps: LaunchDependencies,
): Promise<LaunchResult> {
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

  const running = await deps.isRunning(scope);
  if (running && !wantForce) {
    const fromFile = await deps.readPortFile(userDataDir);
    const checkPort = requestedPort !== 0 ? requestedPort : (fromFile?.port ?? 9222);
    const cdpUrl = `http://127.0.0.1:${checkPort}`;
    const up = await deps.probe(cdpUrl);
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
    logger?.info("quitting running Obsidian before cold start", {
      userDataDir,
    });
    const quit = await deps.quit(scope, timeoutMs);
    if (!quit) {
      throw new UobError("TIMEOUT", "Timed out waiting for Obsidian to quit.", {
        remediation: "Close Obsidian manually, then call obsidian_launch again.",
      });
    }
    restarted = true;
    await deps.sleep(1000);
  }

  // Delete the stale port file before spawning, and accept only one written after
  // this moment. A session's second launch would otherwise find the previous run's
  // file, probe a port that something else now owns, and silently attach this
  // server to a different instance.
  const spawnedAt = deps.now();
  await deps.removePortFile(userDataDir);

  const desktop = await deps.resolveDesktop(process.env);
  const launchArgs = buildLaunchArgs(requestedPort, opts.userDataDir, desktop.transport);
  const launchEnv = childEnv(opts.runtimeDir, desktop.env);
  logger?.info("spawning Obsidian", {
    bin: opts.obsidianBin,
    args: launchArgs,
    desktopEnvSource: desktop.source,
    desktopTransport: desktop.transport,
    recoveredDesktopVariables: desktop.recovered,
  });

  let child: ChildProcess;
  const durable = deps.spawnProcess === spawn;
  const stdoutLog = join(userDataDir, "knapper-launch.stdout.log");
  const stderrLog = join(userDataDir, "knapper-launch.stderr.log");
  const useSystemd = durable && canUseSystemdUserService(opts.runtimeDir);
  const unit = useSystemd
    ? `knapper-obsidian-${randomBytes(8).toString("hex")}.service`
    : undefined;
  const spawnCommand = useSystemd ? "/usr/bin/systemd-run" : opts.obsidianBin;
  const spawnArgs =
    unit !== undefined
      ? buildSystemdRunArgs({
          unit,
          command: opts.obsidianBin,
          args: launchArgs,
          env: launchEnv,
          stdoutLog,
          stderrLog,
        })
      : launchArgs;
  let stdoutFd: number | undefined;
  let stderrFd: number | undefined;
  try {
    if (durable) {
      stdoutFd = openSync(stdoutLog, "a", 0o600);
      stderrFd = openSync(stderrLog, "a", 0o600);
    }
    child = deps.spawnProcess(spawnCommand, spawnArgs, {
      detached: true,
      // A detached process with inherited pipes still dies when an MCP host such
      // as OpenCode tears its child streams down. File-backed output gives the
      // process an independent lifetime and keeps startup diagnostics durable.
      stdio: durable ? ["ignore", stdoutFd!, stderrFd!] : ["ignore", "pipe", "pipe"],
      // childEnv keeps the private CLI socket while it pins any recovered
      // Wayland display to the desktop's real runtime directory.
      env: useSystemd ? { ...process.env, ...desktop.env } : launchEnv,
    });
  } catch (error) {
    throw launchFailed(
      "Obsidian could not start.",
      {
        requestedPort,
        timeoutMs,
        userDataDir,
        desktopEnvSource: desktop.source,
        desktopTransport: desktop.transport,
        spawnError: error instanceof Error ? error.message : String(error),
      },
      error,
    );
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd);
    if (stderrFd !== undefined) closeSync(stderrFd);
  }
  const stdout = captureOutput(child.stdout);
  const stderr = captureOutput(child.stderr);
  let outcome: ProcessOutcome | undefined;
  child.once("error", (error) => {
    outcome = { kind: "error", error, observedAt: deps.now() };
  });
  child.once("exit", (code, signal) => {
    outcome = { kind: "exit", code, signal, observedAt: deps.now() };
  });
  child.unref();

  const deadline = deps.now() + timeoutMs;
  let resolvedPort: number | undefined;
  let browserId: string | undefined;

  while (deps.now() < deadline) {
    if (requestedPort !== 0) {
      if (await waitForCdpWith(requestedPort, 500, deps)) {
        resolvedPort = requestedPort;
        browserId = (await deps.readPortFile(userDataDir))?.browserId;
        break;
      }
    } else {
      const fromFile = await deps.readPortFile(userDataDir);
      if (
        fromFile !== undefined &&
        fromFile.mtimeMs >= spawnedAt &&
        (await waitForCdpWith(fromFile.port, 500, deps))
      ) {
        resolvedPort = fromFile.port;
        browserId = fromFile.browserId;
        break;
      }
    }

    if (outcome?.kind === "error") {
      throw launchFailed(
        "Obsidian could not start.",
        {
          requestedPort,
          timeoutMs,
          userDataDir,
          ...(durable ? { stdoutLog, stderrLog } : {}),
          ...outcomeDetails(outcome, stdout, stderr, desktop),
        },
        outcome.error,
      );
    }
    if (
      outcome?.kind === "exit" &&
      (outcome.signal !== null || (outcome.code !== null && outcome.code !== 0)) &&
      deps.now() - outcome.observedAt >= TERMINAL_CDP_GRACE_MS &&
      (await deps.findPids(scope)).length === 0
    ) {
      const description =
        outcome.signal !== null
          ? `Obsidian terminated with ${outcome.signal} before CDP became reachable.`
          : `Obsidian exited with code ${outcome.code} before CDP became reachable.`;
      throw launchFailed(description, {
        requestedPort,
        timeoutMs,
        userDataDir,
        ...(durable ? { stdoutLog, stderrLog } : {}),
        ...outcomeDetails(outcome, stdout, stderr, desktop),
      });
    }
    await deps.sleep(400);
  }

  if (resolvedPort === undefined) {
    if (
      outcome?.kind === "exit" &&
      (outcome.signal !== null || (outcome.code !== null && outcome.code !== 0)) &&
      (await deps.findPids(scope)).length === 0
    ) {
      const description =
        outcome.signal !== null
          ? `Obsidian terminated with ${outcome.signal} before CDP became reachable.`
          : `Obsidian exited with code ${outcome.code} before CDP became reachable.`;
      throw launchFailed(description, {
        requestedPort,
        timeoutMs,
        userDataDir,
        ...(durable ? { stdoutLog, stderrLog } : {}),
        ...outcomeDetails(outcome, stdout, stderr, desktop),
      });
    }
    throw new UobError(
      "TIMEOUT",
      "The Obsidian CDP port did not become reachable before the launch timeout.",
      {
        remediation:
          "Review the captured launch output. If Obsidian is still starting, wait again or increase the timeout.",
        details: {
          requestedPort,
          timeoutMs,
          userDataDir,
          ...(durable ? { stdoutLog, stderrLog } : {}),
          ...outcomeDetails(outcome, stdout, stderr, desktop),
        },
      },
    );
  }

  stdout.stop();
  stderr.stop();
  const cdpUrl = `http://127.0.0.1:${resolvedPort}`;
  const main = (await deps.findPids(scope))[0];
  const mainStartTime = main === undefined ? undefined : await deps.readStartTime(main);
  return {
    port: resolvedPort,
    cdpUrl,
    restarted,
    ...(browserId !== undefined && browserId !== "" ? { browserId } : {}),
    ...(main !== undefined
      ? {
          pid: main,
          ...(mainStartTime !== undefined ? { pidStartTime: mainStartTime } : {}),
        }
      : {}),
  };
}

export const launchObsidian = createObsidianLauncher();
