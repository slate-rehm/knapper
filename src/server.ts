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
import { registerSessionTools } from "./tools/session.js";
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
/**
 * Shown to the agent at initialize. It has to answer "should I reach for this?"
 * before it answers "how do I drive it?", because an agent that does not connect
 * a request to this server never reads the second half.
 */
const INSTRUCTIONS = `knapper drives a **live Obsidian desktop application** (the Markdown note-taking app by Dynalist) over MCP. It automates the real running app on this machine — not a copy of the vault on disk, and not a web service.

USE THIS SERVER WHEN the task involves:
- Developing, building, reloading, or testing an **Obsidian plugin** or theme — this is its primary purpose. obsidian_dev_cycle answers "did my plugin change work?" in one call.
- Reading, creating, editing, moving, or searching notes in an **Obsidian vault**.
- Driving the Obsidian **UI**: clicking, typing, opening the command palette, screenshotting, inspecting the DOM or accessibility tree.
- Reading Obsidian's **console output, errors, or plugin stack traces**.
- Anything phrased as "in Obsidian", "my vault", "my notes", "this plugin", when Obsidian is the app in question.

DO NOT USE IT FOR: general web browsing or automating other websites (the browser_* tools here are bound to the Obsidian window), editing this project's own source files, or reading Markdown that merely happens to live outside a vault — ordinary file tools are better for that.

GETTING STARTED: run **obsidian_doctor** first. It reports the four precondition states separately and names the tool that fixes each one (usually obsidian_setup_cli, then obsidian_launch). Two transports reach the app: Obsidian's native CLI (needs its "cli" setting on; no restart) and Playwright over CDP (needs Obsidian cold-started with --remote-debugging-port). Tools pick a transport per call.

SAFETY: this drives the user's real Obsidian, and tools annotated destructiveHint can delete notes or run arbitrary JavaScript. For anything experimental, make a throwaway vault with **obsidian_create_vault** rather than working in the user's own. obsidian_remove_vault only ever deletes vaults knapper itself created.

CONVENTIONS: use obsidian_* tools for app, vault, and plugin state; browser_* tools for real input. Browser tools are snapshot-first — call browser_snapshot (or the cheaper obsidian_snapshot), then pass a returned ref as "target"; a CSS selector also works. Prefer obsidian_command over clicking through menus. Read console output with obsidian_logs, passing the previous call's cursor as "since" to see only what is new.`;

export async function createServerContext(config: Config): Promise<ServerContext> {
  const logger = createLogger(config.logLevel);

  if (config.unknownToolsets.length > 0) {
    logger.warn(`ignoring unknown toolset name(s): ${config.unknownToolsets.join(", ")}`, {
      valid: Object.keys(TOOLSET_DESCRIPTIONS),
    });
  }

  const router = new CapabilityRouter(config, logger);
  const telemetry = new TelemetryStore(config.telemetryBuffer);
  const capture = new TelemetryCapture(
    router,
    telemetry,
    logger.child("telemetry"),
    config.telemetryNetwork,
  );
  const browserProxy = new BrowserProxy(config, router, logger.child("browser"));
  const registry = new ToolRegistry(
    config.enabledToolsets,
    logger,
    config.maxConcurrency,
    telemetry,
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
  registerSessionTools(ctx);
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
