/**
 * obsidian_reset_state — disable plugin, clear data.json, re-enable.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { TelemetryStore } from "../telemetry/store.js";
import type { ToolOutcome } from "../tools/registry.js";
import { escEvalString, vaultName } from "../obsidian/helpers.js";
import { UobError } from "../util/errors.js";
import { rendererEval } from "./eval.js";
import { appendTelemetrySummary } from "../telemetry/helpers.js";
import { pluginCli, settleMs } from "./helpers.js";

async function vaultBasePath(router: CapabilityRouter, vault?: string): Promise<string> {
  return rendererEval<string>(router, `app.vault.adapter.basePath`, vault);
}

/**
 * Confirm the directory we are about to write into is one knapper may touch.
 *
 * This is the only path that edits vault files directly on disk rather than
 * through a transport, so neither the CLI's `vault=` token nor the CDP window
 * check covers it. The path comes from the renderer, which means a window that
 * switched vaults between resolution and this call would hand us a different
 * directory than the one the fence approved — so it is re-checked here against
 * the path itself rather than trusted.
 */
async function assertWritableVaultPath(router: CapabilityRouter, basePath: string): Promise<void> {
  if (await router.fence.isPathAuthorized(basePath)) return;
  throw new UobError(
    "VAULT_NOT_AUTHORIZED",
    `Refusing to clear plugin data under ${basePath} — that vault is not authorized.`,
    {
      remediation:
        "The attached Obsidian window reported a vault directory knapper has no grant for. Attach " +
        "to an authorized vault before resetting plugin state.",
      details: { path: basePath },
    },
  );
}

export async function runResetPluginState(
  router: CapabilityRouter,
  config: Config,
  telemetry: TelemetryStore,
  pluginId: string,
  toolArgs: Record<string, unknown>,
): Promise<ToolOutcome> {
  const markSeq = telemetry.cursor;
  const vault = vaultName(toolArgs, config);
  const base = await vaultBasePath(router, vault);
  await assertWritableVaultPath(router, base);
  const dataPath = join(base, ".obsidian", "plugins", pluginId, "data.json");

  let backup: string | null = null;
  try {
    backup = await readFile(dataPath, "utf8");
  } catch {
    backup = null;
  }

  await pluginCli(router, config, "plugin:disable", pluginId, toolArgs);

  const empty = "{}\n";
  try {
    await writeFile(dataPath, empty, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      text: appendTelemetrySummary(
        `Disabled ${pluginId} but could not write data.json: ${msg}`,
        telemetry,
        markSeq,
      ),
      json: { pluginId, backup, dataCleared: false, error: msg },
    };
  }

  await settleMs(300);
  await pluginCli(router, config, "plugin:enable", pluginId, toolArgs);
  await settleMs(800);

  // Ensure in-memory plugin data matches cleared file when loaded.
  try {
    await router.evaluate(
      `(() => { const p = app.plugins.getPlugin(${escEvalString(pluginId)}); if (p) return p.loadData(); return null; })()`,
      vault !== undefined ? { vault } : {},
    );
  } catch {
    // best effort
  }

  const text = appendTelemetrySummary(
    `Reset ${pluginId}: disabled, cleared data.json, re-enabled. Previous data.json backed up in JSON.`,
    telemetry,
    markSeq,
  );

  return {
    text,
    json: {
      pluginId,
      dataCleared: true,
      backup: backup ?? null,
      dataPath,
    },
  };
}
