import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_SELECTOR,
  DOC_HASH_JS,
  docHash,
  editorReplaceSource,
  editorSetSource,
  editorStateSource,
  editorWidgetsSource,
  WIDGET_CAP,
  type EditorPosition,
  type EditorReplaceResult,
  type EditorSetResult,
  type EditorStateResult,
  type EditorWidgetsResult,
} from "../../src/obsidian/editor-probe.js";
import { elementMetricsSource } from "../../src/browser/element-screenshot.js";

/**
 * The probe sources run in the renderer, where mistakes surface as EVAL_FAILED
 * with no unit-test coverage. Executing the generated code here against a stubbed
 * `app` keeps the logic testable without a live Obsidian: the stub implements the
 * slice of the Editor API each source touches, nothing more.
 */

/** Execute a generated source with named stand-ins for renderer globals. */
function runSource<T>(source: string, globals: Record<string, unknown> = {}): T {
  const names = Object.keys(globals);
  const fn = new Function(...names, `return ${source};`);
  return fn(...names.map((n) => globals[n])) as T;
}

function offsetOf(doc: string, pos: EditorPosition): number {
  const lines = doc.split("\n");
  let offset = 0;
  for (let i = 0; i < pos.line; i++) offset += (lines[i] ?? "").length + 1;
  return offset + pos.ch;
}

/** Minimal Obsidian Editor stub backed by a plain string. */
function fakeEditor(initial: string, cursor: EditorPosition = { line: 0, ch: 0 }) {
  let doc = initial;
  let cur = { ...cursor };
  let sels = [{ anchor: { ...cursor }, head: { ...cursor } }];
  const lines = () => doc.split("\n");
  return {
    getValue: () => doc,
    setValue: (v: string) => {
      doc = v;
    },
    getCursor: () => ({ ...cur }),
    setCursor: (p: EditorPosition) => {
      cur = { ...p };
      sels = [{ anchor: { ...p }, head: { ...p } }];
    },
    listSelections: () => sels,
    setSelections: (s: typeof sels) => {
      sels = s;
      const last = s[s.length - 1];
      if (last) cur = { ...last.head };
    },
    lineCount: () => lines().length,
    getLine: (i: number) => lines()[i] ?? "",
    replaceSelection: (t: string) => {
      const at = offsetOf(doc, cur);
      doc = doc.slice(0, at) + t + doc.slice(at);
    },
    replaceRange: (t: string, from: EditorPosition, to?: EditorPosition) => {
      const start = offsetOf(doc, from);
      const end = to === undefined ? start : offsetOf(doc, to);
      doc = doc.slice(0, start) + t + doc.slice(end);
    },
    offsetToPos: (offset: number) => {
      const before = doc.slice(0, offset).split("\n");
      return { line: before.length - 1, ch: (before[before.length - 1] ?? "").length };
    },
    scrollIntoView: () => undefined,
    cm: null as unknown,
  };
}

function fakeApp(
  editor: ReturnType<typeof fakeEditor> | null,
  opts: { file?: string; mode?: string; rawSource?: boolean; viewType?: string } = {},
) {
  const view = {
    getViewType: () => opts.viewType ?? "markdown",
    getMode: () => opts.mode ?? "source",
    getState: () => ({ source: opts.rawSource === true }),
  };
  return {
    workspace: {
      activeLeaf: { view },
      activeEditor: editor ? { editor, file: { path: opts.file ?? "Notes/A.md" } } : null,
      getActiveFile: () => (opts.file !== undefined ? { path: opts.file } : null),
    },
  };
}

describe("docHash", () => {
  it("matches the renderer copy exactly, so the guard cannot drift", () => {
    const rendererHash = runSource<(text: string) => string>(DOC_HASH_JS);
    for (const text of [
      "",
      "hello",
      "line one\nline two",
      "unicode: héllo — ✓",
      "a".repeat(10_000),
    ]) {
      expect(rendererHash(text)).toBe(docHash(text));
    }
  });

  it("distinguishes nearby documents", () => {
    expect(docHash("abc")).not.toBe(docHash("abd"));
    expect(docHash("abc")).not.toBe(docHash("abc "));
  });

  it("is stable across calls", () => {
    expect(docHash("same")).toBe(docHash("same"));
  });
});

