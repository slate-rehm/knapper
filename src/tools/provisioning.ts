/**
 * Layer 2 — provisioning tools that make the server self-sufficient.
 */

import { z } from "zod";
import { lstat, readFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ServerContext } from "../server.js";
import { TOOLSET_DESCRIPTIONS, type Toolset } from "../toolsets.js";
import { launchObsidian } from "../connection/launch.js";
import { isObsidianRunning } from "../connection/health.js";
import { findVault, readGlobalConfig, writeCliFlag } from "../connection/vaults.js";
import { UobError } from "../util/errors.js";
import { contentOutcome, runCli } from "../obsidian/helpers.js";

const TEST_VAULT_HINT =
  "Use vault=uob-test-vault for automated testing; avoid writing to production vaults.";

async function vaultAutomationState(
  ctx: ServerContext,
  vaultName: string,
): Promise<{
  restrictMode: string;
  communityPlugins: boolean;
  devSymlinks: { id: string; path: string }[];
}> {
  const global = await readGlobalConfig();
  const entry = global ? findVault(global, vaultName) : undefined;
  const devSymlinks: { id: string; path: string }[] = [];
  let communityPlugins = false;

  if (entry?.path) {
    const pluginsDir = join(entry.path, ".obsidian", "plugins");
    try {
      const appJson = JSON.parse(
        await readFile(join(entry.path, ".obsidian", "app.json"), "utf8"),
      ) as { communityPluginEnabled?: boolean };
      communityPlugins = appJson.communityPluginEnabled === true;
    } catch {
      communityPlugins = false;
    }
    try {
      const { readdir } = await import("node:fs/promises");
      const names = await readdir(pluginsDir);
      for (const name of names) {
        const full = join(pluginsDir, name);
        try {
          const st = await lstat(full);
          if (st.isSymbolicLink()) {
            devSymlinks.push({ id: name, path: full });
          }
        } catch {
          // skip
        }
      }
    } catch {
      // no plugins dir
    }
  }

  let restrictMode = "unknown";
  try {
    const { stdout } = await runCli(ctx.router, {
      command: "plugins:restrict",
      vault: vaultName,
    });
    restrictMode = stdout.trim() || "unknown";
  } catch {
    restrictMode = "unknown";
  }

  return { restrictMode, communityPlugins, devSymlinks };
}

