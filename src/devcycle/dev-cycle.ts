/**
 * obsidian_dev_cycle — reload plugin, wait, screenshot, return logs since mark.
 */

import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { TelemetryCapture } from "../telemetry/capture.js";
import type { TelemetryStore } from "../telemetry/store.js";
import type { ToolImage, ToolOutcome } from "../tools/registry.js";
import { appendTelemetrySummary } from "../telemetry/helpers.js";
import {
  captureScreenshot,
  devCycleMarkerLabel,
  formatLogSection,
  logsSinceMark,
  openNotePath,
  reloadPlugin,
  settleMs,
  verdictText,
} from "./helpers.js";

export interface DevCycleInput {
  pluginId: string;
  openPath?: string;
  waitMs?: number;
  vault?: string;
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

  const slice = logsSinceMark(telemetry, mark.seq, input.pluginId);
  const pluginErrors = telemetry.query({
    since: mark.seq,
    plugin: input.pluginId,
    minLevel: "error",
    limit: 50,
  });
  const { verdict, text: verdictLine } = verdictText(input.pluginId, reloadOk, slice);
  const screenshot = await captureScreenshot(router);

  const lines = [
    verdictLine,
    "",
    `Marker: ${label} (cursor ${mark.seq})`,
    `Reload output: ${reloadStdout.trim() === "" ? "(ok)" : reloadStdout.trim()}`,
    "",
    "Logs since mark:",
    formatLogSection(slice),
  ];

  const images: ToolImage[] | undefined = screenshot !== undefined ? [screenshot] : undefined;

  let body = lines.join("\n");
  body = appendTelemetrySummary(body, telemetry, mark.seq);

  return {
    text: body,
    json: {
      verdict,
      pluginId: input.pluginId,
      mark: { label, cursor: mark.seq },
      reload: { ok: reloadOk, stdout: reloadStdout.trim() },
      logs: {
        errors: slice.errors,
        warnings: slice.warnings,
        pluginErrors: pluginErrors.records,
        records: slice.records,
      },
      screenshot: screenshot !== undefined,
    },
    ...(images !== undefined ? { images } : {}),
  };
}