describe("editorStateSource", () => {
  const doc = ["# Title", "", "alpha", "beta", "gamma"].join("\n");

  it("reports file, cursor, doc size, and a hash matching the local twin", () => {
    const editor = fakeEditor(doc, { line: 2, ch: 1 });
    const state = runSource<EditorStateResult>(editorStateSource(20), {
      app: fakeApp(editor, { file: "Notes/A.md" }),
    });
    expect(state.editor).toBe(true);
    expect(state.file).toBe("Notes/A.md");
    expect(state.cursor).toEqual({ line: 2, ch: 1 });
    expect(state.lineCount).toBe(5);
    expect(state.docLength).toBe(doc.length);
    expect(state.docHash).toBe(docHash(doc));
  });

  it("windows the doc slice around the cursor", () => {
    const long = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
    const editor = fakeEditor(long, { line: 50, ch: 0 });
    const state = runSource<EditorStateResult>(editorStateSource(10), { app: fakeApp(editor) });
    expect(state.docSlice?.fromLine).toBe(45);
    expect(state.docSlice?.toLine).toBe(55);
    expect(state.docSlice?.lines?.[0]).toBe("45: line-45");
  });

  it("clamps the slice at document edges", () => {
    const editor = fakeEditor("one\ntwo", { line: 0, ch: 0 });
    const state = runSource<EditorStateResult>(editorStateSource(20), { app: fakeApp(editor) });
    expect(state.docSlice?.fromLine).toBe(0);
    expect(state.docSlice?.toLine).toBe(1);
  });

  it("distinguishes source, live-preview, and reading modes", () => {
    const editor = fakeEditor(doc);
    const modeOf = (opts: { mode?: string; rawSource?: boolean }) =>
      runSource<EditorStateResult>(editorStateSource(20), { app: fakeApp(editor, opts) }).mode;
    // getMode() says "source" for both editing variants; getState().source picks raw.
    expect(modeOf({ mode: "source", rawSource: true })).toBe("source");
    expect(modeOf({ mode: "source", rawSource: false })).toBe("live-preview");
    expect(modeOf({ mode: "preview" })).toBe("reading");
  });

  it("degrades to editor:false with the active file when no editor exists", () => {
    const state = runSource<EditorStateResult>(editorStateSource(20), {
      app: fakeApp(null, { file: "Notes/B.md", mode: "preview" }),
    });
    expect(state.editor).toBe(false);
    expect(state.file).toBe("Notes/B.md");
    expect(state.mode).toBe("reading");
  });
});

describe("editorSetSource", () => {
  it("moves the cursor and reports the new position", () => {
    const editor = fakeEditor("a\nb\nc");
    const result = runSource<EditorSetResult>(editorSetSource({ cursor: { line: 2, ch: 1 } }), {
      app: fakeApp(editor),
    });
    expect(result.editor).toBe(true);
    expect(result.cursor).toEqual({ line: 2, ch: 1 });
  });

  it("sets selections and scrolls without crashing", () => {
    const editor = fakeEditor("a\nb\nc");
    const selections = [{ anchor: { line: 0, ch: 0 }, head: { line: 1, ch: 1 } }];
    const result = runSource<EditorSetResult>(
      editorSetSource({ selections, scrollIntoView: true }),
      { app: fakeApp(editor) },
    );
    expect(result.selections).toEqual(selections);
  });

  it("returns editor:false when nothing is being edited", () => {
    const result = runSource<EditorSetResult>(editorSetSource({ cursor: { line: 0, ch: 0 } }), {
      app: fakeApp(null),
    });
    expect(result.editor).toBe(false);
  });
});

describe("editorReplaceSource", () => {
  it("refuses a stale hash and reports the current one, changing nothing", () => {
    const editor = fakeEditor("original");
    const result = runSource<EditorReplaceResult>(
      editorReplaceSource({ mode: "setValue", text: "new", expectedDocHash: "fnv1a-00000000-0" }),
      { app: fakeApp(editor) },
    );
    expect(result.stale).toBe(true);
    expect(result.docHash).toBe(docHash("original"));
    expect(editor.getValue()).toBe("original");
  });

  it("setValue replaces the whole document when the hash matches", () => {
    const editor = fakeEditor("original");
    const result = runSource<EditorReplaceResult>(
      editorReplaceSource({
        mode: "setValue",
        text: "replaced",
        expectedDocHash: docHash("original"),
      }),
      { app: fakeApp(editor) },
    );
    expect(result.stale).toBe(false);
    expect(editor.getValue()).toBe("replaced");
    expect(result.docHash).toBe(docHash("replaced"));
  });

  it("replaceRange inserts at `from` when `to` is omitted", () => {
    const doc = "one\ntwo\nthree";
    const editor = fakeEditor(doc);
    runSource<EditorReplaceResult>(
      editorReplaceSource({
        mode: "replaceRange",
        text: "X",
        from: { line: 1, ch: 0 },
        expectedDocHash: docHash(doc),
      }),
      { app: fakeApp(editor) },
    );
    expect(editor.getValue()).toBe("one\nXtwo\nthree");
  });

  it("replaceRange replaces the from..to span", () => {
    const doc = "one\ntwo\nthree";
    const editor = fakeEditor(doc);
    runSource<EditorReplaceResult>(
      editorReplaceSource({
        mode: "replaceRange",
        text: "2",
        from: { line: 1, ch: 0 },
        to: { line: 1, ch: 3 },
        expectedDocHash: docHash(doc),
      }),
      { app: fakeApp(editor) },
    );
    expect(editor.getValue()).toBe("one\n2\nthree");
  });

  it("replaceSelection inserts at the cursor", () => {
    const doc = "ab";
    const editor = fakeEditor(doc, { line: 0, ch: 1 });
    runSource<EditorReplaceResult>(
      editorReplaceSource({
        mode: "replaceSelection",
        text: "-mid-",
        expectedDocHash: docHash(doc),
      }),
      { app: fakeApp(editor) },
    );
    expect(editor.getValue()).toBe("a-mid-b");
  });

  it("survives text full of quotes, newlines, and backticks", () => {
    const doc = "plain";
    const hostile = 'say "hi"\n`tick` ${not-a-template} \\backslash';
    const editor = fakeEditor(doc);
    runSource<EditorReplaceResult>(
      editorReplaceSource({ mode: "setValue", text: hostile, expectedDocHash: docHash(doc) }),
      { app: fakeApp(editor) },
    );
    expect(editor.getValue()).toBe(hostile);
  });
});

