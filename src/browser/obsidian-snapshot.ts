/**
 * Obsidian-scoped ARIA snapshots — smaller than a full browser_snapshot tree.
 */

import { z } from "zod";
import type { CapabilityRouter } from "../connection/router.js";
import { truncateText } from "../util/truncate.js";
import { UobError } from "../util/errors.js";

const SNAPSHOT_CAP = 80_000;

const SCOPE_SELECTORS: Record<string, string> = {
  "active-leaf": ".workspace-leaf.mod-active",
  workspace: ".workspace",
  modal: ".modal-container, .prompt",
  settings: ".vertical-tab-content, .modal.mod-settings",
};

export const obsidianSnapshotSchema = {
  scope: z
    .enum(["active-leaf", "workspace", "modal", "settings", "selector"])
    .default("active-leaf")
    .describe(
      "Region to snapshot. Prefer active-leaf for the current note or pane; workspace for layout; " +
        "modal for command palette or dialogs; settings for the settings UI; selector for a custom CSS scope.",
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
