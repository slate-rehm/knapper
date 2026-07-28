/**
 * The Playwright-over-CDP transport.
 *
 * Attaches to an Obsidian instance that was cold-started with
 * `--remote-debugging-port`. Notable constraints, all of which shape this module:
 *
 *  - Exactly one BrowserContext exists no matter how many Obsidian windows or
 *    session partitions are in play; Playwright has declared multi-context over
 *    CDP out of scope. Every window and webview lands in `contexts()[0].pages()`.
 *  - `noDefaults` must be set. Playwright's defaults apply emulated media, which
 *    flips the user's light/dark theme, and turn on focus emulation *permanently
 *    and context-wide*, which leaves their live Obsidian behaving as though it
 *    always has focus. Both are unacceptable against a daily-driver app.
 *
 *    Focus emulation itself is not the problem — it is what makes input land in a
 *    window that is not in the foreground, and knapper needs that. The difference
 *    is scope: `src/browser/focus.ts` enables it around a single input dispatch and
 *    reverts it in a finally, so the steady state stays untouched. Opting out here
 *    and back in there is deliberate, not contradictory.
 *  - Page handles go stale when a window closes, so pages are re-enumerated per
 *    call rather than cached.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { Logger } from "../../util/logger.js";
import { appUnavailable, cdpPortClosed, UobError } from "../../util/errors.js";
import { wrapExpression } from "../../util/serialize.js";
import { parseObsidianTitle, OBSIDIAN_MAIN_URL } from "./discover.js";

export interface PlaywrightSessionOptions {
  cdpUrl: string;
  /**
   * The fence. Resolves the vault this session may drive, and throws when none is
   * authorized. Injected rather than imported so the session stays testable and so
   * the router keeps a single fence instance.
   */
  resolveVault: (requested?: string) => Promise<{ name: string }>;
  /** Whether a window's vault is authorized. Used to re-verify pins per call. */
  isVaultAuthorized: (vaultName: string) => Promise<boolean>;
  /** Case-insensitive substring matched against a window's title or URL. */
  targetMatch?: string;
  logger: Logger;
  timeoutMs?: number;
}

export interface ResolvedPage {
  page: Page;
  kind: "main" | "popout";
  vaultName?: string;
  title: string;
  url: string;
}

export class PlaywrightSession {
  private browser?: Browser;
  private context?: BrowserContext;
  private pinnedTargetId?: string;
  /**
   * A stale `targetMatch` degrades instead of failing, so it is re-evaluated on
   * every call. Warning each time would flood stderr, so the miss is announced
   * once and demoted to debug afterwards.
   */
  private warnedTargetMatchMiss = false;

  constructor(private readonly opts: PlaywrightSessionOptions) {}

  get connected(): boolean {
    return this.browser?.isConnected() === true;
  }

  get cdpUrl(): string {
    return this.opts.cdpUrl;
  }

  /**
   * Point at a different endpoint. The caller must `close()` first.
   *
   * Needed because a session launched with `--remote-debugging-port=0` only learns
   * its port after the app is up, by which time this object already exists. The pin
   * is dropped: a target id from the old browser means nothing to the new one.
   */
  retarget(cdpUrl: string): void {
    this.opts.cdpUrl = cdpUrl;
    this.pinnedTargetId = undefined;
  }