describe("editorWidgetsSource", () => {
  function fakeElement(cls: string, text: string, tag = "span") {
    return {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      parentElement: null as unknown,
      getAttribute: (name: string) => (name === "class" ? cls : null),
      getBoundingClientRect: () => ({ x: 10, y: 20, width: 30, height: 15 }),
      textContent: text,
    };
  }

  function widgetsWith(elements: unknown[], selector = DEFAULT_WIDGET_SELECTOR) {
    const editor = fakeEditor("hello widgets");
    const root = { querySelectorAll: () => elements };
    editor.cm = { dom: root, posAtDOM: () => 6 };
    return runSource<EditorWidgetsResult>(editorWidgetsSource(selector, WIDGET_CAP), {
      app: fakeApp(editor),
      document: { querySelector: () => null },
    });
  }

  it("reports rect, cssPath, docPos, and a text preview per match", () => {
    const result = widgetsWith([fakeElement("cm-widget my-widget", "widget text")]);
    expect(result.returned).toBe(1);
    const w = result.widgets?.[0];
    expect(w?.rect).toEqual({ x: 10, y: 20, width: 30, height: 15 });
    expect(w?.cssPath).toBe("span.cm-widget.my-widget");
    expect(w?.docPos).toEqual({ offset: 6, line: 0, ch: 6 });
    expect(w?.textPreview).toBe("widget text");
  });

  it("caps matches and reports the true total", () => {
    const many = Array.from({ length: WIDGET_CAP + 20 }, (_, i) => fakeElement("w", `t${i}`));
    const result = widgetsWith(many);
    expect(result.total).toBe(WIDGET_CAP + 20);
    expect(result.returned).toBe(WIDGET_CAP);
  });

  it("still reports geometry when the CM6 view is absent", () => {
    const editor = fakeEditor("x");
    // No editor.cm: the DOM fallback root serves the query instead.
    const root = { querySelectorAll: () => [fakeElement("cm-embed-block", "embed")] };
    const result = runSource<EditorWidgetsResult>(
      editorWidgetsSource(DEFAULT_WIDGET_SELECTOR, WIDGET_CAP),
      { app: fakeApp(editor), document: { querySelector: () => root } },
    );
    expect(result.returned).toBe(1);
    expect(result.widgets?.[0]?.docPos).toBeNull();
  });

  it("embeds an arbitrary caller selector safely", () => {
    const source = editorWidgetsSource('[data-sigla="x"]', 10);
    expect(source).toContain('"[data-sigla=\\"x\\"]"');
    // Must still be syntactically valid JavaScript.
    expect(() => new Function(`return ${source};`)).not.toThrow();
  });

  it("returns editor:false when no editor pane exists at all", () => {
    const result = runSource<EditorWidgetsResult>(
      editorWidgetsSource(DEFAULT_WIDGET_SELECTOR, WIDGET_CAP),
      { app: fakeApp(null), document: { querySelector: () => null } },
    );
    expect(result.editor).toBe(false);
  });
});

describe("elementMetricsSource", () => {
  it("returns rect, DPR, viewport, and computed display for a match", () => {
    const el = {
      getBoundingClientRect: () => ({ x: 1, y: 2, width: 3, height: 4 }),
    };
    const metrics = runSource<Record<string, unknown>>(elementMetricsSource(".target"), {
      document: { querySelector: () => el },
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      window: { devicePixelRatio: 2, innerWidth: 1920, innerHeight: 1080 },
    });
    expect(metrics).toEqual({
      rect: { x: 1, y: 2, width: 3, height: 4 },
      devicePixelRatio: 2,
      viewport: { innerWidth: 1920, innerHeight: 1080 },
      display: { display: "block", visibility: "visible" },
    });
  });

  it("returns null when nothing matches", () => {
    const metrics = runSource<unknown>(elementMetricsSource("#missing"), {
      document: { querySelector: () => null },
      getComputedStyle: () => ({}),
      window: {},
    });
    expect(metrics).toBeNull();
  });
});
