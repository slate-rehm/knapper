/**
 * MCP server assembly: build the router, register every enabled toolset, and
 * expose a single `createServer` used by both the CLI entry point and tests.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { CapabilityRouter } from "./connection/router.js";
import { ToolRegistry } from "./tools/registry.js";
import { type Logger } from "./util/logger.js";
import { TelemetryStore } from "./telemetry/store.js";
import { TelemetryCapture } from "./telemetry/capture.js";
import { BrowserProxy } from "./browser/proxy.js";
export interface ServerContext {
  config: Config;
  logger: Logger;
  router: CapabilityRouter;
  telemetry: TelemetryStore;
  capture: TelemetryCapture;
  browserProxy: BrowserProxy;
  registry: ToolRegistry;
}
export declare function createServerContext(config: Config): Promise<ServerContext>;
export declare function createServer(config: Config): Promise<{
  server: McpServer;
  ctx: ServerContext;
}>;
