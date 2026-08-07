/**
 * obsidian_dev_cycle — reload plugin, verify health, and return logs since mark.
 */

import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { TelemetryCapture } from "../telemetry/capture.js";
import type { TelemetryStore } from "../telemetry/store.js";
import type { ToolOutcome } from "../tools/registry.js";
import { appendTelemetrySummary } from "../telemetry/helpers.js";
import {
  captureScreenshot,
  devCycleMarkerLabel,
  formatLogSection,
  logsSinceMark,
  openNotePath,
  reloadPlugin,
  settleMs,
} from "./helpers.js";
import { inspectPluginHealth, type PluginHealthInfo } from "./plugin-health.js";

export type DevCycleScreenshotMode = "none" | "full";

export interface DevCycleInput {
  pluginId: string;
  openPath?: string;
  waitMs?: number;
  vault?: string;
  screenshot?: DevCycleScreenshotMode;
}

function healthProblem(info: PluginHealthInfo): string | undefined {
  if (!info.exists) return "the plugin is not installed";
  if (!info.enabled) return "the plugin is not enabled";
  if (!info.loaded) return "the plugin is not loaded";
  return undefined;
}

export async function runDevCycle(
  router: CapabilityRouter,
  config: Config,
  telemetry: TelemetryStore,
  capture: TelemetryCapture,
  input: DevCycleInput,
  toolArgs: Record<string, unknown>,
): Promise<ToolOutcome> {
  const waitMs = input.waitMs ?? 1500;
  const screenshotMode = input.screenshot ?? "none";
  const label = devCycleMarkerLabel(input.pluginId);
  const mark = telemetry.mark(label);

  await capture.tryArm();

  let reloadStdout = "";
  let reloadOk = false;
  try {
    reloadStdout = await reloadPlugin(router, config, input.pluginId, {
      ...toolArgs,
      ...(input.vault !== undefined ? { vault: input.vault } : {}),
    });
    reloadOk = true;
  } catch (e) {
    reloadStdout = e instanceof Error ? e.message : String(e);
  }

  if (input.openPath !== undefined && input.openPath !== "") {
    try {
      await openNotePath(router, config, input.openPath, toolArgs);
    } catch {
      // non-fatal for the cycle
    }
  }

  await settleMs(waitMs);

  let health: PluginHealthInfo | undefined;
  let healthError: string | undefined;
  if (reloadOk) {
    try {
      health = await inspectPluginHealth(router, input.pluginId, input.vault);
    } catch (error) {
      healthError = error instanceof Error ? error.message : String(error);
    }
  }

  const slice = logsSinceMark(telemetry, mark.seq, input.pluginId);
  const pluginErrors = telemetry.query({
    since: mark.seq,
    plugin: input.pluginId,
    minLevel: "error",
    limit: 50,
  });
  const problem = health === undefined ? undefined : healthProblem(health);
  const verdict =
    !reloadOk || health === undefined
      ? "unknown"
      : problem || slice.pluginErrors > 0
        ? "errors"
        : "clean";
  const verdictLine = !reloadOk
    ? `Could not confirm reload of ${input.pluginId}. Check CLI output.`
    : health === undefined
      ? `Reloaded ${input.pluginId}, but could not verify its live state.`
      : problem !== undefined
        ? `Reloaded ${input.pluginId}, but ${problem}.`
        : slice.pluginErrors > 0
          ? `Reloaded ${input.pluginId} with ${slice.pluginErrors} error(s) since mark.`
          : `Reloaded ${input.pluginId} cleanly and verified it is enabled and loaded.`;
  const screenshot =
    screenshotMode === "full"
      ? await captureScreenshot(router, config.outputDir, input.vault)
      : undefined;

  const lines = [
    verdictLine,
    "",
    `Marker: ${label} (cursor ${mark.seq})`,
    `Reload output: ${reloadStdout.trim() === "" ? "(ok)" : reloadStdout.trim()}`,
    `Health: ${
      health === undefined
        ? (healthError ?? "not checked")
        : `exists=${health.exists}, enabled=${health.enabled}, loaded=${health.loaded}`
    }`,
    "",
    "Logs since mark:",
    formatLogSection(slice),
  ];

  let body = lines.join("\n");
  body = appendTelemetrySummary(body, telemetry, mark.seq, input.pluginId);

  return {
    text: body,
    json: {
      verdict,
      pluginId: input.pluginId,
      mark: { label, cursor: mark.seq },
      reload: { ok: reloadOk, stdout: reloadStdout.trim() },
      health: health ?? null,
      healthError: healthError ?? null,
      logs: {
        errors: slice.errors,
        allErrors: slice.allErrors,
        warnings: slice.warnings,
        pluginErrorCount: slice.pluginErrors,
        unattributedErrorCount: slice.unattributedErrors,
        otherPluginErrorCount: slice.otherPluginErrors,
        pluginErrors: pluginErrors.records,
        records: slice.records,
      },
      screenshot: {
        mode: screenshotMode,
        captured: screenshot !== undefined,
        file: screenshot ?? null,
      },
    },
  };
}
