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
import { TOOLSETS, TOOLSET_DESCRIPTIONS } from "../toolsets.js";
import { UobError } from "../util/errors.js";
import { CAPABILITIES, CAPABILITY_PREFERENCE } from "../capabilities.js";
import { readDescriptor } from "../session/descriptor.js";

const toolsetNameSchema = z.enum(TOOLSETS);

const toolsetStateOutputSchema = {
  enabled: z.array(toolsetNameSchema),
  disabled: z.array(toolsetNameSchema),
  available: z.array(toolsetNameSchema),
};

export function registerCoreTools(ctx: ServerContext): void {
  const { registry, router, config } = ctx;

  registry.add({
    name: "obsidian_status",
    toolset: "core",
    alwaysEnabled: true,
    workspaceIndependent: true,
    description:
      "Report which transports are reachable, which Obsidian windows are attached, and which " +
      "toolsets are enabled. Cheap and safe to call first in a session. For a full diagnosis with " +
      "remediation steps, use obsidian_doctor instead.",
    annotations: { readOnlyHint: true },
    profileIndependent: true,
    inputSchema: {},
    handler: async () => {
      const availability = await router.refreshAvailability(true);
      const health = await router.health({ skipCliProbe: true });
      const vaultStatus = await router.fence.status();
      const authorized = vaultStatus.filter((v) => v.authorized);
      const windows = availability.playwright
        ? await router.playwright.windowSummaries().catch(() => [])
        : [];
      const defaultProfileLease = await ctx.profileLease.status();
      const descriptor =
        config.sessionId !== undefined ? await readDescriptor(config.sessionId) : undefined;
      const profile =
        config.sessionId === undefined
          ? {
              kind: "default" as const,
              workspaceHandle: ctx.currentWorkspaceHandle ?? null,
              sessionId: null,
              userDataDir: null,
              visualIdentity: null,
            }
          : {
              kind: "private" as const,
              workspaceHandle: ctx.currentWorkspaceHandle ?? null,
              sessionId: config.sessionId,
              userDataDir: config.userDataDir,
              visualIdentity: descriptor?.visualIdentity ?? {
                state: "degraded" as const,
                warnings: ["Visual identity was not recorded."],
              },
            };

      const lines = [
        `Obsidian running: ${health.running ? "yes" : "no"}`,
        `CLI transport: ${availability.cli ? "enabled" : "disabled"}`,
        `CDP transport: ${availability.playwright ? "attached" : "unavailable"}`,
        `Windows attached: ${windows.length}`,
        `Authorized vaults: ${
          authorized.length === 0
            ? "none — every vault-scoped tool will refuse"
            : authorized.map((v) => `${v.name} (${v.grant})`).join(", ")
        }`,
        `Toolsets enabled: ${registry.toolsetState().enabled.join(", ")}`,
        `Toolsets disabled: ${registry.toolsetState().disabled.join(", ") || "none"}`,
        `Default profile: ${defaultProfileLease.state}`,
        `Profile identity: ${profile.kind}${profile.sessionId === null ? "" : ` (${profile.sessionId})`}`,
        `Workspace: ${profile.workspaceHandle ?? "none"}`,
        ...(profile.visualIdentity === null
          ? []
          : [`Visual identity: ${profile.visualIdentity.state}`]),
      ];
      const commandTransport = router.commandTransportStatus;
      lines.push(
        `Command transport: ${String(commandTransport.selected)} (${String(commandTransport.mode)})`,
      );
      if (commandTransport.cliDegradedUntil !== undefined) {
        lines.push(
          `CLI demoted until ${String(commandTransport.cliDegradedUntil)} after a timeout.`,
        );
      }

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
          commandTransport,
          debuggerHeldBy: router.currentDebuggerHolder ?? null,
          windows,
          vaults: vaultStatus.map((vault) =>
            vault.authorized
              ? {
                  name: vault.name,
                  open: vault.open,
                  authorized: true,
                  grant: vault.grant,
                }
              : { open: vault.open, authorized: false },
          ),
          toolsets: {
            ...registry.toolsetState(),
            available: Object.keys(TOOLSET_DESCRIPTIONS),
          },
          toolCounts: Object.fromEntries(
            Object.entries(registry.byToolset()).map(([name, tools]) => [name, tools.length]),
          ),
          problemCount: health.problems.length,
          defaultProfileLease,
          profile,
        },
      };
    },
  });

  registry.add({
    name: "obsidian_capabilities",
    toolset: "core",
    alwaysEnabled: true,
    profileIndependent: true,
    workspaceIndependent: true,
    description:
      "Report every Knapper capability, the live transport that can serve it, and the fixing tool " +
      "when it is unavailable. Use this before choosing between obsidian_* and browser_* tools.",
    annotations: { readOnlyHint: true },
    inputSchema: {},
    handler: async () => {
      const availability = await router.refreshAvailability(true);
      const rows = CAPABILITIES.map((capability) => {
        const layer = CAPABILITY_PREFERENCE[capability].find((name) => availability[name]) ?? null;
        const fixedBy = layer !== null ? null : capability === "launch" ? null : "obsidian_launch";
        return {
          capability,
          available: layer !== null,
          layer,
          preferredLayers: CAPABILITY_PREFERENCE[capability],
          fixedBy,
        };
      });
      return {
        text: rows
          .map(
            (row) =>
              `${row.capability}: ${row.available ? `available via ${row.layer}` : `unavailable; use ${row.fixedBy ?? "local process control"}`}`,
          )
          .join("\n"),
        json: { transports: availability, capabilities: rows },
      };
    },
  });

  registry.add({
    name: "obsidian_toolsets",
    toolset: "core",
    alwaysEnabled: true,
    profileIndependent: true,
    workspaceIndependent: true,
    description:
      "Report the current operational toolsets. Use obsidian_toolsets_update to change them.",
    annotations: { readOnlyHint: true },
    inputSchema: {},
    outputSchema: toolsetStateOutputSchema,
    handler: async () => {
      const state = registry.toolsetState();
      return {
        text: [
          `Enabled: ${state.enabled.join(", ") || "none"}`,
          `Disabled: ${state.disabled.join(", ") || "none"}`,
        ].join("\n"),
        json: { ...state, available: TOOLSETS },
      };
    },
  });

  registry.add({
    name: "obsidian_toolsets_update",
    toolset: "core",
    alwaysEnabled: true,
    profileIndependent: true,
    workspaceIndependent: true,
    description:
      "Enable or disable operational toolsets for this server process. Use dryRun to preview the change.",
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: {
      enable: z
        .array(toolsetNameSchema)
        .optional()
        .describe("Toolsets to enable immediately through the MCP tool registration handles"),
      disable: z
        .array(toolsetNameSchema)
        .optional()
        .describe("Toolsets to disable immediately through the MCP tool registration handles"),
      dryRun: z.boolean().optional().describe("Preview the resulting surface without changing it"),
    },
    outputSchema: {
      dryRun: z.boolean(),
      enabled: z.array(toolsetNameSchema),
      disabled: z.array(toolsetNameSchema),
      changed: z.object({
        enabled: z.array(toolsetNameSchema),
        disabled: z.array(toolsetNameSchema),
        toolCount: z.number().int().nonnegative(),
      }),
    },
    handler: async (args) => {
      const enable = [...new Set((args.enable as (typeof TOOLSETS)[number][] | undefined) ?? [])];
      const disable = [...new Set((args.disable as (typeof TOOLSETS)[number][] | undefined) ?? [])];
      const overlap = enable.filter((toolset) => disable.includes(toolset));
      if (overlap.length > 0) {
        throw new UobError(
          "INVALID_ARGUMENT",
          `A toolset cannot be enabled and disabled in the same call: ${overlap.join(", ")}.`,
          {
            remediation: "Remove each duplicate toolset from either enable or disable.",
          },
        );
      }

      const before = registry.toolsetState();
      const enabledBefore = new Set(before.enabled);
      const changedEnabled = enable.filter((toolset) => !enabledBefore.has(toolset)).sort();
      const changedDisabled = disable.filter((toolset) => enabledBefore.has(toolset)).sort();
      const dryRun = args.dryRun === true;
      let changedToolCount = 0;

      if (dryRun) {
        for (const toolset of [...changedEnabled, ...changedDisabled]) {
          changedToolCount += (registry.groupAllByToolset()[toolset] ?? []).filter(
            (name) => registry.get(name)?.alwaysEnabled !== true,
          ).length;
        }
      } else {
        for (const toolset of changedEnabled) {
          changedToolCount += registry.setToolsetEnabled(toolset, true).length;
        }
        for (const toolset of changedDisabled) {
          changedToolCount += registry.setToolsetEnabled(toolset, false).length;
        }
      }

      const enabled = new Set(before.enabled);
      for (const toolset of changedEnabled) enabled.add(toolset);
      for (const toolset of changedDisabled) enabled.delete(toolset);
      const state = dryRun
        ? {
            enabled: TOOLSETS.filter((toolset) => enabled.has(toolset)).sort(),
            disabled: TOOLSETS.filter((toolset) => !enabled.has(toolset)).sort(),
          }
        : registry.toolsetState();
      const prefix = dryRun ? "Dry run" : "Updated";
      return {
        text: [
          `${prefix}: ${changedToolCount} tool registration(s) ${dryRun ? "would change" : "changed"}.`,
          `Enabled toolsets: ${state.enabled.join(", ") || "none"}`,
          `Disabled toolsets: ${state.disabled.join(", ") || "none"}`,
        ].join("\n"),
        json: {
          dryRun,
          ...state,
          changed: {
            enabled: changedEnabled,
            disabled: changedDisabled,
            toolCount: changedToolCount,
          },
        },
      };
    },
  });

  registry.add({
    name: "obsidian_tool_catalog",
    toolset: "core",
    alwaysEnabled: true,
    profileIndependent: true,
    workspaceIndependent: true,
    description:
      "Search the Knapper tool catalog without enabling disabled tools. Results use cursor pagination.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Case-insensitive text to find in tool names, toolsets, or descriptions"),
      toolset: toolsetNameSchema.optional().describe("Return tools from only this toolset"),
      enabled: z.boolean().optional().describe("Filter by the current enabled state"),
      cursor: z.string().optional().describe("Opaque nextCursor value from a previous result"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum results to return, from 1 through 100. The default is 20."),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("Summary returns identity fields. Full also returns descriptions and metadata."),
    },
    outputSchema: {
      items: z.array(
        z.object({
          name: z.string(),
          toolset: toolsetNameSchema,
          enabled: z.boolean(),
          description: z.string().optional(),
          capability: z.enum(CAPABILITIES).nullable().optional(),
          annotations: z
            .object({
              readOnlyHint: z.boolean().optional(),
              destructiveHint: z.boolean().optional(),
              idempotentHint: z.boolean().optional(),
              openWorldHint: z.boolean().optional(),
            })
            .optional(),
        }),
      ),
      total: z.number().int().nonnegative(),
      nextCursor: z.string().optional(),
    },
    handler: async (args) => {
      const result = registry.catalog({
        ...(typeof args.query === "string" ? { query: args.query } : {}),
        ...(typeof args.toolset === "string"
          ? { toolset: args.toolset as (typeof TOOLSETS)[number] }
          : {}),
        ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
        ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        detail: args.detail === "full" ? "full" : "summary",
      });
      return {
        text:
          result.items.length === 0
            ? "No tools matched the catalog filters."
            : result.items
                .map(
                  (tool) =>
                    `${tool.name} (${tool.toolset}, ${tool.enabled ? "enabled" : "disabled"})` +
                    (tool.description === undefined ? "" : `\n  ${tool.description}`),
                )
                .join("\n"),
        json: result,
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
      const rows = await router.playwright.windowSummaries().catch((error: unknown) => {
        if (error instanceof UobError) throw error;
        throw new UobError("CDP_PORT_CLOSED", `No CDP endpoint at ${config.cdpUrl}.`, {
          remediation: "Launch Obsidian with --remote-debugging-port.",
          fixedBy: "obsidian_launch",
          cause: error,
        });
      });

      const text = rows
        .map((target) =>
          target.authorized
            ? `[${target.kind}] ${target.title ?? "(untitled)"}\n  id=${target.targetId}`
            : `[${target.kind}] unauthorized window\n  id=${target.targetId}`,
        )
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
            `Refusing to pin to target ${targetId}: the window is not authorized.`,
            {
              remediation:
                "Pin to a window showing an authorized vault. obsidian_list_targets marks which " +
                "ones those are.",
              fixedBy: "obsidian_list_targets",
              details: { targetId },
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
