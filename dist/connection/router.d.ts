/**
 * The capability router.
 *
 * Tools ask for a capability; the router decides which transport serves it based
 * on what is reachable right now. It also enforces the one hard exclusivity rule:
 * Electron allows a single debugger client per WebContents, so the CLI's `dev:cdp`
 * and a live Playwright attachment cannot both be active.
 */
import { type Capability, type Layer } from "../capabilities.js";
import type { Config } from "../config.js";
import type { Logger } from "../util/logger.js";
import { ObsidianCli } from "./cli/exec.js";
import { PlaywrightSession } from "./cdp/session.js";
import { type HealthReport } from "./health.js";
export interface LayerAvailability {
  playwright: boolean;
  cli: boolean;
  cliCdp: boolean;
  local: boolean;
}
export declare class CapabilityRouter {
  private readonly config;
  private readonly logger;
  readonly cli: ObsidianCli;
  readonly playwright: PlaywrightSession;
  private availability;
  private availabilityCheckedAt;
  /** Which layer currently owns the Electron debugger, if any. */
  private debuggerHolder?;
  constructor(config: Config, logger: Logger);
  /**
   * Refresh layer availability, cached briefly so a burst of tool calls does not
   * re-probe the port for each one.
   */
  refreshAvailability(force?: boolean): Promise<LayerAvailability>;
  /** Resolve which layer will serve a capability, or throw explaining why none can. */
  resolve(capability: Capability): Promise<Layer>;
  /** Mark a layer as holding the Electron debugger. */
  claimDebugger(layer: Layer): void;
  releaseDebugger(layer: Layer): void;
  get currentDebuggerHolder(): Layer | undefined;
  /**
   * Evaluate JavaScript in the renderer through whichever layer is available.
   * Returns the value plus which layer served it.
   */
  evaluate<T>(code: string): Promise<{
    value: T;
    layer: Layer;
  }>;
  /**
   * Evaluate and require a JSON result. Used by tools that need structured data
   * regardless of which transport answered.
   */
  evaluateJson<T>(code: string): Promise<{
    value: T;
    layer: Layer;
  }>;
  /** Run an Obsidian CLI command, requiring the CLI layer. */
  cliCommand(
    command: string[],
    overrides?: {
      vault?: string;
    },
  ): Promise<string>;
  health(opts?: { skipCliProbe?: boolean }): Promise<HealthReport>;
  dispose(): Promise<void>;
  private explainUnavailable;
}
