/**
 * Bridge to @playwright/mcp.
 *
 * Rather than reimplementing Playwright's tools, we stand up the real
 * @playwright/mcp server in-process, hand it *our* CDP BrowserContext through
 * `createConnection`'s `contextGetter`, and forward tool calls to it over an
 * in-memory transport. That gives us the ARIA snapshot engine, the `aria-ref=`
 * selector engine, and the response formatter for free — none of which live in the
 * MCP layer, so a fork would not even inherit them.
 *
 * Two hard constraints:
 *  - `isolated` must be false. If enabled, the proxy attaches to a fresh blank
 *    context and silently returns empty snapshots instead of erroring.
 *  - The BrowserContext must come from the same playwright-core instance that
 *    @playwright/mcp resolved, which is why we import it transitively rather than
 *    depending on playwright-core directly.
 */
import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { Logger } from "../util/logger.js";
/**
 * Tools that are unsafe or meaningless against a live Obsidian window.
 *
 * `browser_close` calls `page.close()`, which closes one of the user's Obsidian
 * windows. `browser_navigate` would `page.goto()` away from the app shell, breaking
 * out of Obsidian entirely. The rest are either irrelevant to an attached Electron
 * app or actively disruptive to a daily-driver window.
 */
export declare const BLOCKED_BROWSER_TOOLS: Set<string>;
export interface ProxiedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
export declare class BrowserProxy {
  private readonly config;
  private readonly router;
  private readonly logger;
  private client?;
  private tools?;
  private initializing?;
  constructor(config: Config, router: CapabilityRouter, logger: Logger);
  get available(): boolean;
  /**
   * Start the proxied server if the debug port is reachable. Returns false rather
   * than throwing when Playwright is unavailable, so tool registration can proceed
   * and individual calls can explain the problem.
   */
  init(): Promise<boolean>;
  private doInit;
  /** The allowlisted tool descriptors, or an empty list when unavailable. */
  listTools(): Promise<ProxiedTool[]>;
  /** Forward a tool call, translating unavailability into an actionable error. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}
