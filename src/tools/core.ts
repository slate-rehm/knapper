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
      const vaultStatus = await router.fence.status();
      const authorized = vaultStatus.filter((v) => v.authorized);

      const lines = [
        `Obsidian running: ${health.running ? "yes" : "no"}`,
        `CLI transport: ${availability.cli ? "enabled" : "disabled"}`,
        `CDP transport: ${availability.playwright ? `attached (${config.cdpUrl})` : `unavailable (${config.cdpUrl})`}`,
        `Windows attached: ${health.windows.length}`,
        `Authorized vaults: ${
          authorized.length === 0
            ? "none — every vault-scoped tool will refuse"
            : authorized.map((v) => `${v.name} (${v.grant})`).join(", ")
        }`,
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
          vaults: vaultStatus,
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

      // A window title is "<note> - <vault> - Obsidian <version>", so listing raw
      // titles would hand back the open note of a vault the fence otherwise blocks.
      // The vault name stays visible — that is what makes the refusal diagnosable —
      // and the note name is dropped.
      const rows = await Promise.all(
        classified.map(async (t) => {
          const ok =
            t.vaultName !== undefined
              ? (await router.fence.isAuthorized(t.vaultName)) !== undefined
              : false;
          return {
            id: t.target.id,
            kind: t.kind,
            title: ok ? t.target.title : `(${t.vaultName ?? "unknown vault"} — not authorized)`,
            url: t.target.url,
            vaultName: t.vaultName ?? null,
            noteName: ok ? (t.noteName ?? null) : null,
            authorized: ok,
          };
        }),
      );

      const text = rows
        .map((t) => `[${t.kind}] ${t.title || "(untitled)"}\n  id=${t.id} url=${t.url}`)
        .join("\n");

      return {
        text: text === "" ? "No CDP targets found." : text,
        json: rows,
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

      // Verify before pinning, not after. Setting the pin first would leave the
      // session pointed at an unauthorized window if the check then threw.
      if (targetId !== undefined) {
        const targets = classifyTargets(await fetchTargets(config.cdpUrl).catch(() => []));
        const wanted = targets.find((t) => t.target.id === targetId);
        const vault = wanted?.vaultName;
        if (vault === undefined || (await router.fence.isAuthorized(vault)) === undefined) {
          throw new UobError(
            "VAULT_NOT_AUTHORIZED",
            `Refusing to pin to target ${targetId}: it shows ${vault ?? "no identifiable vault"}, which is not authorized.`,
            {
              remediation:
                "Pin to a window showing an authorized vault. obsidian_list_targets marks which " +
                "ones those are.",
              fixedBy: "obsidian_list_targets",
              details: { targetId, vault: vault ?? null },
            },
          );
        }
      }

      router.playwright.attachTo(targetId);

      // The proxied @playwright/mcp server tracks its own current tab and does not
      // consult our pin, so without this the browser_* tools keep driving whatever
      // window they latched onto — the pin would silently cover only half the tools.
      const followed = targetId === undefined ? false : await ctx.browserProxy.selectPinnedPage();

      if (targetId === undefined) {
        return "Cleared the target pin; window selection is automatic again.";
      }
      return followed
        ? `Pinned subsequent calls to target ${targetId}, including browser_* tools.`
        : `Pinned subsequent calls to target ${targetId}. The browser_* tools could not be ` +
            "repointed (CDP unavailable, or the window is not a tab in this context) — verify with " +
            "browser_snapshot before clicking or typing.";
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
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    // Arbitrary code against the live app: it can delete notes, disable plugins, or
    // reach the network. Annotated like browser_evaluate so clients prompt for it.
    annotations: { destructiveHint: true, openWorldHint: true },
    handler: async (args) => {
      const code = args.code as string;
      const vault = args.vault as string | undefined;
      const { value, layer } = await router.evaluate<unknown>(
        code,
        vault !== undefined ? { vault } : {},
      );
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
    // Dispatches any command in Obsidian's table, including delete and plugin
    // management, so it is at least as powerful as the tools that wrap them.
    annotations: { destructiveHint: true },
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
