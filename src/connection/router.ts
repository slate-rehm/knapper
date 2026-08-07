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
import { sessionPaths, type Config } from "../config.js";
import type { Logger } from "../util/logger.js";
import {
  capabilityUnavailable,
  cdpPortClosed,
  cliDisabled,
  debuggerConflict,
  obsidianNotRunning,
  UobError,
} from "../util/errors.js";
import { classifyCliOutput, ObsidianCli, VAULT_AGNOSTIC_COMMANDS } from "./cli/exec.js";
import { PlaywrightSession } from "./cdp/session.js";
import { ConnectionSupervisor } from "./supervisor.js";
import { isObsidianRunning, probeHealth, type HealthReport, type ProcessScope } from "./health.js";
import { probeCdp } from "./cdp/discover.js";
import { readGlobalConfig } from "./vaults.js";
import { VaultFence, type AuthorizedVault } from "./fence.js";
import { FocusEmulator } from "../browser/focus.js";

export interface LayerAvailability {
  playwright: boolean;
  cli: boolean;
  cliCdp: boolean;
  local: boolean;
}

export class CapabilityRouter {
  cli!: ObsidianCli;
  playwright!: PlaywrightSession;
  /**
   * The vault fence. Owned here because the router is the one place both transports
   * pass through, so a single instance keeps their caches — and therefore their
   * answers — consistent within a call.
   */
  fence!: VaultFence;
  /**
   * Scoped focus emulation for input tools. Owned here so the native tools and the
   * @playwright/mcp proxy share one refcount per page — they drive the same window,
   * and two independent counters would let one revert the other's hold.
   */
  focus!: FocusEmulator;
  /**
   * Owned here rather than by the server so the existing shutdown path —
   * `cli.ts` calls only `router.dispose()` — stops its timer.
   */
  supervisor!: ConnectionSupervisor;

