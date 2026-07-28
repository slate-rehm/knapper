/**
 * obsidian_exercise_hotkey — press a real chord and report whether it did anything.
 *
 * The contract is a verdict, not a dispatch. `browser_press_key` answers "did the
 * call succeed", which is nearly always yes: synthetic keys are delivered whether
 * or not anything is listening. What a plugin author needs to know is whether the
 * *binding* fired, so this samples the workspace on both sides and says so.
 *
 * Two things make an Obsidian hotkey fail to fire that are worth distinguishing
 * from "the binding is wrong", because both look identical from the outside:
 *
 *  - Page focus. Renderer-level handlers are gated on the document believing it has
 *    focus, so this runs inside `FocusEmulator` and works with Obsidian in the
 *    background. See `src/browser/focus.ts`.
 *  - Element focus. Emulation makes the *page* focused; it does not choose an
 *    `activeElement`. A chord bound to the editor still needs the editor focused,
 *    which is what `focus` is for.
 *
 * What it cannot reach: Electron menu accelerators (the app-level Cmd+Q / Cmd+W
 * class) never enter the renderer, so no CDP input triggers them, foreground or
 * not. Those are unreachable by design rather than by omission.
 */

import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { TelemetryStore } from "../telemetry/store.js";
import type { ToolOutcome } from "../tools/registry.js";
import { vaultName } from "../obsidian/helpers.js";
import { appendTelemetrySummary } from "../telemetry/helpers.js";
import { formatLogSection, logsSinceMark, settleMs } from "./helpers.js";
import {
  deltaChanged,
  emptySnapshot,
  formatWorkspaceDelta,
  workspaceDelta,
  workspaceSnapshot,
} from "./workspace-delta.js";

export interface ExerciseHotkeyInput {
  keys: string;
  focus?: string;
  waitMs?: number;
}

export async function runExerciseHotkey(
  router: CapabilityRouter,
  config: Config,
  telemetry: TelemetryStore,
  input: ExerciseHotkeyInput,
  toolArgs: Record<string, unknown>,
): Promise<ToolOutcome> {
  const vault = vaultName(toolArgs, config);
  const waitMs = input.waitMs ?? 600;
  const mark = telemetry.mark(`hotkey:${input.keys}:${Date.now()}`);

  const page = await router.playwright.page(vault);
  const before = (await workspaceSnapshot(router, vault)) ?? emptySnapshot();

  let focused: string | undefined;
  let dispatchError: string | undefined;

  await router.focus.run(page, async () => {
    if (input.focus !== undefined && input.focus !== "") {
      try {
        await page.locator(input.focus).first().focus({ timeout: 2000 });
        focused = input.focus;
      } catch (e) {
        // Non-fatal: report it and still press. A chord bound globally does not
        // need the selector, and failing here would hide that.
        dispatchError = `could not focus ${input.focus}: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    try {
      await page.keyboard.press(input.keys);
    } catch (e) {
      dispatchError = e instanceof Error ? e.message : String(e);
    }
  });

  await settleMs(waitMs);
  const after = (await workspaceSnapshot(router, vault)) ?? emptySnapshot();
  const delta = workspaceDelta(before, after);
  const slice = logsSinceMark(telemetry, mark.seq);
  const changed = deltaChanged(delta);

  const verdict = dispatchError !== undefined ? "error" : changed ? "fired" : "no-change";
  const headline =
    verdict === "error"
      ? `Failed to press ${input.keys}: ${dispatchError}`
      : changed
        ? `Pressed ${input.keys} and the workspace changed.`
        : `Pressed ${input.keys} but nothing observable changed.`;

  const lines = [headline, ""];
  if (focused !== undefined) lines.push(`Focused: ${focused}`, "");
  lines.push(...formatWorkspaceDelta(delta));
  if (!changed && verdict !== "error") {
    lines.push(
      "",
      "No delta does not always mean the hotkey failed — a command that toggles a setting or",
      "writes to a file changes nothing this samples. Check the logs below, then confirm the",
      "binding exists with obsidian_hotkeys, and that the right element is focused.",
    );
  }
  lines.push("", "Logs since mark:", formatLogSection(slice));

  return {
    text: appendTelemetrySummary(lines.join("\n"), telemetry, mark.seq),
    json: {
      keys: input.keys,
      verdict,
      changed,
      focus: focused ?? null,
      error: dispatchError ?? null,
      mark: { cursor: mark.seq },
      delta,
      logs: { errors: slice.errors, warnings: slice.warnings, records: slice.records },
    },
  };
}
