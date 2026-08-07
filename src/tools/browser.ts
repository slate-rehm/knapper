/**
 * Layer 4 — browser automation over the live Obsidian renderer.
 *
 * Proxies a curated subset of @playwright/mcp and adds Obsidian-scoped snapshots plus
 * skillOnly helpers upstream omits from MCP.
 */

import { z } from "zod";
import type { ServerContext } from "../server.js";
import { passthroughMcpResult } from "../browser/forward.js";
import { checkTarget, keyDown, keyUp, pressSequentially, reloadWindow } from "../browser/native.js";
import { takeObsidianSnapshot, obsidianSnapshotSchema } from "../browser/obsidian-snapshot.js";
import type { ProxiedTool } from "../browser/proxy.js";
import { runExerciseHotkey } from "../devcycle/exercise-hotkey.js";

const TARGET_HINT =
  "Use the `target` parameter with a snapshot ref (e.g. e5) or a stable CSS selector from docs/dom-hooks.md. " +
  "`element` is only a human-readable label for approval prompts, not a locator.";

const VIRTUALIZED_TREE =
  "Obsidian's file tree is virtualized: off-screen `.nav-file-title` elements do not exist in the DOM. " +
  "Enumerate files via `app.vault` through obsidian_eval (or obsidian_search / vault tools); use the " +
  "explorer DOM only for visible rows.";

const OBSIDIAN_PROXY_NOTES: Record<string, string> = {
  browser_snapshot: `Full-page ARIA snapshot of the active Obsidian window. Prefer obsidian_snapshot when you only need a pane or modal — the full tree is large. ${TARGET_HINT}`,
  browser_click: `Click with real mouse events over CDP (required for drag handles and gutters). ${TARGET_HINT}`,
  browser_type: `Type into an editable control (e.g. .cm-content in source mode). ${TARGET_HINT}`,
  browser_take_screenshot:
    "Capture the Obsidian **web contents** (Playwright page screenshot), not the OS window chrome. " +
    "For the full native Electron window via `capturePage()`, use obsidian_screenshot instead. " +
    `Defaults to viewport/element shots — avoid fullPage against a real desktop window (device metrics override is risky). ${TARGET_HINT}`,
  browser_mouse_click_xy:
    "Click at viewport coordinates — use when canvas/graph views lack refs (vision capability).",
};

/** Upstream descriptions do not all end in a period, so joining needs one added. */
function sentence(base: string, suffix: string): string {
  const trimmed = base.trim();
  const punctuated = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  return `${punctuated} ${suffix}`;
}

function describeProxiedTool(tool: ProxiedTool): string {
  const base = tool.description ?? tool.name;
  const extra = OBSIDIAN_PROXY_NOTES[tool.name];
  if (extra) return extra;
  if (tool.name.startsWith("browser_mouse_")) {
    return sentence(
      base,
      "Coordinate input against the attached Obsidian window (vision capability).",
    );
  }
  return sentence(
    base,
    "Runs against the user's live Obsidian window — prefer obsidian_command over menu clicking when possible.",
  );
}

function annotationsFor(name: string) {
  const readOnly = name === "browser_snapshot" || name === "browser_wait_for";
  return {
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && name !== "browser_take_screenshot",
    idempotentHint: readOnly,
    openWorldHint: false,
  };
}

