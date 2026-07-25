/**
 * MCP server assembly: build the router, register every enabled toolset, and
 * expose a single `createServer` used by both the CLI entry point and tests.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { CapabilityRouter } from "./connection/router.js";
import { ToolRegistry } from "./tools/registry.js";
import { createLogger, type Logger } from "./util/logger.js";
import { TOOLSET_DESCRIPTIONS } from "./toolsets.js";
import { registerCoreTools } from "./tools/core.js";
import { registerProvisioningTools } from "./tools/provisioning.js";
import { registerObsidianTools } from "./tools/obsidian.js";
import { registerVaultTools } from "./tools/vault.js";
import { registerAuthoringTools } from "./tools/authoring.js";
import { registerDevtoolsTools } from "./tools/devtools.js";
import { registerTelemetryTools } from "./tools/telemetry.js";
import { registerPluginDevTools } from "./tools/plugin-dev.js";
import { registerBrowserTools } from "./tools/browser.js";
import { TelemetryStore } from "./telemetry/store.js";
import { TelemetryCapture } from "./telemetry/capture.js";
import { BrowserProxy } from "./browser/proxy.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface ServerContext {
  config: Config;
  logger: Logger;
  router: CapabilityRouter;
  telemetry: TelemetryStore;
  capture: TelemetryCapture;
  browserProxy: BrowserProxy;
  registry: ToolRegistry;
}

async function packageVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = await readFile(join(here, "..", "package.json"), "utf8");
    return (JSON.parse(text) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Instructions surfaced to the client at initialization. Codex reads this field and
 * advises keeping the first 512 characters self-contained, so the essentials come
 * first and the detail follows.
 */
const INSTRUCTIONS = `Drives a live Obsidian desktop app for plugin development. Two transports: Obsidian's native CLI (needs the "cli" setting enabled, no restart) and Playwright over CDP (needs Obsidian launched with --remote-debugging-port). Run obsidian_doctor first — it reports which transports are available and names the tool that fixes each problem. Use obsidian_* tools for app and vault state, browser_* tools for real UI interaction, and obsidian_logs for console output.

Browser tools are snapshot-first: call browser_snapshot, then pass the returned ref as "target". A raw CSS selector also works as "target" when refs are unavailable. Prefer obsidian_command over clicking through menus. obsidian_dev_cycle is the fastest way to answer "did my plugin change work?".`;

export async function createServerContext(config: Config): Promise<ServerContext> {
  const logger = createLogger(config.logLevel);

  if (config.unknownToolsets.length > 0) {
    logger.warn(`ignoring unknown toolset name(s): ${config.unknownToolsets.join(", ")}`, {
      valid: Object.keys(TOOLSET_DESCRIPTIONS),
    });
  }

  const router = new CapabilityRouter(config, logger);
  const telemetry = new TelemetryStore(config.telemetryBuffer);
  const capture = new TelemetryCapture(router, telemetry, logger.child("telemetry"));
  const browserProxy = new BrowserProxy(config, router, logger.child("browser"));
  const registry = new ToolRegistry(
    config.enabledToolsets,
    logger,
    telemetry,
    config.maxConcurrency,
  );

  const ctx: ServerContext = {
    config,
    logger,
    router,
    telemetry,
    capture,
    browserProxy,
    registry,
  };

  registerCoreTools(ctx);
  registerProvisioningTools(ctx);
  registerObsidianTools(ctx);
  registerVaultTools(ctx);
  registerAuthoringTools(ctx);
  registerDevtoolsTools(ctx);
  registerTelemetryTools(ctx);
  registerPluginDevTools(ctx);
  await registerBrowserTools(ctx);

  // Starts detached and stays quiet until Obsidian appears; stopped by
  // `router.dispose()`, which the CLI already calls on shutdown.
  router.supervisor.start();

  return ctx;
}

export async function createServer(
  config: Config,
): Promise<{ server: McpServer; ctx: ServerContext }> {
  const ctx = await createServerContext(config);
  const server = new McpServer(
    { name: "knapper", version: await packageVersion() },
    { instructions: INSTRUCTIONS },
  );

  ctx.registry.bind(server);

  return { server, ctx };
}
