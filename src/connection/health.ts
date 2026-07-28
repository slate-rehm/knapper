/**
 * Precondition probing.
 *
 * Four states are kept distinct because the remediation differs for each, and
 * collapsing them into a single "cannot connect" is the main reason this class of
 * tooling is frustrating to use.
 */

import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defaultObsidianUserDataDir, obsidianConfigPath } from "../config.js";
import { checkUserFlags, readGlobalConfig, type ObsidianGlobalConfig } from "./vaults.js";
import { probeCdp, fetchTargets, obsidianWindows, type CdpTarget } from "./cdp/discover.js";
import type { ObsidianCli } from "./cli/exec.js";
import type { Logger } from "../util/logger.js";

export interface HealthReport {
  /** Is an Obsidian process alive? */
  running: boolean;
  /** Is the global CLI toggle on? */
  cliEnabled: boolean;
  /** Does the CLI actually answer? */
  cliReachable: boolean;
  /** Is a CDP debug port listening? */
  cdpReachable: boolean;
  cdpUrl: string;
  browserVersion?: string;
  /** Obsidian windows visible over CDP. */
  windows: { kind: string; title: string; vaultName?: string; targetId: string }[];
  /** Single-dash launch flags that corrupt CLI argv. */
  argvCorruption: { path: string; tokens: string[] } | undefined;
  vaults: ObsidianGlobalConfig["vaults"];
  configPath: string;
  /** Human-readable problems, most actionable first. */
  problems: HealthProblem[];
}

export interface HealthProblem {
  state: "not-running" | "cli-disabled" | "cdp-closed" | "argv-corruption";
  message: string;
  remediation: string;
  fixedBy?: string;
}

/**
 * Does this /proc cmdline belong to an Obsidian process?
 *
 * Two packagings to cover, and one trap:
 *
 *  - Official build: argv[0] is the Obsidian binary itself.
 *  - Distro packages (Arch, and any that unbundle Electron): argv[0] is a *shared*
 *    Electron and the app archive is argv[1] —
 *    `/usr/lib/electron39/electron /usr/lib/obsidian/app.asar --disable-gpu`.
 *    Note the archive is `app.asar`, not `obsidian.asar`; only its parent directory
 *    carries the name.
 *
 * The trap is that a plain substring search over the whole cmdline matches any shell
 * that merely *mentions* obsidian — `bash -c "nohup obsidian …"` is itself a process.
 * That would report Obsidian as running whenever someone had just tried to start it.
 * So match structurally, per argv token, never across the whole buffer.
 */
export function isObsidianCmdline(cmdline: string): boolean {
  const argv = cmdline.split("\0").filter((t) => t !== "");
  if (argv.length === 0) return false;

  // `<anything>/obsidian/<name>.asar`, or a literally named obsidian.asar.
  const asar = argv.some(
    (t) => /(^|[/\\])obsidian[/\\][^/\\]*\.asar$/i.test(t) || /(^|[/\\])obsidian\.asar$/i.test(t),
  );
  if (asar) return true;

  // argv[0] is the executable itself: `obsidian`, `Obsidian.exe`, `/opt/Obsidian/obsidian`.
  return /(^|[/\\])obsidian(\.exe)?$/i.test(argv[0] ?? "");
}

/**
 * Which Obsidian instance a process query is about.
 *
 * `userDataDir` undefined means the *default* profile — never "any instance". That
 * distinction is what keeps a session's restart from reaching the user's own
 * Obsidian, and vice versa.
 */
export interface ProcessScope {
  userDataDir?: string;
}

/** The `--user-data-dir` an argv carries, if any. */
export function cmdlineUserDataDir(cmdline: string): string | undefined {
  const argv = cmdline.split("\0").filter((t) => t !== "");
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token.startsWith("--user-data-dir=")) {
      return resolve(token.slice("--user-data-dir=".length));
    }
    // Chromium also accepts the two-token form.
    if (token === "--user-data-dir") {
      const next = argv[i + 1];
      return next !== undefined ? resolve(next) : undefined;
    }
  }
  return undefined;
}

/**
 * Does this process belong to the scoped instance?
 *
 * A conjunction, and it must stay one. Obsidian's own child processes carry
 * `--user-data-dir` while carrying nothing obsidian-ish — the network utility runs
 * as `/proc/self/exe --type=utility --user-data-dir=…`. Matching on the directory
 * alone would sweep those into a SIGTERM loop, which is the mirror image of the
 * mistake commit 5af5361 fixed on the other side.
 */
export function matchesScope(cmdline: string, scope: ProcessScope): boolean {
  if (!isObsidianCmdline(cmdline)) return false;
  const wanted = scope.userDataDir;
  const actual = cmdlineUserDataDir(cmdline);
  if (wanted === undefined) {
    // The default profile is expressed either by omitting the flag (how the app is
    // normally launched) or by naming it explicitly.
    return actual === undefined || actual === resolve(defaultObsidianUserDataDir());
  }
  return actual === resolve(wanted);
}

async function scanProc(scope: ProcessScope, stopAtFirst: boolean): Promise<number[]> {
  if (process.platform !== "linux") return [];
  const out: number[] = [];
  try {
    const entries = await readdir("/proc");
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
        if (matchesScope(cmdline, scope)) {
          out.push(Number(entry));
          if (stopAtFirst) return out;
        }
      } catch {
        // process exited between readdir and read
      }
    }
  } catch {
    return [];
  }
  return out;
}

/** Detect a live Obsidian process for a scope, without spawning the binary. */
export async function isObsidianRunning(scope: ProcessScope = {}): Promise<boolean> {
  // Reading /proc avoids a shell round-trip on Linux; other platforms fall back to
  // the CDP/CLI probes, which are authoritative anyway.
  return (await scanProc(scope, true)).length > 0;
}

