import { describe, expect, it, vi } from "vitest";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createLogger } from "../../src/util/logger.js";
import type { ToolAuditEvent } from "../../src/audit/types.js";

type ToolCallback = (
  args: Record<string, unknown>,
  context?: { requestId?: string | number },
) => Promise<{
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function fakeServer(
  handles: Map<string, RegisteredTool>,
  callbacks?: Map<string, ToolCallback>,
): McpServer {
  return {
    registerTool: vi.fn((name: string, _config: unknown, callback: ToolCallback) => {
      const handle = {
        enabled: true,
        enable() {
          this.enabled = true;
        },
        disable() {
          this.enabled = false;
        },
      } as RegisteredTool;
      handles.set(name, handle);
      callbacks?.set(name, callback);
      return handle;
    }),
  } as unknown as McpServer;
}

describe("ToolRegistry runtime toolsets", () => {
  it("keeps workspace binding exclusive through a read-only handler", async () => {
    const handles = new Map<string, RegisteredTool>();
    const callbacks = new Map<string, ToolCallback>();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const registry = new ToolRegistry(
      new Set(["core"]),
      createLogger("error"),
      4,
      undefined,
      undefined,
      undefined,
      {
        audit: false,
        beforeInvoke: async (_definition, args) => {
          order.push(`bind:${String(args.workspaceHandle)}`);
        },
      },
    );
    registry.add({
      name: "workspace_read",
      toolset: "core",
      description: "Read one workspace through the shared runtime.",
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        order.push(`start:${String(args.workspaceHandle)}`);
        if (args.workspaceHandle === "first") await firstBlocked;
        order.push(`end:${String(args.workspaceHandle)}`);
        return "ok";
      },
    });
    registry.bind(fakeServer(handles, callbacks));

    const first = callbacks.get("workspace_read")?.({ workspaceHandle: "first" });
    await vi.waitFor(() => expect(order).toContain("start:first"));
    const second = callbacks.get("workspace_read")?.({ workspaceHandle: "second" });

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "bind:first",
      "start:first",
      "end:first",
      "bind:second",
      "start:second",
      "end:second",
    ]);
  });

  it("retains disabled definitions and enables them through SDK handles", () => {
    const handles = new Map<string, RegisteredTool>();
    const registry = new ToolRegistry(new Set(["core"]), createLogger("error"), 2);
    registry.add({
      name: "browser_example",
      toolset: "ui",
      description: "Browser example.",
      handler: async () => "ok",
    });
    registry.bind(fakeServer(handles));

    expect(handles.get("browser_example")?.enabled).toBe(false);
    expect(registry.toolsetState().disabled).toContain("ui");

    expect(registry.setToolsetEnabled("ui", true)).toEqual(["browser_example"]);
    expect(handles.get("browser_example")?.enabled).toBe(true);
    expect(registry.byToolset().ui).toEqual(["browser_example"]);
  });

  it("keeps control-plane tools enabled with their toolset disabled", () => {
    const handles = new Map<string, RegisteredTool>();
    const registry = new ToolRegistry(new Set(["core"]), createLogger("error"), 2);
    registry.add({
      name: "obsidian_toolsets",
      toolset: "core",
      alwaysEnabled: true,
      description: "Manage toolsets.",
      handler: async () => "ok",
    });
    registry.bind(fakeServer(handles));

    registry.setToolsetEnabled("core", false);

    expect(handles.get("obsidian_toolsets")?.enabled).toBe(true);
    expect(registry.names()).toContain("obsidian_toolsets");
  });

  it("returns native structured content without duplicate fenced JSON", async () => {
    const handles = new Map<string, RegisteredTool>();
    const callbacks = new Map<string, ToolCallback>();
    const registry = new ToolRegistry(
      new Set(["core"]),
      createLogger("error"),
      2,
      undefined,
      undefined,
      undefined,
      { audit: false },
    );
    registry.add({
      name: "structured_example",
      toolset: "core",
      description: "Structured example.",
      handler: async () => ({ text: "Found 2 items.", json: { count: 2, items: ["a", "b"] } }),
    });
    registry.bind(fakeServer(handles, callbacks));

    const result = await callbacks.get("structured_example")?.({}, { requestId: 7 });

    expect(result?.content).toEqual([{ type: "text", text: "Found 2 items." }]);
    expect(result?.structuredContent).toEqual({ count: 2, items: ["a", "b"] });
    expect(JSON.stringify(result?.content)).not.toContain("```json");
  });

  it("keeps plain text for clients that do not read structured content", async () => {
    const handles = new Map<string, RegisteredTool>();
    const callbacks = new Map<string, ToolCallback>();
    const registry = new ToolRegistry(
      new Set(["core"]),
      createLogger("error"),
      2,
      undefined,
      undefined,
      undefined,
      { audit: false },
    );
    registry.add({
      name: "json_only_example",
      toolset: "core",
      description: "JSON-only example.",
      handler: async () => ({ json: [1, 2] }),
    });
    registry.bind(fakeServer(handles, callbacks));

    const result = await callbacks.get("json_only_example")?.({});

    expect(result?.content[0]?.text).toContain("1");
    expect(result?.content[0]?.text).not.toContain("```");
    expect(result?.structuredContent).toEqual({ result: [1, 2] });
  });

  it("runs request hooks and emits one redacted audit event", async () => {
    const handles = new Map<string, RegisteredTool>();
    const callbacks = new Map<string, ToolCallback>();
    const events: ToolAuditEvent[] = [];
    const order: string[] = [];
    const registry = new ToolRegistry(
      new Set(["core"]),
      createLogger("error"),
      2,
      undefined,
      undefined,
      undefined,
      {
        audit: { write: async (event) => void events.push(event) },
        beforeInvoke: async () => void order.push("before"),
        contextProvider: async () => ({
          clientInfo: { name: "codex", version: "1.2.3" },
          agentHandle: "agent-1",
          workspaceHandle: "workspace-1",
          transport: "stdio",
          protocolVersion: "2025-11-25",
          traceId: "trace-1",
          workspaceKind: "vault",
        }),
      },
    );
    registry.add({
      name: "audited_example",
      toolset: "core",
      description: "Audited example.",
      handler: async () => {
        order.push("handler");
        return "ok";
      },
    });
    registry.bind(fakeServer(handles, callbacks));

    await callbacks.get("audited_example")?.(
      { code: "private code", text: "private note", settings: { token: "private" } },
      { requestId: "request-1" },
    );

    expect(order).toEqual(["before", "handler"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      request_id: "request-1",
      trace_id: "trace-1",
      tool: "audited_example",
      outcome: "success",
      client: { name: "codex", version: "1.2.3" },
      agent_handle: "agent-1",
      workspace_handle: "workspace-1",
      arguments: {
        count: 3,
        keys: ["code", "settings", "text"],
        types: { code: "string", settings: "object", text: "string" },
        redacted: true,
      },
    });
    expect(JSON.stringify(events[0])).not.toContain("private");
  });

  it("emits a redacted error envelope and native error details", async () => {
    const handles = new Map<string, RegisteredTool>();
    const callbacks = new Map<string, ToolCallback>();
    const events: ToolAuditEvent[] = [];
    const registry = new ToolRegistry(
      new Set(["core"]),
      createLogger("error"),
      2,
      undefined,
      undefined,
      undefined,
      { audit: { write: async (event) => void events.push(event) } },
    );
    registry.add({
      name: "failed_example",
      toolset: "core",
      description: "Failed example.",
      handler: async () => {
        throw new Error("private typed text");
      },
    });
    registry.bind(fakeServer(handles, callbacks));

    const result = await callbacks.get("failed_example")?.({}, { requestId: "request-2" });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent).toMatchObject({ code: "INTERNAL" });
    expect(result?.content).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.error).toEqual({
      type: "UobError",
      code: "INTERNAL",
      message: "The tool call failed.",
      retriable: false,
    });
    expect(JSON.stringify(events[0])).not.toContain("private typed text");
  });
});