export function registerProvisioningTools(ctx: ServerContext): void {
  const { registry, router, config } = ctx;

  registry.add({
    name: "obsidian_doctor",
    toolset: "core",
    description:
      "Full diagnostic: the four precondition states (not running, CLI disabled, CDP closed, " +
      "argv corruption), binary path and version, registered vaults, target vault automation state, " +
      "dev-plugin symlinks, and per-toolset tool availability. Prefer this over obsidian_status when " +
      "something is broken — every problem includes remediation and names a fixing tool when one exists.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      vault: z.string().optional().describe("Vault to inspect for restrict-mode and plugin state"),
    },
    handler: async (args) => {
      const vaultArg = args.vault as string | undefined;
      const targetVault = vaultArg ?? config.vault;

      const health = await router.health();
      const availability = await router.refreshAvailability(true);

      let version = "";
      try {
        version = (await router.cli.run(["version"], { timeoutMs: 5000 })).trim();
      } catch {
        version = "(unavailable)";
      }

      const toolsets: Record<string, { enabled: boolean; tools: string[] }> = {};
      const byToolset = registry.byToolset();
      for (const name of Object.keys(TOOLSET_DESCRIPTIONS) as Toolset[]) {
        const enabled = config.enabledToolsets.has(name);
        toolsets[name] = { enabled, tools: byToolset[name] ?? [] };
      }

      let vaultState: Awaited<ReturnType<typeof vaultAutomationState>> | undefined;
      if (targetVault !== undefined && targetVault !== "") {
        vaultState = await vaultAutomationState(ctx, targetVault);
      }

      const lines = [
        `Obsidian running: ${health.running ? "yes" : "no"}`,
        `CLI enabled (config): ${health.cliEnabled ? "yes" : "no"}`,
        `CLI reachable: ${health.cliReachable ? "yes" : "no"}`,
        `CDP reachable: ${health.cdpReachable ? "yes" : "no"} (${health.cdpUrl})`,
        `Binary: ${config.obsidianBin}`,
        `Version: ${version}`,
        `Config: ${health.configPath}`,
      ];

      if (health.argvCorruption) {
        lines.push(
          `Argv corruption: ${health.argvCorruption.tokens.join(", ")} in ${health.argvCorruption.path}`,
        );
      }

      lines.push("", "Registered vaults:");
      for (const v of health.vaults) {
        lines.push(`  - ${v.name}${v.open ? " (open)" : ""} → ${v.path}`);
      }

      if (vaultState && targetVault) {
        lines.push(
          "",
          `Vault "${targetVault}" automation:`,
          `  Restricted mode: ${vaultState.restrictMode}`,
          `  Community plugins (app.json): ${vaultState.communityPlugins ? "on" : "off"}`,
          `  Dev symlinks: ${vaultState.devSymlinks.length === 0 ? "none" : vaultState.devSymlinks.map((s) => s.id).join(", ")}`,
        );
      }

      if (health.problems.length > 0) {
        lines.push("", "Problems:");
        for (const p of health.problems) {
          lines.push(`  [${p.state}] ${p.message}`);
          lines.push(`    → ${p.remediation}`);
          if (p.fixedBy) lines.push(`    Fix: ${p.fixedBy}`);
        }
      }

      lines.push("", "Toolsets:");
      for (const [name, info] of Object.entries(toolsets)) {
        lines.push(
          `  ${name}: ${info.enabled ? "enabled" : "disabled"} (${info.tools.length} tools)`,
        );
      }

      return {
        text: lines.join("\n"),
        json: {
          health,
          availability,
          binary: config.obsidianBin,
          version,
          argvCorruption: health.argvCorruption ?? null,
          vaults: health.vaults,
          targetVault: targetVault ?? null,
          vaultState: vaultState ?? null,
          toolsets,
          transports: availability,
        },
      };
    },
  });

  registry.add({
    name: "obsidian_launch",
    toolset: "core",
    capability: "launch",
    description:
      "Cold-start Obsidian with `--remote-debugging-port` and `--remote-allow-origins=*`. " +
      "Because of Electron's single-instance lock, launching while Obsidian is already running " +
      "silently drops the debug flag — use restart=true to quit first. Never overrides user-data-dir. " +
      "Prefer this over manual nohup when CDP attach times out.",
    inputSchema: {
      port: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Debug port (0 = auto via DevToolsActivePort; default: from OBSIDIAN_CDP_URL)"),
      restart: z
        .boolean()
        .optional()
        .describe("Quit any running instance before launching (required to gain CDP on Linux)"),
      force: z.boolean().optional().describe("Alias for restart"),
    },
    handler: async (args) => {
      const portArg = args.port as number | undefined;
      const port = portArg ?? config.cdpPort;
      const result = await launchObsidian({
        obsidianBin: config.obsidianBin,
        port,
        restart: args.restart === true,
        force: args.force === true,
        logger: ctx.logger,
      });

      await router.refreshAvailability(true);

      return {
        text: [
          result.restarted
            ? "Restarted Obsidian with CDP enabled."
            : "Obsidian is running with CDP enabled.",
          `CDP URL: ${result.cdpUrl}`,
          `Port: ${result.port}`,
          config.cdpUrl !== result.cdpUrl
            ? `Note: server config still points at ${config.cdpUrl} — set OBSIDIAN_CDP_URL if needed.`
            : "",
        ]
          .filter((l) => l !== "")
          .join("\n"),
        json: result,
      };
    },
  });

  registry.add({
    name: "obsidian_setup_cli",
    toolset: "core",
    description:
      "Enable Obsidian's global CLI toggle (`cli` in obsidian.json). While the app is running, " +
      "uses the renderer ipcRenderer bootstrap (same as Settings). While quit, edits the file " +
      "directly. Refuses to edit the file while Obsidian is running because the live instance " +
      'overwrites obsidian.json on exit. On Arch Linux the in-app "Register CLI" button does not ' +
      "work (the binary is electron39, not obsidian); registration is unnecessary when `obsidian` is on PATH.",
    inputSchema: {
      enabled: z.boolean().optional().describe("Enable (default) or disable the CLI"),
    },
    handler: async (args) => {
      const enabled = args.enabled !== false;
      const running = await isObsidianRunning();

      if (running) {
        if (!enabled) {
          throw new UobError(
            "INVALID_ARGUMENT",
            "Disabling CLI while Obsidian is running is not supported.",
            {
              remediation: "Quit Obsidian, then call obsidian_setup_cli with enabled=false.",
            },
          );
        }
        await router.resolve("evaluate");
        const layer = await router.refreshAvailability(true);
        if (!layer.playwright) {
          throw new UobError(
            "CDP_PORT_CLOSED",
            "CDP is required to enable CLI while Obsidian is running.",
            {
              remediation:
                "Launch with --remote-debugging-port or quit Obsidian and call obsidian_setup_cli again.",
              fixedBy: "obsidian_launch",
            },
          );
        }
        router.claimDebugger("playwright");
        await router.playwright.evaluate(`require("electron").ipcRenderer.sendSync("cli", true)`);
        return contentOutcome("CLI enabled via renderer IPC (persists like the settings UI).");
      }

      await writeCliFlag(enabled);
      return contentOutcome(
        enabled
          ? "Wrote cli=true to obsidian.json. Start Obsidian to use the CLI."
          : "Removed cli flag from obsidian.json.",
      );
    },
  });

  registry.add({
    name: "obsidian_setup_vault",
    toolset: "core",
    capability: "cliCommand",
    description:
      "Prepare a vault for plugin development: turn off restricted mode, enable community plugins " +
      "in app.json, and optionally enable a plugin by id. " +
      TEST_VAULT_HINT +
      " " +
      "May open a closed vault in a new window.",
    inputSchema: {
      vault: z.string().describe("Registered vault name"),
      pluginId: z.string().optional().describe("Community plugin id to enable after setup"),
    },
    handler: async (args) => {
      const vault = args.vault as string;
      const pluginId = args.pluginId as string | undefined;

      const global = await readGlobalConfig();
      const entry = global ? findVault(global, vault) : undefined;
      if (!entry) {
        const known = global?.vaults.map((v) => v.name) ?? [];
        throw new UobError("VAULT_NOT_FOUND", `Unknown vault "${vault}".`, {
          remediation:
            known.length > 0
              ? `Known: ${known.join(", ")}`
              : "Register the vault in Obsidian first.",
          details: { known },
        });
      }

      await runCli(router, { command: "plugins:restrict", args: ["off"], vault });

      const appPath = join(entry.path, ".obsidian", "app.json");
      let appCfg: Record<string, unknown> = {};
      try {
        appCfg = JSON.parse(await readFile(appPath, "utf8")) as Record<string, unknown>;
      } catch {
        appCfg = {};
      }
      appCfg.communityPluginEnabled = true;
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(join(entry.path, ".obsidian"), { recursive: true });
      await writeFile(appPath, `${JSON.stringify(appCfg, null, 2)}\n`, "utf8");

      if (pluginId !== undefined && pluginId !== "") {
        await runCli(router, {
          command: "plugin:enable",
          args: [`id=${pluginId}`],
          vault,
        });
      }

      const state = await vaultAutomationState(ctx, vault);
      return {
        text: `Vault "${vault}" is automation-ready (restrict off, community plugins on).`,
        json: { vault, pluginId: pluginId ?? null, state },
      };
    },
  });

  registry.add({
    name: "obsidian_link_plugin",
    toolset: "core",
    description:
      "Symlink a plugin build directory into `<vault>/.obsidian/plugins/<id>` for a dev loop. " +
      "Source must contain manifest.json (id read from it when omitted). Refuses to replace a real " +
      "directory — only an existing symlink may be replaced. Use unlink=true to remove the symlink.",
    inputSchema: {
      vault: z.string().describe("Registered vault name"),
      sourceDir: z.string().describe("Absolute path to the plugin project root"),
      pluginId: z.string().optional().describe("Plugin id (default: read from manifest.json)"),
      unlink: z.boolean().optional().describe("Remove the symlink instead of creating one"),
    },
    handler: async (args) => {
      const vault = args.vault as string;
      const sourceDir = args.sourceDir as string;
      const unlinkMode = args.unlink === true;
      let pluginId = args.pluginId as string | undefined;

      const global = await readGlobalConfig();
      const entry = global ? findVault(global, vault) : undefined;
      if (!entry?.path) {
        throw new UobError("VAULT_NOT_FOUND", `Unknown vault "${vault}".`, {});
      }

      if (!unlinkMode) {
        let manifest: { id?: string };
        try {
          manifest = JSON.parse(await readFile(join(sourceDir, "manifest.json"), "utf8")) as {
            id?: string;
          };
        } catch {
          throw new UobError("INVALID_ARGUMENT", `No manifest.json in ${sourceDir}.`, {});
        }
        pluginId = pluginId ?? manifest.id;
        if (pluginId === undefined || pluginId === "") {
          throw new UobError("INVALID_ARGUMENT", "manifest.json has no id field.", {});
        }
      } else if (pluginId === undefined || pluginId === "") {
        throw new UobError("INVALID_ARGUMENT", "pluginId is required when unlink=true.", {});
      }

      const linkPath = join(entry.path, ".obsidian", "plugins", pluginId!);
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(entry.path, ".obsidian", "plugins"), { recursive: true });

      if (unlinkMode) {
        try {
          const st = await lstat(linkPath);
          if (!st.isSymbolicLink()) {
            throw new UobError("INVALID_ARGUMENT", `${linkPath} is not a symlink.`, {});
          }
          await unlink(linkPath);
        } catch (e) {
          if (e instanceof UobError) throw e;
          throw new UobError("INVALID_ARGUMENT", `No symlink at ${linkPath}.`, {});
        }
        return contentOutcome(`Removed symlink ${linkPath}`);
      }

      try {
        const st = await lstat(linkPath);
        if (st.isSymbolicLink()) {
          await unlink(linkPath);
        } else {
          throw new UobError(
            "INVALID_ARGUMENT",
            `${linkPath} exists and is not a symlink — refusing to clobber.`,
            {},
          );
        }
      } catch (e) {
        if (e instanceof UobError) throw e;
        // does not exist — ok
      }

      await symlink(sourceDir, linkPath);
      return {
        text: `Linked ${sourceDir} → ${linkPath}`,
        json: { vault, pluginId, sourceDir, linkPath },
      };
    },
  });
}
