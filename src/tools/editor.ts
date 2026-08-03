/**
 * Editor toolset: read and mutate the active editor (toolset: editor).
 *
 * Default-on: plugin development is mostly editor work, and without these tools
 * agents fall back to raw obsidian_eval for every cursor read. Everything routes
 * through `router.evaluateJson` with sources built in obsidian/editor-probe.ts,
 * so either transport can serve them and the renderer logic stays unit-tested.
 *
 * `obsidian_editor_replace` is hash-guarded: concurrent agents (and the user)
 * share one live editor, so every edit must prove it saw the current document.
 */

import { z } from "zod";
import type { ServerContext } from "../server.js";
import { evalJson, vaultName } from "../obsidian/helpers.js";
import {
  DEFAULT_WIDGET_SELECTOR,
  DEFAULT_WINDOW_LINES,
  editorReplaceSource,
  editorSetSource,
  editorStateSource,
  editorWidgetsSource,
  WIDGET_CAP,
  type EditorPosition,
  type EditorReplaceResult,
  type EditorSelectionRange,
  type EditorSetResult,
  type EditorStateResult,
  type EditorWidgetsResult,
} from "../obsidian/editor-probe.js";
import { UobError } from "../util/errors.js";

const positionSchema = z.object({
  line: z.number().int().nonnegative().describe("Zero-based line number"),
  ch: z.number().int().nonnegative().describe("Zero-based character offset within the line"),
});

const selectionSchema = z.object({
  anchor: positionSchema.describe("Selection anchor (where the selection started)"),
  head: positionSchema.describe("Selection head (where the cursor is)"),
});

const vaultOpt = {
  vault: z.string().optional().describe("Target vault name; overrides the session default"),
};

function noActiveEditor(): UobError {
  return new UobError("TARGET_NOT_FOUND", "No active markdown editor.", {
    remediation:
      "Open a markdown file in an editing mode first (obsidian_open from the vault toolset, or " +
      "obsidian_command with a file-opening command), then retry. obsidian_editor_state reports " +
      "mode 'reading' or 'none' without erroring if you need to diagnose.",
    fixedBy: "obsidian_command",
  });
}

