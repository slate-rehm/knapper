/**
 * Precondition probing.
 *
 * Four states are kept distinct because the remediation differs for each, and
 * collapsing them into a single "cannot connect" is the main reason this class of
 * tooling is frustrating to use.
 */
import { readdir } from "node:fs/promises";
import { checkUserFlags, readGlobalConfig } from "./vaults.js";
import { probeCdp, fetchTargets, obsidianWindows } from "./cdp/discover.js";
/** Detect a live Obsidian process without spawning the binary. */
export async function isObsidianRunning() {
  // Reading /proc avoids a shell round-trip on Linux; other platforms fall back to
  // the CDP/CLI probes, which are authoritative anyway.
  if (process.platform !== "linux") return false;
  try {
    const entries = await readdir("/proc");
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const { readFile } = await import("node:fs/promises");
        const cmdline = await readFile(`/proc/${entry}/cmdline`, "utf8");
        if (cmdline.includes("obsidian.asar") || /obsidian/i.test(cmdline.split("\0")[0] ?? "")) {
          return true;
        }
      } catch {
        // process exited between readdir and read
      }
    }
  } catch {
    return false;
  }
  return false;
}
export async function probeHealth(opts) {
  const { cdpUrl, cli, logger } = opts;
  const [globalConfig, userFlags, version, procRunning] = await Promise.all([
    readGlobalConfig(),
    checkUserFlags(),
    probeCdp(cdpUrl),
    isObsidianRunning(),
  ]);
  const cdpReachable = version !== undefined;
  const argvCorruption =
    userFlags.exists && userFlags.corruptingTokens.length > 0
      ? { path: userFlags.path, tokens: userFlags.corruptingTokens }
      : undefined;
  let targets = [];
  if (cdpReachable) {
    try {
      targets = await fetchTargets(cdpUrl);
    } catch (e) {
      logger.debug("target enumeration failed", { error: String(e) });
    }
  }
  const windows = obsidianWindows(targets).map((w) => ({
    kind: w.kind,
    title: w.target.title,
    ...(w.vaultName !== undefined ? { vaultName: w.vaultName } : {}),
    targetId: w.target.id,
  }));
  const cliEnabled = globalConfig?.cli === true;
  // Only pay for the CLI round-trip when it can plausibly succeed: it blocks
  // while the renderer boots, and it cold-launches Obsidian if nothing is running.
  let cliReachable = false;
  const running = procRunning || cdpReachable;
  if (!opts.skipCliProbe && cliEnabled && running && argvCorruption === undefined) {
    cliReachable = await cli.isReachable();
  }
  const problems = [];
  if (argvCorruption) {
    problems.push({
      state: "argv-corruption",
      message: `Launch flags file contains single-dash token(s): ${argvCorruption.tokens.join(", ")}.`,
      remediation:
        `Obsidian strips only \`--\`-prefixed flags from argv, so these survive and become the ` +
        `command name, failing every CLI call. Edit ${argvCorruption.path} to use a double dash, ` +
        `or remove the line.`,
    });
  }
  if (!running) {
    problems.push({
      state: "not-running",
      message: "Obsidian is not running.",
      remediation: "Launch it with the debug port so both transports are available.",
      fixedBy: "obsidian_launch",
    });
  }
  if (!cliEnabled) {
    problems.push({
      state: "cli-disabled",
      message: "Obsidian's command line interface is disabled.",
      remediation:
        "This gates the majority of the Obsidian tools. It cannot be enabled through the CLI " +
        "itself, so either let this server flip it over the CDP connection or toggle it in " +
        "Settings > General > Advanced.",
      fixedBy: "obsidian_setup_cli",
    });
  }
  if (!cdpReachable) {
    problems.push({
      state: "cdp-closed",
      message: `No CDP endpoint at ${cdpUrl}.`,
      remediation:
        "Browser automation, ARIA snapshots, and live telemetry need this. Because of Electron's " +
        "single-instance lock, Obsidian must be fully quit and cold-started with " +
        "`--remote-debugging-port` — adding the flag to a running instance does nothing.",
      fixedBy: "obsidian_launch",
    });
  }
  return {
    running,
    cliEnabled,
    cliReachable,
    cdpReachable,
    cdpUrl,
    ...(version?.Browser !== undefined ? { browserVersion: version.Browser } : {}),
    windows,
    argvCorruption,
    vaults: globalConfig?.vaults ?? [],
    configPath: (await import("../config.js")).obsidianConfigPath(),
    problems,
  };
}
//# sourceMappingURL=health.js.map
