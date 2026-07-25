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
import { getCompletions, cliCommandIds } from "../obsidian/completions.js";

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
      const map = await getCompletions(router, { force: args.refresh === true });
      const names = Object.keys(map).sort();
      const filtered =
        filter !== undefined && filter !== ""
          ? names.filter((n) => n.toLowerCase().includes(filter))
          : names;
      const text = filtered.map((n) => `${n}: ${map[n]?.description ?? ""}`).join("\n");
      return {
        text: text === "" ? "No commands match." : text,
        json: { count: filtered.length, commands: filtered.map((n) => ({ name: n, ...map[n] })) },
      };
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
    inputSchema: pluginIdSchema,
    handler: async (args) => {
      const { stdout } = await runCli(router, {
        command: "plugin:enable",
        args: [`id=${args.id as string}`],
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Enabled");
    },
  });

  registry.add({
    name: "obsidian_plugin_disable",
    toolset: "plugin-dev",
    capability: "cliCommand",
    description: "Disable a plugin by id. " + CLOSED_VAULT_WARNING,
    inputSchema: pluginIdSchema,
    handler: async (args) => {
      const { stdout } = await runCli(router, {
        command: "plugin:disable",
        args: [`id=${args.id as string}`],
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Disabled");
    },
  });

  registry.add({
    name: "obsidian_plugin_reload",
    toolset: "plugin-dev",
    capability: "cliCommand",
    description:
      "Hot-reload a plugin after rebuilding — fastest way to test code changes without restarting Obsidian. " +
      CLOSED_VAULT_WARNING,
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
    annotations: { destructiveHint: true },
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
      "Read or write a plugin's persisted settings (data.json in memory). Write requires the plugin " +
      "to be loaded. Prefer over obsidian_eval for typed settings access. " +
      CLOSED_VAULT_WARNING,
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
      if (data !== undefined) {
        await writePluginData(router, id, data);
        return contentOutcome(`Saved settings for ${id}.`);
      }
      const value = await readPluginData(router, id);
      return { text: "Plugin settings loaded.", json: { id, data: value } };
    },
  });

  registry.add({
    name: "obsidian_plugin_commands",
    toolset: "plugin-dev",
    capability: "cliCommand",
    description:
      "List command-palette ids registered by a plugin (prefix filter). " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      id: z.string().describe("Plugin id prefix filter"),
      vault: z.string().optional().describe("Target vault name; overrides the session default"),
    },
    handler: async (args) => {
      const prefix = args.id as string;
      const ids = await cliCommandIds(router, prefix, vaultName(args, config));
      const filtered = ids.filter((c) => c.startsWith(prefix));
      return {
        text: filtered.join("\n") || "(no commands)",
        json: { pluginId: prefix, commands: filtered },
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
    handler: async () => {
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
      const value = await evalJson<unknown>(router, code);
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
    },
    handler: async (args) => {
      const message = args.message as string;
      const duration = (args.duration as number | undefined) ?? 4000;
      // Return a primitive — Notice objects are circular and fail Playwright serialization.
      const code = `(() => { new Notice(${JSON.stringify(message)}, ${duration}); return true; })()`;
      await router.evaluate(code);
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
    capability: "cliCommand",
    description:
      "Restart the Obsidian app via CLI. Does not add --remote-debugging-port; use obsidian_launch " +
      "after restart if you need CDP. " +
      CLOSED_VAULT_WARNING,
    inputSchema: {},
    handler: async () => {
      const { stdout } = await runCli(router, { command: "restart" });
      return contentOutcome(stdout, "Restart requested");
    },
  });
}
