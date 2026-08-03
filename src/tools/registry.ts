/**
 * Tool registry with toolset and capability gating.
 *
 * Tools declare the toolset they belong to and the capability they need. The
 * registry skips registration when the toolset is disabled, so a session only
 * carries the tools it can actually use. Capability availability is checked at
 * call time rather than registration time, because a transport can appear or
 * disappear while the server is running (Obsidian restarts, debug port opens).
 *
 * Dispatch is also where call admission happens. Every tool drives the same live
 * Obsidian window, so a mutating call takes the exclusive lock and a read-only
 * call takes a bounded shared one. Classification comes from the `readOnlyHint`
 * annotation each tool already declares, and defaults to exclusive when the hint
 * is absent — an unannotated tool is assumed to touch the UI.
 */

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import type { Capability } from "../capabilities.js";
import type { Toolset } from "../toolsets.js";
import type { Logger } from "../util/logger.js";
import type { TelemetryStore } from "../telemetry/store.js";
import { appendTelemetrySummary } from "../telemetry/helpers.js";
import { toUobError, UobError } from "../util/errors.js";
import { CallLock, type LockMode } from "../util/concurrency.js";
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
  /** Keep this control-plane tool enabled even when its toolset is disabled. */
  alwaysEnabled?: boolean;
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
  private readonly handles = new Map<string, RegisteredTool>();
  private readonly lock: CallLock;

  constructor(
    enabledToolsets: Set<Toolset>,
    private readonly logger: Logger,
    /**
     * Read-only calls allowed to overlap.
     *
     * Required rather than defaulted: this used to fall back to `loadConfig()`,
     * which both broke the repo's own "config lives in config.ts" rule and, once
     * sessions existed, would size the lock from the *unbound* environment while
     * the rest of the server ran against a session.
     */
    maxConcurrency: number,
    private readonly telemetry?: TelemetryStore,
  ) {
    this.enabledToolsets = new Set(enabledToolsets);
    this.lock = new CallLock({ maxShared: maxConcurrency });
  }

  private readonly enabledToolsets: Set<Toolset>;

  /** Retain every definition so its toolset can be enabled at runtime. */
  add<S extends ZodRawShape>(def: ToolDefinition<S>): void {
    if (this.definitions.has(def.name)) {
      throw new Error(`Duplicate tool registration: ${def.name}`);
    }
    this.definitions.set(def.name, def as unknown as ToolDefinition);
  }

  addAll(defs: ToolDefinition[]): void {
    for (const def of defs) this.add(def);
  }

  names(): string[] {
    return [...this.definitions.values()]
      .filter((def) => this.isDefinitionEnabled(def))
      .map((def) => def.name)
      .sort();
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  /** Tools grouped by toolset, for diagnostics. */
  byToolset(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const def of this.definitions.values()) {
      if (!this.isDefinitionEnabled(def)) continue;
      (out[def.toolset] ??= []).push(def.name);
    }
    for (const list of Object.values(out)) list.sort();
    return out;
  }

  /** Current runtime toolset state. */
  toolsetState(): { enabled: Toolset[]; disabled: Toolset[] } {
    const enabled: Toolset[] = [];
    const disabled: Toolset[] = [];
    for (const toolset of Object.keys(this.groupAllByToolset()) as Toolset[]) {
      (this.enabledToolsets.has(toolset) ? enabled : disabled).push(toolset);
    }
    enabled.sort();
    disabled.sort();
    return { enabled, disabled };
  }

  isToolsetEnabled(toolset: Toolset): boolean {
    return this.enabledToolsets.has(toolset);
  }

  /** Enable or disable one toolset through the SDK registration handles. */
  setToolsetEnabled(toolset: Toolset, enabled: boolean): string[] {
    if (enabled) this.enabledToolsets.add(toolset);
    else this.enabledToolsets.delete(toolset);

    const changed: string[] = [];
    for (const def of this.definitions.values()) {
      if (def.toolset !== toolset || def.alwaysEnabled === true) continue;
      const handle = this.handles.get(def.name);
      if (!handle || handle.enabled === enabled) continue;
      if (enabled) handle.enable();
      else handle.disable();
      changed.push(def.name);
    }
    return changed.sort();
  }

  /** All retained definitions grouped by toolset, including disabled tools. */
  groupAllByToolset(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const def of this.definitions.values()) {
      (out[def.toolset] ??= []).push(def.name);
    }
    for (const list of Object.values(out)) list.sort();
    return out;
  }

  private isDefinitionEnabled(def: ToolDefinition): boolean {
    return def.alwaysEnabled === true || this.enabledToolsets.has(def.toolset);
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

      const handle = server.registerTool(
        def.name,
        config as never,
        (async (args: Record<string, unknown>) => {
          const started = Date.now();
          const mode: LockMode = def.annotations?.readOnlyHint === true ? "shared" : "exclusive";
          try {
            return await this.lock.run(mode, def.name, async () => {
              // Read the telemetry cursor after admission, not before: a call that
              // waited in the queue would otherwise report every log line produced
              // by the calls it was queued behind.
              const sinceSeq = this.telemetry?.cursor ?? 0;
              const ranAt = Date.now();
              let outcome = await def.handler(args ?? {});
              if (
                this.telemetry &&
                def.annotations?.readOnlyHint !== true &&
                def.handlesOwnTelemetry !== true
              ) {
                outcome = withTelemetrySuffix(outcome, this.telemetry, sinceSeq);
              }
              this.logger.debug("tool ok", {
                tool: def.name,
                ms: Date.now() - ranAt,
                queuedMs: ranAt - started,
              });
              return normalize(outcome);
            });
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
      this.handles.set(def.name, handle);
      if (!this.isDefinitionEnabled(def)) handle.disable();
    }
    this.logger.info(`registered ${this.definitions.size} tools`, this.byToolset());
  }
}
