import { describe, expect, it } from "vitest";
import {
  classifyTarget,
  classifyTargets,
  obsidianWindows,
  parseObsidianTitle,
  selectTarget,
  type CdpTarget,
} from "../../src/connection/cdp/discover.js";

function target(partial: Partial<CdpTarget>): CdpTarget {
  return { id: "t", type: "page", title: "", url: "", ...partial };
}

/**
 * Fixtures cover the three shapes that break naive target selection: a main window,
 * a popout (which reports `about:blank` because Obsidian creates it with
 * window.open and injects a <base href>), and a Web Viewer webview.
 */
const MAIN = target({
  id: "main-1",
  type: "page",
  title: "Alpha - uob-test-vault - Obsidian 1.12.7",
  url: "app://obsidian.md/index.html",
});

const POPOUT = target({
  id: "popout-1",
  type: "page",
  title: "Beta - uob-test-vault - Obsidian 1.12.7",
  url: "about:blank",
});

const WEBVIEW = target({
  id: "wv-1",
  type: "webview",
  title: "Some Web Page",
  url: "https://example.com",
});

const WORKER = target({ id: "w-1", type: "worker", title: "", url: "" });

const UNRELATED_BLANK = target({
  id: "blank-1",
  type: "page",
  title: "about:blank",
  url: "about:blank",
});

describe("parseObsidianTitle", () => {
  it("splits note and vault from a title with a note open", () => {
    expect(parseObsidianTitle("Alpha - uob-test-vault - Obsidian 1.12.7")).toEqual({
      vaultName: "uob-test-vault",
      noteName: "Alpha",
    });
  });

  it("reads only the vault when no note is open", () => {
    expect(parseObsidianTitle("uob-test-vault - Obsidian 1.12.7")).toEqual({
      vaultName: "uob-test-vault",
    });
  });

  it("keeps hyphens inside a note name", () => {
    expect(parseObsidianTitle("2026-07-25 - my vault - Obsidian 1.12.7")).toEqual({
      vaultName: "my vault",
      noteName: "2026-07-25",
    });
  });

  it("returns nothing for a title without the Obsidian version suffix", () => {
    expect(parseObsidianTitle("Some Web Page")).toEqual({});
  });
});

describe("classifyTarget", () => {
  it("recognizes a main window by its app:// URL", () => {
    expect(classifyTarget(MAIN).kind).toBe("main");
  });

  it("recognizes a popout despite its about:blank URL", () => {
    const result = classifyTarget(POPOUT);
    expect(result.kind).toBe("popout");
    expect(result.vaultName).toBe("uob-test-vault");
  });

  it("does not mistake an unrelated blank page for a popout", () => {
    expect(classifyTarget(UNRELATED_BLANK).kind).toBe("other");
  });

  it("classifies webviews separately so they are never driven as app windows", () => {
    expect(classifyTarget(WEBVIEW).kind).toBe("webview");
  });

  it("treats non-page targets as other", () => {
    expect(classifyTarget(WORKER).kind).toBe("other");
  });
});

describe("obsidianWindows", () => {
  it("returns main windows and popouts but not webviews or workers", () => {
    const kinds = obsidianWindows([MAIN, POPOUT, WEBVIEW, WORKER, UNRELATED_BLANK]).map(
      (t) => t.kind,
    );
    expect(kinds).toEqual(["main", "popout"]);
  });
});

describe("selectTarget", () => {
  it("prefers a main window over a popout", () => {
    expect(selectTarget([POPOUT, MAIN])?.target.id).toBe("main-1");
  });

  it("selects by explicit target id, including a popout", () => {
    expect(selectTarget([MAIN, POPOUT], { targetId: "popout-1" })?.target.id).toBe("popout-1");
  });

  it("returns undefined for an unknown target id", () => {
    expect(selectTarget([MAIN], { targetId: "nope" })).toBeUndefined();
  });

  it("matches a vault case-insensitively", () => {
    const other = target({
      id: "main-2",
      type: "page",
      title: "Note - Second Vault - Obsidian 1.12.7",
      url: "app://obsidian.md/index.html",
    });
    expect(selectTarget([MAIN, other], { vault: "second vault" })?.target.id).toBe("main-2");
  });

  it("falls back to the default choice when the requested vault is absent", () => {
    expect(selectTarget([MAIN], { vault: "no-such-vault" })?.target.id).toBe("main-1");
  });

  it("returns undefined when no Obsidian window is present", () => {
    expect(selectTarget([WEBVIEW, WORKER])).toBeUndefined();
  });
});

describe("live fixture", () => {
  it("classifies the captured live target list", async () => {
    const live = (await import("../fixtures/cdp-targets-live.json", {
      with: { type: "json" },
    })) as unknown as { default: CdpTarget[] };
    const classified = classifyTargets(live.default);
    expect(classified.filter((t) => t.kind === "main")).toHaveLength(1);
    expect(selectTarget(live.default)?.kind).toBe("main");
  });
});
