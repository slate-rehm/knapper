/**
 * Core tools: status, target inspection, raw evaluation, and command execution.
 *
 * This module is the reference for how every other tool module is written — declare
 * the toolset and capability, let the registry wrap errors, and return structured
 * JSON alongside prose so agents never have to parse text.
 */

import { z } from "zod";
import type { ServerContext } from "../server.js";
import { renderResult } from "../util/serialize.js";
import { fetchTargets, classifyTargets } from "../connection/cdp/discover.js";
import { TOOLSET_DESCRIPTIONS } from "../toolsets.js";
import { UobError } from "../util/errors.js";

export function registerCoreTools(ctx: ServerContext): void {
  const { registry, router, config } = ctx;

  registry.add({
    name: "obsidian_status",
    toolset: "core",
    description:
      "Report which transports are reachable, which Obsidian windows are attached, and which " +
      "toolsets are enabled. Cheap and safe to call first in a session. For a full diagnosis with " +
      "remediation steps, use obsidian_doctor instead.",
    annotations: { readOnlyHint: true },
    inputSchema: {},
    handler: async () => {
      const availability = await router.refreshAvailability(true);
      const health = await router.health({ skipCliProbe: true });

      const lines = [
        `Obsidian running: ${health.running ? "yes" : "no"}`,
        `CLI transport: ${availability.cli ? "enabled" : "disabled"}`,
        `CDP transport: ${availability.playwright ? `attached (${config.cdpUrl})` : `unavailable (${config.cdpUrl})`}`,
        `Windows attached: ${health.windows.length}`,
        `Toolsets enabled: ${[...config.enabledToolsets].join(", ")}`,
      ];

      if (health.problems.length > 0) {
        lines.push(
          "",
          `${health.problems.length} problem(s) found — run obsidian_doctor for details.`,
        );
      }

      return {
        text: lines.join("\n"),
        json: {
          transports: availability,
          debuggerHeldBy: router.currentDebuggerHolder ?? null,
          windows: health.windows,
          vaults: health.vaults.map((v) => ({ name: v.name, open: v.open, path: v.path })),
          toolsets: {
            enabled: [...config.enabledToolsets],
            available: Object.keys(TOOLSET_DESCRIPTIONS),
          },
          tools: registry.byToolset(),
          problemCount: health.problems.length,
        },
      };
    },
  });

  registry.add({
    name: "obsidian_list_targets",
    toolset: "core",
    description:
      "List every CDP target, classified as an Obsidian main window, a popout, or a webview. Use " +
      "this when multiple vaults or popout windows are open and you need to pick one explicitly. " +
      "Note that Obsidian popouts report their URL as about:blank, so they are identified by title.",
    annotations: { readOnlyHint: true },
    inputSchema: {},
    handler: async () => {
      const targets = await fetchTargets(config.cdpUrl).catch(() => {
        throw new UobError("CDP_PORT_CLOSED", `No CDP endpoint at ${config.cdpUrl}.`, {
          remediation: "Launch Obsidian with --remote-debugging-port.",
          fixedBy: "obsidian_launch",
        });
      });

      const classified = classifyTargets(targets);
      const text = classified
        .map(
          (t) =>
            `[${t.kind}] ${t.target.title || "(untitled)"}\n  id=${t.target.id} url=${t.target.url}`,
        )
        .join("\n");

      return {
        text: text === "" ? "No CDP targets found." : text,
        json: classified.map((t) => ({
          id: t.target.id,
          kind: t.kind,
          title: t.target.title,
          url: t.target.url,
          vaultName: t.vaultName ?? null,
          noteName: t.noteName ?? null,
        })),
      };
    },
  });

  registry.add({
    name: "obsidian_attach",
    toolset: "core",
    description:
      "Pin every subsequent Playwright-backed call to one CDP target, obtained from " +
      "obsidian_list_targets. Pass no targetId to clear the pin and go back to automatic selection.",
    inputSchema: {
      targetId: z
        .string()
        .optional()
        .describe("CDP target id from obsidian_list_targets; omit to clear the pin"),
    },
    handler: async (args) => {
      const targetId = args.targetId as string | undefined;
      router.playwright.attachTo(targetId);
      return targetId === undefined
        ? "Cleared the target pin; window selection is automatic again."
        : `Pinned subsequent calls to target ${targetId}.`;
    },
  });

  registry.add({
    name: "obsidian_eval",
    toolset: "core",
    capability: "evaluate",
    description:
      "Run JavaScript inside the Obsidian renderer with full access to the `app` object " +
      "(app.vault, app.workspace, app.metadataCache, app.plugins). Accepts either a bare " +
      "expression (`app.vault.getName()`) or a statement body with an explicit return. This is the " +
      "most powerful tool here — prefer it over DOM scraping for reading vault or plugin state.",
    inputSchema: {
      code: z.string().describe("JavaScript to evaluate in the renderer"),
    },
    // Arbitrary code against the live app: it can delete notes, disable plugins, or
    // reach the network. Annotated like browser_evaluate so clients prompt for it.
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (args) => {
      const code = args.code as string;
      const { value, layer } = await router.evaluate<unknown>(code);
      const rendered = renderResult(value);
      return {
        text: rendered.text,
        json: { layer, truncated: rendered.truncated },
      };
    },
  });

  registry.add({
    name: "obsidian_cli",
    toolset: "core",
    capability: "cliCommand",
    description:
      "Run a raw Obsidian CLI command. Arguments use Obsidian's own grammar: `key=value` sets a " +
      'parameter, a bare token sets it to "true", and `cmd:flag` is shorthand for `cmd flag=true`. ' +
      "Only --copy/--help/--json/--md/--tsv/--csv survive Obsidian's flag filter; any other " +
      "--flag is silently dropped. Use obsidian_commands to discover what is available.",
    inputSchema: {
      command: z.string().describe('Command name, e.g. "vault:info" or "note:open"'),
      args: z
        .array(z.string())
        .optional()
        .describe('Additional tokens, e.g. ["path=Notes/Today.md", "format=json"]'),
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    handler: async (args) => {
      const command = args.command as string;
      const extra = (args.args as string[] | undefined) ?? [];
      const vault = args.vault as string | undefined;

      const stdout = await router.cliCommand(
        [command, ...extra],
        vault !== undefined ? { vault } : {},
      );
      const rendered = renderResult(stdout);
      return {
        text: rendered.text === "" ? "(command produced no output)" : rendered.text,
        json: { command, args: extra, truncated: rendered.truncated },
      };
    },
  });
}
