#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { loadConfig, DEFAULT_CDP_URL, defaultObsidianBin } from "./config.js";
import { createServer } from "./server.js";
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
    choices: LOG_LEVELS,
    describe: "Log verbosity (stderr only)",
  })
  .option("output-dir", {
    type: "string",
    describe: "Directory for screenshots and snapshot files",
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
});
const { server, ctx } = await createServer(config);
const shutdown = async (signal) => {
  ctx.logger.info(`received ${signal}, shutting down`);
  await ctx.browserProxy.close().catch(() => undefined);
  await ctx.router.dispose().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
const transport = new StdioServerTransport();
await server.connect(transport);
ctx.logger.info("unified-obsidian-mcp ready", {
  toolsets: [...config.enabledToolsets],
  cdpUrl: config.cdpUrl,
});
//# sourceMappingURL=cli.js.map
