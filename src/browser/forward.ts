/**
 * Convert proxied @playwright/mcp tool results into registry outcomes.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpToolResult, ToolOutcome } from "../tools/registry.js";

/** Preserve upstream MCP content (snapshot links, images, YAML) without re-wrapping. */
export function passthroughMcpResult(result: CallToolResult): ToolOutcome {
  const content = result.content.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    if (part.type === "image") {
      return { type: "image" as const, data: part.data, mimeType: part.mimeType };
    }
    // Resource and other part types are rare from Playwright MCP; stringify as text.
    return { type: "text" as const, text: JSON.stringify(part) };
  });

  const mcp: McpToolResult = { content };
  if (result.isError) mcp.isError = true;
  return { mcp };
}
