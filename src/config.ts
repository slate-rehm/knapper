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

/** Transport the MCP server listens on. */
export type TransportKind = "stdio" | "http";

export const TRANSPORT_KINDS = ["stdio", "http"] as const;

export function isTransportKind(value: string): value is TransportKind {
  return (TRANSPORT_KINDS as readonly string[]).includes(value);
}

export interface Config {
  /** CDP endpoint to attach to. */
  cdpUrl: string;
  /** Port parsed out of cdpUrl, used for launch and error messages. */
  cdpPort: number;
  /** Path to the Obsidian binary. */
  obsidianBin: string;
  /** Target vault name, or undefined to let Obsidian resolve it. */
  vault?: string;
  /**
   * Substring matched against a window's title or URL when choosing a CDP target.
   * Narrows selection when several Obsidian windows are attached; `vault` still
   * wins because it is confirmed against the renderer rather than the title.
   */
  targetMatch?: string;
  /** Which MCP transport to serve. */
  transport: TransportKind;
  /** Listen port for the http transport. */
  httpPort: number;
  /** Listen host for the http transport. Non-loopback values are warned about. */
  httpHost: string;
  /**
   * How many tool calls may run at once. UI mutations are serialized regardless;
   * this caps the read-only calls that are safe to overlap.
   */
  maxConcurrency: number;
  enabledToolsets: Set<Toolset>;
  unknownToolsets: string[];
  logLevel: LogLevel;
  telemetryBuffer: number;
  /**
   * Capture failed network requests alongside console output. Off by default: the
   * two share one ring buffer, and Obsidian's renderer is chatty enough that
   * network events crowd out the plugin errors most sessions are actually after.
   */
  telemetryNetwork: boolean;
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
  targetMatch?: string;
  transport?: string;
  httpPort?: number;
  httpHost?: string;
  maxConcurrency?: number;
  toolsets?: string;
  logLevel?: string;
  telemetryBuffer?: number;
  telemetryNetwork?: boolean;
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

/** Accept the shapes people actually type in an MCP client's env block. */
function boolFrom(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

export function loadConfig(overrides: ConfigOverrides = {}, env = process.env): Config {
  const cdpUrl = overrides.cdpUrl ?? env.OBSIDIAN_CDP_URL ?? DEFAULT_CDP_URL;

  const rawLogLevel = overrides.logLevel ?? env.KNAP_LOG_LEVEL ?? env.LOG_LEVEL ?? "info";
  const logLevel: LogLevel = isLogLevel(rawLogLevel) ? rawLogLevel : "info";

  const { enabled, unknown } = parseToolsets(overrides.toolsets ?? env.KNAP_TOOLSETS);

  const vault = overrides.vault ?? env.OBSIDIAN_VAULT;
  const targetMatch = overrides.targetMatch ?? env.OBSIDIAN_TARGET_MATCH;

  const rawTransport = overrides.transport ?? env.MCP_TRANSPORT ?? "stdio";
  const transport: TransportKind = isTransportKind(rawTransport) ? rawTransport : "stdio";

  return {
    cdpUrl,
    cdpPort: parsePort(cdpUrl),
    obsidianBin: overrides.obsidianBin ?? env.OBSIDIAN_BIN ?? defaultObsidianBin(),
    ...(vault !== undefined && vault !== "" ? { vault } : {}),
    ...(targetMatch !== undefined && targetMatch !== "" ? { targetMatch } : {}),
    transport,
    httpPort: overrides.httpPort ?? numberFrom(env.MCP_PORT, 9223),
    httpHost: overrides.httpHost ?? env.MCP_HOST ?? "127.0.0.1",
    maxConcurrency: Math.max(
      1,
      overrides.maxConcurrency ?? numberFrom(env.KNAP_MAX_CONCURRENCY, 4),
    ),
    enabledToolsets: enabled,
    unknownToolsets: unknown,
    logLevel,
    telemetryBuffer: overrides.telemetryBuffer ?? numberFrom(env.KNAP_TELEMETRY_BUFFER, 2000),
    telemetryNetwork: overrides.telemetryNetwork ?? boolFrom(env.KNAP_TELEMETRY_NETWORK, false),
    reconnectMs:
      overrides.reconnectMs ?? numberFrom(env.KNAP_RECONNECT_MS ?? env.RECONNECT_MS, 2000),
    outputDir:
      overrides.outputDir ??
      env.KNAP_SCREENSHOT_DIR ??
      env.SCREENSHOT_DIR ??
      join(process.cwd(), ".knapper"),
    cliTimeoutMs: overrides.cliTimeoutMs ?? numberFrom(env.KNAP_CLI_TIMEOUT_MS, 15_000),
  };
}
