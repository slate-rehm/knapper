/**
 * Renderer-side probe sources for the editor toolset.
 *
 * Every function here builds a JavaScript source string that runs in the Obsidian
 * renderer via `router.evaluateJson`, where only `app` (and the DOM) are in scope.
 * The `MarkdownView` class is not importable there, so mode detection reads the
 * active leaf's view and everything else goes through `app.workspace.activeEditor`.
 * Keeping the builders pure lets unit tests execute the generated code against a
 * stubbed `app` without a live renderer.
 */

export interface EditorPosition {
  line: number;
  ch: number;
}

export interface EditorSelectionRange {
  anchor: EditorPosition;
  head: EditorPosition;
}

/** Lines of context returned around the cursor when the caller does not choose. */
export const DEFAULT_WINDOW_LINES = 20;

/** Hard cap on widget matches so a decoration-heavy note cannot flood the reply. */
export const WIDGET_CAP = 50;

/**
 * Default query for widget-ish CM6 elements: replacement/inline widgets plus
 * embed blocks. Callers pass their own selector (e.g. `[data-my-plugin]`) to
 * find plugin-specific decorations.
 */
export const DEFAULT_WIDGET_SELECTOR =
  '.cm-content [class*="cm-widget"], .cm-content .cm-embed-block';

/**
 * FNV-1a over UTF-16 code units, suffixed with the document length in base 36.
 *
 * This guards `obsidian_editor_replace` against concurrent edits, so the only
 * property that matters is that both sides compute it identically: this string is
 * the renderer copy, `docHash` below is the local twin, and a unit test executes
 * this string to prove the two cannot drift.
 */
export const DOC_HASH_JS = `(text) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return "fnv1a-" + h.toString(16).padStart(8, "0") + "-" + text.length.toString(36);
}`;

/** Local twin of {@link DOC_HASH_JS}. */
export function docHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return `fnv1a-${h.toString(16).padStart(8, "0")}-${text.length.toString(36)}`;
}

export interface EditorStateResult {
  file: string | null;
  viewType: string;
  mode: "source" | "live-preview" | "reading" | "none";
  editor: boolean;
  cursor?: EditorPosition;
  selections?: EditorSelectionRange[];
  lineCount?: number;
  docLength?: number;
  docHash?: string;
  docSlice?: { fromLine: number; toLine: number; lines: string[] };
}

/**
 * Mode detection constraint: `view.getMode()` only distinguishes "source" from
 * "preview". Live preview and raw source both report "source"; the view state's
 * `source: true` is what marks the raw-source variant.
 */
export function editorStateSource(windowLines: number): string {
  return `(() => {
    const hash = ${DOC_HASH_JS};
    const leaf = app.workspace.activeLeaf;
    const view = leaf ? leaf.view : null;
    const viewType = view && typeof view.getViewType === "function" ? view.getViewType() : "none";
    let mode = "none";
    if (view && typeof view.getMode === "function") {
      if (view.getMode() === "preview") mode = "reading";
      else {
        const state = typeof view.getState === "function" ? view.getState() : null;
        mode = state && state.source === true ? "source" : "live-preview";
      }
    }
    const info = app.workspace.activeEditor;
    const editor = info ? info.editor : null;
    const active = app.workspace.getActiveFile ? app.workspace.getActiveFile() : null;
    const file = info && info.file ? info.file.path : active ? active.path : null;
    if (!editor) return { file, viewType, mode, editor: false };
    const doc = editor.getValue();
    const cursor = editor.getCursor();
    const lineCount = editor.lineCount();
    const half = Math.floor(${JSON.stringify(windowLines)} / 2);
    const fromLine = Math.max(0, cursor.line - half);
    const toLine = Math.min(lineCount - 1, cursor.line + half);
    const lines = [];
    for (let i = fromLine; i <= toLine; i++) lines.push(i + ": " + editor.getLine(i));
    return {
      file, viewType, mode, editor: true,
      cursor,
      selections: editor.listSelections().map((s) => ({ anchor: s.anchor, head: s.head })),
      lineCount,
      docLength: doc.length,
      docHash: hash(doc),
      docSlice: { fromLine, toLine, lines },
    };
  })()`;
}

export interface EditorSetOptions {
  cursor?: EditorPosition;
  selections?: EditorSelectionRange[];
  scrollIntoView?: boolean;
}

export interface EditorSetResult {
  editor: boolean;
  cursor?: EditorPosition;
  selections?: EditorSelectionRange[];
}