/**
 * PIDs of running Obsidian processes in a scope.
 *
 * Shares `matchesScope` with the health probe deliberately. These were once two
 * copies of the same matching rule, and fixing only the probe left this one blind:
 * `isObsidianRunning()` reported true, this returned nothing, and quitting failed
 * with a timeout that blamed the app for not closing.
 */
export async function findObsidianPids(scope: ProcessScope = {}): Promise<number[]> {
  return scanProc(scope, false);
}

/**
 * Process start time in clock ticks (`/proc/<pid>/stat` field 22).
 *
 * Recorded with a pid so a later check can tell "still my instance" from "the
 * kernel reused that number". Cheap insurance against a session that outlives a
 * reboot signalling an unrelated process.
 */
export async function readPidStartTime(pid: number): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // comm can contain spaces and parentheses, so fields are counted after the
    // final ')' rather than by splitting the whole line.
    const after = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
    // field 22 overall = index 19 of the post-comm fields (which start at field 3).
    const raw = after[19];
    const value = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Is `pid` still the same scoped Obsidian process it was when recorded? */
export async function isPidStillObsidian(
  pid: number,
  scope: ProcessScope = {},
  startTime?: number,
): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    if (!matchesScope(await readFile(`/proc/${pid}/cmdline`, "utf8"), scope)) return false;
  } catch {
    return false;
  }
  if (startTime === undefined) return true;
  return (await readPidStartTime(pid)) === startTime;
}

export interface ProbeOptions {
  cdpUrl: string;
  cli: ObsidianCli;
  logger: Logger;
  /** Skip the CLI round-trip, which can block while Obsidian starts up. */
  skipCliProbe?: boolean;
  /** This instance's `obsidian.json`. Defaults to the user's own installation. */
  configPath?: string;
  /** Restrict process detection to one instance. */
  scope?: ProcessScope;
}

export async function probeHealth(opts: ProbeOptions): Promise<HealthReport> {
  const { cdpUrl, cli, logger } = opts;
  const configPath = opts.configPath ?? obsidianConfigPath();

  const [globalConfig, userFlags, version, procRunning] = await Promise.all([
    readGlobalConfig(configPath),
    // Deliberately unscoped: the distro wrapper reads one fixed user-flags.conf
    // regardless of --user-data-dir, so a corrupting token there breaks every
    // session's CLI, not just the default profile's.
    checkUserFlags(),
    probeCdp(cdpUrl),
    isObsidianRunning(opts.scope ?? {}),
  ]);

  const cdpReachable = version !== undefined;
  const argvCorruption =
    userFlags.exists && userFlags.corruptingTokens.length > 0
      ? { path: userFlags.path, tokens: userFlags.corruptingTokens }
      : undefined;

  let targets: CdpTarget[] = [];
  if (cdpReachable) {
    try {
      targets = await fetchTargets(cdpUrl);
    } catch (e) {
      logger.debug("target enumeration failed", { error: String(e) });
    }
  }

  const windows = obsidianWindows(targets).map((w) => ({
    kind: w.kind,
    title: w.target.title,
    ...(w.vaultName !== undefined ? { vaultName: w.vaultName } : {}),
    targetId: w.target.id,
  }));

  const cliEnabled = globalConfig?.cli === true;

  // Only pay for the CLI round-trip when it can plausibly succeed: it blocks
  // while the renderer boots, and it cold-launches Obsidian if nothing is running.
  let cliReachable = false;
  const running = procRunning || cdpReachable;
  if (!opts.skipCliProbe && cliEnabled && running && argvCorruption === undefined) {
    cliReachable = await cli.isReachable();
  }

  const problems: HealthProblem[] = [];

  if (argvCorruption) {
    problems.push({
      state: "argv-corruption",
      message: `Launch flags file contains single-dash token(s): ${argvCorruption.tokens.join(", ")}.`,
      remediation:
        `Obsidian strips only \`--\`-prefixed flags from argv, so these survive and become the ` +
        `command name, failing every CLI call. Edit ${argvCorruption.path} to use a double dash, ` +
        `or remove the line.`,
    });
  }

  if (!running) {
    problems.push({
      state: "not-running",
      message: "Obsidian is not running.",
      remediation: "Launch it with the debug port so both transports are available.",
      fixedBy: "obsidian_launch",
    });
  }

  if (!cliEnabled) {
    problems.push({
      state: "cli-disabled",
      message: "Obsidian's command line interface is disabled.",
      remediation:
        "This gates the majority of the Obsidian tools. It cannot be enabled through the CLI " +
        "itself, so either let this server flip it over the CDP connection or toggle it in " +
        "Settings > General > Advanced.",
      fixedBy: "obsidian_setup_cli",
    });
  }

  if (!cdpReachable) {
    problems.push({
      state: "cdp-closed",
      message: `No CDP endpoint at ${cdpUrl}.`,
      remediation:
        "Browser automation, ARIA snapshots, and live telemetry need this. Because of Electron's " +
        "single-instance lock, Obsidian must be fully quit and cold-started with " +
        "`--remote-debugging-port` — adding the flag to a running instance does nothing.",
      fixedBy: "obsidian_launch",
    });
  }

  return {
    running,
    cliEnabled,
    cliReachable,
    cdpReachable,
    cdpUrl,
    ...(version?.Browser !== undefined ? { browserVersion: version.Browser } : {}),
    windows,
    argvCorruption,
    vaults: globalConfig?.vaults ?? [],
    configPath,
    problems,
  };
}
