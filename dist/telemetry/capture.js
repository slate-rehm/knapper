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
/** Playwright console message types mapped onto our level vocabulary. */
function toLevel(type) {
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
  router;
  store;
  logger;
  /** Pages already wired, tracked so re-arming does not double-subscribe. */
  wired = new WeakSet();
  armed = false;
  networkEnabled = false;
  constructor(router, store, logger) {
    this.router = router;
    this.store = store;
    this.logger = logger;
  }
  get isArmed() {
    return this.armed;
  }
  /**
   * Subscribe to console, page errors, and (optionally) network events on every
   * attached Obsidian window. Safe to call repeatedly.
   */
  async arm(opts = {}) {
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
  async wirePage(page, network) {
    if (this.wired.has(page)) return false;
    this.wired.add(page);
    page.on("console", (msg) => {
      const location = msg.location();
      const url = location?.url;
      this.store.add({
        source: "console",
        level: toLevel(msg.type()),
        text: msg.text(),
        ...(url ? { url } : {}),
        ...(location?.lineNumber !== undefined
          ? { meta: { line: location.lineNumber, column: location.columnNumber } }
          : {}),
      });
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
  async wireNetwork(page) {
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
  async tryArm(opts = {}) {
    try {
      const { armed } = await this.arm(opts);
      return armed;
    } catch (e) {
      this.logger.debug("telemetry arm failed", { error: String(e) });
      return false;
    }
  }
}
//# sourceMappingURL=capture.js.map
