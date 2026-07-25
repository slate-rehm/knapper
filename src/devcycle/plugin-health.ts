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
): Promise<ToolOutcome> {
  const info = await rendererEval<PluginHealthInfo>(
    router,
    `(() => {
      const id = ${escEvalString(pluginId)};
      const manifests = app.plugins.manifests;
      const manifest = manifests[id];
      const instance = app.plugins.getPlugin(id);
      const enabled = app.plugins.enabledPlugins.has(id);
      const commands = [];
      for (const [cmdId, cmd] of Object.entries(app.commands.commands)) {
        if (cmdId.startsWith(id + ":") || (cmd && cmd.name && String(cmd.name).includes(manifest?.name ?? ""))) {
          commands.push(cmdId);
        }
      }
      return {
        id,
        loaded: instance != null,
        enabled,
        name: manifest?.name ?? null,
        version: manifest?.version ?? null,
        commands: commands.sort(),
      };
    })()`,
  );

  const recentErrors = telemetry.query({
    plugin: pluginId,
    minLevel: "error",
    limit: 10,
  });

  const lines = [
    `Plugin ${pluginId}`,
    `  enabled: ${info.enabled ? "yes" : "no"}`,
    `  loaded: ${info.loaded ? "yes" : "no"}`,
    `  name: ${info.name ?? "(unknown)"} v${info.version ?? "?"}`,
    `  commands (${info.commands.length}): ${info.commands.join(", ") || "(none)"}`,
    `  recent telemetry errors: ${recentErrors.matched}`,
  ];

  return {
    text: lines.join("\n"),
    json: { ...info, recentErrors: recentErrors.records },
  };
}
