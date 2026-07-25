/**
 * Cold-start Obsidian with a CDP debug port.
 *
 * Electron's single-instance lock means a second launch becomes a CLI client and
 * silently drops `--remote-debugging-port`. This module detects a running instance,
 * optionally quits it, spawns a fresh process, and polls until CDP answers.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { obsidianUserDataDir } from "../config.js";
import { childEnv } from "./cli/exec.js";
import { probeCdp } from "./cdp/discover.js";
import { isObsidianRunning } from "./health.js";
import { UobError } from "../util/errors.js";
import type { Logger } from "../util/logger.js";

export interface LaunchOptions {
  obsidianBin: string;
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
}

const DEVTOOLS_PORT_FILE = "DevToolsActivePort";

export async function readDevToolsPort(
  userDataDir = obsidianUserDataDir(),
): Promise<number | undefined> {
  try {
    const text = await readFile(join(userDataDir, DEVTOOLS_PORT_FILE), "utf8");
    const first = text.split("\n")[0]?.trim();
    if (first === undefined || first === "") return undefined;
    const port = Number(first);
    return Number.isFinite(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

export async function quitObsidian(timeoutMs = 15_000): Promise<boolean> {
  if (!(await isObsidianRunning())) return false;

  const pids = await findObsidianPids();
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
    if (!(await isObsidianRunning())) return true;
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
  return !(await isObsidianRunning());
}

async function findObsidianPids(): Promise<number[]> {
  if (process.platform !== "linux") return [];
  const { readdir, readFile } = await import("node:fs/promises");
  const out: number[] = [];
  try {
    const entries = await readdir("/proc");
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
        if (cmdline.includes("obsidian.asar") || /obsidian/i.test(cmdline.split("\0")[0] ?? "")) {
          out.push(Number(entry));
        }
      } catch {
        // skip
      }
    }
  } catch {
    return [];
  }
  return out;
}

function buildLaunchArgs(port: number): string[] {
  const args = [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"];
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
 * Launch Obsidian with CDP enabled. Never passes `--user-data-dir`.
 */
export async function launchObsidian(opts: LaunchOptions): Promise<LaunchResult> {
  const logger = opts.logger;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const wantForce = opts.force === true || opts.restart === true;
  const requestedPort = opts.port ?? 0;

  const running = await isObsidianRunning();
  if (running && !wantForce) {
    const fromFile = await readDevToolsPort();
    const checkPort = requestedPort !== 0 ? requestedPort : (fromFile ?? 9222);
    const cdpUrl = `http://127.0.0.1:${checkPort}`;
    const up = await probeCdp(cdpUrl);
    if (up !== undefined) {
      return { port: checkPort, cdpUrl, restarted: false };
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
    logger?.info("quitting running Obsidian before cold start");
    const quit = await quitObsidian(timeoutMs);
    if (!quit) {
      throw new UobError("TIMEOUT", "Timed out waiting for Obsidian to quit.", {
        remediation: "Close Obsidian manually, then call obsidian_launch again.",
      });
    }
    restarted = true;
    await sleep(1000);
  }

  const launchArgs = buildLaunchArgs(requestedPort);
  logger?.info("spawning Obsidian", { bin: opts.obsidianBin, args: launchArgs });

  const child = spawn(opts.obsidianBin, launchArgs, {
    detached: true,
    stdio: "ignore",
    // Same reason as the CLI path: an inherited ELECTRON_RUN_AS_NODE would start
    // Obsidian as a bare Node process, which cannot require("electron").
    env: childEnv(),
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  let resolvedPort: number | undefined;

  while (Date.now() < deadline) {
    if (requestedPort !== 0) {
      if (await waitForCdp(requestedPort, 500)) {
        resolvedPort = requestedPort;
        break;
      }
    } else {
      const fromFile = await readDevToolsPort();
      if (fromFile !== undefined && (await waitForCdp(fromFile, 500))) {
        resolvedPort = fromFile;
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
        details: { requestedPort, timeoutMs },
      },
    );
  }

  const cdpUrl = `http://127.0.0.1:${resolvedPort}`;
  return { port: resolvedPort, cdpUrl, restarted };
}
