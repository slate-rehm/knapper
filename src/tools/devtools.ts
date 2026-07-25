/**
 * Developer tooling: DOM/CSS inspection, CDP passthrough, screenshots (toolset: devtools).
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ServerContext } from "../server.js";
import {
  CLOSED_VAULT_WARNING,
  cliOutcome,
  contentOutcome,
  pushFlag,
  pushKv,
  runCli,
  vaultName,
} from "../obsidian/helpers.js";
import { cliValue } from "../connection/cli/exec.js";
import { parseCliJson } from "../util/serialize.js";

const vaultOpt = { vault: z.string().optional() };

export function registerDevtoolsTools(ctx: ServerContext): void {
  const { registry, router, config } = ctx;

  registry.add({
    name: "obsidian_dom",
    toolset: "devtools",
    capability: "cliCommand",
    description:
      "Query the Obsidian renderer DOM by CSS selector via `dev:dom`. Prefer browser_snapshot for " +
      "interaction refs; use this for HTML/text extraction. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      selector: z.string(),
      text: z.boolean().optional(),
      all: z.boolean().optional(),
      attr: z.string().optional(),
      css: z.string().optional(),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens = [`selector=${cliValue(args.selector as string)}`];
      pushFlag(tokens, "text", args.text as boolean | undefined);
      pushFlag(tokens, "all", args.all as boolean | undefined);
      pushKv(tokens, "attr", args.attr as string | undefined);
      pushKv(tokens, "css", args.css as string | undefined);
      const { stdout } = await runCli(router, {
        command: "dev:dom",
        args: tokens,
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
    },
  });

  registry.add({
    name: "obsidian_css",
    toolset: "devtools",
    capability: "cliCommand",
    description:
      "Inspect computed CSS and source locations for a selector via `dev:css`. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      selector: z.string(),
      prop: z.string().optional(),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens = [`selector=${cliValue(args.selector as string)}`];
      pushKv(tokens, "prop", args.prop as string | undefined);
      const { stdout } = await runCli(router, {
        command: "dev:css",
        args: tokens,
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
    },
  });

  registry.add({
    name: "obsidian_cdp",
    toolset: "devtools",
    capability: "rawCdp",
    description:
      "Raw Chrome DevTools Protocol passthrough via Obsidian's `dev:cdp` (webContents.debugger). " +
      "Coexists with Playwright per verified Gate B. " +
      CLOSED_VAULT_WARNING,
    inputSchema: {
      method: z.string().describe("CDP method name, e.g. Runtime.evaluate"),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Method parameters as JSON object"),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens = [`method=${args.method as string}`];
      if (args.params !== undefined) {
        tokens.push(`params=${cliValue(JSON.stringify(args.params))}`);
      }
      const { stdout } = await runCli(router, {
        command: "dev:cdp",
        args: tokens,
        vault: vaultName(args, config),
      });
      const parsed = parseCliJson(stdout);
      return cliOutcome(stdout, parsed ?? undefined);
    },
  });

  registry.add({
    name: "obsidian_mobile_emulation",
    toolset: "devtools",
    capability: "cliCommand",
    description:
      "Toggle Obsidian mobile layout emulation via `dev:mobile`. " + CLOSED_VAULT_WARNING,
    inputSchema: {
      on: z.boolean().optional().describe("Enable emulation"),
      off: z.boolean().optional().describe("Disable emulation"),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFlag(tokens, "on", args.on as boolean | undefined);
      pushFlag(tokens, "off", args.off as boolean | undefined);
      const { stdout } = await runCli(router, {
        command: "dev:mobile",
        args: tokens,
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Mobile emulation updated");
    },
  });

  registry.add({
    name: "obsidian_dev_errors",
    toolset: "devtools",
    capability: "cliCommand",
    description:
      "Show errors captured by Obsidian's dev harness (`dev:errors`). Prefer obsidian_logs for " +
      "live Playwright console streaming. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      clear: z.boolean().optional(),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFlag(tokens, "clear", args.clear as boolean | undefined);
      const { stdout } = await runCli(router, {
        command: "dev:errors",
        args: tokens,
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout, stdout.trim() === "" ? { empty: true } : undefined);
    },
  });

  registry.add({
    name: "obsidian_screenshot",
    toolset: "devtools",
    capability: "screenshot",
    description:
      "Capture the Obsidian OS window via Electron `capturePage()` (`dev:screenshot`). This is the " +
      "full native window, complementary to Playwright web-contents screenshots in browser_* tools. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      path: z.string().optional().describe("Output path (default: under UOB output dir)"),
      ...vaultOpt,
    },
    handler: async (args) => {
      const outPath =
        (args.path as string | undefined) ??
        join(config.outputDir, `obsidian-window-${Date.now()}.png`);
      const tokens = [`path=${cliValue(outPath)}`];
      await runCli(router, {
        command: "dev:screenshot",
        args: tokens,
        vault: vaultName(args, config),
      });

      let b64 = "";
      try {
        b64 = (await readFile(outPath)).toString("base64");
      } catch {
        return contentOutcome(`Screenshot requested at ${outPath} (file not readable yet).`);
      }

      return {
        text: `Window screenshot saved to ${outPath}`,
        json: { path: outPath },
        images: [{ data: b64, mimeType: "image/png" }],
      };
    },
  });
}
