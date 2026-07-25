/**
 * The capability router.
 *
 * Tools ask for a capability; the router decides which transport serves it based
 * on what is reachable right now. It also enforces the one hard exclusivity rule:
 * Electron allows a single debugger client per WebContents, so the CLI's `dev:cdp`
 * and a live Playwright attachment cannot both be active.
 */

import {
  CAPABILITY_PREFERENCE,
  EXCLUSIVE_DEBUGGER_LAYERS,
  type Capability,
  type Layer,
} from "../capabilities.js";
import type { Config } from "../config.js";
import type { Logger } from "../util/logger.js";
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
import { isObsidianRunning, probeHealth, type HealthReport } from "./health.js";
import { probeCdp } from "./cdp/discover.js";
import { readGlobalConfig } from "./vaults.js";

export interface LayerAvailability {
  playwright: boolean;
  cli: boolean;
  cliCdp: boolean;
  local: boolean;
}

export class CapabilityRouter {
  readonly cli: ObsidianCli;
  readonly playwright: PlaywrightSession;

  private availability: LayerAvailability = {
    playwright: false,
    cli: false,
    cliCdp: false,
    local: true,
  };
  private availabilityCheckedAt = 0;
  /** Global `cli` flag from obsidian.json, independent of process liveness. */
  private cliFlagEnabled = false;
  /** Which layer currently owns the Electron debugger, if any. */
  private debuggerHolder?: Layer;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
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
  async refreshAvailability(force = false): Promise<LayerAvailability> {
    const age = Date.now() - this.availabilityCheckedAt;
    if (!force && age < 3000) return this.availability;

    const [version, globalConfig, procRunning] = await Promise.all([
      probeCdp(this.config.cdpUrl),
      readGlobalConfig(),
      isObsidianRunning(),
    ]);

    const cdpUp = version !== undefined;
    const cliOn = globalConfig?.cli === true;
    // Spawning the CLI binary while nothing is running cold-starts Obsidian
    // *without* `--remote-debugging-port`. On Linux we can see the process; on
    // other platforms fall back to trusting the flag (a failed call still
    // surfaces TIMEOUT / NOT_RUNNING via exec).
    const running = cdpUp || procRunning;
    const cliUsable = cliOn && (running || process.platform !== "linux");

    this.cliFlagEnabled = cliOn;
    this.availability = {
      playwright: cdpUp,
      cli: cliUsable,
      // dev:cdp rides the CLI. Verified to coexist with a live Playwright
      // attachment (see EXCLUSIVE_DEBUGGER_LAYERS), so no exclusion here.
      cliCdp: cliUsable,
      local: true,
    };
    this.availabilityCheckedAt = Date.now();
    this.logger.debug("layer availability", this.availability);
    return this.availability;
  }

  /** Resolve which layer will serve a capability, or throw explaining why none can. */
  async resolve(capability: Capability): Promise<Layer> {
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

  /**
   * Record that a layer is driving the debugger. Purely informational now that the
   * two CDP transports are known to coexist, but it still feeds the status output
   * and the conflict error path in case a future Electron reintroduces contention.
   */
  claimDebugger(layer: Layer): void {
    if (
      EXCLUSIVE_DEBUGGER_LAYERS.length > 0 &&
      EXCLUSIVE_DEBUGGER_LAYERS.includes(layer) &&
      this.debuggerHolder !== undefined &&
      this.debuggerHolder !== layer
    ) {
      throw debuggerConflict(this.debuggerHolder);
    }
    this.debuggerHolder = layer;
  }

  releaseDebugger(layer: Layer): void {
    if (this.debuggerHolder === layer) this.debuggerHolder = undefined;
  }

  get currentDebuggerHolder(): Layer | undefined {
    return this.debuggerHolder;
  }

  /**
   * Evaluate JavaScript in the renderer through whichever layer is available.
   * Returns the value plus which layer served it.
   */
  async evaluate<T>(code: string): Promise<{ value: T; layer: Layer }> {
    const layer = await this.resolve("evaluate");
    if (layer === "playwright") {
      this.claimDebugger("playwright");
      return { value: await this.playwright.evaluate<T>(code), layer };
    }
    const stdout = await this.cli.evaluate(code);
    const { parseCliJson } = await import("../util/serialize.js");
    const parsed = parseCliJson<T>(stdout);
    return { value: (parsed ?? (stdout.trim() as unknown)) as T, layer };
  }

  /**
   * Evaluate and require a JSON result. Used by tools that need structured data
   * regardless of which transport answered.
   */
  async evaluateJson<T>(code: string): Promise<{ value: T; layer: Layer }> {
    const layer = await this.resolve("evaluate");
    if (layer === "playwright") {
      this.claimDebugger("playwright");
      return { value: await this.playwright.evaluate<T>(code), layer };
    }
    // The CLI returns strings, so ask the page to stringify before it crosses over.
    // Use wrapExpression so IIFEs and bare expressions keep their return values —
    // a naive `{ ${code} }` body discards an IIFE result and yields `(no output)`.
    const { parseCliJson, wrapExpression } = await import("../util/serialize.js");
    const stdout = await this.cli.evaluate(`JSON.stringify((() => { ${wrapExpression(code)} })())`);
    const parsed = parseCliJson<T>(stdout);
    if (parsed === undefined) {
      const cleaned = stdout.trim().replace(/^=>\s*/, "");
      if (cleaned === "" || cleaned === "(no output)") {
        return { value: undefined as T, layer };
      }
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
  async cliCommand(command: string[], overrides: { vault?: string } = {}): Promise<string> {
    await this.resolve("cliCommand");
    return this.cli.run(command, overrides);
  }

  async health(opts: { skipCliProbe?: boolean } = {}): Promise<HealthReport> {
    return probeHealth({
      cdpUrl: this.config.cdpUrl,
      cli: this.cli,
      logger: this.logger.child("health"),
      ...(opts.skipCliProbe !== undefined ? { skipCliProbe: opts.skipCliProbe } : {}),
    });
  }

  async dispose(): Promise<void> {
    await this.playwright.close();
  }

  private explainUnavailable(
    capability: Capability,
    preference: readonly Layer[],
    availability: LayerAvailability,
  ): UobError {
    const onlyPlaywright = preference.length === 1 && preference[0] === "playwright";
    if (onlyPlaywright) {
      if (this.debuggerHolder === "cliCdp") return debuggerConflict("cliCdp");
      return cdpPortClosed(this.config.cdpUrl);
    }

    const onlyCli = preference.every((l) => l === "cli");
    if (onlyCli) {
      // Distinguish "flag off" from "flag on but process down" — collapsing these
      // was the exact failure mode the four precondition states exist to avoid.
      return this.cliFlagEnabled ? obsidianNotRunning(this.config.cdpPort) : cliDisabled();
    }

    // Mixed preference with nothing available means Obsidian is unreachable entirely.
    if (!availability.cli && !availability.playwright) {
      if (this.cliFlagEnabled) {
        return obsidianNotRunning(this.config.cdpPort);
      }
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
