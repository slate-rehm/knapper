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
import { type BrowserContext, type Page } from "playwright-core";
import type { Logger } from "../../util/logger.js";
export interface PlaywrightSessionOptions {
  cdpUrl: string;
  vault?: string;
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
export declare class PlaywrightSession {
  private readonly opts;
  private browser?;
  private context?;
  private pinnedTargetId?;
  constructor(opts: PlaywrightSessionOptions);
  get connected(): boolean;
  /** Attach to the running Obsidian instance, reusing an existing connection. */
  connect(): Promise<BrowserContext>;
  /**
   * Every Obsidian window currently attached. Re-enumerated on each call because
   * closed windows leave stale Page handles behind.
   */
  windows(): Promise<ResolvedPage[]>;
  /** Pin subsequent calls to a specific CDP target id. */
  attachTo(targetId: string | undefined): void;
  get pinned(): string | undefined;
  /**
   * Resolve the page to drive.
   *
   * Multiple main windows all share the same URL, so when a vault is requested we
   * confirm identity through `app.vault.getName()` rather than trusting the title,
   * which lags behind vault switches.
   */
  page(): Promise<Page>;
  /** Ask the renderer which vault it has open. Authoritative, unlike the title. */
  vaultNameOf(page: Page): Promise<string | undefined>;
  /** Resolve a page's CDP target id via a per-page session. */
  targetIdFor(page: Page): Promise<string | undefined>;
  /** Evaluate an expression in the renderer, verifying `window.app` first. */
  evaluate<T>(expression: string): Promise<T>;
  /** A raw CDP session bound to the active page. */
  cdpSession(): Promise<import("playwright-core").CDPSession>;
  close(): Promise<void>;
}
