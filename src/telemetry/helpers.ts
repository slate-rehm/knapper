/**
 * Shared telemetry tool helpers.
 */

import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { TelemetryCapture } from "./capture.js";
import type { QueryOptions, QueryResult, TelemetryStore } from "./store.js";
import { formatRecords } from "./store.js";
import { cdpPortClosed } from "../util/errors.js";

export const CDP_REMEDIATION =
  "Telemetry needs Obsidian cold-started with `--remote-debugging-port`. The single-instance " +
  "lock means adding the flag to a running instance silently does nothing — fully quit Obsidian " +
  "first, then relaunch with the debug port.";

export async function ensureCaptureArmed(
  router: CapabilityRouter,
  capture: TelemetryCapture,
): Promise<{ armed: boolean; pages: number }> {
  const availability = await router.refreshAvailability();
  if (!availability.playwright) {
    return { armed: false, pages: 0 };
  }
  return capture.arm();
}

export function cdpUnavailableOutcome(config: Config): never {
  throw cdpPortClosed(config.cdpUrl);
}

export function runLogQuery(
  store: TelemetryStore,
  opts: QueryOptions & { sinceMarker?: string },
): QueryResult {
  if (opts.sinceMarker !== undefined && opts.sinceMarker !== "") {
    const { sinceMarker, ...rest } = opts;
    return store.sinceMarker(sinceMarker, rest);
  }
  return store.query(opts);
}

export function logsOutcome(
  result: QueryResult,
  extra: { armed: boolean; telemetryNote?: string } = { armed: true },
): { text: string; json: Record<string, unknown> } {
  const lines = [
    formatRecords(result.records),
    "",
    `Records: ${result.records.length} returned, ${result.matched} matched. Cursor: ${result.cursor}. Dropped: ${result.dropped}.`,
  ];
  if (extra.telemetryNote) lines.push("", extra.telemetryNote);
  return {
    text: lines.join("\n"),
    json: {
      records: result.records,
      returned: result.records.length,
      cursor: result.cursor,
      matched: result.matched,
      dropped: result.dropped,
      armed: extra.armed,
    },
  };
}

/** Compact suffix for mutating tools so agents see fresh console noise. */
export function appendTelemetrySummary(
  text: string,
  store: TelemetryStore,
  sinceSeq?: number,
  plugin?: string,
): string {
  const s = store.summary(sinceSeq, plugin);
  if (s.total === 0) return text;
  const parts = [
    `${s.errors} error(s), ${s.warnings} warning(s) since this action (${s.total} log line(s)).`,
  ];
  if (s.errors > 0) {
    const errs = store.query({
      since: sinceSeq,
      minLevel: "error",
      ...(plugin !== undefined ? { plugin } : {}),
      limit: 5,
    });
    if (errs.records.length > 0) {
      parts.push("", "Recent errors:", formatRecords(errs.records));
    }
  }
  return `${text}\n\n${parts.join("\n")}`;
}
