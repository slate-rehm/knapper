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

import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import { z, type ZodRawShape } from "zod";
import type { Capability } from "../capabilities.js";
import type { Toolset } from "../toolsets.js";
import type { Logger } from "../util/logger.js";
import type { TelemetryStore } from "../telemetry/store.js";
import { appendTelemetrySummary } from "../telemetry/helpers.js";
import { toUobError, UobError } from "../util/errors.js";
import { CallLock, type LockMode } from "../util/concurrency.js";
import { renderResult, safeStringify } from "../util/serialize.js";
import { jsonSchemaToZodShape } from "../browser/json-schema.js";
import type { DefaultProfileLease } from "../session/default-profile-lease.js";
import { errorEnvelope, requestId, toolAuditEvent } from "../audit/event.js";
import { JsonlAuditWriter } from "../audit/writer.js";
import type {
  AuditCallContext,
  AuditErrorEnvelope,
  AuditSink,
  ToolRegistryHooks,
  ToolRequestContext,
} from "../audit/types.js";

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
  /** Zod output shape for tools defined in this repo. */
  outputSchema?: ZodRawShape;
  /** JSON Schema for proxied tools (converted to Zod at registration). */
  jsonOutputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  /** This tool never reads or drives the installation's default Obsidian profile. */
  profileIndependent?: boolean | ((args: Record<string, unknown>) => boolean);
  /** This control-plane tool does not require or bind a workspace handle. */
  workspaceIndependent?: boolean;
  /** A workspace-control tool must hold the same exclusive lease as operational tools. */
  requiresWorkspaceLease?: boolean;
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
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
}

function structuredContent(value: unknown): Record<string, unknown> {
  const rendered = safeStringify(value, 0);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered) as unknown;
  } catch {
    parsed = rendered;
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { result: parsed };
}

