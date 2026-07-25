/**
 * The capability router.
 *
 * Tools ask for a capability; the router decides which transport serves it based
 * on what is reachable right now. It also enforces the one hard exclusivity rule:
 * Electron allows a single debugger client per WebContents, so the CLI's `dev:cdp`
 * and a live Playwright attachment cannot both be active.
 */
import { CAPABILITY_PREFERENCE, EXCLUSIVE_DEBUGGER_LAYERS } from "../capabilities.js";
import {
  capabilityUnavailable,
  cdpPortClosed,
  cliDisabled,
  debuggerConflict,
  obsidianNotRunning,
  UobError,
} from "../util/errors.js";
import { ObsidianCli } from "./cli/exec.js";
import { PlaywrightSession } from "./cdp/session.js";
import { probeHealth } from "./health.js";
import { probeCdp } from "./cdp/discover.js";
import { readGlobalConfig } from "./vaults.js";
export class CapabilityRouter {
  config;
  logger;
  cli;
  playwright;
  availability = {
    playwright: false,
    cli: false,
    cliCdp: false,
    local: true,
  };
  availabilityCheckedAt = 0;
  /** Which layer currently owns the Electron debugger, if any. */
  debuggerHolder;
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.cli = new ObsidianCli({
      obsidianBin: config.obsidianBin,
      ...(config.vault !== undefined ? { vault: config.vault } : {}),
      timeoutMs: config.cliTimeoutMs,
    });
    this.playwright = new PlaywrightSession({
      cdpUrl: config.cdpUrl,
      ...(config.vault !== undefined ? { vault: config.vault } : {}),
      logger: logger.child("cdp"),
    });
  }
  /**
   * Refresh layer availability, cached briefly so a burst of tool calls does not
   * re-probe the port for each one.
   */
  async refreshAvailability(force = false) {
    const age = Date.now() - this.availabilityCheckedAt;
    if (!force && age < 3000) return this.availability;
    const [version, globalConfig] = await Promise.all([
      probeCdp(this.config.cdpUrl),
      readGlobalConfig(),
    ]);
    const cdpUp = version !== undefined;
    const cliOn = globalConfig?.cli === true;
    this.availability = {
      playwright: cdpUp,
      cli: cliOn,
      // dev:cdp rides the CLI, and is unusable while Playwright holds the debugger.
      cliCdp: cliOn && this.debuggerHolder !== "playwright",
      local: true,
    };
    this.availabilityCheckedAt = Date.now();
    this.logger.debug("layer availability", this.availability);
    return this.availability;
  }
  /** Resolve which layer will serve a capability, or throw explaining why none can. */
  async resolve(capability) {
    const availability = await this.refreshAvailability();
    const preference = CAPABILITY_PREFERENCE[capability];
    for (const layer of preference) {
      if (!availability[layer]) continue;
      if (EXCLUSIVE_DEBUGGER_LAYERS.includes(layer)) {
        if (this.debuggerHolder !== undefined && this.debuggerHolder !== layer) {
          continue; // another layer holds the debugger; try the next preference
        }
      }
      this.logger.debug("routed capability", { capability, layer });
      return layer;
    }
    throw this.explainUnavailable(capability, preference, availability);
  }
  /** Mark a layer as holding the Electron debugger. */
  claimDebugger(layer) {
    if (!EXCLUSIVE_DEBUGGER_LAYERS.includes(layer)) return;
    if (this.debuggerHolder !== undefined && this.debuggerHolder !== layer) {
      throw debuggerConflict(this.debuggerHolder);
    }
    this.debuggerHolder = layer;
    this.availabilityCheckedAt = 0;
  }
  releaseDebugger(layer) {
    if (this.debuggerHolder === layer) {
      this.debuggerHolder = undefined;
      this.availabilityCheckedAt = 0;
    }
  }
  get currentDebuggerHolder() {
    return this.debuggerHolder;
  }
  /**
   * Evaluate JavaScript in the renderer through whichever layer is available.
   * Returns the value plus which layer served it.
   */
  async evaluate(code) {
    const layer = await this.resolve("evaluate");
    if (layer === "playwright") {
      this.claimDebugger("playwright");
      return { value: await this.playwright.evaluate(code), layer };
    }
    const stdout = await this.cli.evaluate(code);
    const { parseCliJson } = await import("../util/serialize.js");
    const parsed = parseCliJson(stdout);
    return { value: parsed ?? stdout.trim(), layer };
  }
  /**
   * Evaluate and require a JSON result. Used by tools that need structured data
   * regardless of which transport answered.
   */
  async evaluateJson(code) {
    const layer = await this.resolve("evaluate");
    if (layer === "playwright") {
      this.claimDebugger("playwright");
      return { value: await this.playwright.evaluate(code), layer };
    }
    // The CLI returns strings, so ask the page to stringify before it crosses over.
    const stdout = await this.cli.evaluate(`JSON.stringify((() => { ${code} })())`);
    const { parseCliJson } = await import("../util/serialize.js");
    const parsed = parseCliJson(stdout);
    if (parsed === undefined) {
      throw new UobError(
        "EVAL_FAILED",
        "Expected JSON from the Obsidian CLI but could not parse it.",
        {
          details: { stdout: stdout.slice(0, 2000) },
        },
      );
    }
    return { value: parsed, layer };
  }
  /** Run an Obsidian CLI command, requiring the CLI layer. */
  async cliCommand(command, overrides = {}) {
    await this.resolve("cliCommand");
    return this.cli.run(command, overrides);
  }
  async health(opts = {}) {
    return probeHealth({
      cdpUrl: this.config.cdpUrl,
      cli: this.cli,
      logger: this.logger.child("health"),
      ...(opts.skipCliProbe !== undefined ? { skipCliProbe: opts.skipCliProbe } : {}),
    });
  }
  async dispose() {
    await this.playwright.close();
  }
  explainUnavailable(capability, preference, availability) {
    const onlyPlaywright = preference.length === 1 && preference[0] === "playwright";
    if (onlyPlaywright) {
      if (this.debuggerHolder === "cliCdp") return debuggerConflict("cliCdp");
      return cdpPortClosed(this.config.cdpUrl);
    }
    const onlyCli = preference.every((l) => l === "cli");
    if (onlyCli) {
      return availability.cli ? obsidianNotRunning(this.config.cdpPort) : cliDisabled();
    }
    // Mixed preference with nothing available means Obsidian is unreachable entirely.
    if (!availability.cli && !availability.playwright) {
      return new UobError(
        "OBSIDIAN_NOT_RUNNING",
        `No transport can serve "${capability}": the CLI is disabled and no CDP port is open.`,
        {
          remediation:
            "Run the doctor tool for a per-precondition breakdown; it names the tool that fixes each one.",
          fixedBy: "obsidian_doctor",
          details: { capability, availability },
        },
      );
    }
    return capabilityUnavailable(
      capability,
      `no available transport among [${preference.join(", ")}]`,
    );
  }
}
//# sourceMappingURL=router.js.map
