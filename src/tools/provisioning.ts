/**
 * Layer 2 — provisioning tools that make the server self-sufficient.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ServerContext } from "../server.js";
import { TOOLSET_DESCRIPTIONS, type Toolset } from "../toolsets.js";
import { launchObsidian, type LaunchResult } from "../connection/launch.js";
import {
  buildObsidianVersions,
  detectInstalledObsidianPackageVersion,
  findDownloadedAsarVersion,
} from "../obsidian/version-drift.js";
import { isObsidianRunning, type HealthReport } from "../connection/health.js";
import type { CapabilityRouter } from "../connection/router.js";
import {
  createManagedVault,
  findVault,
  readGlobalConfig,
  removeManagedVault,
  writeCliFlag,
} from "../connection/vaults.js";
import { cliSocketPathFor, knapperHome } from "../config.js";
import { UobError } from "../util/errors.js";
import { linkPlugin, unlinkPlugin } from "../session/plugin-link.js";
import { contentOutcome, runCli } from "../obsidian/helpers.js";
import { patchDescriptor, readDescriptor } from "../session/descriptor.js";
import { inspectPluginHealth } from "../devcycle/plugin-health.js";
import { writeFileAtomic, writeJsonAtomic } from "../util/atomic-json.js";

interface MutableJson<T> {
  path: string;
  existed: boolean;
  value: T;
}

type VaultSetupStep = {
  status: "changed" | "unchanged" | "verified" | "failed" | "skipped";
  error?: string;
};

const VAULT_SETUP_STEP_LABELS: Record<string, string> = {
  preflight: "Preflight",
  communityPlugins: "Community plugins",
  trust: "Restricted mode",
  pluginEnabled: "Plugin enabled",
  pluginLoaded: "Plugin loaded",
};

export function formatVaultSetupResult(
  vault: string,
  steps: Record<string, VaultSetupStep>,
  failures: { step: string; error: string }[],
): string {
  const lines = [
    failures.length === 0
      ? `Vault "${vault}" is automation-ready.`
      : `Vault "${vault}" setup completed with ${failures.length} failed step(s).`,
    "Setup steps:",
  ];

  for (const [name, result] of Object.entries(steps)) {
    const label = VAULT_SETUP_STEP_LABELS[name] ?? name;
    lines.push(
      `- ${label}: ${result.status}${result.error === undefined ? "" : ` — ${result.error}`}`,
    );
  }

  return lines.join("\n");
}

async function backUpInvalidJson(
  path: string,
  raw?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const directory = join(knapperHome(env), "backups", "invalid-json");
  const backup = join(directory, `${basename(path)}.${Date.now()}.${randomUUID()}.invalid`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (raw !== undefined) await writeFileAtomic(backup, raw, { mode: 0o600 });
    else await copyFile(path, backup);
    return backup;
  } catch {
    return undefined;
  }
}

async function readJsonForMutation<T>(
  path: string,
  validate: (value: unknown) => value is T,
  fallback: T,
  env?: NodeJS.ProcessEnv,
): Promise<MutableJson<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, existed: false, value: fallback };
    }
    const backupPath = await backUpInvalidJson(path, undefined, env);
    throw new UobError("INVALID_ARGUMENT", `Cannot read ${path}. The file was not replaced.`, {
      remediation:
        "Repair the file permissions or restore the configuration, then run setup again.",
      details: { path, backupPath: backupPath ?? null },
      cause: error,
    });
  }

  try {
    const value: unknown = JSON.parse(raw);
    if (!validate(value)) throw new Error("The JSON value has the wrong shape.");
    return { path, existed: true, value };
  } catch (error) {
    const backupPath = await backUpInvalidJson(path, raw, env);
    throw new UobError("INVALID_ARGUMENT", `${path} is not valid configuration JSON.`, {
      remediation: "Repair the original file, then run setup again. Knapper did not replace it.",
      details: { path, backupPath: backupPath ?? null },
      cause: error,
    });
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export async function preflightVaultSetup(
  vaultPath: string,
  pluginId?: string,
  env?: NodeJS.ProcessEnv,
) {
  const obsidianDir = join(vaultPath, ".obsidian");
  const app = await readJsonForMutation(
    join(obsidianDir, "app.json"),
    isJsonObject,
    {} as Record<string, unknown>,
    env,
  );
  const enabled = await readJsonForMutation(
    join(obsidianDir, "community-plugins.json"),
    isStringArray,
    [] as string[],
    env,
  );

  if (pluginId !== undefined && pluginId !== "") {
    try {
      const manifest = await lstat(join(obsidianDir, "plugins", pluginId, "manifest.json"));
      if (!manifest.isFile()) throw new Error("not a file");
    } catch (error) {
      throw new UobError(
        "INVALID_ARGUMENT",
        `Plugin "${pluginId}" is not installed in this vault.`,
        {
          remediation: "Link or install the plugin before enabling it.",
          fixedBy: "obsidian_link_plugin",
          details: { pluginId, vaultPath },
          cause: error,
        },
      );
    }
  }

  return { app, enabled };
}

export function communityPluginsEnabledConfig(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return { ...value, communityPluginEnabled: true };
}

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
  if (config.sessionId !== undefined) {
    const heartbeatAt = new Date().toISOString();
    await patchDescriptor(config.sessionId, (descriptor) => {
      const instance = {
        ...descriptor.instance,
        cdpPort: result.port,
        cdpUrl: result.cdpUrl,
      };
      if (result.pid !== undefined) instance.pid = result.pid;
      else delete instance.pid;
      if (result.pidStartTime !== undefined) instance.pidStartTime = result.pidStartTime;
      else delete instance.pidStartTime;
      if (result.browserId !== undefined) instance.browserId = result.browserId;
      else delete instance.browserId;
      return {
        ...descriptor,
        heartbeatAt,
        readiness: { phase: "ready", readyAt: heartbeatAt },
        instance,
      };
    });
  }
  return result;
}

/**
 * Read the running app version without turning a diagnostic into a launch.
 *
 * The Arch wrapper treats `obsidian version` as an ordinary Electron invocation.
 * If no instance owns the singleton lock, that command starts the full app without
 * CDP. The health probe already proves whether a forwarding target exists, so an
 * offline doctor must stop here instead of creating the failure it is reporting.
 */
