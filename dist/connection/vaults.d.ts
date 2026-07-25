/**
 * Obsidian's vault registry and global settings, read straight from
 * `obsidian.json` in the userData directory.
 *
 * This file is also where the global `cli` toggle lives, which is why the doctor
 * and the CLI-enable tool both read it here rather than asking the app.
 */
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
export declare function readGlobalConfig(path?: string): Promise<ObsidianGlobalConfig | undefined>;
/**
 * Set the global `cli` flag by editing `obsidian.json` directly.
 *
 * Only safe while Obsidian is not running — a live instance holds this config in
 * memory and rewrites the file on exit, silently discarding the edit. Callers
 * should prefer the renderer-side `ipcRenderer` bootstrap when the app is up.
 */
export declare function writeCliFlag(enabled: boolean, path?: string): Promise<void>;
/** Resolve a vault by name or id, matching names case-insensitively. */
export declare function findVault(
  config: ObsidianGlobalConfig,
  nameOrId: string,
): VaultEntry | undefined;
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
export declare function checkUserFlags(path?: string): Promise<UserFlagsCheck>;
