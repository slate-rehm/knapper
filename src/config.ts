/**
 * Configuration: CLI flags override env vars override defaults.
 *
 * Cursor plugin `variables` and Claude Code `userConfig` do not unify, so every
 * setting is readable from a plain environment variable and documented per host
 * rather than expressed in three manifest dialects.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { isLogLevel, type LogLevel } from "./util/logger.js";
import { parseToolsets, type Toolset } from "./toolsets.js";

export interface Config {
  /** CDP endpoint to attach to. */
  cdpUrl: string;
  /** Port parsed out of cdpUrl, used for launch and error messages. */
  cdpPort: number;
  /** Path to the Obsidian binary. */
  obsidianBin: string;
  /** Target vault name, or undefined to let Obsidian resolve it. */
  vault?: string;
  enabledToolsets: Set<Toolset>;
  unknownToolsets: string[];
  logLevel: LogLevel;
  telemetryBuffer: number;
  reconnectMs: number;
  /** Directory for screenshots and snapshot files. */
  outputDir: string;
  /** Timeout for a single Obsidian CLI invocation, in ms. */
  cliTimeoutMs: number;
}

export interface ConfigOverrides {
  cdpUrl?: string;
  obsidianBin?: string;
  vault?: string;
  toolsets?: string;
  logLevel?: string;
  telemetryBuffer?: number;
  reconnectMs?: number;
  outputDir?: string;
  cliTimeoutMs?: number;
}

export const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

/**
 * Obsidian's own userData directory, which holds the vault registry and the global
 * `cli` toggle. Honors the same platform conventions Electron uses.
 */
export function obsidianUserDataDir(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "obsidian");
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "obsidian");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "obsidian");
  }
}

/** Path to `obsidian.json`, which contains the vault registry and the `cli` flag. */
export function obsidianConfigPath(): string {
  return join(obsidianUserDataDir(), "obsidian.json");
}

/**
 * Path to the Linux launch-flags file read by distro wrapper scripts. Single-dash
 * tokens here corrupt every CLI invocation, so the doctor checks it.
 */
export function userFlagsPath(): string {
  return join(obsidianUserDataDir(), "user-flags.conf");
}

export function defaultObsidianBin(): string {
  switch (process.platform) {
    case "darwin":
      return "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
    case "win32":
      return join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "Obsidian",
        "Obsidian.exe",
      );
    default:
      return "obsidian";
  }
}

function parsePort(url: string): number {
  try {
    const parsed = new URL(url);
    if (parsed.port !== "") return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return 9222;
  }
}

function numberFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadConfig(overrides: ConfigOverrides = {}, env = process.env): Config {
  const cdpUrl = overrides.cdpUrl ?? env.OBSIDIAN_CDP_URL ?? DEFAULT_CDP_URL;

  const rawLogLevel = overrides.logLevel ?? env.UOB_LOG_LEVEL ?? "info";
  const logLevel: LogLevel = isLogLevel(rawLogLevel) ? rawLogLevel : "info";

  const { enabled, unknown } = parseToolsets(overrides.toolsets ?? env.UOB_TOOLSETS);

  const vault = overrides.vault ?? env.OBSIDIAN_VAULT;

  return {
    cdpUrl,
    cdpPort: parsePort(cdpUrl),
    obsidianBin: overrides.obsidianBin ?? env.OBSIDIAN_BIN ?? defaultObsidianBin(),
    ...(vault !== undefined && vault !== "" ? { vault } : {}),
    enabledToolsets: enabled,
    unknownToolsets: unknown,
    logLevel,
    telemetryBuffer: overrides.telemetryBuffer ?? numberFrom(env.UOB_TELEMETRY_BUFFER, 2000),
    reconnectMs: overrides.reconnectMs ?? numberFrom(env.UOB_RECONNECT_MS, 2000),
    outputDir:
      overrides.outputDir ?? env.UOB_SCREENSHOT_DIR ?? join(process.cwd(), ".unified-obsidian-mcp"),
    cliTimeoutMs: overrides.cliTimeoutMs ?? numberFrom(env.UOB_CLI_TIMEOUT_MS, 15_000),
  };
}
