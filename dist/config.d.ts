/**
 * Configuration: CLI flags override env vars override defaults.
 *
 * Cursor plugin `variables` and Claude Code `userConfig` do not unify, so every
 * setting is readable from a plain environment variable and documented per host
 * rather than expressed in three manifest dialects.
 */
import { type LogLevel } from "./util/logger.js";
import { type Toolset } from "./toolsets.js";
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
export declare const DEFAULT_CDP_URL = "http://127.0.0.1:9222";
/**
 * Obsidian's own userData directory, which holds the vault registry and the global
 * `cli` toggle. Honors the same platform conventions Electron uses.
 */
export declare function obsidianUserDataDir(): string;
/** Path to `obsidian.json`, which contains the vault registry and the `cli` flag. */
export declare function obsidianConfigPath(): string;
/**
 * Path to the Linux launch-flags file read by distro wrapper scripts. Single-dash
 * tokens here corrupt every CLI invocation, so the doctor checks it.
 */
export declare function userFlagsPath(): string;
export declare function defaultObsidianBin(): string;
export declare function loadConfig(overrides?: ConfigOverrides, env?: NodeJS.ProcessEnv): Config;
