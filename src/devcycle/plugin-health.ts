/**
 * obsidian_plugin_health — loaded state, commands, recent errors.
 */

import type { CapabilityRouter } from "../connection/router.js";
import type { TelemetryStore } from "../telemetry/store.js";
import type { ToolOutcome } from "../tools/registry.js";
import { escEvalString } from "../obsidian/helpers.js";
import { rendererEval } from "./eval.js";

interface PluginHealthInfo {
  id: string;
  /** False when no registry knows this id at all — a typo, or never installed. */
  exists: boolean;
  /** Which registry it came from. Core plugins are not in app.plugins. */
  kind: "community" | "core" | "unknown";
  loaded: boolean;
  enabled: boolean;
  name: string | null;
  version: string | null;
  commands: string[];
}

export async function runPluginHealth(
  router: CapabilityRouter,
  telemetry: TelemetryStore,
  pluginId: string,
  vault?: string,
): Promise<ToolOutcome> {
  const info = await rendererEval<PluginHealthInfo>(
    router,
    `(() => {
      const id = ${escEvalString(pluginId)};

      // Community plugins live in app.plugins; core ones only in
      // app.internalPlugins. Checking just the former reported every core plugin
      // as absent and disabled.
      const manifest = app.plugins?.manifests?.[id];
      const community = manifest != null || app.plugins?.getPlugin?.(id) != null;
      const core = app.internalPlugins?.plugins?.[id];

      let kind = "unknown";
      let enabled = false;
      let loaded = false;
      let name = null;
      let version = null;

      if (community) {
        kind = "community";
        enabled = app.plugins.enabledPlugins?.has(id) === true;
        loaded = app.plugins.getPlugin(id) != null;
        name = manifest?.name ?? null;
        version = manifest?.version ?? null;
      } else if (core != null) {
        kind = "core";
        enabled = core.enabled === true;
        loaded = core.instance != null;
        name = core.instance?.name ?? core.name ?? id;
        version = null;
      }

      // Prefix match only. The old fallback also matched on the manifest name via
      // String(cmd.name).includes(manifest?.name ?? ""), and for an unknown plugin
      // that is includes("") — true for everything — so it returned the app's
      // entire command table as "commands this plugin likely owns".
      const commands = Object.keys(app.commands?.commands ?? {})
        .filter((cmdId) => cmdId === id || cmdId.startsWith(id + ":"))
        .sort();

      return { id, exists: kind !== "unknown", kind, loaded, enabled, name, version, commands };
    })()`,
    vault,
  );

  const recentErrors = telemetry.query({
    plugin: pluginId,
    minLevel: "error",
    limit: 10,
  });

  const lines = info.exists
    ? [
        `Plugin ${pluginId} (${info.kind})`,
        `  enabled: ${info.enabled ? "yes" : "no"}`,
        `  loaded: ${info.loaded ? "yes" : "no"}`,
        `  name: ${info.name ?? "(unknown)"}${info.version === null ? "" : ` v${info.version}`}`,
        `  commands (${info.commands.length}): ${info.commands.join(", ") || "(none)"}`,
        `  recent telemetry errors: ${recentErrors.matched}`,
      ]
    : [
        `No plugin with id "${pluginId}" is installed.`,
        "",
        "Neither the community registry (app.plugins) nor the core one",
        "(app.internalPlugins) knows this id. Check the spelling, or list what is",
        "actually present with obsidian_plugin_list.",
      ];

  return {
    text: lines.join("\n"),
    json: { ...info, recentErrors: recentErrors.records },
  };
}
