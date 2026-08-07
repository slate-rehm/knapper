/**
 * Dev-cycle primitives shared by plugin-dev tools.
 */

import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { TelemetryStore } from "../telemetry/store.js";
import { formatRecords } from "../telemetry/store.js";
import { vaultName } from "../obsidian/helpers.js";
import { saveArtifact, type ArtifactFile } from "../util/artifacts.js";

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
  outputDir: string,
  vault?: string,
): Promise<ArtifactFile | undefined> {
  const availability = await router.refreshAvailability();
  if (!availability.playwright) return undefined;
  try {
    const page = await router.playwright.page(vault);
    const buffer = await page.screenshot({ type: "png" });
    return saveArtifact(
      outputDir,
      undefined,
      `obsidian-dev-cycle-${Date.now()}.png`,
      buffer,
      "image/png",
    );
  } catch {
    return undefined;
  }
}

export interface PluginLogSlice {
  records: ReturnType<TelemetryStore["query"]>["records"];
  /** Errors attributed to the selected plugin, or all errors without a plugin filter. */
  errors: number;
  allErrors: number;
  warnings: number;
  pluginErrors: number;
  unattributedErrors: number;
  otherPluginErrors: number;
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
  const allErrors = store.query({
    since: markSeq,
    level: "error",
    limit: Number.MAX_SAFE_INTEGER,
  });
  const pluginErrors =
    pluginId === undefined
      ? allErrors.matched
      : allErrors.records.filter((record) => record.plugin === pluginId).length;
  const unattributedErrors = allErrors.records.filter(
    (record) => record.plugin === undefined,
  ).length;
  const otherPluginErrors = Math.max(0, allErrors.matched - pluginErrors - unattributedErrors);
  const warnings = store.query({
    since: markSeq,
    ...(pluginId !== undefined ? { plugin: pluginId } : {}),
    level: "warn",
    limit: 1,
  }).matched;
  return {
    records: result.records,
    errors: pluginErrors,
    allErrors: allErrors.matched,
    warnings,
    pluginErrors,
    unattributedErrors,
    otherPluginErrors,
  };
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
