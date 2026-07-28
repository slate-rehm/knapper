#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  loadSessionConfig,
  DEFAULT_CDP_URL,
  defaultObsidianBin,
  TRANSPORT_KINDS,
} from "./config.js";
import { createServer } from "./server.js";
import { startHttpTransport, type HttpTransportHandle } from "./transport/http.js";
import { TOOLSETS, DEFAULT_TOOLSETS } from "./toolsets.js";
import { LOG_LEVELS } from "./util/logger.js";

/**
 * Subcommands, with the server as the default command.
 *
 * `knapper` with no verb still starts the MCP server, so every existing client
 * config keeps working untouched. The authorize/revoke verbs are terminal-only
 * utilities that never start a server — see `src/authorize.ts` for why they are
 * not MCP tools.
 */
const argv = await yargs(hideBin(process.argv))
  .scriptName("knapper")
  .usage("$0 [options]\n\nMCP server for Obsidian plugin development.")
  .command(
    "authorize <vault>",
    "Grant knapper access to a vault (interactive; run this yourself)",
    (y) =>
      y.positional("vault", {
        type: "string",
        describe: "Vault directory path, or the name of a registered vault",
      }),
    async (a) => {
      const { runAuthorize, terminalIo } = await import("./authorize.js");
      process.exit(await runAuthorize(String(a.vault), terminalIo()));
    },
  )
  .command(
    "revoke <vault>",
    "Withdraw knapper's access to a vault",
    (y) =>
      y.positional("vault", {
        type: "string",
        describe: "Vault directory path, or the name of a registered vault",
      }),
    async (a) => {
      const { runRevoke, terminalIo } = await import("./authorize.js");
      process.exit(await runRevoke(String(a.vault), terminalIo()));
    },
  )
  .command("authorizations", "List which vaults knapper may touch", {}, async () => {
    const { runListAuthorizations, terminalIo } = await import("./authorize.js");
    process.exit(await runListAuthorizations(terminalIo()));
  })
  .command("sessions", "List knapper's isolated Obsidian sessions", {}, async () => {
    const { listSessions } = await import("./session/registry.js");
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log("No knapper sessions.");
      process.exit(0);
    }
    for (const s of sessions) {
      const d = s.descriptor;
      console.log(
        `${d.key}  [${s.state}]\n` +
          `  vault ${d.vault?.name ?? "(none)"} → ${d.vault?.path ?? ""}\n` +
          `  ${d.instance.cdpUrl}  pid ${d.instance.pid ?? "?"}  cli ${s.cliIsolation}\n` +
          `  from ${d.origin.cwd}`,
      );
    }
    process.exit(0);
  })
  .command(
    "sessions:reap",
    "Remove abandoned sessions (reports without deleting unless --yes)",
    (y) =>
      y
        .option("yes", { type: "boolean", describe: "Actually delete, rather than just report" })
        .option("force", {
          type: "boolean",
          describe: "Also remove sessions whose app died recently, not just long-abandoned ones",
        }),
    async (a) => {
      const { reapStaleSessions } = await import("./session/reap.js");
      // Dry run is the default output shape: this deletes vaults, and a human
      // typing a bare verb should see the plan before it happens.
      const report = await reapStaleSessions({
        dryRun: a.yes !== true,
        force: a.force === true,
        deleteVaults: true,
      });
      if (report.candidates.length === 0) {
        console.log("Nothing to reap.");
      }
      for (const c of report.candidates) {
        console.log(`${report.dryRun ? "would reap" : "reaped"} ${c.key} — ${c.reason}`);
      }
      for (const k of report.kept) console.log(`kept ${k.key} — ${k.reason}`);
      if (report.dryRun && report.candidates.length > 0) {
        console.log("\nRe-run with --yes to delete these.");
      }
      process.exit(0);
    },
  )
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
  .option("session", {
    type: "string",
    describe: "Bind to a knapper session (same as the KNAP_SESSION env var)",
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
  .option("target-match", {
    type: "string",
    describe: "Only attach to windows whose title or URL contains this substring",
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
  .example("$0 authorize ~/vaults/scratch", "Let knapper touch that vault")
  .example("$0 authorizations", "Show which vaults knapper may touch")
  .help()
  .version(false)
  .parseAsync();

// A subcommand handler calls process.exit, so reaching here means the default
// command: start the server.

const config = await loadSessionConfig({
  ...(argv["cdp-url"] !== undefined ? { cdpUrl: argv["cdp-url"] } : {}),
  ...(argv["obsidian-bin"] !== undefined ? { obsidianBin: argv["obsidian-bin"] } : {}),
  ...(argv.vault !== undefined ? { vault: argv.vault } : {}),
  ...(argv.session !== undefined ? { sessionId: argv.session } : {}),
  ...(argv.toolsets !== undefined ? { toolsets: argv.toolsets } : {}),
  ...(argv["log-level"] !== undefined ? { logLevel: argv["log-level"] } : {}),
  ...(argv["output-dir"] !== undefined ? { outputDir: argv["output-dir"] } : {}),
  ...(argv["target-match"] !== undefined ? { targetMatch: argv["target-match"] } : {}),
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
  // Record that this server is gone, but deliberately do NOT close the session:
  // an MCP client restarting must not destroy the agent's Obsidian and vault. The
  // reaper collects it later if nobody comes back for it.
  if (config.sessionId !== undefined) {
    const { patchDescriptor } = await import("./session/descriptor.js");
    await patchDescriptor(config.sessionId, (d) => ({
      ...d,
      ...(d.owner !== undefined
        ? { owner: { ...d.owner, exitedAt: new Date().toISOString() } }
        : {}),
    })).catch(() => undefined);
  }
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
  ctx.logger.info(`knapper listening on ${httpHandle.url}`, {
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
  ctx.logger.info("knapper ready", {
    toolsets: [...config.enabledToolsets],
    cdpUrl: config.cdpUrl,
    ...(config.sessionId !== undefined ? { session: config.sessionId } : {}),
  });
}