export function registerEditorTools(ctx: ServerContext): void {
  const { registry, router, config } = ctx;

  registry.add({
    name: "obsidian_editor_state",
    toolset: "editor",
    capability: "evaluate",
    description:
      "Report the active editor: file, mode (source, live-preview, reading, none), cursor, " +
      "selections, line count, doc length, a stable docHash of the whole document, and a window " +
      "of numbered lines around the cursor. Call this before obsidian_editor_replace — the " +
      "returned docHash is what authorizes the edit. Never errors on a reading view or empty " +
      "workspace; it reports the mode instead.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      windowLines: z
        .number()
        .int()
        .min(0)
        .max(400)
        .optional()
        .describe(
          `Lines of context around the cursor in docSlice (default ${DEFAULT_WINDOW_LINES})`,
        ),
      ...vaultOpt,
    },
    handler: async (args) => {
      const windowLines = (args.windowLines as number | undefined) ?? DEFAULT_WINDOW_LINES;
      const state = await evalJson<EditorStateResult>(
        router,
        editorStateSource(windowLines),
        vaultName(args, config),
      );
      const text = state.editor
        ? `Editing ${state.file ?? "(untitled)"} (${state.mode}) — cursor ${state.cursor?.line}:${state.cursor?.ch}, ` +
          `${state.lineCount} lines, ${state.docLength} chars, hash ${state.docHash}`
        : `No active editor (view: ${state.viewType}, mode: ${state.mode}` +
          `${state.file !== null ? `, file: ${state.file}` : ""}).`;
      return { text, json: state };
    },
  });

  registry.add({
    name: "obsidian_editor_set",
    toolset: "editor",
    capability: "evaluate",
    description:
      "Move the cursor and/or set selections in the active editor. Positions are zero-based " +
      "{line, ch}, matching obsidian_editor_state output. Pass scrollIntoView=true to center the " +
      "view on the result. Changes selection state only — use obsidian_editor_replace for text.",
    inputSchema: {
      cursor: positionSchema.optional().describe("New cursor position"),
      selections: z
        .array(selectionSchema)
        .min(1)
        .optional()
        .describe("Replace all selections (applied after cursor when both are given)"),
      scrollIntoView: z
        .boolean()
        .optional()
        .describe("Scroll the editor so the new cursor/selection is centered"),
      ...vaultOpt,
    },
    handler: async (args) => {
      const cursor = args.cursor as EditorPosition | undefined;
      const selections = args.selections as EditorSelectionRange[] | undefined;
      if (cursor === undefined && selections === undefined) {
        throw new UobError("INVALID_ARGUMENT", "Pass cursor and/or selections — nothing to set.", {
          remediation: "Provide a cursor position, a selections array, or both.",
        });
      }
      const result = await evalJson<EditorSetResult>(
        router,
        editorSetSource({
          ...(cursor !== undefined ? { cursor } : {}),
          ...(selections !== undefined ? { selections } : {}),
          ...(args.scrollIntoView === true ? { scrollIntoView: true } : {}),
        }),
        vaultName(args, config),
      );
      if (!result.editor) throw noActiveEditor();
      return {
        text: `Cursor at ${result.cursor?.line}:${result.cursor?.ch} (${result.selections?.length} selection(s)).`,
        json: result,
      };
    },
  });

  registry.add({
    name: "obsidian_editor_replace",
    toolset: "editor",
    capability: "evaluate",
    description:
      "Edit text in the active editor: replaceSelection (insert at cursor/selection), " +
      "replaceRange (from/to span, zero-based {line, ch}; omit `to` to insert), or setValue " +
      "(replace the whole document). Requires expectedDocHash from a fresh obsidian_editor_state " +
      "call and refuses when the document has changed since — the user or another agent may be " +
      "typing in the same editor.",
    // setValue overwrites the entire document, and even ranged edits destroy the
    // replaced span, so the whole tool carries the hint rather than one mode.
    annotations: { destructiveHint: true },
    inputSchema: {
      mode: z
        .enum(["replaceSelection", "replaceRange", "setValue"])
        .describe("Which edit to perform"),
      text: z.string().describe("Replacement text"),
      from: positionSchema.optional().describe("Range start (required for replaceRange)"),
      to: positionSchema
        .optional()
        .describe("Range end (replaceRange only; omit to insert at `from`)"),
      expectedDocHash: z
        .string()
        .describe("docHash from the latest obsidian_editor_state — the edit refuses on mismatch"),
      ...vaultOpt,
    },
    handler: async (args) => {
      const mode = args.mode as "replaceSelection" | "replaceRange" | "setValue";
      const from = args.from as EditorPosition | undefined;
      const to = args.to as EditorPosition | undefined;
      if (mode === "replaceRange" && from === undefined) {
        throw new UobError("INVALID_ARGUMENT", "replaceRange requires `from`.", {
          remediation: "Pass a zero-based {line, ch} start position (and optionally `to`).",
        });
      }
      const expected = args.expectedDocHash as string;
      const result = await evalJson<EditorReplaceResult>(
        router,
        editorReplaceSource({
          mode,
          text: args.text as string,
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          expectedDocHash: expected,
        }),
        vaultName(args, config),
      );
      if (!result.editor) throw noActiveEditor();
      if (result.stale === true) {
        throw new UobError(
          "STALE_REF",
          "The document changed since that docHash was taken — refusing to edit blind.",
          {
            remediation:
              "Call obsidian_editor_state again, re-derive the edit from the fresh content, and " +
              "retry with the new docHash. Another agent or the user may be editing the same file.",
            fixedBy: "obsidian_editor_state",
            details: { expected, actual: result.docHash },
          },
        );
      }
      return {
        text:
          `Applied ${mode}: now ${result.lineCount} lines, ${result.docLength} chars, ` +
          `hash ${result.docHash}.`,
        json: result,
      };
    },
  });

  registry.add({
    name: "obsidian_editor_widgets",
    toolset: "editor",
    capability: "evaluate",
    description:
      "Query rendered decorations and widgets inside the active editor DOM. Defaults to " +
      "widget-ish CM6 elements (cm-widget classes and embed blocks); pass any CSS selector — " +
      `e.g. '[data-my-plugin]' — to find plugin-specific decorations. Each match (capped at ` +
      `${WIDGET_CAP}) reports a short cssPath, its bounding rect, the document position via the ` +
      "CM6 view when reachable, and a text preview.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      selector: z
        .string()
        .optional()
        .describe(`CSS selector scoped to the editor root (default: '${DEFAULT_WIDGET_SELECTOR}')`),
      ...vaultOpt,
    },
    handler: async (args) => {
      const selector = (args.selector as string | undefined) ?? DEFAULT_WIDGET_SELECTOR;
      const result = await evalJson<EditorWidgetsResult>(
        router,
        editorWidgetsSource(selector, WIDGET_CAP),
        vaultName(args, config),
      );
      if (result.badSelector !== undefined) {
        throw new UobError("INVALID_ARGUMENT", `Invalid CSS selector "${selector}".`, {
          remediation: "Pass a valid selector scoped to the active editor root.",
          details: { selector, error: result.badSelector },
        });
      }
      if (!result.editor && result.widgets === undefined) {
        throw new UobError("TARGET_NOT_FOUND", "No active editor pane to query.", {
          remediation: "Open a markdown file in an editing mode first, then retry.",
        });
      }
      const capped =
        (result.total ?? 0) > (result.returned ?? 0) ? ` (capped from ${result.total})` : "";
      return {
        text: `${result.returned} widget(s) match ${selector}${capped}.`,
        json: { selector, ...result },
      };
    },
  });
}
