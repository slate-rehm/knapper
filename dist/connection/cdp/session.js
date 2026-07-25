/**
 * The Playwright-over-CDP transport.
 *
 * Attaches to an Obsidian instance that was cold-started with
 * `--remote-debugging-port`. Notable constraints, all of which shape this module:
 *
 *  - Exactly one BrowserContext exists no matter how many Obsidian windows or
 *    session partitions are in play; Playwright has declared multi-context over
 *    CDP out of scope. Every window and webview lands in `contexts()[0].pages()`.
 *  - `noDefaults` must be set. Without it Playwright applies focus emulation and
 *    emulated media to the attached context, which makes the user's live Obsidian
 *    behave as permanently focused and can flip their light/dark theme.
 *  - Page handles go stale when a window closes, so pages are re-enumerated per
 *    call rather than cached.
 */
import { chromium } from "playwright-core";
import { appUnavailable, cdpPortClosed, UobError } from "../../util/errors.js";
import { parseObsidianTitle, OBSIDIAN_MAIN_URL } from "./discover.js";
export class PlaywrightSession {
  opts;
  browser;
  context;
  pinnedTargetId;
  constructor(opts) {
    this.opts = opts;
  }
  get connected() {
    return this.browser?.isConnected() === true;
  }
  /** Attach to the running Obsidian instance, reusing an existing connection. */
  async connect() {
    if (this.context && this.browser?.isConnected()) return this.context;
    const { cdpUrl, logger, timeoutMs = 30_000 } = this.opts;
    logger.debug("attaching over CDP", { cdpUrl });
    let browser;
    try {
      browser = await chromium.connectOverCDP(cdpUrl, {
        // Both are essential when attaching to a user's live application rather
        // than a browser we launched ourselves. Without noDefaults, Playwright
        // enables focus emulation and applies emulated media, which can flip the
        // user's Obsidian theme and make it behave as permanently focused.
        noDefaults: true,
        isLocal: true,
        timeout: timeoutMs,
      });
    } catch {
      throw cdpPortClosed(cdpUrl);
    }
    const contexts = browser.contexts();
    const context = contexts[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      throw new UobError("TARGET_NOT_FOUND", "The CDP endpoint exposed no browser context.", {
        remediation: "Confirm the endpoint belongs to Obsidian and that a window is open.",
        details: { cdpUrl },
      });
    }
    browser.on("disconnected", () => {
      logger.warn("CDP connection lost");
      this.browser = undefined;
      this.context = undefined;
    });
    this.browser = browser;
    this.context = context;
    logger.info("attached to Obsidian over CDP", { pages: context.pages().length });
    return context;
  }
  /**
   * Every Obsidian window currently attached. Re-enumerated on each call because
   * closed windows leave stale Page handles behind.
   */
  async windows() {
    const context = await this.connect();
    const out = [];
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const url = page.url();
      let title;
      try {
        title = await page.title();
      } catch {
        continue; // window closed mid-enumeration
      }
      const parsed = parseObsidianTitle(title);
      const isMain = url === OBSIDIAN_MAIN_URL || url.startsWith("app://obsidian.md/");
      const isPopout = url === "about:blank" && parsed.vaultName !== undefined;
      if (!isMain && !isPopout) continue;
      out.push({
        page,
        kind: isMain ? "main" : "popout",
        title,
        url,
        ...(parsed.vaultName !== undefined ? { vaultName: parsed.vaultName } : {}),
      });
    }
    return out;
  }
  /** Pin subsequent calls to a specific CDP target id. */
  attachTo(targetId) {
    this.pinnedTargetId = targetId;
  }
  get pinned() {
    return this.pinnedTargetId;
  }
  /**
   * Resolve the page to drive.
   *
   * Multiple main windows all share the same URL, so when a vault is requested we
   * confirm identity through `app.vault.getName()` rather than trusting the title,
   * which lags behind vault switches.
   */
  async page() {
    const windows = await this.windows();
    if (windows.length === 0) {
      throw appUnavailable();
    }
    if (this.pinnedTargetId !== undefined) {
      for (const w of windows) {
        const id = await this.targetIdFor(w.page);
        if (id === this.pinnedTargetId) return w.page;
      }
      throw new UobError(
        "TARGET_NOT_FOUND",
        `Pinned target ${this.pinnedTargetId} is no longer present.`,
        {
          remediation: "List targets and attach again; the window was probably closed.",
          fixedBy: "obsidian_list_targets",
        },
      );
    }
    const wanted = this.opts.vault?.toLowerCase();
    if (wanted !== undefined) {
      for (const w of windows.filter((x) => x.kind === "main")) {
        const name = await this.vaultNameOf(w.page);
        if (name?.toLowerCase() === wanted) return w.page;
      }
    }
    const main = windows.find((w) => w.kind === "main");
    return (main ?? windows[0]).page;
  }
  /** Ask the renderer which vault it has open. Authoritative, unlike the title. */
  async vaultNameOf(page) {
    try {
      return await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => globalThis.app?.vault?.getName?.(),
      );
    } catch {
      return undefined;
    }
  }
  /** Resolve a page's CDP target id via a per-page session. */
  async targetIdFor(page) {
    try {
      const context = await this.connect();
      const cdp = await context.newCDPSession(page);
      const info = await cdp.send("Target.getTargetInfo");
      await cdp.detach().catch(() => undefined);
      return info.targetInfo?.targetId;
    } catch {
      return undefined;
    }
  }
  /** Evaluate an expression in the renderer, verifying `window.app` first. */
  async evaluate(expression) {
    const page = await this.page();
    const hasApp = await page.evaluate(() => typeof globalThis.app !== "undefined");
    if (!hasApp) throw appUnavailable();
    try {
      return await page.evaluate(`(() => { ${wrapExpression(expression)} })()`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new UobError("EVAL_FAILED", `Evaluation threw in the Obsidian renderer: ${message}`, {
        details: { stack: e instanceof Error ? e.stack : undefined },
        cause: e,
      });
    }
  }
  /** A raw CDP session bound to the active page. */
  async cdpSession() {
    const context = await this.connect();
    const page = await this.page();
    return context.newCDPSession(page);
  }
  async close() {
    // Only detaches our client; never closes the user's Obsidian windows.
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    if (browser?.isConnected()) await browser.close().catch(() => undefined);
  }
}
/**
 * Allow both expression and statement bodies. A bare expression gets an implicit
 * return so `obsidian_eval` accepts `app.vault.getName()` as well as a full body.
 */
function wrapExpression(code) {
  const trimmed = code.trim();
  const looksLikeStatements =
    /^(?:const|let|var|return|if|for|while|switch|try|throw|function|class)\b/.test(trimmed);
  if (looksLikeStatements || trimmed.includes(";") || trimmed.includes("\n")) {
    return trimmed.includes("return") ? trimmed : `${trimmed}\nreturn undefined;`;
  }
  return `return (${trimmed});`;
}
//# sourceMappingURL=session.js.map
