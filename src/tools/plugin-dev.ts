/**
 * Plugin development composites built on CLI + telemetry primitives.
 */

import { z } from "zod";
import type { ServerContext } from "../server.js";
import { vaultName, CLOSED_VAULT_WARNING } from "../obsidian/helpers.js";
import { runDevCycle } from "../devcycle/dev-cycle.js";
import { runExerciseCommand } from "../devcycle/exercise-command.js";
import { runResetPluginState } from "../devcycle/reset-state.js";
import { runPluginHealth } from "../devcycle/plugin-health.js";

export function registerPluginDevTools(ctx: ServerContext): void {
  const { registry, router, config, telemetry, capture } = ctx;

  registry.add({
    name: "obsidian_dev_cycle",
    toolset: "plugin-dev",
    handlesOwnTelemetry: true,
    description:
      "Answer “did my plugin change work?” in one call: insert a telemetry mark, reload the plugin " +
      "via CLI, optionally open a note, wait for the UI to settle, capture a screenshot, and return " +
      "console errors since the mark (attributed to the plugin when possible). Prefer this after " +
      "editing plugin source over manual reload + log spelunking. Side effects: reloads the plugin; " +
      "may open a note; reload throws away in-memory plugin state.",
    inputSchema: {
      pluginId: z.string().min(1).describe("Plugin id folder name under .obsidian/plugins/"),
      openPath: z
        .string()
        .optional()
        .describe("Vault-relative note path to open after reload (e.g. Notes/Alpha.md)"),
      waitMs: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Milliseconds to wait after reload before screenshot/logs (default 1500)"),
      vault: z
        .string()
        .optional()
        .describe(`Target vault name; default from session. ${CLOSED_VAULT_WARNING}`),
    },
    handler: async (args) =>
      runDevCycle(
        router,
        config,
        telemetry,
        capture,
        {
          pluginId: args.pluginId as string,
          openPath: args.openPath as string | undefined,
          waitMs: args.waitMs as number | undefined,
          vault: vaultName(args, config),
        },
        args,
      ),
  });

  registry.add({
    name: "obsidian_exercise_command",
    toolset: "plugin-dev",
    capability: "evaluate",
    handlesOwnTelemetry: true,
    description:
      "Run an Obsidian command-palette command by id (via app.commands.executeCommandById), wait for " +
      "the UI to settle, and return workspace state before/after plus new console output since a " +
      "telemetry mark. Prefer this over menu clicking when verifying a plugin-registered command. " +
      "Side effects: whatever the command does.",
    inputSchema: {
      commandId: z.string().min(1).describe("Command id, often pluginId:command-name"),
      waitMs: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Milliseconds to wait after running the command (default 1000)"),
      vault: z.string().optional().describe(`Target vault. ${CLOSED_VAULT_WARNING}`),
    },
    handler: async (args) =>
      runExerciseCommand(
        router,
        config,
        telemetry,
        args.commandId as string,
        (args.waitMs as number | undefined) ?? 1000,
        args,
      ),
  });

  registry.add({
    name: "obsidian_reset_state",
    toolset: "plugin-dev",
    handlesOwnTelemetry: true,
    description:
      "Disable a plugin, reset its data.json to {}, and re-enable it for a clean-slate test run. " +
      "Returns the previous data.json contents so you can restore them. Side effects: plugin unload/load; " +
      "wiping persisted settings.",
    annotations: { destructiveHint: true },
    inputSchema: {
      pluginId: z.string().min(1).describe("Plugin id to reset"),
      vault: z.string().optional().describe(`Target vault. ${CLOSED_VAULT_WARNING}`),
    },
    handler: async (args) =>
      runResetPluginState(router, config, telemetry, args.pluginId as string, args),
  });

  registry.add({
    name: "obsidian_plugin_health",
    toolset: "plugin-dev",
    capability: "evaluate",
    description:
      "Report whether a plugin is enabled and loaded, its manifest name/version, command ids it likely " +
      "owns, and recent attributed telemetry errors. Use after enable/reload or when a plugin silently " +
      "fails onload. Read-only aside from renderer inspection.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      pluginId: z.string().min(1).describe("Plugin id"),
      vault: z.string().optional().describe(`Target vault. ${CLOSED_VAULT_WARNING}`),
    },
    handler: async (args) =>
      runPluginHealth(router, telemetry, args.pluginId as string, vaultName(args, config)),
  });
}
