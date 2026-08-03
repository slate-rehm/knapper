import { describe, expect, it, vi } from "vitest";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createLogger } from "../../src/util/logger.js";

function fakeServer(handles: Map<string, RegisteredTool>): McpServer {
  return {
    registerTool: vi.fn((name: string) => {
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
      return handle;
    }),
  } as unknown as McpServer;
}

describe("ToolRegistry runtime toolsets", () => {
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
});