  /** Attach to the running Obsidian instance, reusing an existing connection. */
  async connect(): Promise<BrowserContext> {
    if (this.context && this.browser?.isConnected()) return this.context;

    const { cdpUrl, logger, timeoutMs = 30_000 } = this.opts;
    logger.debug("attaching over CDP", { cdpUrl });

    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(cdpUrl, {
        // Both are essential when attaching to a user's live application rather
        // than a browser we launched ourselves. noDefaults suppresses emulated
        // media (which flips their theme) and context-wide focus emulation (which
        // leaves the window permanently focus-looking). Input still needs focus
        // emulation, so focus.ts re-enables it per dispatch and reverts it — see
        // the module header for why that is not a contradiction.
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
  async windows(): Promise<ResolvedPage[]> {
    const context = await this.connect();
    const out: ResolvedPage[] = [];

    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const url = page.url();
      let title: string;
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
  attachTo(targetId: string | undefined): void {
    this.pinnedTargetId = targetId;
  }

  get pinned(): string | undefined {
    return this.pinnedTargetId;
  }

  /**
   * The vault a window belongs to.
   *
   * Main windows are asked directly; a popout has no `app` object, so its vault
   * comes from the title. An unparseable title yields undefined, which the callers
   * below treat as unauthorized — a window we cannot identify is not one we drive.
   */
  private async vaultOfWindow(w: ResolvedPage): Promise<string | undefined> {
    if (w.kind === "main") return this.vaultNameOf(w.page);
    return w.vaultName;
  }

  /**
   * Resolve the page to drive, or refuse.
   *
   * Precedence, strongest signal first:
   *   1. `attachTo` — an explicitly pinned CDP target id. Re-verified as authorized
   *      on every call, because a window can switch vaults under a pin that was
   *      valid when it was set.
   *   2. The fenced vault, confirmed through `app.vault.getName()` in the renderer.
   *      The renderer is authoritative; the window title lags behind vault switches.
   *   3. `targetMatch`, but only as a tiebreaker *among* windows that already
   *      cleared step 2. It can narrow the set and can never widen it.
   *
   * There is deliberately no step 4. This used to fall through to "first main
   * window, then whatever is left", which meant a `vault` that matched nothing
   * silently drove someone else's notes.
   */
  async page(requestedVault?: string): Promise<Page> {
    const windows = await this.windows();
    if (windows.length === 0) {
      throw appUnavailable();
    }

    if (this.pinnedTargetId !== undefined) {
      for (const w of windows) {
        const id = await this.targetIdFor(w.page);
        if (id !== this.pinnedTargetId) continue;

        const vaultName = await this.vaultOfWindow(w);
        if (vaultName === undefined || !(await this.opts.isVaultAuthorized(vaultName))) {
          throw new UobError(
            "VAULT_NOT_AUTHORIZED",
            `The pinned window is showing "${vaultName ?? "an unidentifiable vault"}", which is not authorized.`,
            {
              remediation:
                "The window switched vaults after it was pinned, or was never authorized. Attach " +
                "to an authorized window instead; knapper re-checks the pin on every call rather " +
                "than trusting it.",
              fixedBy: "obsidian_list_targets",
              details: { pinnedTargetId: this.pinnedTargetId, vault: vaultName },
            },
          );
        }
        return w.page;
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

    const wanted = (await this.opts.resolveVault(requestedVault)).name.toLowerCase();
    const matching: ResolvedPage[] = [];
    for (const w of windows) {
      const name = await this.vaultOfWindow(w);
      if (name?.toLowerCase() === wanted) matching.push(w);
    }

    if (matching.length === 0) {
      throw new UobError(
        "TARGET_NOT_FOUND",
        `No open Obsidian window is showing the authorized vault "${wanted}".`,
        {
          remediation:
            "Open that vault in Obsidian, or name a different authorized vault. knapper will not " +
            "fall back to another window — that is how automation ends up driving the wrong vault.",
          fixedBy: "obsidian_list_targets",
          details: { vault: wanted, openWindows: windows.length },
        },
      );
    }

    const match = this.opts.targetMatch?.toLowerCase();
    if (match !== undefined && match !== "" && matching.length > 1) {
      const narrowed = matching.filter(
        (w) => w.title.toLowerCase().includes(match) || w.url.toLowerCase().includes(match),
      );
      const chosen = narrowed.find((w) => w.kind === "main") ?? narrowed[0];
      if (chosen) return chosen.page;
      const message =
        "no authorized Obsidian window matches OBSIDIAN_TARGET_MATCH; using the authorized main window";
      if (this.warnedTargetMatchMiss) {
        this.opts.logger.debug(message, { targetMatch: this.opts.targetMatch });
      } else {
        this.warnedTargetMatchMiss = true;
        this.opts.logger.warn(message, {
          targetMatch: this.opts.targetMatch,
          titles: matching.map((w) => w.title),
        });
      }
    }

    const main = matching.find((w) => w.kind === "main") ?? matching[0];
    if (!main) throw appUnavailable();
    return main.page;
  }

  /**
   * Whether an arbitrary page belongs to an authorized vault.
   *
   * Used by telemetry capture, which enumerates the raw context rather than going
   * through `page()`. Console output and page errors quote note content, so an
   * unauthorized window's stream must never reach the ring buffer.
   *
   * Fails closed: a page we cannot identify is not authorized.
   */
  async isPageAuthorized(page: Page): Promise<boolean> {
    let name = await this.vaultNameOf(page);
    if (name === undefined) {
      try {
        name = parseObsidianTitle(await page.title()).vaultName;
      } catch {
        return false;
      }
    }
    if (name === undefined) return false;
    return this.opts.isVaultAuthorized(name);
  }

  /** Ask the renderer which vault it has open. Authoritative, unlike the title. */
  async vaultNameOf(page: Page): Promise<string | undefined> {
    try {
      return await page.evaluate(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        () => (globalThis as any).app?.vault?.getName?.() as string | undefined,
      );
    } catch {
      return undefined;
    }
  }

  /** Resolve a page's CDP target id via a per-page session. */
  async targetIdFor(page: Page): Promise<string | undefined> {
    try {
      const context = await this.connect();
      const cdp = await context.newCDPSession(page);
      const info = (await cdp.send("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      await cdp.detach().catch(() => undefined);
      return info.targetInfo?.targetId;
    } catch {
      return undefined;
    }
  }

  /** Is `window.app` present in this page? The cheapest proof the renderer is live. */
  private async hasApp(page: Page): Promise<boolean> {
    return page.evaluate(() => typeof (globalThis as { app?: unknown }).app !== "undefined");
  }

  /**
   * Liveness probe for the supervisor: attach if needed, then confirm some renderer
   * still answers. Never throws — "Obsidian is not running" is an ordinary state
   * for this server, not an error, so every failure mode collapses to `false`.
   *
   * Deliberately unfenced. Whether Obsidian is reachable is a transport question,
   * not a vault question: a server with nothing authorized must still report the
   * app as up, or the supervisor spends the session backing off from a healthy
   * instance. The probe reads `typeof app` and nothing else, so it sees no content.
   */
  async healthCheck(): Promise<boolean> {
    try {
      for (const w of await this.windows()) {
        if (await this.hasApp(w.page)) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Evaluate an expression in the renderer, verifying `window.app` first. */
  async evaluate<T>(expression: string, vault?: string): Promise<T> {
    const page = await this.page(vault);
    if (!(await this.hasApp(page))) throw appUnavailable();

    try {
      return (await page.evaluate(`(() => { ${wrapExpression(expression)} })()`)) as T;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new UobError("EVAL_FAILED", `Evaluation threw in the Obsidian renderer: ${message}`, {
        details: { stack: e instanceof Error ? e.stack : undefined },
        cause: e,
      });
    }
  }

  /**
   * Run an Obsidian CLI command over CDP instead of the IPC socket.
   *
   * This is not a reimplementation. Obsidian's own main process serves a CLI
   * request by evaluating exactly this in the target vault's renderer:
   *
   *   new Promise((resolve, reject) => {
   *     if (window.handleCli) Promise.resolve(window.handleCli(argv)).then(resolve, reject)
   *     else { window.cliQueue = window.cliQueue || []; window.cliQueue.push({argv, resolve, reject}) }
   *   })
   *
   * so this produces byte-identical output and `classifyCliOutput` needs no
   * changes. `argv` arrives WITHOUT the `vault=` token, because the main process
   * strips it before dispatching — the vault is chosen by which window you
   * evaluate in, which here is the one the fence already picked.
   *
   * The `cliQueue` branch matters: before layout-ready `window.handleCli` does not
   * exist yet, and Obsidian's answer is to queue rather than fail. Mirroring that
   * is why a command issued during startup blocks instead of erroring.
   *
   * Why keep it when the native socket works: it is the only route on macOS and
   * Windows, where the socket path takes no environment input and cannot be made
   * per-session. It also bypasses the main process's `if (!C.cli)` gate, so the
   * doctor must keep sourcing `cliEnabled` from obsidian.json rather than
   * inferring it from this succeeding.
   */
  async handleCli(argv: string[], vault?: string): Promise<string> {
    const page = await this.page(vault);
    if (!(await this.hasApp(page))) throw appUnavailable();

    // Passed as a source string rather than a closure, matching `evaluate` above:
    // this project's tsconfig has no DOM lib, so `window` is not a typed global
    // here, and the payload is Obsidian's own snippet transcribed rather than code
    // meant to typecheck against the renderer.
    const source = `new Promise((resolve, reject) => {
      const argv = ${JSON.stringify(argv)};
      if (typeof window.handleCli === "function") {
        Promise.resolve(window.handleCli(argv)).then(resolve, reject);
      } else {
        window.cliQueue = window.cliQueue || [];
        window.cliQueue.push({ argv, resolve, reject });
      }
    })`;

    let result: unknown;
    try {
      result = await page.evaluate(source);
    } catch (e) {
      // A rejection here is the command failing, not the transport: Obsidian's own
      // IPC path surfaces the same rejection as an error string on stdout, so
      // normalize to that shape and let classifyCliOutput decide.
      const message = e instanceof Error ? e.message : String(e);
      return message.startsWith("Error:") ? message : `Error: ${message}`;
    }

    return typeof result === "string" ? result : result === undefined ? "" : String(result);
  }

  /** A raw CDP session bound to the active page. */
  async cdpSession(vault?: string) {
    const context = await this.connect();
    const page = await this.page(vault);
    return context.newCDPSession(page);
  }

  /**
   * A raw CDP session bound to a caller-supplied page.
   *
   * Focus emulation needs a session on the *same target* the input will land on,
   * held open for the duration of the dispatch: Chromium reverts a session's
   * overrides when it detaches, so `src/browser/focus.ts` caches these rather than
   * attaching per call.
   */
  async cdpSessionFor(page: Page) {
    const context = await this.connect();
    return context.newCDPSession(page);
  }

  async close(): Promise<void> {
    // Only detaches our client; never closes the user's Obsidian windows.
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    if (browser?.isConnected()) await browser.close().catch(() => undefined);
  }
}
