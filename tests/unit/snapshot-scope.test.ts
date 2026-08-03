import { describe, expect, it } from "vitest";
import { z } from "zod";
import { obsidianSnapshotSchema, SCOPE_SELECTORS } from "../../src/browser/obsidian-snapshot.js";

describe("obsidian_snapshot scopes", () => {
  it("maps every non-selector scope to a selector", () => {
    const scopes = obsidianSnapshotSchema.scope.def.innerType.options.filter(
      (s: string) => s !== "selector",
    );
    for (const scope of scopes) {
      expect(SCOPE_SELECTORS[scope], `no selector for scope "${scope}"`).toBeTruthy();
    }
  });

  it("editor scope targets the active leaf's editor with a reading-view fallback", () => {
    const selector = SCOPE_SELECTORS.editor ?? "";
    // Fallback order matters: the cm-editor half must come first so `.first()`
    // picks it (document order) whenever the note is in an editing mode.
    const [primary, fallback] = selector.split(",").map((s) => s.trim());
    expect(primary).toBe(".workspace-leaf.mod-active .cm-editor");
    expect(fallback).toBe(".workspace-leaf.mod-active .markdown-reading-view");
  });

  it("parses scope=editor", () => {
    const parsed = z.object(obsidianSnapshotSchema).parse({ scope: "editor" });
    expect(parsed.scope).toBe("editor");
  });
});
