/**
 * Tool registry with toolset and capability gating.
 *
 * Tools declare the toolset they belong to and the capability they need. The
 * registry skips registration when the toolset is disabled, so a session only
 * carries the tools it can actually use. Capability availability is checked at
 * call time rather than registration time, because a transport can appear or
 * disappear while the server is running (Obsidian restarts, debug port opens).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { Capability } from "../capabilities.js";
import type { Toolset } from "../toolsets.js";
import type { Logger } from "../util/logger.js";
/** What a tool handler may return; the registry normalizes it to MCP content. */
export type ToolOutcome =
  | string
  | {
      text: string;
      json?: unknown;
      images?: ToolImage[];
      isError?: boolean;
    }
  | {
      json: unknown;
      text?: string;
    };
export interface ToolImage {
  /** Base64-encoded image data. */
  data: string;
  mimeType: string;
}
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
export interface ToolDefinition<S extends ZodRawShape = ZodRawShape> {
  name: string;
  toolset: Toolset;
  /** Capability required to serve this tool, if any. */
  capability?: Capability;
  description: string;
  inputSchema?: S;
  annotations?: ToolAnnotations;
  handler: (args: Record<string, unknown>) => Promise<ToolOutcome>;
}
type McpContent =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      data: string;
      mimeType: string;
    };
export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
  [key: string]: unknown;
}
export declare class ToolRegistry {
  private readonly enabledToolsets;
  private readonly logger;
  private readonly definitions;
  constructor(enabledToolsets: Set<Toolset>, logger: Logger);
  /** Register a tool, or skip it when its toolset is disabled. */
  add<S extends ZodRawShape>(def: ToolDefinition<S>): void;
  addAll(defs: ToolDefinition[]): void;
  names(): string[];
  get(name: string): ToolDefinition | undefined;
  /** Tools grouped by toolset, for diagnostics. */
  byToolset(): Record<string, string[]>;
  /**
   * Bind every registered tool onto an MCP server, wrapping each handler so that
   * connection setup and error mapping live in exactly one place.
   */
  bind(server: McpServer): void;
}
