import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  obsidianSnapshotSchema,
  SNAPSHOT_SCOPES,
  SCOPE_SELECTORS,
} from "../../src/browser/obsidian-snapshot.js";

describe("obsidian_snapshot scopes", () => {
  it("maps every non-selector scope to a selector", () => {
    const scopes = SNAPSHOT_SCOPES.filter((scope) => scope !== "selector");
    expect(scopes).toHaveLength(Object.keys(SCOPE_SELECTORS).length);
    for (const scope of scopes) {
      expect(SCOPE_SELECTORS[scope], `no selector for scope "${scope}"`).toBeTruthy();
    }
  });

  it("editor scope targets the active leaf's editor with a reading-view fallback", () => {
    const selector = SCOPE_SELECTORS.editor ?? "";
    // Matches return in document order. The source editor precedes the reading
    // view inside a leaf, so `.first()` selects it in an editing mode.
    const [primary, fallback] = selector.split(",").map((s) => s.trim());
    expect(primary).toBe(".workspace-leaf.mod-active .cm-editor");
    expect(fallback).toBe(".workspace-leaf.mod-active .markdown-reading-view");
  });

  it("parses scope=editor", () => {
    const parsed = z.object(obsidianSnapshotSchema).parse({ scope: "editor" });
    expect(parsed.scope).toBe("editor");
  });
});
