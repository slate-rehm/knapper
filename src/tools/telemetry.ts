/**
 * Telemetry tools: cursor-based log tailing, markers, and capture status.
 */

import { z } from "zod";
import type { ServerContext } from "../server.js";
import type { LogLevel, RecordSource } from "../telemetry/store.js";
import {
  appendTelemetrySummary,
  CDP_REMEDIATION,
  ensureCaptureArmed,
  logsOutcome,
  runLogQuery,
} from "../telemetry/helpers.js";
import { UobError } from "../util/errors.js";

const logLevelSchema = z.enum(["debug", "info", "log", "warn", "error"]);
const sourceSchema = z.enum(["console", "pageerror", "exception", "network", "marker"]);

export function registerTelemetryTools(ctx: ServerContext): void {
  const { registry, router, telemetry, capture } = ctx;

  registry.add({
    name: "obsidian_logs",
    toolset: "telemetry",
    capability: "eventStream",
    description:
      "Tail Obsidian renderer console output, page errors, and (when enabled) failed network " +
      "requests. Returns a monotonic `cursor`; pass it as `since` on the next call to read only " +
      "what happened after your last read — the reliable way to see what an action caused without " +
      "diffing blobs. Arms live capture on first use (requires CDP). Prefer this over CLI " +
      "`dev:console`. Side effects: subscribes to console events on attached windows (cheap).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      since: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Cursor from a previous response; return only records with seq > since"),
      sinceMarker: z
        .string()
        .optional()
        .describe(
          "Return records after the most recent marker with this label (from obsidian_log_mark)",
        ),
      level: logLevelSchema.optional().describe("Exact log level filter"),
      minLevel: logLevelSchema.optional().describe("Minimum severity (e.g. warn → warn and error)"),
      plugin: z.string().optional().describe("Only records attributed to this plugin id"),
      pattern: z
        .string()
        .optional()
        .describe("Case-insensitive regex applied to message text and stack"),
      source: sourceSchema.optional().describe("Record source filter"),
      withinMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Only records newer than this many milliseconds"),
      limit: z
        .number()
        .int()
        .positive()
        .max(500)
        .optional()
        .describe("Max records to return (default 100, keeps most recent)"),
    },
    handler: async (args) => {
      const availability = await router.refreshAvailability();
      let armed = false;
      let pages = 0;
      if (availability.playwright) {
        ({ armed, pages } = await ensureCaptureArmed(router, capture));
      }

      const result = runLogQuery(telemetry, {
        since: args.since as number | undefined,
        sinceMarker: args.sinceMarker as string | undefined,
        level: args.level as LogLevel | undefined,
        minLevel: args.minLevel as LogLevel | undefined,
        plugin: args.plugin as string | undefined,
        pattern: args.pattern as string | undefined,
        source: args.source as RecordSource | undefined,
        withinMs: args.withinMs as number | undefined,
        limit: args.limit as number | undefined,
      });

      const note = !availability.playwright
        ? `Telemetry unavailable: ${CDP_REMEDIATION} Fix with obsidian_launch.`
        : !armed
          ? "Capture could not attach to any Obsidian window."
          : undefined;

      const out = logsOutcome(result, { armed, ...(note ? { telemetryNote: note } : {}) });
      return {
        ...out,
        json: { ...out.json, pagesSubscribed: pages, cdpAvailable: availability.playwright },
      };
    },
  });

  registry.add({
    name: "obsidian_log_mark",
    toolset: "telemetry",
    capability: "eventStream",
    description:
      "Insert a named marker into the telemetry buffer so you can bracket a dev action. Pair with " +
      "obsidian_logs `sinceMarker` (or note the returned cursor) to read only logs after the mark. " +
      "Arms capture if needed. No effect on Obsidian itself.",
    inputSchema: {
      label: z.string().min(1).describe("Marker label (e.g. dev-cycle-1)"),
    },
    handler: async (args) => {
      const label = args.label as string;
      const availability = await router.refreshAvailability();
      if (availability.playwright) {
        await ensureCaptureArmed(router, capture);
      }
      const record = telemetry.mark(label);
      const text = appendTelemetrySummary(
        `Marked telemetry at cursor ${record.seq}: ${label}`,
        telemetry,
      );
      return {
        text,
        json: { label, cursor: record.seq, seq: record.seq },
      };
    },
  });

  registry.add({
    name: "obsidian_logs_clear",
    toolset: "telemetry",
    description:
      "Clear retained telemetry records while preserving the monotonic cursor. Also clears the " +
      "optional durable record file. Does not clear Obsidian's own devtools console.",
    annotations: { destructiveHint: true },
    inputSchema: {},
    handler: async () => {
      const before = telemetry.cursor;
      const clearedRecords = telemetry.size;
      telemetry.clear();
      const text = appendTelemetrySummary(
        `Cleared telemetry buffer (was at cursor ${before}).`,
        telemetry,
      );
      return {
        text,
        json: {
          cleared: true,
          clearedRecords,
          records: [],
          previousCursor: before,
          cursor: telemetry.cursor,
        },
      };
    },
  });

  registry.add({
    name: "obsidian_telemetry_status",
    toolset: "telemetry",
    description:
      "Report whether live telemetry capture is armed, how many records are buffered, how many were " +
      "dropped by the ring buffer, whether network capture is on, and how many authorized pages are " +
      "subscribed. The response omits window titles and vault names.",
    annotations: { readOnlyHint: true },
    inputSchema: {},
    handler: async () => {
      const availability = await router.refreshAvailability();
      let pagesSubscribed = 0;
      let armed = capture.isArmed;

      if (availability.playwright) {
        try {
          const armResult = await capture.arm();
          armed = armResult.armed;
          pagesSubscribed = armResult.pages;
        } catch (e) {
          if (e instanceof UobError && e.code === "CDP_PORT_CLOSED") {
            armed = false;
          } else {
            throw e;
          }
        }
      }

      const counts = telemetry.recordCounts();
      const persistence = telemetry.persistenceSummary();
      const subscriptions = Array.from({ length: pagesSubscribed }, () => ({ authorized: true }));

      const lines = [
        `CDP available: ${availability.playwright ? "yes" : "no"}`,
        `Capture armed: ${armed ? "yes" : "no"}`,
        `Buffered records: ${telemetry.size}`,
        `Dropped (evicted): ${telemetry.dropped}`,
        `Current cursor: ${telemetry.cursor}`,
        `Network capture: ${capture.isNetworkEnabled ? "on" : "off"}`,
        `Authorized pages subscribed: ${pagesSubscribed}`,
        `Durable persistence: ${persistence.enabled ? "on" : "off"}`,
      ];

      if (!availability.playwright) {
        lines.push("", CDP_REMEDIATION, "Fix with obsidian_launch.");
      }

      return {
        text: lines.join("\n"),
        json: {
          cdpAvailable: availability.playwright,
          armed,
          networkCapture: capture.isNetworkEnabled,
          pagesSubscribed,
          subscriptions,
          buffered: telemetry.size,
          dropped: telemetry.dropped,
          cursor: telemetry.cursor,
          counts,
          persistence,
        },
      };
    },
  });
}
