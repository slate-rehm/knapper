import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { passthroughMcpResult } from "../../src/browser/forward.js";
import { validateScreenshotFilename } from "../../src/browser/proxy.js";
import type { ServerContext } from "../../src/server.js";
import { registerCoreTools } from "../../src/tools/core.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { Toolset } from "../../src/toolsets.js";
import { createLogger } from "../../src/util/logger.js";

function registry(enabled: string[] = []): ToolRegistry {
  return new ToolRegistry(new Set(enabled as Toolset[]), createLogger("error"), 2);
}

function bindWithConfigs(
  toolRegistry: ToolRegistry,
  configs: Map<string, Record<string, unknown>>,
): void {
  const server = {
    registerTool: vi.fn((name: string, config: Record<string, unknown>) => {
      configs.set(name, config);
      return {
        enabled: true,
        enable() {
          this.enabled = true;
        },
        disable() {
          this.enabled = false;
        },
      } as RegisteredTool;
    }),
  } as unknown as McpServer;
  toolRegistry.bind(server);
}

describe("tool catalog", () => {
  it("searches disabled definitions and paginates in stable name order", () => {
    const toolRegistry = registry(["core"]);
    toolRegistry.addAll([
      {
        name: "browser_snapshot",
        toolset: "ui",
        description: "Read the browser accessibility tree.",
        annotations: { readOnlyHint: true },
        handler: async () => "ok",
      },
      {
        name: "browser_type",
        toolset: "ui",
        description: "Type into the browser.",
        handler: async () => "ok",
      },
      {
        name: "obsidian_status",
        toolset: "core",
        description: "Report status.",
        handler: async () => "ok",
      },
    ]);

    const first = toolRegistry.catalog({
      query: "browser",
      enabled: false,
      limit: 1,
    });
    expect(first).toEqual({
      items: [{ name: "browser_snapshot", toolset: "ui", enabled: false }],
      total: 2,
      nextCursor: "1",
    });

    const second = toolRegistry.catalog({
      query: "browser",
      enabled: false,
      cursor: first.nextCursor,
      limit: 1,
      detail: "full",
    });
    expect(second.nextCursor).toBeUndefined();
    expect(second.items[0]).toMatchObject({
      name: "browser_type",
      toolset: "ui",
      enabled: false,
      description: "Type into the browser.",
      capability: null,
      annotations: { readOnlyHint: false },
    });
  });

  it("filters by toolset and rejects cursors that did not come from the catalog", () => {
    const toolRegistry = registry();
    toolRegistry.add({
      name: "obsidian_logs",
      toolset: "telemetry",
      description: "Read telemetry records.",
      handler: async () => "ok",
    });

    expect(toolRegistry.catalog({ toolset: "telemetry" }).items).toHaveLength(1);
    expect(() => toolRegistry.catalog({ cursor: "not-a-cursor" })).toThrow(
      "The catalog cursor is invalid.",
    );
  });
});

describe("dynamic tool surface", () => {
  it("starts with only core control tools and updates SDK handles at runtime", async () => {
    const toolRegistry = registry();
    toolRegistry.add({
      name: "browser_example",
      toolset: "ui",
      description: "Example browser operation.",
      handler: async () => "ok",
    });
    registerCoreTools({ registry: toolRegistry } as ServerContext);

    expect(toolRegistry.names()).toEqual([
      "obsidian_capabilities",
      "obsidian_status",
      "obsidian_tool_catalog",
      "obsidian_toolsets",
      "obsidian_toolsets_update",
    ]);

    const handles = new Map<string, RegisteredTool>();
    const server = {
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
    toolRegistry.bind(server);

    const update = toolRegistry.get("obsidian_toolsets_update")?.handler;
    expect(update).toBeDefined();
    const preview = await update?.({ enable: ["ui"], dryRun: true });
    expect(handles.get("browser_example")?.enabled).toBe(false);
    expect(preview).toMatchObject({
      json: {
        dryRun: true,
        enabled: ["ui"],
        changed: { enabled: ["ui"], toolCount: 1 },
      },
    });

    const changed = await update?.({ enable: ["ui"] });
    expect(handles.get("browser_example")?.enabled).toBe(true);
    expect(changed).toMatchObject({
      json: {
        dryRun: false,
        enabled: ["ui"],
        changed: { enabled: ["ui"], toolCount: 1 },
      },
    });
  });
});

describe("tool output schemas", () => {
  it("passes native and converted proxied output schemas to the SDK", () => {
    const toolRegistry = registry(["core", "ui"]);
    const nativeOutput = { count: z.number() };
    toolRegistry.add({
      name: "native_output",
      toolset: "core",
      description: "Return a native output.",
      outputSchema: nativeOutput,
      handler: async () => ({ json: { count: 1 } }),
    });
    toolRegistry.add({
      name: "proxied_output",
      toolset: "ui",
      description: "Return a proxied output.",
      jsonOutputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      handler: async () => ({ json: { value: "ok" } }),
    });

    const configs = new Map<string, Record<string, unknown>>();
    bindWithConfigs(toolRegistry, configs);

    expect(configs.get("native_output")?.outputSchema).toBe(nativeOutput);
    expect(configs.get("proxied_output")?.outputSchema).toMatchObject({
      value: expect.anything(),
    });
  });

  it("preserves proxied structured content", () => {
    const outcome = passthroughMcpResult({
      content: [{ type: "text", text: "one result" }],
      structuredContent: { count: 1, values: ["a"] },
    });

    expect(outcome).toEqual({
      mcp: {
        content: [{ type: "text", text: "one result" }],
        structuredContent: { count: 1, values: ["a"] },
      },
    });
  });
});

describe("screenshot output paths", () => {
  it("accepts only unused relative targets inside the configured directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "knapper-screenshot-"));
    const outputDir = join(root, "output");
    await mkdir(outputDir);
    await writeFile(join(outputDir, "existing.png"), "existing");

    try {
      await expect(validateScreenshotFilename(outputDir, "new.png")).resolves.toBeUndefined();
      await expect(validateScreenshotFilename(outputDir, undefined)).resolves.toBeUndefined();
      await expect(validateScreenshotFilename(outputDir, "/tmp/outside.png")).rejects.toMatchObject(
        {
          code: "INVALID_ARGUMENT",
        },
      );
      await expect(validateScreenshotFilename(outputDir, "../outside.png")).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(validateScreenshotFilename(outputDir, "existing.png")).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a relative path through a symlinked parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "knapper-screenshot-link-"));
    const outputDir = join(root, "output");
    const outside = join(root, "outside");
    await Promise.all([mkdir(outputDir), mkdir(outside)]);
    await symlink(outside, join(outputDir, "linked"));

    try {
      await expect(
        validateScreenshotFilename(outputDir, "linked/nested/new.png"),
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
