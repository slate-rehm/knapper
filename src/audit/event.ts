import { createHash, randomUUID } from "node:crypto";
import { UobError } from "../util/errors.js";
import type {
  AuditArgumentMetadata,
  AuditCallContext,
  AuditErrorEnvelope,
  ToolAuditEvent,
  ToolRequestContext,
} from "./types.js";

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Record shape only. Argument values can contain note text, code, or settings. */
export function argumentMetadata(args: Record<string, unknown>): AuditArgumentMetadata {
  const entries = Object.keys(args)
    .map((key) => ({ key: safeLabel(key) ?? "[redacted]", type: valueType(args[key]) }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return {
    count: entries.length,
    keys: entries.map((entry) => entry.key),
    types: Object.fromEntries(entries.map((entry) => [entry.key, entry.type])),
    redacted: true,
  };
}

function safeLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,127}$/.test(value) ? value : "[redacted]";
}

function opaqueIdentifier(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function safeContext(context: AuditCallContext | undefined): AuditCallContext {
  if (!context) return {};
  const clientName = opaqueIdentifier(context.clientInfo?.name);
  const clientVersion = opaqueIdentifier(context.clientInfo?.version);
  return {
    ...(clientName
      ? { clientInfo: { name: clientName, ...(clientVersion ? { version: clientVersion } : {}) } }
      : {}),
    ...(opaqueIdentifier(context.agentHandle)
      ? { agentHandle: opaqueIdentifier(context.agentHandle) }
      : {}),
    ...(opaqueIdentifier(context.workspaceHandle)
      ? { workspaceHandle: opaqueIdentifier(context.workspaceHandle) }
      : {}),
    ...(safeLabel(context.transport) ? { transport: safeLabel(context.transport) } : {}),
    ...(safeLabel(context.protocolVersion)
      ? { protocolVersion: safeLabel(context.protocolVersion) }
      : {}),
    ...(opaqueIdentifier(context.traceId) ? { traceId: opaqueIdentifier(context.traceId) } : {}),
    ...(safeLabel(context.workspaceKind)
      ? { workspaceKind: safeLabel(context.workspaceKind) }
      : {}),
  };
}

export function requestId(context: ToolRequestContext | undefined): string {
  const supplied = context?.requestId ?? context?.mcpReq?.id;
  if (typeof supplied === "number" || typeof supplied === "string") {
    return opaqueIdentifier(String(supplied)) ?? randomUUID();
  }
  return randomUUID();
}

/** Error messages stay generic because thrown text can contain private input. */
export function errorEnvelope(error: unknown): AuditErrorEnvelope {
  if (error instanceof UobError) {
    return {
      type: error.name,
      code: error.code,
      message: "The tool call failed.",
      retriable: error.code === "TIMEOUT" || error.code === "APP_UNAVAILABLE",
    };
  }
  return {
    type: error instanceof Error ? (safeLabel(error.name) ?? "Error") : "UnknownError",
    code: "INTERNAL",
    message: "The tool call failed.",
    retriable: false,
  };
}

export function toolAuditEvent(input: {
  timestamp: string;
  requestId: string;
  tool: string;
  durationMs: number;
  queueMs: number;
  outcome: "success" | "error";
  args: Record<string, unknown>;
  context?: AuditCallContext;
  error?: AuditErrorEnvelope;
}): ToolAuditEvent {
  const context = safeContext(input.context);
  return {
    schema_version: 1,
    event: "tool.call",
    timestamp: input.timestamp,
    request_id: input.requestId,
    ...(context.traceId ? { trace_id: context.traceId } : {}),
    service: "knapper",
    tool: input.tool,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    queue_ms: Math.max(0, Math.round(input.queueMs)),
    outcome: input.outcome,
    arguments: argumentMetadata(input.args),
    ...(input.error ? { error: input.error } : {}),
    ...(context.clientInfo ? { client: context.clientInfo } : {}),
    ...(context.agentHandle ? { agent_handle: context.agentHandle } : {}),
    ...(context.workspaceHandle ? { workspace_handle: context.workspaceHandle } : {}),
    ...(context.transport ? { transport: context.transport } : {}),
    ...(context.protocolVersion ? { protocol_version: context.protocolVersion } : {}),
    ...(context.workspaceKind ? { workspace_kind: context.workspaceKind } : {}),
  };
}