export function editorSetSource(opts: EditorSetOptions): string {
  const steps: string[] = [];
  if (opts.cursor !== undefined) {
    steps.push(`editor.setCursor(${JSON.stringify(opts.cursor)});`);
  }
  if (opts.selections !== undefined) {
    steps.push(`editor.setSelections(${JSON.stringify(opts.selections)});`);
  }
  if (opts.scrollIntoView === true) {
    // Center on the selection so a jump to a far-away line is actually visible.
    steps.push(
      `editor.scrollIntoView({ from: editor.getCursor("from"), to: editor.getCursor("to") }, true);`,
    );
  }
  return `(() => {
    const info = app.workspace.activeEditor;
    const editor = info ? info.editor : null;
    if (!editor) return { editor: false };
    ${steps.join("\n    ")}
    return {
      editor: true,
      cursor: editor.getCursor(),
      selections: editor.listSelections().map((s) => ({ anchor: s.anchor, head: s.head })),
    };
  })()`;
}

export type EditorReplaceMode = "replaceSelection" | "replaceRange" | "setValue";

export interface EditorReplaceOptions {
  mode: EditorReplaceMode;
  text: string;
  from?: EditorPosition;
  to?: EditorPosition;
  expectedDocHash: string;
}

export interface EditorReplaceResult {
  editor: boolean;
  stale?: boolean;
  docHash?: string;
  docLength?: number;
  lineCount?: number;
  cursor?: EditorPosition;
}

export function editorReplaceSource(opts: EditorReplaceOptions): string {
  const text = JSON.stringify(opts.text);
  let edit: string;
  if (opts.mode === "replaceSelection") {
    edit = `editor.replaceSelection(${text});`;
  } else if (opts.mode === "setValue") {
    edit = `editor.setValue(${text});`;
  } else {
    // `to` omitted means insert at `from` — that is the Editor API's own contract.
    const args = [text, JSON.stringify(opts.from)];
    if (opts.to !== undefined) args.push(JSON.stringify(opts.to));
    edit = `editor.replaceRange(${args.join(", ")});`;
  }
  return `(() => {
    const hash = ${DOC_HASH_JS};
    const info = app.workspace.activeEditor;
    const editor = info ? info.editor : null;
    if (!editor) return { editor: false };
    const current = hash(editor.getValue());
    if (current !== ${JSON.stringify(opts.expectedDocHash)}) {
      return { editor: true, stale: true, docHash: current };
    }
    ${edit}
    const doc = editor.getValue();
    return {
      editor: true,
      stale: false,
      docHash: hash(doc),
      docLength: doc.length,
      lineCount: editor.lineCount(),
      cursor: editor.getCursor(),
    };
  })()`;
}

export interface EditorWidget {
  index: number;
  cssPath: string;
  rect: { x: number; y: number; width: number; height: number };
  docPos: { offset: number; line?: number; ch?: number } | null;
  textPreview: string;
}

export interface EditorWidgetsResult {
  editor: boolean;
  badSelector?: string;
  total?: number;
  returned?: number;
  widgets?: EditorWidget[];
}

/**
 * The CM6 EditorView lives at `activeEditor.editor.cm` — an Obsidian internal,
 * so its absence is guarded everywhere. `posAtDOM` is what ties a widget's DOM
 * node back to a document offset; when the view is missing the widgets still
 * report geometry and text, just no position.
 */
export function editorWidgetsSource(selector: string, cap: number): string {
  return `(() => {
    const info = app.workspace.activeEditor;
    const editor = info ? info.editor : null;
    const cm = editor && editor.cm ? editor.cm : null;
    const root = (cm && cm.dom) || document.querySelector(".workspace-leaf.mod-active .cm-editor");
    if (!root) return { editor: false };
    const cssPath = (el) => {
      const parts = [];
      let node = el;
      for (let depth = 0; node && node.nodeType === 1 && depth < 3; depth++) {
        const cls = (node.getAttribute("class") || "")
          .trim().split(/\\s+/).filter((c) => c !== "").slice(0, 3).join(".");
        parts.unshift(node.tagName.toLowerCase() + (cls ? "." + cls : ""));
        node = node.parentElement;
      }
      return parts.join(" > ");
    };
    let all;
    try {
      all = Array.from(root.querySelectorAll(${JSON.stringify(selector)}));
    } catch (error) {
      return { editor: !!editor, badSelector: error instanceof Error ? error.message : String(error) };
    }
    const widgets = all.slice(0, ${JSON.stringify(cap)}).map((el, index) => {
      const r = el.getBoundingClientRect();
      let docPos = null;
      try {
        if (cm && typeof cm.posAtDOM === "function") {
          const offset = cm.posAtDOM(el);
          const pos = editor && editor.offsetToPos ? editor.offsetToPos(offset) : null;
          docPos = pos ? { offset, line: pos.line, ch: pos.ch } : { offset };
        }
      } catch (e) {
        docPos = null;
      }
      return {
        index,
        cssPath: cssPath(el),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        docPos,
        textPreview: (el.textContent || "").slice(0, 120),
      };
    });
    return { editor: !!editor, total: all.length, returned: widgets.length, widgets };
  })()`;
}
