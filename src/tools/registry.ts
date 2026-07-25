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
import type { TelemetryStore } from "../telemetry/store.js";
import { appendTelemetrySummary } from "../telemetry/helpers.js";
import { toUobError, UobError } from "../util/errors.js";
import { renderResult } from "../util/serialize.js";
import { jsonSchemaToZodShape } from "../browser/json-schema.js";

/** What a tool handler may return; the registry normalizes it to MCP content. */
export type ToolOutcome =
  | string
  | { text: string; json?: unknown; images?: ToolImage[]; isError?: boolean }
  | { json: unknown; text?: string }
  /** Pass through MCP content verbatim (used for proxied @playwright/mcp tools). */
  | { mcp: McpToolResult };

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
  /** Zod shape for tools defined in this repo. */
  inputSchema?: S;
  /** JSON Schema for proxied tools (converted to Zod at registration). */
  jsonInputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  /**
   * When true, the tool already appends a telemetry summary (e.g. composites that
   * bracket with a mark). Skip the registry-level mutator suffix.
   */
  handlesOwnTelemetry?: boolean;
  handler: (args: Record<string, unknown>) => Promise<ToolOutcome>;
}

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
  [key: string]: unknown;
}

function normalize(outcome: ToolOutcome): McpToolResult {
  if (typeof outcome === "object" && outcome !== null && "mcp" in outcome) {
    return outcome.mcp;
  }

  if (typeof outcome === "string") {
    return { content: [{ type: "text", text: outcome }] };
  }

  const content: McpContent[] = [];
  const text = "text" in outcome ? outcome.text : undefined;
  const json = "json" in outcome ? outcome.json : undefined;

  if (text !== undefined && text !== "") {
    content.push({ type: "text", text });
  }

  // Structured payload is appended as fenced JSON so agents get machine-readable
  // data without needing a second call, while still reading naturally as text.
  if (json !== undefined) {
    const rendered = renderResult(json);
    content.push({ type: "text", text: `\`\`\`json\n${rendered.text}\n\`\`\`` });
  }

  if ("images" in outcome && outcome.images) {
    for (const img of outcome.images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  }

  if (content.length === 0) {
    content.push({ type: "text", text: "(no output)" });
  }

  const isError = "isError" in outcome ? outcome.isError : undefined;
  return isError ? { content, isError: true } : { content };
}

function errorResult(err: UobError): McpToolResult {
  return {
    content: [
      { type: "text", text: err.toText() },
      { type: "text", text: `\`\`\`json\n${JSON.stringify(err.toJSON(), null, 2)}\n\`\`\`` },
    ],
    isError: true,
  };
}

function withTelemetrySuffix(
  outcome: ToolOutcome,
  store: TelemetryStore,
  sinceSeq: number,
): ToolOutcome {
  if (typeof outcome === "string") {
    return appendTelemetrySummary(outcome, store, sinceSeq);
  }
  if ("mcp" in outcome) return outcome;
  if (outcome.text === undefined) return outcome;
  return { ...outcome, text: appendTelemetrySummary(outcome.text, store, sinceSeq) };
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  constructor(
    private readonly enabledToolsets: Set<Toolset>,
    private readonly logger: Logger,
    private readonly telemetry?: TelemetryStore,
  ) {}

  /** Register a tool, or skip it when its toolset is disabled. */
  add<S extends ZodRawShape>(def: ToolDefinition<S>): void {
    if (!this.enabledToolsets.has(def.toolset)) {
      this.logger.debug(`skipping tool (toolset disabled)`, {
        tool: def.name,
        toolset: def.toolset,
      });
      return;
    }
    if (this.definitions.has(def.name)) {
      throw new Error(`Duplicate tool registration: ${def.name}`);
    }
    this.definitions.set(def.name, def as unknown as ToolDefinition);
  }

  addAll(defs: ToolDefinition[]): void {
    for (const def of defs) this.add(def);
  }

  names(): string[] {
    return [...this.definitions.keys()].sort();
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  /** Tools grouped by toolset, for diagnostics. */
  byToolset(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const def of this.definitions.values()) {
      (out[def.toolset] ??= []).push(def.name);
    }
    for (const list of Object.values(out)) list.sort();
    return out;
  }

  /**
   * Bind every registered tool onto an MCP server, wrapping each handler so that
   * connection setup and error mapping live in exactly one place.
   */
  bind(server: McpServer): void {
    for (const def of this.definitions.values()) {
      const config: Record<string, unknown> = { description: def.description };
      if (def.jsonInputSchema) config.inputSchema = jsonSchemaToZodShape(def.jsonInputSchema);
      else if (def.inputSchema) config.inputSchema = def.inputSchema;
      if (def.annotations) config.annotations = def.annotations;

      server.registerTool(
        def.name,
        config as never,
        (async (args: Record<string, unknown>) => {
          const started = Date.now();
          const sinceSeq = this.telemetry?.cursor ?? 0;
          try {
            let outcome = await def.handler(args ?? {});
            if (
              this.telemetry &&
              def.annotations?.readOnlyHint !== true &&
              def.handlesOwnTelemetry !== true
            ) {
              outcome = withTelemetrySuffix(outcome, this.telemetry, sinceSeq);
            }
            this.logger.debug("tool ok", { tool: def.name, ms: Date.now() - started });
            return normalize(outcome);
          } catch (e) {
            const err = toUobError(e);
            this.logger.warn("tool failed", {
              tool: def.name,
              code: err.code,
              ms: Date.now() - started,
            });
            return errorResult(err);
          }
        }) as never,
      );
    }
    this.logger.info(`registered ${this.definitions.size} tools`, this.byToolset());
  }
}
