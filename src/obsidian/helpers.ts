/**
 * Shared helpers for Obsidian CLI-backed tools.
 */

import type { CapabilityRouter } from "../connection/router.js";
import type { Config } from "../config.js";
import { parseCliJson, renderResult } from "../util/serialize.js";
import type { ToolOutcome } from "../tools/registry.js";

/** Shown on tools that may open a closed vault in a new window. */
/**
 * Appended to ~60 tool descriptions, so it has to stay short.
 *
 * The long form ran to 27 words and repeated on every vault-scoped tool including
 * pure readers, which buried the half of each description that actually
 * distinguishes one tool from another — the opposite of what helps tool selection.
 */
export const CLOSED_VAULT_WARNING =
  "Opens the vault in a new window if it is registered but closed.";

export function vaultName(args: Record<string, unknown>, config: Config): string | undefined {
  const v = args.vault as string | undefined;
  if (v !== undefined && v !== "") return v;
  return config.vault;
}

export function pushFlag(args: string[], name: string, enabled?: boolean): void {
  if (enabled === true) args.push(name);
}

export function pushKv(args: string[], key: string, value?: string | number | boolean): void {
  if (value === undefined) return;
  if (typeof value === "boolean") {
    if (value) args.push(key);
    return;
  }
  args.push(`${key}=${String(value)}`);
}

export function pushFileTarget(args: string[], file?: string, path?: string): void {
  pushKv(args, "file", file);
  pushKv(args, "path", path);
}

export interface CliRunOptions {
  vault?: string;
  json?: boolean;
  command: string;
  args?: string[];
}

export async function runCli(
  router: CapabilityRouter,
  opts: CliRunOptions,
): Promise<{ stdout: string; parsed?: unknown }> {
  const tokens = [opts.command, ...(opts.args ?? [])];
  if (opts.json === true && !tokens.some((t) => t.startsWith("format="))) {
    tokens.push("format=json");
  }
  const stdout = await router.cliCommand(
    tokens,
    opts.vault !== undefined ? { vault: opts.vault } : {},
  );
  const parsed = opts.json === true ? parseCliJson(stdout) : parseCliJson(stdout);
  return { stdout, ...(parsed !== undefined ? { parsed } : {}) };
}

export function cliOutcome(
  stdout: string,
  parsed?: unknown,
  emptyMessage = "(no output)",
): ToolOutcome {
  const rendered = renderResult(stdout);
  const text = rendered.text === "" ? emptyMessage : rendered.text;
  if (parsed !== undefined) {
    return { text, json: { data: parsed, truncated: rendered.truncated } };
  }
  const auto = parseCliJson(stdout);
  if (auto !== undefined) {
    return { text, json: { data: auto, truncated: rendered.truncated } };
  }
  return { text, json: { raw: rendered.text, truncated: rendered.truncated } };
}

export function contentOutcome(content: string, label = "OK"): ToolOutcome {
  const trimmed = content.trim();
  return {
    text: trimmed === "" ? label : trimmed,
    json: { ok: true },
  };
}

export async function evalJson<T>(
  router: CapabilityRouter,
  code: string,
  vault?: string,
): Promise<T> {
  const { value } = await router.evaluateJson<T>(code, vault !== undefined ? { vault } : {});
  return value;
}

export function escEvalString(s: string): string {
  return JSON.stringify(s);
}

export async function readPluginData(
  router: CapabilityRouter,
  pluginId: string,
  vault?: string,
): Promise<{ persisted: unknown; runtime: unknown }> {
  const code = `(async () => {
    const p = app.plugins.getPlugin(${escEvalString(pluginId)});
    if (!p) throw new Error("Plugin not loaded");
    const persisted = await p.loadData();
    const runtime = "settings" in p ? p.settings : null;
    return { persisted: persisted ?? null, runtime: runtime ?? null };
  })()`;
  return evalJson(router, code, vault);
}

export async function writePluginData(
  router: CapabilityRouter,
  pluginId: string,
  data: unknown,
  vault?: string,
): Promise<void> {
  const serialized = JSON.stringify(data);
  const code = `(() => { const p = app.plugins.getPlugin(${escEvalString(pluginId)}); if (!p) throw new Error("Plugin not loaded"); p.saveData(${serialized}); return true; })()`;
  await router.evaluate(code, vault !== undefined ? { vault } : {});
}