export async function registerBrowserTools(ctx: ServerContext): Promise<void> {
  const { registry, browserProxy, router } = ctx;

  let proxied: ProxiedTool[] = [];
  try {
    proxied = await browserProxy.listTools();
  } catch (e) {
    ctx.logger.warn("browser proxy init failed during registration; tools will error on call", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  for (const tool of proxied) {
    registry.add({
      name: tool.name,
      toolset: "ui",
      capability: tool.name === "browser_snapshot" ? "ariaSnapshot" : "realInput",
      description: describeProxiedTool(tool),
      jsonInputSchema: tool.inputSchema,
      ...(tool.outputSchema !== undefined ? { jsonOutputSchema: tool.outputSchema } : {}),
      ...(annotationsFor(tool.name) ? { annotations: annotationsFor(tool.name) } : {}),
      handler: async (args) => {
        const result = await browserProxy.callTool(tool.name, args);
        return passthroughMcpResult(result);
      },
    });
  }

  registry.add({
    name: "obsidian_snapshot",
    toolset: "ui",
    capability: "ariaSnapshot",
    description:
      "ARIA snapshot scoped to part of Obsidian (active leaf, workspace, modal, settings, or a custom selector). " +
      "Much smaller than browser_snapshot for everyday navigation. Refs in the output work as browser_* `target` values. " +
      VIRTUALIZED_TREE,
    annotations: { readOnlyHint: true },
    inputSchema: obsidianSnapshotSchema,
    handler: async (args) => takeObsidianSnapshot(router, args),
  });

  registry.add({
    name: "browser_reload",
    toolset: "ui",
    capability: "realInput",
    description:
      "Reload the Obsidian window. Tries the in-app app:reload command first; falls back to page.reload(). " +
      "This reloads the whole renderer — for plugin changes prefer obsidian_dev_cycle instead.",
    annotations: { destructiveHint: true },
    inputSchema: {},
    handler: async () => reloadWindow(router),
  });

  registry.add({
    name: "browser_check",
    toolset: "ui",
    capability: "realInput",
    description: `Check a checkbox or radio in Obsidian. ${TARGET_HINT}`,
    inputSchema: {
      target: z.string().describe("Snapshot ref or CSS selector"),
      element: z.string().optional().describe("Human-readable label for approval prompts"),
    },
    handler: async (args) => checkTarget(router, args),
  });

  registry.add({
    name: "browser_press_sequentially",
    toolset: "ui",
    capability: "realInput",
    description:
      "Type text one key at a time on the focused element — use when Obsidian key handlers ignore fill(). " +
      "Focus the editor (.cm-content) or a search field first.",
    inputSchema: {
      text: z.string().describe("Text to type"),
      submit: z.boolean().optional().describe("Press Enter after typing"),
    },
    handler: async (args) => pressSequentially(router, args),
  });

  registry.add({
    name: "browser_keydown",
    toolset: "ui",
    capability: "realInput",
    description:
      "Hold a key down (modifiers, chords). Pair with browser_keyup. Does not target an element — focus first.",
    inputSchema: {
      key: z.string().describe("Key name such as Shift, Control, or ArrowDown"),
    },
    handler: async (args) => keyDown(router, args),
  });

  registry.add({
    name: "obsidian_exercise_hotkey",
    toolset: "ui",
    capability: "realInput",
    handlesOwnTelemetry: true,
    annotations: { readOnlyHint: false, destructiveHint: true },
    description:
      "Press a real keyboard chord and report whether it actually did anything: workspace state " +
      "before/after plus console output since a telemetry mark. Use this to test that a hotkey " +
      "*binding* works — browser_press_key only tells you the keys were delivered, which they " +
      "almost always are. Works with Obsidian in the background. Cannot trigger Electron menu " +
      "accelerators (the app-level Cmd+Q class), which never reach the renderer. " +
      "To just run a command, prefer obsidian_command; this is for exercising the binding.",
    inputSchema: {
      keys: z
        .string()
        .describe('Chord in Playwright syntax, e.g. "Control+p", "Shift+Alt+F", "Escape"'),
      focus: z
        .string()
        .optional()
        .describe(
          'CSS selector to focus first, e.g. ".cm-content" for editor-scoped hotkeys. Page focus ' +
            "is emulated automatically; this picks the focused element within it.",
        ),
      waitMs: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Milliseconds to wait after the chord before sampling (default 600)"),
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    handler: async (args) =>
      runExerciseHotkey(
        router,
        ctx.config,
        ctx.telemetry,
        {
          keys: args.keys as string,
          focus: args.focus as string | undefined,
          waitMs: args.waitMs as number | undefined,
        },
        args,
      ),
  });

  registry.add({
    name: "browser_keyup",
    toolset: "ui",
    capability: "realInput",
    description:
      "Release a key previously held with browser_keydown. Always pair the two, or the modifier " +
      "stays logically held down and corrupts every later keystroke in the session. Does not " +
      "target an element — focus first.",
    inputSchema: {
      key: z.string().describe("Key name matching the prior keydown"),
    },
    handler: async (args) => keyUp(router, args),
  });
}
