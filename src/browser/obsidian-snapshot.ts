/**
 * Obsidian-scoped ARIA snapshots — smaller than a full browser_snapshot tree.
 */

import { z } from "zod";
import type { CapabilityRouter } from "../connection/router.js";
import { truncateText } from "../util/truncate.js";
import { UobError } from "../util/errors.js";

const SNAPSHOT_CAP = 80_000;

export const SCOPE_SELECTORS: Record<string, string> = {
  "active-leaf": ".workspace-leaf.mod-active",
  workspace: ".workspace",
  modal: ".modal-container, .prompt",
  settings: ".vertical-tab-content, .modal.mod-settings",
  // The reading view is the fallback, not an alternative: a comma list matches in
  // document order and the source view precedes the reading view inside a leaf,
  // so `.first()` lands on the cm-editor whenever the note is in an editing mode.
  editor:
    ".workspace-leaf.mod-active .cm-editor, .workspace-leaf.mod-active .markdown-reading-view",
};

export const SNAPSHOT_SCOPES = [
  "active-leaf",
  "workspace",
  "modal",
  "settings",
  "editor",
  "selector",
] as const;

export const obsidianSnapshotSchema = {
  scope: z
    .enum(SNAPSHOT_SCOPES)
    .default("active-leaf")
    .describe(
      "Region to snapshot. Prefer active-leaf for the current note or pane; workspace for layout; " +
        "modal for command palette or dialogs; settings for the settings UI; editor for just the " +
        "active editor (reading view when no editor); selector for a custom CSS scope.",
    ),
  selector: z
    .string()
    .optional()
    .describe(
      "CSS selector when scope is selector (e.g. .workspace-leaf-content[data-type=markdown])",
    ),
  depth: z.number().optional().describe("Optional depth limit passed to ariaSnapshot"),
};

export async function takeObsidianSnapshot(
  router: CapabilityRouter,
  args: Record<string, unknown>,
): Promise<{ text: string; json: unknown }> {
  const parsed = z.object(obsidianSnapshotSchema).parse(args);
  const scope = parsed.scope;
  let selector: string;
  if (scope === "selector") {
    if (parsed.selector === undefined || parsed.selector === "") {
      throw new UobError("INVALID_ARGUMENT", "selector is required when scope is selector.");
    }
    selector = parsed.selector;
  } else {
    selector = SCOPE_SELECTORS[scope] ?? ".workspace";
  }

  await router.playwright.connect();
  const page = await router.playwright.page();
  const locator = page.locator(selector).first();
  const count = await locator.count();
  if (count === 0) {
    throw new UobError("TARGET_NOT_FOUND", `No element matched scope "${scope}" (${selector}).`, {
      remediation:
        "Open the UI you need (note, modal, settings) or pass scope=selector with a DOM hook from docs/dom-hooks.md.",
    });
  }

  const options: { mode: "ai"; depth?: number } = { mode: "ai" };
  if (parsed.depth !== undefined) options.depth = parsed.depth;

  const yaml = await locator.ariaSnapshot(options);
  const capped = truncateText(yaml, SNAPSHOT_CAP);

  const lines = [
    `Scoped ARIA snapshot (${scope})`,
    `Selector: ${selector}`,
    "",
    "```yaml",
    capped.text,
    "```",
  ];

  return {
    text: lines.join("\n"),
    json: {
      scope,
      selector,
      truncated: capped.truncated,
      ...(capped.originalLength !== undefined ? { originalLength: capped.originalLength } : {}),
      lineCount: yaml.split("\n").length,
    },
  };
}
