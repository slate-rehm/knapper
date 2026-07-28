/**
 * obsidian_exercise_command — run a palette command and report state delta + logs.
 */

import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { TelemetryStore } from "../telemetry/store.js";
import type { ToolOutcome } from "../tools/registry.js";
import { escEvalString, vaultName } from "../obsidian/helpers.js";
import { rendererEval } from "./eval.js";
import { appendTelemetrySummary } from "../telemetry/helpers.js";
import { formatLogSection, logsSinceMark, settleMs } from "./helpers.js";
import {
  emptySnapshot,
  formatWorkspaceDelta,
  workspaceDelta,
  workspaceSnapshot,
} from "./workspace-delta.js";

export async function runExerciseCommand(
  router: CapabilityRouter,
  config: Config,
  telemetry: TelemetryStore,
  commandId: string,
  waitMs: number,
  toolArgs: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const vault = vaultName(toolArgs, config);
  const mark = telemetry.mark(`exercise:${commandId}:${Date.now()}`);
  const before = (await workspaceSnapshot(router, vault)) ?? emptySnapshot();

  // `=== true` normalizes the result across both transports, since the CLI path
  // round-trips through JSON and would otherwise blur false into undefined.
  const runCode = `return app.commands.executeCommandById(${escEvalString(commandId)}) === true`;
  let executed = false;
  let execError: string | undefined;
  try {
    const dispatched = await rendererEval<boolean>(router, runCode, vault);
    // executeCommandById returns false for an id Obsidian does not know, and for a
    // command whose availability check declines. Discarding that return value made
    // this tool report "Executed command fake:nope." — a green result for a command
    // that never ran, which is precisely what it exists to detect.
    if (dispatched === false) {
      execError =
        `Obsidian did not run "${commandId}": executeCommandById returned false. ` +
        "Either no command has that id, or its checkCallback declined in the current context. " +
        "List real ids with obsidian_plugin_commands or obsidian_commands.";
    } else {
      executed = true;
    }
  } catch (e) {
    execError = e instanceof Error ? e.message : String(e);
  }

  await settleMs(waitMs);
  const after = (await workspaceSnapshot(router, vault)) ?? emptySnapshot();
  const slice = logsSinceMark(telemetry, mark.seq);

  const delta = workspaceDelta(before, after);

  const lines = [
    executed
      ? `Executed command ${commandId}.`
      : `Failed to execute ${commandId}: ${execError ?? "unknown error"}`,
    "",
    ...formatWorkspaceDelta(delta),
    "",
    "Logs since mark:",
    formatLogSection(slice),
  ];

  return {
    text: appendTelemetrySummary(lines.join("\n"), telemetry, mark.seq),
    json: {
      commandId,
      executed,
      execError: execError ?? null,
      mark: { cursor: mark.seq },
      delta,
      logs: { errors: slice.errors, warnings: slice.warnings, records: slice.records },
    },
  };
}
