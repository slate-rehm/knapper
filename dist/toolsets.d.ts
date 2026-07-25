/**
 * Toolset gating.
 *
 * The proxied @playwright/mcp surface alone is 24 tools by default and 69 with every
 * capability enabled. Stacked on the Obsidian surface that is well over 100 tools,
 * which is more context than a session should carry and measurably degrades tool
 * selection. Gating is a correctness feature here, not a convenience.
 */
export declare const TOOLSETS: readonly [
  "core",
  "ui",
  "telemetry",
  "plugin-dev",
  "vault",
  "devtools",
  "authoring",
];
export type Toolset = (typeof TOOLSETS)[number];
/**
 * The plugin-development surface. Vault CRUD is opt-in because other Obsidian MCP
 * servers already cover it well, and `devtools`/`authoring` are niche.
 */
export declare const DEFAULT_TOOLSETS: readonly Toolset[];
export declare const TOOLSET_DESCRIPTIONS: Record<Toolset, string>;
export declare function isToolset(value: string): value is Toolset;
export interface ToolsetParseResult {
  enabled: Set<Toolset>;
  unknown: string[];
}
/**
 * Parse a comma-separated toolset spec. `all` enables everything. Unknown names are
 * collected rather than thrown so the server can warn and continue — a typo in an
 * env var should not prevent startup.
 */
export declare function parseToolsets(spec: string | undefined): ToolsetParseResult;
