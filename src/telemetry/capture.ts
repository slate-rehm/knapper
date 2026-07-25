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

import type { Page } from "playwright-core";
import type { CapabilityRouter } from "../connection/router.js";
import type { Logger } from "../util/logger.js";
import { consoleMessageText } from "./console-format.js";
import type { LogLevel, TelemetryStore } from "./store.js";

/** Playwright console message types mapped onto our level vocabulary. */
function toLevel(type: string): LogLevel {
  switch (type) {
    case "error":
      return "error";
    case "warning":
    case "warn":
      return "warn";
    case "debug":
    case "trace":
      return "debug";
    case "info":
      return "info";
    default:
      return "log";
  }
}

export class TelemetryCapture {
  /** Pages already wired, tracked so re-arming does not double-subscribe. */
  private readonly wired = new WeakSet<Page>();
  private armed = false;
  private networkEnabled = false;

  constructor(
    private readonly router: CapabilityRouter,
    private readonly store: TelemetryStore,
    private readonly logger: Logger,
  ) {}

  get isArmed(): boolean {
    return this.armed;
  }

  get isNetworkEnabled(): boolean {
    return this.networkEnabled;
  }

  /**
   * Subscribe to console, page errors, and (optionally) network events on every
   * attached Obsidian window. Safe to call repeatedly.
   */
  async arm(opts: { network?: boolean } = {}): Promise<{ armed: boolean; pages: number }> {
    const availability = await this.router.refreshAvailability();
    if (!availability.playwright) {
      this.armed = false;
      return { armed: false, pages: 0 };
    }

    const session = this.router.playwright;
    const context = await session.connect();
    this.router.claimDebugger("playwright");

    // Catch windows opened after we attach (popouts, new vault windows).
    if (!this.armed) {
      context.on("page", (page) => {
        void this.wirePage(page, opts.network === true).catch((e) =>
          this.logger.debug("failed to wire new page", { error: String(e) }),
        );
      });
    }

    let count = 0;
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      if (await this.wirePage(page, opts.network === true)) count++;
    }

    this.armed = true;
    if (opts.network === true) this.networkEnabled = true;
    this.logger.debug("telemetry armed", { pages: count, network: this.networkEnabled });
    return { armed: true, pages: count };
  }

  private async wirePage(page: Page, network: boolean): Promise<boolean> {
    if (this.wired.has(page)) return false;
    this.wired.add(page);

    page.on("console", (msg) => {
      const location = msg.location();
      const url = location?.url;
      const level = toLevel(msg.type());
      const meta =
        location?.lineNumber !== undefined
          ? { line: location.lineNumber, column: location.columnNumber }
          : undefined;

      void (async () => {
        const text = await consoleMessageText(msg);
        this.store.add({
          source: "console",
          level,
          text,
          ...(url ? { url } : {}),
          ...(meta !== undefined ? { meta } : {}),
        });
      })().catch((e) => this.logger.debug("console format failed", { error: String(e) }));
    });

    page.on("pageerror", (error) => {
      this.store.add({
        source: "pageerror",
        level: "error",
        text: error.message,
        ...(error.stack !== undefined ? { stack: error.stack } : {}),
      });
    });

    page.on("crash", () => {
      this.store.add({
        source: "exception",
        level: "error",
        text: "Obsidian renderer crashed.",
      });
    });

    if (network) await this.wireNetwork(page);
    return true;
  }

  /**
   * Network capture is opt-in: plugin HTTP traffic is useful when debugging a sync
   * or API integration, and pure noise otherwise.
   */
  private async wireNetwork(page: Page): Promise<void> {
    page.on("requestfailed", (request) => {
      this.store.add({
        source: "network",
        level: "warn",
        text: `${request.method()} ${request.url()} failed: ${request.failure()?.errorText ?? "unknown"}`,
        url: request.url(),
        meta: { method: request.method() },
      });
    });

    page.on("response", (response) => {
      const status = response.status();
      if (status < 400) return; // only surface failures by default
      this.store.add({
        source: "network",
        level: status >= 500 ? "error" : "warn",
        text: `${response.request().method()} ${response.url()} -> ${status}`,
        url: response.url(),
        meta: { status, method: response.request().method() },
      });
    });
  }

  /**
   * Best-effort arm that never throws, for use on paths where telemetry is a bonus
   * rather than the point (e.g. a dev cycle that should still reload the plugin
   * even if the debug port is closed).
   */
  async tryArm(opts: { network?: boolean } = {}): Promise<boolean> {
    try {
      const { armed } = await this.arm(opts);
      return armed;
    } catch (e) {
      this.logger.debug("telemetry arm failed", { error: String(e) });
      return false;
    }
  }
}
