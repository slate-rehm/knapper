/**
 * Event capture from the Obsidian renderer.
 *
 * This is the thing the CLI transport fundamentally cannot do: the CLI's
 * `dev:console` returns a text blob on request, whereas subscribing to Playwright's
 * page events gives a live, structured, attributable stream.
 *
 * Capture is idempotent and re-arms itself after a reconnect, because Obsidian
 * restarts are routine during plugin development.
 */
import type { CapabilityRouter } from "../connection/router.js";
import type { Logger } from "../util/logger.js";
import type { TelemetryStore } from "./store.js";
export declare class TelemetryCapture {
  private readonly router;
  private readonly store;
  private readonly logger;
  /** Pages already wired, tracked so re-arming does not double-subscribe. */
  private readonly wired;
  private armed;
  private networkEnabled;
  constructor(router: CapabilityRouter, store: TelemetryStore, logger: Logger);
  get isArmed(): boolean;
  /**
   * Subscribe to console, page errors, and (optionally) network events on every
   * attached Obsidian window. Safe to call repeatedly.
   */
  arm(opts?: { network?: boolean }): Promise<{
    armed: boolean;
    pages: number;
  }>;
  private wirePage;
  /**
   * Network capture is opt-in: plugin HTTP traffic is useful when debugging a sync
   * or API integration, and pure noise otherwise.
   */
  private wireNetwork;
  /**
   * Best-effort arm that never throws, for use on paths where telemetry is a bonus
   * rather than the point (e.g. a dev cycle that should still reload the plugin
   * even if the debug port is closed).
   */
  tryArm(opts?: { network?: boolean }): Promise<boolean>;
}