function normalize(outcome: ToolOutcome): McpToolResult {
  if (typeof outcome === "object" && outcome !== null && "mcp" in outcome) {
    return outcome.mcp;
  }

  if (typeof outcome === "string") {
    return {
      content: [{ type: "text", text: outcome }],
      structuredContent: { result: outcome },
    };
  }

  const content: McpContent[] = [];
  const text = "text" in outcome ? outcome.text : undefined;
  const json = "json" in outcome ? outcome.json : undefined;

  if (text !== undefined && text !== "") {
    content.push({ type: "text", text });
  }

  if (json !== undefined) {
    if (text === undefined || text === "") {
      content.push({ type: "text", text: renderResult(json).text });
    }
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
  return {
    content,
    structuredContent: json !== undefined ? structuredContent(json) : { result: text ?? null },
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(err: UobError): McpToolResult {
  return {
    content: [{ type: "text", text: err.toText() }],
    structuredContent: structuredContent(err.toJSON()),
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
  return {
    ...outcome,
    text: appendTelemetrySummary(outcome.text, store, sinceSeq),
  };
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();
  private readonly handles = new Map<string, RegisteredTool>();
  private readonly lock: CallLock;
  private readonly audit: AuditSink | false;

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
    private readonly profileLease?: DefaultProfileLease,
    private readonly sessionBound: () => boolean = () => false,
    private readonly hooks: ToolRegistryHooks = {},
  ) {
    this.enabledToolsets = new Set(enabledToolsets);
    this.lock = new CallLock({ maxShared: maxConcurrency });
    this.audit = hooks.audit === undefined ? new JsonlAuditWriter() : hooks.audit;
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

  /** Search all retained definitions without changing the enabled surface. */
  catalog(options: {
    query?: string;
    toolset?: Toolset;
    enabled?: boolean;
    cursor?: string;
    limit?: number;
    detail?: "summary" | "full";
  }): {
    items: Array<{
      name: string;
      toolset: Toolset;
      enabled: boolean;
      description?: string;
      capability?: Capability | null;
      annotations?: ToolAnnotations;
    }>;
    total: number;
    nextCursor?: string;
  } {
    const query = options.query?.trim().toLowerCase() ?? "";
    const offset = options.cursor === undefined ? 0 : Number(options.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new UobError("INVALID_ARGUMENT", "The catalog cursor is invalid.", {
        remediation: "Use the nextCursor value from the previous obsidian_tool_catalog result.",
      });
    }

    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const definitions = [...this.definitions.values()]
      .filter((def) => options.toolset === undefined || def.toolset === options.toolset)
      .filter(
        (def) => options.enabled === undefined || this.isDefinitionEnabled(def) === options.enabled,
      )
      .filter((def) => {
        if (query === "") return true;
        return `${def.name}\n${def.toolset}\n${def.description}`.toLowerCase().includes(query);
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const items = definitions.slice(offset, offset + limit).map((def) => ({
      name: def.name,
      toolset: def.toolset,
      enabled: this.isDefinitionEnabled(def),
      ...(options.detail === "full"
        ? {
            description: def.description,
            capability: def.capability ?? null,
            annotations: { readOnlyHint: false, ...def.annotations },
          }
        : {}),
    }));
    const nextOffset = offset + items.length;
    return {
      items,
      total: definitions.length,
      ...(nextOffset < definitions.length ? { nextCursor: String(nextOffset) } : {}),
    };
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
      const shape = def.jsonInputSchema
        ? jsonSchemaToZodShape(def.jsonInputSchema)
        : (def.inputSchema ?? {});
      config.inputSchema =
        def.workspaceIndependent === true
          ? shape
          : {
              ...shape,
              workspaceHandle: z
                .string()
                .describe("Explicit workspace handle returned by an obsidian_workspace_* tool."),
            };
      if (def.jsonOutputSchema) {
        config.outputSchema = jsonSchemaToZodShape(def.jsonOutputSchema);
      } else if (def.outputSchema) {
        config.outputSchema = def.outputSchema;
      } else if (def.jsonInputSchema === undefined) {
        // Native tools always return structuredContent. A permissive base schema
        // gives hosts the MCP contract even when a tool's more specific schema has
        // not been declared yet.
        config.outputSchema = z.looseObject({});
      }
      config.annotations = { readOnlyHint: false, ...def.annotations };

      const handle = server.registerTool(
        def.name,
        config as never,
        (async (
          args: Record<string, unknown>,
          requestContext?: ToolRequestContext,
        ): Promise<McpToolResult> => {
          const started = Date.now();
          const timestamp = new Date(started).toISOString();
          const callRequestId = requestId(requestContext);
          const callArgs = args ?? {};
          let queueMs = 0;
          let admitted = false;
          let auditContext: AuditCallContext | undefined;
          let auditOutcome: "success" | "error" = "success";
          let auditError: AuditErrorEnvelope | undefined;
          // Workspace binding mutates the shared router, capture, telemetry
          // delegate, and configuration. Keep the exclusive grant through the
          // complete handler so a second workspace cannot rebind mid-call.
          const mode: LockMode =
            def.workspaceIndependent === true && def.annotations?.readOnlyHint === true
              ? "shared"
              : "exclusive";
          try {
            return await this.lock.run(mode, def.name, async () => {
              // Read the telemetry cursor after admission, not before: a call that
              // waited in the queue would otherwise report every log line produced
              // by the calls it was queued behind.
              const sinceSeq = this.telemetry?.cursor ?? 0;
              const ranAt = Date.now();
              admitted = true;
              queueMs = ranAt - started;
              await this.hooks.beforeInvoke?.(def, callArgs, requestContext);
              auditContext = await this.hooks.contextProvider?.(callArgs, requestContext);
              const invoke = (): Promise<ToolOutcome> => def.handler(callArgs);
              const profileIndependent =
                typeof def.profileIndependent === "function"
                  ? def.profileIndependent(callArgs)
                  : def.profileIndependent === true;
              let outcome =
                profileIndependent || this.sessionBound() || !this.profileLease
                  ? await invoke()
                  : await this.profileLease.run(def.name, invoke);
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
              const result = normalize(outcome);
              if (result.isError === true) {
                auditOutcome = "error";
                auditError = {
                  type: "ToolResultError",
                  code: "TOOL_ERROR",
                  message: "The tool call failed.",
                  retriable: false,
                };
              }
              return result;
            });
          } catch (e) {
            const err = toUobError(e);
            auditOutcome = "error";
            auditError = errorEnvelope(err);
            this.logger.warn("tool failed", {
              tool: def.name,
              code: err.code,
              ms: Date.now() - started,
            });
            return errorResult(err);
          } finally {
            if (this.audit !== false) {
              try {
                await this.audit.write(
                  toolAuditEvent({
                    timestamp,
                    requestId: callRequestId,
                    tool: def.name,
                    durationMs: Date.now() - started,
                    queueMs: admitted ? queueMs : Date.now() - started,
                    outcome: auditOutcome,
                    args: callArgs,
                    ...(auditContext ? { context: auditContext } : {}),
                    ...(auditError ? { error: auditError } : {}),
                  }),
                );
              } catch (auditFailure) {
                this.logger.warn("audit write failed", {
                  tool: def.name,
                  error: auditFailure instanceof Error ? auditFailure.name : "UnknownAuditError",
                });
              }
            }
          }
        }) as never,
      );
      this.handles.set(def.name, handle);
      if (!this.isDefinitionEnabled(def)) handle.disable();
    }
    this.logger.info(`registered ${this.definitions.size} tools`, this.byToolset());
  }
}
