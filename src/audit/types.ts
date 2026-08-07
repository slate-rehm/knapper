import type { ToolDefinition } from "../tools/registry.js";

export interface AuditClientInfo {
  name: string;
  version?: string;
}

/** Optional request data supplied by the server and workspace layers. */
export interface AuditCallContext {
  clientInfo?: AuditClientInfo;
  agentHandle?: string;
  workspaceHandle?: string;
  transport?: string;
  protocolVersion?: string;
  traceId?: string;
  workspaceKind?: string;
}

export interface ToolRequestContext {
  requestId?: string | number;
  sessionId?: string;
  mcpReq?: {
    id?: string | number;
    envelope?: {
      protocolVersion?: string;
      clientInfo?: { name?: string; version?: string; title?: string };
    };
  };
  [key: string]: unknown;
}

export interface AuditArgumentMetadata {
  count: number;
  keys: string[];
  types: Record<string, string>;
  redacted: true;
}

export interface AuditErrorEnvelope {
  type: string;
  code: string;
  message: string;
  retriable: boolean;
}

export interface ToolAuditEvent {
  schema_version: 1;
  event: "tool.call";
  timestamp: string;
  request_id: string;
  trace_id?: string;
  service: "knapper";
  tool: string;
  duration_ms: number;
  queue_ms: number;
  outcome: "success" | "error";
  arguments: AuditArgumentMetadata;
  error?: AuditErrorEnvelope;
  client?: AuditClientInfo;
  agent_handle?: string;
  workspace_handle?: string;
  transport?: string;
  protocol_version?: string;
  workspace_kind?: string;
}

export interface AuditSink {
  write(event: ToolAuditEvent): Promise<void>;
}

export interface ToolRegistryHooks {
  audit?: AuditSink | false;
  beforeInvoke?: (
    definition: ToolDefinition,
    args: Record<string, unknown>,
    requestContext?: ToolRequestContext,
  ) => void | Promise<void>;
  contextProvider?: (
    args: Record<string, unknown>,
    requestContext?: ToolRequestContext,
  ) => AuditCallContext | undefined | Promise<AuditCallContext | undefined>;
}
