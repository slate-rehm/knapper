/**
 * Obsidian app control: commands, plugins, workspace, and restarts.
 */

import { z } from "zod";
import type { ServerContext } from "../server.js";
import {
  CLOSED_VAULT_WARNING,
  cliOutcome,
  contentOutcome,
  evalJson,
  pushFlag,
  pushKv,
  readPluginData,
  runCli,
  vaultName,
  writePluginData,
} from "../obsidian/helpers.js";
import { getCompletions } from "../obsidian/completions.js";
import { launchWithCdp } from "./provisioning.js";
import { listPluginCommandIds } from "../devcycle/plugin-health.js";
import { renderResult } from "../util/serialize.js";

export function pluginListContains(value: unknown, stdout: string, id: string): boolean {
  const visit = (entry: unknown): boolean => {
    if (Array.isArray(entry)) {
      return entry.some((item) => (typeof item === "string" ? item === id : visit(item)));
    }
    if (typeof entry !== "object" || entry === null) return false;
    const record = entry as Record<string, unknown>;
    if (record.id === id) return true;
    return Object.values(record).some((item) => (Array.isArray(item) ? visit(item) : false));
  };
  if (visit(value)) return true;
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/[\t,]/, 1)[0])
    .some((candidate) => candidate === id);
}

export function registerObsidianTools(ctx: ServerContext): void {
  const { registry, router, config } = ctx;

  registry.add({
    name: "obsidian_commands",
    toolset: "core",
    capability: "cliCommand",
    description:
      "List CLI commands from live `__completions` introspection (enabled core plugins and dev " +
      "handlers). Prefer over guessing command names. Use obsidian_cli to run one. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      filter: z.string().optional().describe("Substring filter on command name"),
      refresh: z.boolean().optional().describe("Bypass the completions cache"),
    },
    handler: async (args) => {
      const filter = (args.filter as string | undefined)?.toLowerCase();
      const map = await getCompletions(router, {
        force: args.refresh === true,
      });
      const names = Object.keys(map).sort();
      const filtered =
        filter !== undefined && filter !== ""
          ? names.filter((n) => n.toLowerCase().includes(filter))
          : names;
      const text = filtered.map((n) => `${n}: ${map[n]?.description ?? ""}`).join("\n");
      return {
        text: text === "" ? "No commands match." : text,
        json: {
          count: filtered.length,
          commands: filtered.map((n) => ({ name: n, ...map[n] })),
        },
      };
    },
  });

  registry.add({
    name: "obsidian_hotkeys",
    toolset: "core",
    capability: "cliCommand",
    description:
      "List Obsidian's keyboard bindings, or look one up by command id. Use this to discover the " +
      "chord for a command before exercising it with obsidian_exercise_hotkey, and to confirm " +
      "whether a plugin's binding registered at all. Bindings are reported, not triggered. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      commandId: z
        .string()
        .optional()
        .describe("Look up one command's binding instead of listing all, e.g. editor:toggle-bold"),
      all: z
        .boolean()
        .optional()
        .describe("Include commands that have no binding (ignored with commandId)"),
      verbose: z.boolean().optional().describe("Show whether each binding is a custom override"),
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    handler: async (args) => {
      const commandId = args.commandId as string | undefined;
      const vault = vaultName(args, config);

      // Two CLI commands behind one tool, matching obsidian_theme's shape: the
      // per-item lookup and the listing answer the same question at two scales.
      if (commandId !== undefined && commandId !== "") {
        const tokens = [`id=${commandId}`];
        pushFlag(tokens, "verbose", args.verbose as boolean | undefined);
        const { stdout, parsed } = await runCli(router, {
          command: "hotkey",
          args: tokens,
          ...(vault !== undefined ? { vault } : {}),
        });
        return cliOutcome(stdout, parsed, `No hotkey is bound to ${commandId}.`);
      }

      const tokens: string[] = [];
      pushFlag(tokens, "all", args.all as boolean | undefined);
      pushFlag(tokens, "verbose", args.verbose as boolean | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "hotkeys",
        args: tokens,
        json: true,
        ...(vault !== undefined ? { vault } : {}),
      });
      return cliOutcome(stdout, parsed, "No hotkeys reported.");
    },
  });

  registry.add({
    name: "obsidian_command",
    toolset: "core",
    capability: "cliCommand",
    description:
      "Run a command-palette action by id (e.g. editor:toggle-source). Prefer over browser clicks " +
      "for deterministic automation. " +
      CLOSED_VAULT_WARNING,
    inputSchema: {
      id: z.string().describe("Command palette id"),
      vault: z.string().optional().describe("Target vault"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args) => {
      const { stdout } = await runCli(router, {
        command: "command",
        args: [`id=${args.id as string}`],
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Command executed");
    },
  });

  registry.add({
    name: "obsidian_plugin_list",
    toolset: "plugin-dev",
    capability: "cliCommand",
    description:
      "List installed plugins with enabled state. Use filter=community during plugin development. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      filter: z
        .enum(["core", "community"])
        .optional()
        .describe("Limit to core or community plugins"),
      versions: z.boolean().optional().describe("Include plugin versions"),
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushKv(tokens, "filter", args.filter as string | undefined);
      pushFlag(tokens, "versions", args.versions as boolean | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "plugins",
        args: tokens,
        vault: vaultName(args, config),
        json: true,
      });
      return cliOutcome(stdout, parsed);
    },
  });

  const pluginIdSchema = {
    id: z.string().describe("Plugin id"),
    vault: z.string().optional().describe("Target vault name; overrides the session default"),
  };

  registry.add({
    name: "obsidian_plugin_enable",
    toolset: "plugin-dev",
    capability: "cliCommand",
    description: "Enable a plugin by id. " + CLOSED_VAULT_WARNING,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    inputSchema: pluginIdSchema,
    handler: async (args) => {
      const id = args.id as string;
      const vault = vaultName(args, config);
      const enabled = await runCli(router, {
        command: "plugins:enabled",
        vault,
        json: true,
      });
      if (pluginListContains(enabled.parsed, enabled.stdout, id)) {
        return {
          text: `Plugin ${id} is already enabled.`,
          json: { id, enabled: true, changed: false },
        };
      }
      const { stdout } = await runCli(router, {
        command: "plugin:enable",
        args: [`id=${id}`],
        vault,
      });
      return {
        text: stdout.trim() || `Enabled ${id}.`,
        json: { id, enabled: true, changed: true },
      };
    },
  });

  registry.add({
    name: "obsidian_plugin_disable",
    toolset: "plugin-dev",
    capability: "cliCommand",
    description: "Disable a plugin by id. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: false, idempotentHint: true },
    inputSchema: pluginIdSchema,
    handler: async (args) => {
      const id = args.id as string;
      const vault = vaultName(args, config);
      const enabled = await runCli(router, {
        command: "plugins:enabled",
        vault,
        json: true,
      });
      if (!pluginListContains(enabled.parsed, enabled.stdout, id)) {
        return {
          text: `Plugin ${id} is already disabled.`,
          json: { id, enabled: false, changed: false },
        };
      }
      const { stdout } = await runCli(router, {
        command: "plugin:disable",
        args: [`id=${id}`],
        vault,
      });
      return {
        text: stdout.trim() || `Disabled ${id}.`,
        json: { id, enabled: false, changed: true },
      };
    },
  });

  registry.add({
    name: "obsidian_plugin_reload",
    toolset: "plugin-dev",
    capability: "cliCommand",
    description:
      "Hot-reload a plugin after rebuilding — fastest way to test code changes without restarting Obsidian. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: pluginIdSchema,
    handler: async (args) => {
      const { stdout } = await runCli(router, {
        command: "plugin:reload",
        args: [`id=${args.id as string}`],
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Reloaded");
    },
  });

  registry.add({
    name: "obsidian_plugin_install",
    toolset: "plugin-dev",
    capability: "pluginInstall",
    description:
      "Install a community plugin from the registry by id. Network access required. " +
      CLOSED_VAULT_WARNING,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      id: z.string().describe("Community plugin id"),
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    handler: async (args) => {
      const { stdout } = await runCli(router, {
        command: "plugin:install",
        args: [`id=${args.id as string}`],
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Installed");
    },
  });

  registry.add({
    name: "obsidian_plugin_uninstall",
    toolset: "plugin-dev",
    capability: "pluginInstall",
    description: "Uninstall a community plugin. " + CLOSED_VAULT_WARNING,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    },
    inputSchema: pluginIdSchema,
    handler: async (args) => {
      const { stdout } = await runCli(router, {
        command: "plugin:uninstall",
        args: [`id=${args.id as string}`],
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Uninstalled");
    },
  });

  registry.add({
    name: "obsidian_plugin_manifest",
    toolset: "plugin-dev",
    capability: "cliCommand",
    description:
      "Get plugin metadata (id, name, version, enabled). Prefer over reading manifest.json from disk " +
      "when the vault is open. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: pluginIdSchema,
    handler: async (args) => {
      const id = args.id as string;
      const { stdout } = await runCli(router, {
        command: "plugin",
        args: [`id=${id}`],
        vault: vaultName(args, config),
      });
      // Obsidian echoes type/name/version/author/enabled/description but never
      // the id it was asked about, so put it back to match this tool's contract.
      return cliOutcome(`id\t${id}\n${stdout.trim()}`);
    },
  });

  registry.add({
    name: "obsidian_plugin_settings",
    toolset: "plugin-dev",
    capability: "evaluate",
    description:
      "Read a plugin's persisted data and conventional runtime settings, or replace its persisted " +
      "data. Write requires the plugin to be loaded. Prefer over obsidian_eval for settings access. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      id: z.string().describe("Plugin id"),
      data: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("If set, replaces saved settings"),
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    handler: async (args) => {
      const id = args.id as string;
      const data = args.data as Record<string, unknown> | undefined;
      const vault = vaultName(args, config);
      if (data !== undefined) {
        await writePluginData(router, id, data, vault);
        return contentOutcome(`Saved settings for ${id}.`);
      }
      const value = await readPluginData(router, id, vault);
      const rendered = renderResult(value);
      return {
        text: `Plugin settings for ${id}:\n${rendered.text}`,
        json: { id, data: value, truncated: rendered.truncated },
      };
    },
  });

  registry.add({
    name: "obsidian_plugin_commands",
    toolset: "plugin-dev",
    capability: "evaluate",
    description:
      "List command-palette ids registered by a plugin (prefix filter). " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      id: z.string().describe("Plugin id prefix filter"),
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    handler: async (args) => {
      const prefix = args.id as string;
      const filtered = await listPluginCommandIds(router, prefix, vaultName(args, config));
      return {
        text: filtered.join("\n") || "(no commands)",
        json: { pluginId: prefix, count: filtered.length, commands: filtered },
      };
    },
  });

  registry.add({
    name: "obsidian_navigation_state",
    toolset: "core",
    capability: "evaluate",
    description:
      "Structured snapshot of open leaves, tabs, and the active file. Prefer over obsidian_tabs when " +
      "you need JSON rather than a tree drawing. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    handler: async (args) => {
      const code = `(() => {
        const leaves = [];
        app.workspace.iterateAllLeaves((leaf) => {
          const view = leaf.view;
          const file = view?.file;
          leaves.push({
            id: leaf.id,
            type: view?.getViewType?.() ?? "unknown",
            title: view?.getDisplayText?.() ?? "",
            file: file ? file.path : null,
            active: leaf === app.workspace.activeLeaf,
          });
        });
        return {
          activeFile: app.workspace.getActiveFile()?.path ?? null,
          leaves,
        };
      })()`;
      const value = await evalJson<unknown>(router, code, vaultName(args, config));
      return { text: "Navigation state captured.", json: value };
    },
  });

  registry.add({
    name: "obsidian_notice",
    toolset: "core",
    capability: "evaluate",
    description:
      "Show a transient Notice banner in the Obsidian UI — useful to confirm an automation step ran. " +
      "Notices render into `.notice-container` on `document.body`, outside `.workspace`, so workspace-scoped " +
      "snapshots will miss them. " +
      CLOSED_VAULT_WARNING,
    inputSchema: {
      message: z.string().describe("Notice text"),
      duration: z.number().optional().describe("Duration in ms (default 4000)"),
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    handler: async (args) => {
      const message = args.message as string;
      const duration = (args.duration as number | undefined) ?? 4000;
      const vault = vaultName(args, config);
      // Return a primitive — Notice objects are circular and fail Playwright serialization.
      const code = `(() => { new Notice(${JSON.stringify(message)}, ${duration}); return true; })()`;
      await router.evaluate(code, vault !== undefined ? { vault } : {});
      return contentOutcome(`Notice shown: ${message}`);
    },
  });

  registry.add({
    name: "obsidian_workspace",
    toolset: "core",
    capability: "cliCommand",
    description:
      "Human-readable workspace tree (main/left/right splits). Use obsidian_navigation_state for JSON. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      ids: z.boolean().optional().describe("Include workspace item ids"),
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFlag(tokens, "ids", args.ids as boolean | undefined);
      const { stdout } = await runCli(router, {
        command: "workspace",
        args: tokens,
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
    },
  });

  registry.add({
    name: "obsidian_reload",
    toolset: "core",
    capability: "cliCommand",
    description: "Reload the current vault (re-reads plugins and config). " + CLOSED_VAULT_WARNING,
    inputSchema: {
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    handler: async (args) => {
      const { stdout } = await runCli(router, {
        command: "reload",
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Vault reloaded");
    },
  });

  registry.add({
    name: "obsidian_restart",
    toolset: "core",
    capability: "launch",
    description:
      "Cold-restart this server's Obsidian instance with CDP preserved: quits it and relaunches " +
      "with --remote-debugging-port, then re-attaches. Under a session, only that session's " +
      "instance restarts. Equivalent to obsidian_launch with restart=true.",
    inputSchema: {},
    handler: async () => {
      // Deliberately not the in-app CLI `restart` command: Obsidian relaunches
      // itself without --remote-debugging-port, so every CDP-backed tool then
      // fails until an obsidian_launch that nothing prompted the agent to run.
      const result = await launchWithCdp(ctx, { restart: true });
      return {
        text: [
          result.restarted
            ? "Restarted Obsidian with CDP preserved."
            : "Obsidian was not running; started it with CDP enabled.",
          `CDP URL: ${result.cdpUrl}`,
        ].join("\n"),
        json: result,
      };
    },
  });
}
