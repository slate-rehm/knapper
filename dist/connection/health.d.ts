/**
 * Precondition probing.
 *
 * Four states are kept distinct because the remediation differs for each, and
 * collapsing them into a single "cannot connect" is the main reason this class of
 * tooling is frustrating to use.
 */
import { type ObsidianGlobalConfig } from "./vaults.js";
import type { ObsidianCli } from "./cli/exec.js";
import type { Logger } from "../util/logger.js";
export interface HealthReport {
  /** Is an Obsidian process alive? */
  running: boolean;
  /** Is the global CLI toggle on? */
  cliEnabled: boolean;
  /** Does the CLI actually answer? */
  cliReachable: boolean;
  /** Is a CDP debug port listening? */
  cdpReachable: boolean;
  cdpUrl: string;
  browserVersion?: string;
  /** Obsidian windows visible over CDP. */
  windows: {
    kind: string;
    title: string;
    vaultName?: string;
    targetId: string;
  }[];
  /** Single-dash launch flags that corrupt CLI argv. */
  argvCorruption:
    | {
        path: string;
        tokens: string[];
      }
    | undefined;
  vaults: ObsidianGlobalConfig["vaults"];
  configPath: string;
  /** Human-readable problems, most actionable first. */
  problems: HealthProblem[];
}
export interface HealthProblem {
  state: "not-running" | "cli-disabled" | "cdp-closed" | "argv-corruption";
  message: string;
  remediation: string;
  fixedBy?: string;
}
/** Detect a live Obsidian process without spawning the binary. */
export declare function isObsidianRunning(): Promise<boolean>;
export interface ProbeOptions {
  cdpUrl: string;
  cli: ObsidianCli;
  logger: Logger;
  /** Skip the CLI round-trip, which can block while Obsidian starts up. */
  skipCliProbe?: boolean;
}
export declare function probeHealth(opts: ProbeOptions): Promise<HealthReport>;
