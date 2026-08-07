/**
 * Toolset gating.
 *
 * The proxied @playwright/mcp surface alone is 24 tools by default and 69 with every
 * capability enabled. Stacked on the Obsidian surface that is well over 100 tools,
 * which is more context than a session should carry and measurably degrades tool
 * selection. Gating is a correctness feature here, not a convenience.
 */

export const TOOLSETS = [
  "core",
  "workspace",
  "ui",
  "telemetry",
  "plugin-dev",
  "editor",
  "vault",
  "devtools",
  "authoring",
] as const;

export type Toolset = (typeof TOOLSETS)[number];

/** Operational tools are opt-in. Control-plane tools use `alwaysEnabled`. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = [];

export const TOOLSET_DESCRIPTIONS: Record<Toolset, string> = {
  core: "Status, doctor, launch, eval, CLI, and command-palette execution.",
  workspace:
    "Explicit agent and workspace handles for isolated scratch instances or the default profile.",
  ui: "Browser automation over CDP (proxied from @playwright/mcp) plus Obsidian-scoped snapshots.",
  telemetry: "Console, error, and network capture with cursor-based tailing.",
  "plugin-dev": "Plugin reload, manifest and settings inspection, and dev-cycle composites.",
  editor:
    "Active-editor state (mode, cursor, doc hash), cursor and selection control, hash-guarded " +
    "text edits, and widget/decoration queries.",
  vault: "File and note CRUD, search, tabs, and graph queries (backlinks, orphans, aliases).",
  devtools: "Raw CDP passthrough, DOM/CSS inspection, OS-window screenshots, and mobile emulation.",
  authoring: "Themes, snippets, frontmatter properties, tags, tasks, daily notes, and templates.",
};

export function isToolset(value: string): value is Toolset {
  return (TOOLSETS as readonly string[]).includes(value);
}

export interface ToolsetParseResult {
  enabled: Set<Toolset>;
  unknown: string[];
}

/**
 * Parse a comma-separated toolset spec. `all` enables everything. Unknown names are
 * collected rather than thrown so the server can warn and continue — a typo in an
 * env var should not prevent startup.
 */
export function parseToolsets(spec: string | undefined): ToolsetParseResult {
  if (spec === undefined || spec.trim() === "") {
    return { enabled: new Set(DEFAULT_TOOLSETS), unknown: [] };
  }

  const tokens = spec
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== "");

  if (tokens.includes("all")) {
    return { enabled: new Set(TOOLSETS), unknown: [] };
  }

  const enabled = new Set<Toolset>();
  const unknown: string[] = [];
  for (const token of tokens) {
    if (isToolset(token)) enabled.add(token);
    else unknown.push(token);
  }

  // An all-garbage spec falls back to the empty operational surface.
  if (enabled.size === 0) return { enabled: new Set(DEFAULT_TOOLSETS), unknown };

  return { enabled, unknown };
}
