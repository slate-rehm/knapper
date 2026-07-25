#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { loadConfig, DEFAULT_CDP_URL, defaultObsidianBin, TRANSPORT_KINDS } from "./config.js";
import { createServer } from "./server.js";
import { startHttpTransport, type HttpTransportHandle } from "./transport/http.js";
import { TOOLSETS, DEFAULT_TOOLSETS } from "./toolsets.js";
import { LOG_LEVELS } from "./util/logger.js";

const argv = await yargs(hideBin(process.argv))
  .scriptName("unified-obsidian-mcp")
  .usage("$0 [options]\n\nMCP server for Obsidian plugin development.")
  .option("cdp-url", {
    type: "string",
    describe: `CDP endpoint of a running Obsidian (default: ${DEFAULT_CDP_URL})`,
  })
  .option("obsidian-bin", {
    type: "string",
    describe: `Path to the Obsidian binary (default: ${defaultObsidianBin()})`,
  })
  .option("vault", {
    alias: "v",
    type: "string",
    describe: "Target a specific vault by name",
  })
  .option("toolsets", {
    type: "string",
    describe: `Comma-separated toolsets to enable, or "all". Available: ${TOOLSETS.join(", ")} (default: ${DEFAULT_TOOLSETS.join(",")})`,
  })
  .option("log-level", {
    type: "string",
    choices: LOG_LEVELS as unknown as string[],
    describe: "Log verbosity (stderr only)",
  })
  .option("output-dir", {
    type: "string",
    describe: "Directory for screenshots and snapshot files",
  })
  .option("transport", {
    type: "string",
    choices: TRANSPORT_KINDS as unknown as string[],
    describe: "MCP transport to serve (default: stdio)",
  })
  .option("port", {
    type: "number",
    describe: "Listen port for the http transport (default: 9223)",
  })
  .option("host", {
    type: "string",
    describe: "Listen host for the http transport (default: 127.0.0.1)",
  })
  .example("$0 --toolsets all", "Enable every toolset")
  .example("$0 --vault 'My Vault'", "Pin all operations to one vault")
  .help()
  .version(false)
  .parseAsync();

const config = loadConfig({
  ...(argv["cdp-url"] !== undefined ? { cdpUrl: argv["cdp-url"] } : {}),
  ...(argv["obsidian-bin"] !== undefined ? { obsidianBin: argv["obsidian-bin"] } : {}),
  ...(argv.vault !== undefined ? { vault: argv.vault } : {}),
  ...(argv.toolsets !== undefined ? { toolsets: argv.toolsets } : {}),
  ...(argv["log-level"] !== undefined ? { logLevel: argv["log-level"] } : {}),
  ...(argv["output-dir"] !== undefined ? { outputDir: argv["output-dir"] } : {}),
  ...(argv.transport !== undefined ? { transport: argv.transport } : {}),
  ...(argv.port !== undefined ? { httpPort: argv.port } : {}),
  ...(argv.host !== undefined ? { httpHost: argv.host } : {}),
});

const { server, ctx } = await createServer(config);

let httpHandle: HttpTransportHandle | undefined;

let shuttingDown = false;
const shutdown = async (reason: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  ctx.logger.info(`${reason}, shutting down`);
  await httpHandle?.close().catch(() => undefined);
  await ctx.browserProxy.close().catch(() => undefined);
  await ctx.router.dispose().catch(() => undefined);
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("received SIGINT"));
process.on("SIGTERM", () => void shutdown("received SIGTERM"));

if (config.transport === "http") {
  // Deliberately no stdin hooks here: under http the client is not on the other end of
  // this process's stdin, and a detached or redirected stdin closing must not take a
  // server with live sessions down with it.
  httpHandle = await startHttpTransport({ server, config, logger: ctx.logger });
  ctx.logger.info(`unified-obsidian-mcp listening on ${httpHandle.url}`, {
    toolsets: [...config.enabledToolsets],
    cdpUrl: config.cdpUrl,
  });
} else {
  // An MCP client signals shutdown by closing stdin. Without this the attached CDP
  // websocket keeps the event loop alive and the process lingers after every session.
  process.stdin.on("close", () => void shutdown("stdin closed"));
  process.stdin.on("end", () => void shutdown("stdin ended"));

  const transport = new StdioServerTransport();
  transport.onclose = () => void shutdown("transport closed");
  await server.connect(transport);
  ctx.logger.info("unified-obsidian-mcp ready", {
    toolsets: [...config.enabledToolsets],
    cdpUrl: config.cdpUrl,
  });
}
