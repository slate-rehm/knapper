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
  "ui",
  "telemetry",
  "plugin-dev",
  "vault",
  "devtools",
  "authoring",
] as const;

export type Toolset = (typeof TOOLSETS)[number];

/**
 * The plugin-development surface. Vault CRUD is opt-in because other Obsidian MCP
 * servers already cover it well, and `devtools`/`authoring` are niche.
 */
export const DEFAULT_TOOLSETS: readonly Toolset[] = ["core", "ui", "telemetry", "plugin-dev"];

export const TOOLSET_DESCRIPTIONS: Record<Toolset, string> = {
  core: "Status, doctor, launch, eval, and command execution.",
  ui: "Browser automation over CDP (proxied from @playwright/mcp) plus Obsidian-scoped snapshots.",
  telemetry: "Console, error, and network capture with cursor-based tailing.",
  "plugin-dev": "Plugin reload, manifest and settings inspection, and dev-cycle composites.",
  vault: "File and note CRUD, search, properties, tags, and tasks.",
  devtools: "Raw CDP passthrough, DOM/CSS inspection, and mobile emulation.",
  authoring: "Themes, snippets, daily notes, and metadata authoring.",
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

  // An all-garbage spec falls back to defaults rather than registering nothing.
  if (enabled.size === 0) return { enabled: new Set(DEFAULT_TOOLSETS), unknown };

  return { enabled, unknown };
}