export async function runningObsidianVersion(
  router: Pick<CapabilityRouter, "cli">,
  health: Pick<HealthReport, "running" | "cliEnabled" | "argvCorruption">,
): Promise<string> {
  if (!health.running) return "(unavailable — Obsidian is stopped)";
  if (health.argvCorruption !== undefined) return "(unavailable — CLI arguments are corrupted)";
  if (!health.cliEnabled) return "(unavailable — Obsidian CLI is disabled)";

  try {
    const raw = await router.cli.run(["version"], { timeoutMs: 5000 });
    return (
      raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .find((line) => /^v?\d+\.\d+\.\d+/.test(line)) ?? "(unavailable)"
    );
  } catch {
    return "(unavailable)";
  }
}

export function registerProvisioningTools(ctx: ServerContext): void {
  const { registry, router, config } = ctx;

  registry.add({
    name: "obsidian_doctor",
    toolset: "core",
    alwaysEnabled: true,
    workspaceIndependent: true,
    description:
      "Full diagnostic: the four precondition states (not running, CLI disabled, CDP closed, " +
      "argv corruption), binary path and version, registered vaults, target vault automation state, " +
      "dev-plugin symlinks, and per-toolset tool availability. Prefer this over obsidian_status when " +
      "something is broken — every problem includes remediation and names a fixing tool when one exists.",
    annotations: { readOnlyHint: true },
    profileIndependent: true,
    inputSchema: {
      vault: z.string().optional().describe("Vault to inspect for restrict-mode and plugin state"),
      detail: z
        .enum(["summary", "full"])
        .optional()
        .describe("Summary by default. Full adds authorized paths and local profile diagnostics."),
    },
    handler: async (args) => {
      const vaultArg = args.vault as string | undefined;
      const full = args.detail === "full";
      const targetVault = vaultArg ?? config.vault;

      let health = await router.health({
        skipCliProbe: config.sessionId === undefined,
      });
      const availability = await router.refreshAvailability(true);

      let version: string;
      if (config.sessionId === undefined && health.running) {
        try {
          const result = await ctx.profileLease.run("obsidian_doctor", async () => {
            const leasedHealth = await router.health();
            return {
              health: leasedHealth,
              version: await runningObsidianVersion(router, leasedHealth),
            };
          });
          health = result.health;
          version = result.version;
        } catch (error) {
          version =
            error instanceof UobError && error.code === "DEFAULT_PROFILE_BUSY"
              ? "(unavailable — default profile busy)"
              : "(unavailable)";
        }
      } else {
        version = await runningObsidianVersion(router, health);
      }
      const defaultProfileLease = await ctx.profileLease.status();

      const toolsets: Record<string, { enabled: boolean; toolCount: number }> = {};
      const byToolset = registry.groupAllByToolset();
      for (const name of Object.keys(TOOLSET_DESCRIPTIONS) as Toolset[]) {
        const enabled = registry.isToolsetEnabled(name);
        toolsets[name] = { enabled, toolCount: (byToolset[name] ?? []).length };
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
      const installedPackage = await detectInstalledObsidianPackageVersion();
      const versions = buildObsidianVersions({
        running: version,
        downloadedAsar,
        installedPackage: installedPackage?.version,
        installedPackageSource: installedPackage?.source,
      });
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
        `Profile identity: ${profile.kind}${profile.sessionId === null ? "" : ` (${profile.sessionId})`}`,
        `Obsidian running: ${health.running ? "yes" : "no"}`,
        `CLI enabled (config): ${health.cliEnabled ? "yes" : "no"}`,
        `CLI reachable: ${health.cliReachable ? "yes" : "no"}`,
        `CDP reachable: ${health.cdpReachable ? "yes" : "no"}`,
        `Binary: ${config.obsidianBin}`,
        `Version: ${version}`,
        `Running vs downloaded ASAR: ${versions.comparisons.runningVsDownloaded}`,
        `Running vs installed package: ${versions.comparisons.runningVsInstalled}`,
        ...(full ? [`Config: ${health.configPath}`] : []),
      ];

      // Which instance this server drives, and how well CLI commands are pinned to
      // it. `shared` means a CLI call may land in whichever Obsidian booted last,
      // which is worth saying out loud because nothing else reports it.
      if (config.sessionId !== undefined) {
        lines.push(
          `Workspace: ${ctx.currentWorkspaceHandle ?? "isolated"}`,
          ...(full ? [`Profile: ${config.userDataDir}`] : []),
          `Visual identity: ${profile.visualIdentity?.state ?? "degraded"}`,
          `CLI isolation: ${config.cliIsolation}` +
            (config.cliIsolation === "per-session"
              ? ` (socket ${cliSocketPathFor(config.runtimeDir)})`
              : " — CLI commands are not pinned to this instance; the renderer route is"),
        );
      } else {
        lines.push(
          `Workspace: ${ctx.currentWorkspaceHandle ?? "none"} (default Obsidian profile)`,
          `Default profile: ${defaultProfileLease.state}`,
        );
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

      lines.push("", `Registered vaults: ${vaultStatus.length} (${authorizedCount} authorized)`);
      for (const v of vaultStatus) {
        if (!v.authorized) continue;
        const grantTag =
          v.grant === "created"
            ? "authorized scratch"
            : "authorized by the user (never deleted by knapper)";
        const tags = [v.open ? "open" : "", grantTag].filter((t) => t !== "").join(", ");
        lines.push(`  - ${v.name} (${tags})${full ? ` → ${v.path}` : ""}`);
      }
      if (authorizedCount === 0) {
        lines.push(
          "  No vault is authorized. Every vault-scoped tool will refuse until the user runs",
          "  `npx knapper authorize <vault path>` themselves, or obsidian_create_vault makes a",
          "  registered one. Prefer obsidian_workspace_create for throwaway work. Do not suggest",
          "  authorization unless the user asked to work",
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
        lines.push(`  ${name}: ${info.enabled ? "enabled" : "disabled"} (${info.toolCount} tools)`);
      }

      return {
        text: lines.join("\n"),
        json: {
          health: {
            running: health.running,
            cliEnabled: health.cliEnabled,
            cliReachable: health.cliReachable,
            cdpReachable: health.cdpReachable,
            windows: health.cdpReachable
              ? await router.playwright.windowSummaries().catch(() => [])
              : [],
            problems: health.problems,
            ...(full ? { configPath: health.configPath } : {}),
          },
          availability,
          binary: config.obsidianBin,
          version,
          versions,
          downloadedAsarVersion: downloadedAsar ?? null,
          argvCorruption: health.argvCorruption ?? null,
          vaults: vaultStatus.map((vault) =>
            vault.authorized
              ? {
                  name: vault.name,
                  open: vault.open,
                  authorized: true,
                  grant: vault.grant,
                  ...(full ? { path: vault.path } : {}),
                }
              : { open: vault.open, authorized: false },
          ),
          authorizedVaultCount: authorizedCount,
          targetVault: targetVault ?? null,
          vaultState: vaultState ?? null,
          toolsets,
          transports: availability,
          defaultProfileLease,
          profile,
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
    annotations: { readOnlyHint: false, destructiveHint: true },
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
    annotations: { readOnlyHint: false, destructiveHint: true },
    handler: async (args) => {
      const vault = args.vault as string;
      const pluginId = args.pluginId as string | undefined;

      // Fenced explicitly rather than by accident. This handler writes app.json
      // straight to disk, and it used to take that path from an unauthorized
      // registry lookup — safe only because the `plugins:restrict` call below
      // happens to fence first and throw. Reordering those two lines would have
      // silently turned this into a write into any registered vault.
      const target = await router.fence.resolve(vault);

      // Complete every read and shape check before the first mutation. Invalid
      // settings are backed up outside the vault and left unchanged.
      const preflight = await preflightVaultSetup(target.path, pluginId);
      const steps: Record<string, VaultSetupStep> = {
        preflight: { status: "verified" },
      };

      const appCfg = communityPluginsEnabledConfig(preflight.app.value);
      try {
        if (preflight.app.value.communityPluginEnabled === true) {
          steps.communityPlugins = { status: "unchanged" };
        } else {
          await writeJsonAtomic(preflight.app.path, appCfg, { mode: 0o600 });
          steps.communityPlugins = { status: "changed" };
        }
      } catch (error) {
        steps.communityPlugins = {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }

      if (steps.communityPlugins.status !== "failed") {
        try {
          const before = await runCli(router, {
            command: "plugins:restrict",
            vault,
          });
          if (/\boff\b/i.test(before.stdout)) {
            steps.trust = { status: "unchanged" };
          } else {
            await runCli(router, {
              command: "plugins:restrict",
              args: ["off"],
              vault,
            });
            steps.trust = { status: "changed" };
          }
        } catch (error) {
          steps.trust = {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      } else {
        steps.trust = { status: "skipped" };
      }

      if (pluginId === undefined || pluginId === "") {
        steps.pluginEnabled = { status: "skipped" };
        steps.pluginLoaded = { status: "skipped" };
      } else if (steps.trust.status === "failed" || steps.communityPlugins.status === "failed") {
        steps.pluginEnabled = { status: "skipped" };
        steps.pluginLoaded = { status: "skipped" };
      } else {
        try {
          if (preflight.enabled.value.includes(pluginId)) {
            steps.pluginEnabled = { status: "unchanged" };
          } else {
            await runCli(router, {
              command: "plugin:enable",
              args: [`id=${pluginId}`],
              vault,
            });
            steps.pluginEnabled = { status: "changed" };
          }
        } catch (error) {
          steps.pluginEnabled = {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }

        if (steps.pluginEnabled.status !== "failed") {
          try {
            const health = await inspectPluginHealth(router, pluginId, vault);
            steps.pluginLoaded = health.loaded
              ? { status: "verified" }
              : {
                  status: "failed",
                  error: "The plugin is enabled but is not loaded.",
                };
          } catch (error) {
            steps.pluginLoaded = {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        } else {
          steps.pluginLoaded = { status: "skipped" };
        }
      }

      const failures = Object.entries(steps)
        .filter(([, step]) => step.status === "failed")
        .map(([step, result]) => ({
          step,
          error: result.error ?? "Unknown error",
        }));
      const state = await vaultAutomationState(ctx, vault, config.obsidianConfigPath);
      return {
        text: formatVaultSetupResult(vault, steps, failures),
        json: {
          ok: failures.length === 0,
          partial: failures.length > 0,
          vault,
          pluginId: pluginId ?? null,
          steps,
          failures,
          state,
        },
      };
    },
  });

  registry.add({
    name: "obsidian_create_vault",
    toolset: "vault",
    description:
      "Create a test vault and register it with Obsidian. Stores an external authorization record " +
      "under KNAP_HOME. Knapper never deletes this directory. Refuses to adopt a directory that " +
      "already contains files. Obsidian caches the vault " +
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

      if (config.sessionId !== undefined) {
        throw new UobError(
          "INVALID_ARGUMENT",
          "A workspace-bound server cannot add another vault to its private profile.",
          {
            remediation:
              "Create a separate workspace for the new vault. This keeps each private profile tied to one vault.",
            fixedBy: "obsidian_workspace_create",
          },
        );
      }

      const result = await createManagedVault(path, new Date(), config.obsidianConfigPath);

      let restarted = false;
      let automationReady = false;
      let restartError: string | undefined;
      if (args.open === true) {
        // A running instance holds obsidian.json in memory and rewrites it on exit,
        // so the registry edit only takes effect after a genuine cold start.
        try {
          await launchWithCdp(ctx, { restart: true });
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
          "Authorization stored outside the vault.",
          status,
        ].join("\n"),
        json: {
          ...result,
          restarted,
          automationReady,
          restartError: restartError ?? null,
        },
      };
    },
  });

  registry.add({
    name: "obsidian_remove_vault",
    toolset: "vault",
    description:
      "Unregister an authorized vault from Obsidian. This tool never deletes files. Scratch " +
      "workspace cleanup is available only through obsidian_workspace_destroy and moves content " +
      "to recoverable Knapper trash.",
    inputSchema: {
      vault: z
        .string()
        .describe("Registered vault name, or an absolute path to the vault directory"),
    },
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const wanted = args.vault as string;

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

      const result = await removeManagedVault(targetPath, vaults, false, config.obsidianConfigPath);
      return {
        text: [
          `Removed test vault at ${result.path}`,
          result.unregistered ? "Unregistered from obsidian.json." : "Was not registered.",
          "Directory left on disk.",
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
      pluginId: z
        .string()
        .optional()
        .describe("Expected plugin id. When set, it must match manifest.json."),
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
