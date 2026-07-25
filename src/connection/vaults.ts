/**
 * Obsidian's vault registry and global settings, read straight from
 * `obsidian.json` in the userData directory.
 *
 * This file is also where the global `cli` toggle lives, which is why the doctor
 * and the CLI-enable tool both read it here rather than asking the app.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { obsidianConfigPath, userFlagsPath } from "../config.js";

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

interface RawVault {
  path?: string;
  ts?: number;
  open?: boolean;
}

export async function readGlobalConfig(
  path = obsidianConfigPath(),
): Promise<ObsidianGlobalConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const rawVaults = (parsed.vaults ?? {}) as Record<string, RawVault>;
  const vaults: VaultEntry[] = Object.entries(rawVaults).map(([id, entry]) => ({
    id,
    path: entry.path ?? "",
    name: entry.path ? basename(entry.path) : id,
    open: entry.open === true,
    ...(entry.ts !== undefined ? { ts: entry.ts } : {}),
  }));

  return {
    cli: parsed.cli === true,
    vaults,
    raw: parsed,
  };
}

/**
 * Set the global `cli` flag by editing `obsidian.json` directly.
 *
 * Only safe while Obsidian is not running — a live instance holds this config in
 * memory and rewrites the file on exit, silently discarding the edit. Callers
 * should prefer the renderer-side `ipcRenderer` bootstrap when the app is up.
 */
export async function writeCliFlag(enabled: boolean, path = obsidianConfigPath()): Promise<void> {
  const text = await readFile(path, "utf8");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (enabled) parsed.cli = true;
  else delete parsed.cli;
  await writeFile(path, JSON.stringify(parsed), "utf8");
}

/** Resolve a vault by name or id, matching names case-insensitively. */
export function findVault(config: ObsidianGlobalConfig, nameOrId: string): VaultEntry | undefined {
  const wanted = nameOrId.toLowerCase();
  return config.vaults.find((v) => v.id === nameOrId || v.name.toLowerCase() === wanted);
}

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
export async function checkUserFlags(path = userFlagsPath()): Promise<UserFlagsCheck> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { path, exists: false, corruptingTokens: [], tokens: [] };
  }

  const tokens = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .flatMap((line) => line.split(/\s+/))
    .filter((t) => t !== "");

  const corruptingTokens = tokens.filter((t) => t.startsWith("-") && !t.startsWith("--"));

  return { path, exists: true, corruptingTokens, tokens };
}
