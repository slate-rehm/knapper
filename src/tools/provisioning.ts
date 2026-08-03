/**
 * Layer 2 — provisioning tools that make the server self-sufficient.
 */

import { z } from "zod";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ServerContext } from "../server.js";
import { TOOLSET_DESCRIPTIONS, type Toolset } from "../toolsets.js";
import { launchObsidian, type LaunchResult } from "../connection/launch.js";
import { findDownloadedAsarVersion, versionDrift } from "../obsidian/version-drift.js";
import { isObsidianRunning } from "../connection/health.js";
import {
  createManagedVault,
  findVault,
  readGlobalConfig,
  removeManagedVault,
  writeCliFlag,
  MANAGED_MARKER,
} from "../connection/vaults.js";
import { cliSocketPathFor } from "../config.js";
import { UobError } from "../util/errors.js";
import { linkPlugin, unlinkPlugin } from "../session/plugin-link.js";
import { contentOutcome, runCli } from "../obsidian/helpers.js";

async function vaultAutomationState(
  ctx: ServerContext,
  vaultName: string,
  configPath: string,
): Promise<{
  restrictMode: string;
  communityPlugins: boolean;
  devSymlinks: { id: string; path: string }[];
}> {
  const global = await readGlobalConfig(configPath);
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

/**
 * Launch (or relaunch) this server's Obsidian with CDP and re-point the router.
 *
 * Shared by obsidian_launch and obsidian_restart so the retarget-after-launch
 * invariant lives in one place: with `--remote-debugging-port=0` the real port is
 * only known after startup, and a router still probing the configured port would
 * leave every CDP tool failing against a healthy app.
 */
export async function launchWithCdp(
  ctx: ServerContext,
  opts: { port?: number; restart?: boolean; force?: boolean } = {},
): Promise<LaunchResult> {
  const { config, router } = ctx;
  const result = await launchObsidian({
    obsidianBin: config.obsidianBin,
    port: opts.port ?? config.cdpPort,
    restart: opts.restart === true,
    force: opts.force === true,
    logger: ctx.logger,
    // Under a session this launches (and quits) only that session's instance.
    // Unbound, both stay undefined and this drives the user's own Obsidian
    // exactly as it did before sessions existed.
    ...(config.sessionId !== undefined ? { userDataDir: config.userDataDir } : {}),
    ...(config.runtimeDir !== undefined ? { runtimeDir: config.runtimeDir } : {}),
  });
  if (result.cdpUrl !== config.cdpUrl) await router.retarget(result.cdpUrl);
  await router.refreshAvailability(true);
  return result;
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
        // A cold-starting Obsidian prints startup lines ("Loaded main app package
        // …") on the same stdout, and taking the whole buffer made doctor report a
        // log excerpt as the version — in exactly the broken state doctor exists to
        // diagnose. Pick the line that actually looks like a version.
        const raw = await router.cli.run(["version"], { timeoutMs: 5000 });
        const line = raw
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l !== "")
          .find((l) => /^v?\d+\.\d+\.\d+/.test(l));
        version = line ?? "(unavailable)";
      } catch {
        version = "(unavailable)";
      }

      const toolsets: Record<string, { enabled: boolean; tools: string[] }> = {};
      const byToolset = registry.groupAllByToolset();
      for (const name of Object.keys(TOOLSET_DESCRIPTIONS) as Toolset[]) {
        const enabled = registry.isToolsetEnabled(name);
        toolsets[name] = { enabled, tools: byToolset[name] ?? [] };
      }

      let vaultState: Awaited<ReturnType<typeof vaultAutomationState>> | undefined;
      if (targetVault !== undefined && targetVault !== "") {
        vaultState = await vaultAutomationState(ctx, targetVault, config.obsidianConfigPath);
      }

      // The in-app updater drops `obsidian-<v>.asar` next to obsidian.json and
      // only loads it on the next launch, so the downloaded and running versions
      // can drift for days. A report line, not a precondition: the app works
      // either way, but an agent wondering why a fix "is not live" should see it.
      const downloadedAsar = await findDownloadedAsarVersion(dirname(config.obsidianConfigPath));
      const drift = versionDrift(version, downloadedAsar);

      const lines = [
        `Obsidian running: ${health.running ? "yes" : "no"}`,
        `CLI enabled (config): ${health.cliEnabled ? "yes" : "no"}`,
        `CLI reachable: ${health.cliReachable ? "yes" : "no"}`,
        `CDP reachable: ${health.cdpReachable ? "yes" : "no"} (${health.cdpUrl})`,
        `Binary: ${config.obsidianBin}`,
        `Version: ${version}`,
        ...(drift !== undefined
          ? [
              `Update pending: ${drift.installed} downloaded, ${drift.running} running — ` +
                "cold-restart Obsidian (obsidian_restart) to load it.",
            ]
          : []),
        `Config: ${health.configPath}`,
      ];

      // Which instance this server drives, and how well CLI commands are pinned to
      // it. `shared` means a CLI call may land in whichever Obsidian booted last,
      // which is worth saying out loud because nothing else reports it.
      if (config.sessionId !== undefined) {
        lines.push(
          `Session: ${config.sessionId}`,
          `Profile: ${config.userDataDir}`,
          `CLI isolation: ${config.cliIsolation}` +
            (config.cliIsolation === "per-session"
              ? ` (socket ${cliSocketPathFor(config.runtimeDir)})`
              : " — CLI commands are not pinned to this instance; the renderer route is"),
        );
      } else {
        lines.push("Session: none (driving the installation's own Obsidian)");
      }

      if (health.argvCorruption) {
        lines.push(
          `Argv corruption: ${health.argvCorruption.tokens.join(", ")} in ${health.argvCorruption.path}`,
        );
      }

      // Authorization is the first thing an agent needs from the doctor now: a
      // refusal from any vault-scoped tool is diagnosed here, and "created" vs
      // "adopted" tells it whether the vault is scratch space or someone's notes.
      const vaultStatus = await router.fence.status();
      const authorizedCount = vaultStatus.filter((v) => v.authorized).length;

      lines.push("", `Registered vaults (${authorizedCount} authorized):`);
      for (const v of vaultStatus) {
        const grantTag =
          v.grant === "created"
            ? "authorized, knapper-created (removable)"
            : v.grant === "adopted"
              ? "authorized by the user (never deleted by knapper)"
              : "NOT AUTHORIZED — vault-scoped tools will refuse";
        const tags = [v.open ? "open" : "", grantTag].filter((t) => t !== "").join(", ");
        lines.push(`  - ${v.name} (${tags}) → ${v.path}`);
      }
      if (authorizedCount === 0) {
        lines.push(
          "  No vault is authorized. Every vault-scoped tool will refuse until the user runs",
          "  `npx knapper authorize <vault path>` themselves, or obsidian_create_vault makes a",
          "  throwaway one. Do not suggest the authorize command unless the user asked to work",
          "  in a specific existing vault.",
        );
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
          versionDrift: drift ?? null,
          downloadedAsarVersion: downloadedAsar ?? null,
          argvCorruption: health.argvCorruption ?? null,
          vaults: vaultStatus.map((v) => ({
            ...v,
            // Retained for compatibility with the pre-fence shape; `grant` is the
            // field to read now, since it distinguishes created from adopted.
            knapperManaged: v.grant === "created",
          })),
          authorizedVaultCount: authorizedCount,
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
      "silently drops the debug flag — use restart=true to quit first. Targets this server's " +
      "instance: under a session that is the session's own private profile, otherwise the user's " +
      "installation. Prefer this over manual nohup when CDP attach times out.",
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
      const result = await launchWithCdp(ctx, {
        ...(portArg !== undefined ? { port: portArg } : {}),
        restart: args.restart === true,
        force: args.force === true,
      });

      return {
        text: [
          result.restarted
            ? "Restarted Obsidian with CDP enabled."
            : "Obsidian is running with CDP enabled.",
          `CDP URL: ${result.cdpUrl}`,
          `Port: ${result.port}`,
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
      const running = await isObsidianRunning(router.processScope);

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

      await writeCliFlag(enabled, config.obsidianConfigPath);
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
      " " +
      "May open a closed vault in a new window.",
    inputSchema: {
      vault: z.string().describe("Registered vault name"),
      pluginId: z.string().optional().describe("Community plugin id to enable after setup"),
    },
    handler: async (args) => {
      const vault = args.vault as string;
      const pluginId = args.pluginId as string | undefined;

      // Fenced explicitly rather than by accident. This handler writes app.json
      // straight to disk, and it used to take that path from an unauthorized
      // registry lookup — safe only because the `plugins:restrict` call below
      // happens to fence first and throw. Reordering those two lines would have
      // silently turned this into a write into any registered vault.
      const target = await router.fence.resolve(vault);

      await runCli(router, { command: "plugins:restrict", args: ["off"], vault });

      const appPath = join(target.path, ".obsidian", "app.json");
      let appCfg: Record<string, unknown> = {};
      try {
        appCfg = JSON.parse(await readFile(appPath, "utf8")) as Record<string, unknown>;
      } catch {
        appCfg = {};
      }
      appCfg.communityPluginEnabled = true;
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(join(target.path, ".obsidian"), { recursive: true });
      await writeFile(appPath, `${JSON.stringify(appCfg, null, 2)}\n`, "utf8");

      if (pluginId !== undefined && pluginId !== "") {
        await runCli(router, {
          command: "plugin:enable",
          args: [`id=${pluginId}`],
          vault,
        });
      }

      const state = await vaultAutomationState(ctx, vault, config.obsidianConfigPath);
      return {
        text: `Vault "${vault}" is automation-ready (restrict off, community plugins on).`,
        json: { vault, pluginId: pluginId ?? null, state },
      };
    },
  });

  registry.add({
    name: "obsidian_create_vault",
    toolset: "core",
    description:
      "Create a disposable test vault and register it with Obsidian. Writes a " +
      `\`${MANAGED_MARKER}\` marker into the directory, which is the only thing that later lets ` +
      "obsidian_remove_vault delete it — a vault you made by hand can never be removed by that " +
      "tool. Refuses to adopt a directory that already contains files. Obsidian caches the vault " +
      "registry at startup, so the new vault is not usable until a cold restart.",
    inputSchema: {
      path: z.string().describe("Absolute path for the vault directory (created if missing)"),
      open: z
        .boolean()
        .optional()
        .describe("Cold-restart Obsidian afterwards so the vault is immediately usable"),
    },
    handler: async (args) => {
      const path = args.path as string;
      const result = await createManagedVault(path, new Date(), config.obsidianConfigPath);

      let restarted = false;
      let automationReady = false;
      let restartError: string | undefined;
      if (args.open === true) {
        // A running instance holds obsidian.json in memory and rewrites it on exit,
        // so the registry edit only takes effect after a genuine cold start.
        try {
          await launchObsidian({
            obsidianBin: config.obsidianBin,
            port: config.cdpPort,
            restart: true,
            logger: ctx.logger,
          });
          await router.refreshAvailability(true);
          restarted = true;

          // A brand-new vault has community plugins off, so plugin tools fail on
          // first use. Write app.json directly instead of going through the CLI:
          // Obsidian only registers a vault's commands once it has opened that
          // vault, so `plugins:restrict` is genuinely absent this early and the
          // filesystem is the only thing that works.
          try {
            const appDir = join(result.path, ".obsidian");
            const { writeFile, mkdir } = await import("node:fs/promises");
            await mkdir(appDir, { recursive: true });
            let appCfg: Record<string, unknown> = {};
            try {
              appCfg = JSON.parse(await readFile(join(appDir, "app.json"), "utf8")) as Record<
                string,
                unknown
              >;
            } catch {
              appCfg = {};
            }
            appCfg.communityPluginEnabled = true;
            await writeFile(
              join(appDir, "app.json"),
              `${JSON.stringify(appCfg, null, 2)}\n`,
              "utf8",
            );
            automationReady = true;

            // Best effort on top; only works once Obsidian has opened the vault,
            // and the app.json write above already covers what matters.
            try {
              await runCli(router, {
                command: "plugins:restrict",
                args: ["off"],
                vault: result.name,
              });
            } catch {
              // expected on a vault Obsidian has not opened yet
            }
          } catch (e) {
            ctx.logger.warn("created vault but could not make it automation-ready", {
              error: e instanceof Error ? e.message : String(e),
            });
          }
        } catch (e) {
          // The vault is already created and registered by this point. Throwing
          // would hide that and invite a retry that then trips the
          // already-exists path, so report it as partial success instead.
          restartError = e instanceof Error ? e.message : String(e);
        }
      }

      const status = restarted
        ? automationReady
          ? "Obsidian was cold-restarted and the vault is automation-ready (restricted mode off, community plugins on)."
          : "Obsidian was cold-restarted, but making the vault automation-ready failed — run obsidian_setup_vault before using plugin tools."
        : restartError !== undefined
          ? `The vault exists and is registered, but the restart failed: ${restartError} ` +
            "Quit Obsidian yourself and call obsidian_launch to finish."
          : "Obsidian caches the vault registry at startup — call obsidian_launch with restart=true (or re-run this with open=true) before using the vault.";

      return {
        text: [
          `Created test vault "${result.name}" at ${result.path}`,
          result.createdDirectory
            ? "Directory created."
            : "Directory already existed and was empty.",
          `Marker written: ${MANAGED_MARKER}`,
          status,
        ].join("\n"),
        json: { ...result, restarted, automationReady, restartError: restartError ?? null },
      };
    },
  });

  registry.add({
    name: "obsidian_remove_vault",
    toolset: "core",
    description:
      "Remove a test vault created by obsidian_create_vault: unregister it from Obsidian and, with " +
      "deleteFiles=true, delete its directory. " +
      `**Refuses outright unless the vault carries a \`${MANAGED_MARKER}\` marker**, so vaults you ` +
      "created yourself are never touched — delete those from Obsidian's vault switcher by hand. " +
      "Also refuses a path that contains another registered vault.",
    inputSchema: {
      vault: z
        .string()
        .describe("Registered vault name, or an absolute path to the vault directory"),
      deleteFiles: z
        .boolean()
        .optional()
        .describe("Also delete the directory and its contents (default: unregister only)"),
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const wanted = args.vault as string;
      const deleteFiles = args.deleteFiles === true;

      const global = await readGlobalConfig(config.obsidianConfigPath);
      const vaults = global?.vaults ?? [];
      // Accept a path so an unregistered leftover directory can still be cleaned up.
      const entry = global ? findVault(global, wanted) : undefined;
      const targetPath = entry?.path ?? (wanted.startsWith("/") ? wanted : undefined);
      if (targetPath === undefined) {
        throw new UobError("VAULT_NOT_FOUND", `Unknown vault "${wanted}".`, {
          remediation:
            vaults.length > 0
              ? `Known: ${vaults.map((v) => v.name).join(", ")}. An absolute path also works.`
              : "Pass an absolute path to the vault directory.",
          details: { known: vaults.map((v) => v.name) },
        });
      }

      const result = await removeManagedVault(
        targetPath,
        vaults,
        deleteFiles,
        config.obsidianConfigPath,
      );
      return {
        text: [
          `Removed test vault at ${result.path}`,
          result.unregistered ? "Unregistered from obsidian.json." : "Was not registered.",
          result.deletedDirectory ? "Directory deleted." : "Directory left on disk.",
          "Obsidian caches the registry at startup; restart it to drop the entry from the switcher.",
        ].join("\n"),
        json: result,
      };
    },
  });

  registry.add({
    name: "obsidian_link_plugin",
    toolset: "core",
    description:
      "Symlink a loadable plugin directory into `<vault>/.obsidian/plugins/<id>` for a dev loop. " +
      "Source must contain manifest.json and main.js. Refuses to replace a real " +
      "directory — only an existing symlink may be replaced. Use unlink=true to remove the symlink.",
    inputSchema: {
      vault: z.string().describe("Registered vault name"),
      sourceDir: z.string().describe("Absolute path to a loadable plugin directory"),
      pluginId: z.string().optional().describe("Plugin id (default: read from manifest.json)"),
      unlink: z.boolean().optional().describe("Remove the symlink instead of creating one"),
    },
    // Replaces an existing symlink at the target path, and unlink=true removes one.
    // It refuses to clobber a real directory, but the link itself is still lost.
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const vault = args.vault as string;
      const sourceDir = args.sourceDir as string;
      const unlinkMode = args.unlink === true;
      const pluginId = args.pluginId as string | undefined;

      // Resolved through the fence, not the registry. Being *registered* is not
      // consent: this writes into `<vault>/.obsidian/plugins`, and a bare registry
      // lookup let it install a symlink into any vault Obsidian happened to know
      // about, including the user's own. Refusals now match every other
      // vault-scoped tool.
      const target = await router.fence.resolve(vault);

      if (unlinkMode) {
        if (pluginId === undefined || pluginId === "") {
          throw new UobError("INVALID_ARGUMENT", "pluginId is required when unlink=true.", {});
        }
        return contentOutcome(`Removed symlink ${await unlinkPlugin(target.path, pluginId)}`);
      }

      // Shared with session provisioning so the "replace a symlink, never a real
      // directory" rule has exactly one implementation.
      const linked = await linkPlugin(target.path, sourceDir, pluginId);
      return {
        text: `Linked ${linked.sourceDir} → ${linked.linkPath}`,
        json: { vault, ...linked },
      };
    },
  });
}
