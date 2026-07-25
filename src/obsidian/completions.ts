/**
 * Live inventory of Obsidian CLI commands from the hidden `__completions` command.
 * Cached in-process because the set reflects enabled core plugins and dev plugin handlers.
 */

import type { CapabilityRouter } from "../connection/router.js";
import { parseCliJson } from "../util/serialize.js";

export interface CompletionFlag {
  value?: string;
  description?: string;
  required?: boolean;
}

export interface CompletionEntry {
  usage: string;
  description: string;
  flags: Record<string, CompletionFlag>;
}

export type CompletionMap = Record<string, CompletionEntry>;

let cache: CompletionMap | undefined;
let cacheAt = 0;
const CACHE_TTL_MS = 60_000;

export function clearCompletionsCache(): void {
  cache = undefined;
  cacheAt = 0;
}

export async function getCompletions(
  router: CapabilityRouter,
  opts: { force?: boolean } = {},
): Promise<CompletionMap> {
  const age = Date.now() - cacheAt;
  if (!opts.force && cache !== undefined && age < CACHE_TTL_MS) {
    return cache;
  }

  const stdout = await router.cliCommand(["__completions"]);
  const parsed = parseCliJson<CompletionMap>(stdout);
  if (parsed === undefined || typeof parsed !== "object") {
    throw new Error("Could not parse __completions output as JSON.");
  }
  cache = parsed;
  cacheAt = Date.now();
  return parsed;
}

/** Fuzzy file search via `__files`. */
export async function cliFileSearch(
  router: CapabilityRouter,
  query: string,
  limit: number,
  vault?: string,
): Promise<string[]> {
  const tokens = ["__files", `query=${query}`, `limit=${String(limit)}`];
  const stdout = await router.cliCommand(tokens, vault !== undefined ? { vault } : {});
  const parsed = parseCliJson<string[]>(stdout);
  if (Array.isArray(parsed)) return parsed;
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  try {
    const again = JSON.parse(trimmed) as unknown;
    return Array.isArray(again) ? (again as string[]) : [];
  } catch {
    return trimmed
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  }
}

/** Command-palette ids via `__commands` (or `commands` when exposed). */
export async function cliCommandIds(
  router: CapabilityRouter,
  filter?: string,
  vault?: string,
): Promise<string[]> {
  const tokens = ["__commands"];
  if (filter !== undefined && filter !== "") tokens.push(`filter=${filter}`);
  let stdout: string;
  try {
    stdout = await router.cliCommand(tokens, vault !== undefined ? { vault } : {});
  } catch {
    const fallback = ["commands"];
    if (filter !== undefined && filter !== "") fallback.push(`filter=${filter}`);
    stdout = await router.cliCommand(fallback, vault !== undefined ? { vault } : {});
  }
  const parsed = parseCliJson<string[]>(stdout);
  if (Array.isArray(parsed)) return parsed;
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}