  private availability: LayerAvailability = {
    playwright: false,
    cli: false,
    cliCdp: false,
    local: true,
  };
  private availabilityCheckedAt = 0;
  /** Global `cli` flag from obsidian.json, independent of process liveness. */
  private cliFlagEnabled = false;
  /** Whether an Obsidian for this scope is alive, however unreachable. */
  private processRunning = false;
  /** Which layer currently owns the Electron debugger, if any. */
  private debuggerHolder?: Layer;
  private disposed = false;
  private cliDegradedUntil = 0;
  private lastCliTimeoutAt?: number;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.buildTarget();
  }

  private buildTarget(): void {
    this.fence = new VaultFence({
      ...(this.config.vault !== undefined ? { defaultVault: this.config.vault } : {}),
      configPath: this.config.obsidianConfigPath,
      ...(this.config.sessionId !== undefined
        ? {
            sessionKey: this.config.sessionId,
            sessionVaultPath: sessionPaths(this.config.sessionId).vaultDir,
          }
        : {}),
      logger: this.logger.child("fence"),
    });
    this.cli = new ObsidianCli({
      obsidianBin: this.config.obsidianBin,
      timeoutMs: this.config.cliTimeoutMs,
      // Both only set under a session; together they make every CLI invocation a
      // forwarding client of *this* instance rather than of whichever Obsidian
      // currently owns the shared socket.
      ...(this.config.runtimeDir !== undefined ? { runtimeDir: this.config.runtimeDir } : {}),
      ...(this.config.sessionId !== undefined ? { userDataDir: this.config.userDataDir } : {}),
    });
    this.playwright = new PlaywrightSession({
      cdpUrl: this.config.cdpUrl,
      resolveVault: (requested) => this.fence.resolve(requested),
      isVaultAuthorized: async (name) => (await this.fence.isAuthorized(name)) !== undefined,
      ...(this.config.targetMatch !== undefined ? { targetMatch: this.config.targetMatch } : {}),
      logger: this.logger.child("cdp"),
    });
    this.focus = new FocusEmulator(this.playwright, this.logger.child("focus"));
    this.supervisor = new ConnectionSupervisor({
      session: this.playwright,
      logger: this.logger.child("supervisor"),
      reconnectMs: this.config.reconnectMs,
      // Proves to the reaper that this session still has a connected MCP owner,
      // including the window where Obsidian has died and the agent will restart it.
      onHeartbeat: () => {
        const key = this.config.sessionId;
        if (key !== undefined) {
          void import("../session/descriptor.js")
            .then((module) => module.touchHeartbeat(key, new Date()))
            .catch((error: unknown) => {
              this.logger.debug("session heartbeat failed", {
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }
      },
    });
  }

  /** Rebuild every target-specific transport after the shared config changes. */
  async rebind(): Promise<void> {
    if (this.disposed) throw new Error("Cannot rebind a disposed capability router.");
    this.supervisor.stop();
    await this.focus.dispose().catch(() => undefined);
    await this.playwright.close().catch(() => undefined);
    if (this.disposed) throw new Error("Cannot rebind a disposed capability router.");
    this.debuggerHolder = undefined;
    this.availability = { playwright: false, cli: false, cliCdp: false, local: true };
    this.availabilityCheckedAt = 0;
    this.cliFlagEnabled = false;
    this.processRunning = false;
    this.cliDegradedUntil = 0;
    this.lastCliTimeoutAt = undefined;
    this.buildTarget();
    this.supervisor.start();
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
      readGlobalConfig(this.config.obsidianConfigPath),
      isObsidianRunning(this.processScope),
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
    this.processRunning = running;
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
    let preference = CAPABILITY_PREFERENCE[capability];
    if (capability === "evaluate" || capability === "cliCommand") {
      if (this.config.commandTransport === "cli") preference = ["cli"];
      if (this.config.commandTransport === "playwright") preference = ["playwright"];
      if (this.config.commandTransport === "auto" && Date.now() < this.cliDegradedUntil) {
        preference = ["playwright", "cli"];
      }
    }

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

  get commandTransportStatus(): Record<string, unknown> {
    const degraded = Date.now() < this.cliDegradedUntil;
    return {
      mode: this.config.commandTransport,
      selected:
        this.config.commandTransport === "playwright" ||
        (this.config.commandTransport === "auto" && degraded)
          ? "playwright"
          : "cli",
      ...(degraded ? { cliDegradedUntil: new Date(this.cliDegradedUntil).toISOString() } : {}),
      ...(this.lastCliTimeoutAt !== undefined
        ? { lastCliTimeoutAt: new Date(this.lastCliTimeoutAt).toISOString() }
        : {}),
    };
  }

  private async nativeCliCall<T>(call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      if (this.config.commandTransport === "auto") this.cliDegradedUntil = 0;
      return result;
    } catch (error) {
      if (
        this.config.commandTransport === "auto" &&
        error instanceof UobError &&
        error.code === "TIMEOUT"
      ) {
        this.lastCliTimeoutAt = Date.now();
        this.cliDegradedUntil = this.lastCliTimeoutAt + 30_000;
        this.logger.warn("native CLI timed out; later commands will prefer Playwright", {
          degradedUntil: new Date(this.cliDegradedUntil).toISOString(),
        });
      }
      throw error;
    }
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
  async evaluate<T>(
    code: string,
    opts: { vault?: string } = {},
  ): Promise<{ value: T; layer: Layer }> {
    const vault = await this.fence.resolve(opts.vault);
    const layer = await this.resolve("evaluate");
    if (layer === "playwright") {
      this.claimDebugger("playwright");
      return { value: await this.playwright.evaluate<T>(code, vault.name), layer };
    }
    const stdout = await this.nativeCliCall(() => this.cli.evaluate(code, vault.name));
    const { parseCliJson } = await import("../util/serialize.js");
    const parsed = parseCliJson<T>(stdout);
    return { value: (parsed ?? (stdout.trim() as unknown)) as T, layer };
  }

  /**
   * Evaluate and require a JSON result. Used by tools that need structured data
   * regardless of which transport answered.
   */
  async evaluateJson<T>(
    code: string,
    opts: { vault?: string } = {},
  ): Promise<{ value: T; layer: Layer }> {
    const vault = await this.fence.resolve(opts.vault);
    const layer = await this.resolve("evaluate");
    if (layer === "playwright") {
      this.claimDebugger("playwright");
      return { value: await this.playwright.evaluate<T>(code, vault.name), layer };
    }
    // Obsidian's CLI already serializes object and array results as JSON. Wrapping
    // a long, multiline IIFE in JSON.stringify makes its evaluator return
    // `(no output)` on current Obsidian releases, even though the same IIFE returns
    // the correct object by itself.
    const { parseCliJson } = await import("../util/serialize.js");
    const stdout = await this.nativeCliCall(() => this.cli.evaluate(code, vault.name));
    const parsed = parseCliJson<T>(stdout);
    if (parsed === undefined) {
      const cleaned = stdout.trim().replace(/^=>\s*/, "");
      if (cleaned === "" || cleaned === "(no output)") {
        return { value: undefined as T, layer };
      }
      // The CLI renders a returned string without JSON quotes. A JSON-oriented
      // caller can still legitimately request one, so preserve that scalar.
      if (stdout.trim().startsWith("=>")) return { value: cleaned as T, layer };
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

  /**
   * Run an Obsidian CLI command, requiring the CLI layer.
   *
   * The vault is resolved through the fence here rather than trusted from the
   * caller, so a handler that forgets to resolve still cannot produce an unscoped
   * call. Vault-agnostic commands (`version`, `help`, `__completions`) skip the
   * fence — they answer questions about the installation, not about notes, and
   * `version` has to work before anything is authorized.
   */
  async cliCommand(command: string[], overrides: { vault?: string } = {}): Promise<string> {
    const layer = await this.resolve("cliCommand");
    if (VAULT_AGNOSTIC_COMMANDS.has(command[0] ?? "")) {
      // These answer questions about the installation rather than about notes, and
      // `version` must work before anything is authorized — so they never reach
      // the renderer route, which needs a fenced window to evaluate in.
      return this.nativeCliCall(() => this.cli.run(command));
    }
    const vault = await this.fence.resolve(overrides.vault);

    if (layer === "playwright") {
      this.claimDebugger("playwright");
      // The vault token is omitted deliberately: Obsidian's main process strips it
      // before calling handleCli, and the window we evaluate in is what scopes the
      // command. Output shape is identical, so the same classifier applies.
      const stdout = await this.playwright.handleCli(command, vault.name);
      const failure = classifyCliOutput(stdout, vault.name);
      if (failure) throw failure;
      return stdout;
    }

    return this.nativeCliCall(() => this.cli.run(command, { vault: vault.name }));
  }

  /** The vault a call will target, or a typed refusal. */
  async resolveVault(requested?: string): Promise<AuthorizedVault> {
    return this.fence.resolve(requested);
  }

  /** Which Obsidian process(es) this server owns. */
  get processScope(): ProcessScope {
    return this.config.sessionId !== undefined ? { userDataDir: this.config.userDataDir } : {};
  }

  async health(opts: { skipCliProbe?: boolean } = {}): Promise<HealthReport> {
    return probeHealth({
      cdpUrl: this.config.cdpUrl,
      cli: this.cli,
      logger: this.logger.child("health"),
      configPath: this.config.obsidianConfigPath,
      scope: this.processScope,
      ...(opts.skipCliProbe !== undefined ? { skipCliProbe: opts.skipCliProbe } : {}),
    });
  }

  /**
   * Re-point at a different CDP endpoint after a launch.
   *
   * With `--remote-debugging-port=0` the port is only known once the app is up, but
   * the PlaywrightSession is built with `config.cdpUrl` at construction. Without
   * this, a session that auto-allocated its port would keep probing the port the
   * config guessed at startup.
   */
  async retarget(cdpUrl: string): Promise<void> {
    if (cdpUrl === this.config.cdpUrl) return;
    this.logger.info("retargeting CDP endpoint", { from: this.config.cdpUrl, to: cdpUrl });
    await this.playwright.close().catch(() => undefined);
    this.config.cdpUrl = cdpUrl;
    this.config.cdpPort = Number(new URL(cdpUrl).port);
    this.playwright.retarget(cdpUrl);
    await this.refreshAvailability(true);
  }

  /** Idempotent: shutdown paths can and do call this more than once. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.supervisor.stop();
    // Before closing the connection: a held key or a live emulation override must
    // not outlive the session on the user's window.
    await this.focus.dispose().catch(() => undefined);
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

    // A CLI-preferring capability whose app is up but whose flag is off: naming the
    // disabled flag keeps the precondition distinguishable. Gaining the renderer
    // route made `onlyCli` above stop matching `cliCommand`, which silently
    // downgraded this case to a generic "cannot connect" — the regression the four
    // states exist to prevent. Gated on the process being alive, so a
    // wholly-unreachable Obsidian still reports itself as not running.
    if (preference[0] === "cli" && this.processRunning && !this.cliFlagEnabled) {
      return cliDisabled();
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
