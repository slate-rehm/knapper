/**
 * Dev-cycle primitives shared by plugin-dev tools.
 */

import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { TelemetryStore } from "../telemetry/store.js";
import { formatRecords } from "../telemetry/store.js";
import { vaultName } from "../obsidian/helpers.js";

export function devCycleMarkerLabel(pluginId: string): string {
  return `dev-cycle:${pluginId}:${Date.now()}`;
}

export async function settleMs(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

export async function reloadPlugin(
  router: CapabilityRouter,
  config: Config,
  pluginId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const vault = vaultName(args, config);
  return router.cliCommand(
    ["plugin:reload", `id=${pluginId}`],
    vault !== undefined ? { vault } : {},
  );
}

export async function pluginCli(
  router: CapabilityRouter,
  config: Config,
  command: string,
  pluginId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const vault = vaultName(args, config);
  return router.cliCommand([command, `id=${pluginId}`], vault !== undefined ? { vault } : {});
}

export async function openNotePath(
  router: CapabilityRouter,
  config: Config,
  path: string,
  args: Record<string, unknown>,
): Promise<void> {
  const vault = vaultName(args, config);
  await router.cliCommand(["note:open", `path=${path}`], vault !== undefined ? { vault } : {});
}

export async function captureScreenshot(
  router: CapabilityRouter,
): Promise<{ data: string; mimeType: string } | undefined> {
  const availability = await router.refreshAvailability();
  if (!availability.playwright) return undefined;
  try {
    const page = await router.playwright.page();
    const buffer = await page.screenshot({ type: "png" });
    return { data: buffer.toString("base64"), mimeType: "image/png" };
  } catch {
    return undefined;
  }
}

export interface PluginLogSlice {
  records: ReturnType<TelemetryStore["query"]>["records"];
  errors: number;
  warnings: number;
}

export function logsSinceMark(
  store: TelemetryStore,
  markSeq: number,
  pluginId?: string,
): PluginLogSlice {
  const result = store.query({
    since: markSeq,
    ...(pluginId !== undefined ? { plugin: pluginId } : {}),
    limit: 200,
  });
  const all = store.query({ since: markSeq, limit: 500 });
  let errors = 0;
  let warnings = 0;
  for (const r of all.records) {
    if (r.source === "marker") continue;
    if (r.level === "error") errors++;
    else if (r.level === "warn") warnings++;
  }
  return { records: result.records, errors, warnings };
}

export function verdictText(
  pluginId: string,
  reloaded: boolean,
  slice: PluginLogSlice,
): { verdict: "clean" | "errors" | "unknown"; text: string } {
  if (!reloaded) {
    return {
      verdict: "unknown",
      text: `Could not confirm reload of ${pluginId}. Check CLI output.`,
    };
  }
  if (slice.errors > 0) {
    return {
      verdict: "errors",
      text: `Reloaded ${pluginId} with ${slice.errors} error(s) since mark.`,
    };
  }
  return {
    verdict: "clean",
    text: `Reloaded ${pluginId} cleanly (no errors since mark).`,
  };
}

export function formatLogSection(slice: PluginLogSlice): string {
  if (slice.records.length === 0) return "(no log records since mark)";
  return formatRecords(slice.records);
}
