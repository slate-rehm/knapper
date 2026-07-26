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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Page } from "playwright-core";
import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { Logger } from "../util/logger.js";
import { UobError } from "../util/errors.js";
import {
  ALLOWED_TABS_ACTIONS,
  BLOCKED_BROWSER_TOOLS,
  isAllowedBrowserTool,
  isInputBrowserTool,
} from "./allowlist.js";

export { BLOCKED_BROWSER_TOOLS, ALLOWED_BROWSER_TOOLS } from "./allowlist.js";

/** Playwright's wording when the page, context, or browser died under us. */
const STALE_TARGET = /(target|page|context|browser).{0,40}(has been closed|closed)/i;

export interface ProxiedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class BrowserProxy {
  private client?: Client;
  private tools?: ProxiedTool[];
  private initializing?: Promise<void>;

  constructor(
    private readonly config: Config,
    private readonly router: CapabilityRouter,
    private readonly logger: Logger,
  ) {}

  get available(): boolean {
    return this.client !== undefined;
  }

  /**
   * Start the proxied server if the debug port is reachable. Returns false rather
   * than throwing when Playwright is unavailable, so tool registration can proceed
   * and individual calls can explain the problem.
   */
  async init(): Promise<boolean> {
    // A prior CDP disconnect leaves a live Client pointing at a dead context.
    if (this.client && !this.router.playwright.connected) {
      await this.close().catch(() => undefined);
    }

    if (this.client) return true;
    if (this.initializing) {
      await this.initializing;
      return this.client !== undefined;
    }

    this.initializing = this.doInit();
    try {
      await this.initializing;
      return this.client !== undefined;
    } finally {
      this.initializing = undefined;
    }
  }

  private async doInit(): Promise<void> {
    const availability = await this.router.refreshAvailability();
    if (!availability.playwright) {
      this.logger.debug("browser proxy unavailable: no CDP endpoint");
      return;
    }

    // Resolve through @playwright/mcp's dependency tree so the context we pass in
    // comes from the exact playwright-core build it expects.
    const { createConnection } = await import("@playwright/mcp");

    const session = this.router.playwright;
    await session.connect();
    this.router.claimDebugger("playwright");

    const server = await createConnection(
      {
        capabilities: ["vision", "testing"],
        browser: { isolated: false },
        outputDir: this.config.outputDir,
      },
      // Resolve the context per call rather than capturing one. Obsidian restarting
      // gives the session a brand-new BrowserContext, and a captured one stayed
      // pinned to the dead browser — every browser_* tool then failed forever with
      // "Target page, context or browser has been closed" while knapper's own CDP
      // tools had already recovered. session.connect() reuses a live connection and
      // rebuilds a dead one.
      async () => session.connect(),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "knapper", version: "0.1.0" });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const tools = listed.tools
      .filter((t) => isAllowedBrowserTool(t.name))
      .map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));

    const skipped = listed.tools.filter(
      (t) => !isAllowedBrowserTool(t.name) && !BLOCKED_BROWSER_TOOLS.has(t.name),
    );
    if (skipped.length > 0) {
      this.logger.debug("upstream tools not on ui allowlist", {
        names: skipped.map((t) => t.name),
      });
    }

    this.client = client;
    this.tools = tools;
    this.logger.info(`browser proxy ready with ${tools.length} tools`, {
      upstream: listed.tools.length,
      blocked: listed.tools.filter((t) => BLOCKED_BROWSER_TOOLS.has(t.name)).length,
    });
  }

  /** The allowlisted tool descriptors, or an empty list when unavailable. */
  async listTools(): Promise<ProxiedTool[]> {
    await this.init();
    return this.tools ?? [];
  }

  /**
   * Point the proxied server at the window knapper is pinned to.
   *
   * We hand `createConnection` the whole BrowserContext, so @playwright/mcp keeps
   * its *own* notion of the current tab and never consults our pin. That made
   * `obsidian_attach` a half-truth: knapper's own CDP tools followed it while every
   * browser_* tool stayed on whatever page the proxy latched onto first — so an
   * agent could pin to a scratch vault and still be typing into a real one.
   *
   * `browser_tabs select` is the only lever upstream exposes for this, so the pin
   * is translated into a tab index. Best effort: a failure here must not take down
   * the attach call, which still succeeds for the native layer.
   */
  async selectPinnedPage(): Promise<boolean> {
    if (!(await this.init()) || !this.client) return false;
    try {
      const page = await this.router.playwright.page();
      return await this.pointProxyAt(page);
    } catch (e) {
      this.logger.warn("could not point the browser proxy at the pinned window", {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  /**
   * Make upstream's "current tab" be `page`.
   *
   * Returns false rather than throwing so `obsidian_attach` can report partial
   * success, but `callTool` treats false as a refusal: forwarding real input to
   * whatever tab the proxy happened to latch onto is the failure mode this exists
   * to prevent.
   */
  private async pointProxyAt(page: Page): Promise<boolean> {
    if (!this.client) return false;
    try {
      const title = await page.title();

      // The index must come from upstream's own tab list, not from
      // context.pages(). Those are different index spaces: context.pages() also
      // contains metadata workers and blob pages, while upstream lists only real
      // windows. Indexing the former into the latter selected an unrelated tab
      // (or none) and quietly left the pin unhonored — it happened to line up in
      // one arrangement of windows, which is worse than failing outright.
      const listed = await this.client.callTool({
        name: "browser_tabs",
        arguments: { action: "list" },
      });
      const text = (listed as CallToolResult).content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");

      // Lines look like `- 0: (current) [Title](url)`.
      const tabs = [...text.matchAll(/^-\s*(\d+):\s*(\(current\)\s*)?\[(.+?)\]\(/gm)].map((m) => ({
        index: Number(m[1]),
        current: m[2] !== undefined,
        title: m[3] ?? "",
      }));

      // Every Obsidian window shares app://obsidian.md/index.html, so the title —
      // "<note> - <vault> - Obsidian <version>" — is the only distinguishing field.
      const match = tabs.find((t) => t.title === title);
      if (!match) {
        this.logger.warn("target window is not in the proxy's tab list", { title });
        return false;
      }

      // Skip the round-trip when upstream is already there. This runs before every
      // input call now, not just on attach, so the common case has to be cheap.
      if (match.current) return true;

      await this.client.callTool({
        name: "browser_tabs",
        arguments: { action: "select", index: match.index },
      });
      this.logger.debug("browser proxy retargeted", { index: match.index, title });
      return true;
    } catch (e) {
      this.logger.warn("could not point the browser proxy at the target window", {
        error: e instanceof Error ? e.message : String(e),
      });
      return false;
    }
  }

  /** Forward a tool call, translating unavailability into an actionable error. */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!isAllowedBrowserTool(name)) {
      throw new UobError("INVALID_ARGUMENT", `The "${name}" tool is intentionally not exposed.`, {
        remediation:
          "It is unsafe against a live Obsidian window, filtered from the ui allowlist, or " +
          "reimplemented natively. Use obsidian_* tools or an allowed browser_* tool instead.",
      });
    }

    // `select` and `close` would move upstream off the window the fence just
    // approved, which would make every later input call target something else.
    if (name === "browser_tabs") {
      const action = args.action;
      if (typeof action === "string" && !ALLOWED_TABS_ACTIONS.has(action)) {
        throw new UobError(
          "INVALID_ARGUMENT",
          `browser_tabs "${action}" is not available; only ${[...ALLOWED_TABS_ACTIONS].join(", ")} is.`,
          {
            remediation:
              "Switching or closing tabs behind knapper's back would retarget every later input " +
              "call. Use obsidian_attach to choose a window; it repoints the proxy for you.",
            fixedBy: "obsidian_attach",
          },
        );
      }
    }

    const ready = await this.init();
    if (!ready || !this.client) {
      throw new UobError(
        "CDP_PORT_CLOSED",
        `Browser automation is unavailable: no CDP endpoint at ${this.config.cdpUrl}.`,
        {
          remediation:
            "Obsidian must be fully quit and cold-started with `--remote-debugging-port`. Electron's " +
            "single-instance lock means adding the flag to a running instance silently does nothing.",
          fixedBy: "obsidian_launch",
        },
      );
    }

    const forward = async (): Promise<CallToolResult> =>
      this.client!.callTool({
        name,
        arguments: stripUndefined(args),
      }) as Promise<CallToolResult>;

    /**
     * Real input needs two things upstream cannot give us, both resolved here
     * because @playwright/mcp is a black box we forward to rather than a library
     * we can reach inside.
     *
     * The fence: `page()` throws unless the window belongs to an authorized vault,
     * and `pointProxyAt` makes upstream's own current-tab notion agree. Without
     * this the proxy keeps driving whichever tab it latched onto first.
     *
     * Focus emulation: set over a *separate* CDP session on the same target, so it
     * applies to upstream's dispatches without upstream knowing about it. That is
     * what makes background input work through the proxy at all.
     */
    const call = async (): Promise<CallToolResult> => {
      if (!isInputBrowserTool(name)) return forward();

      const page = await this.router.playwright.page();
      if (!(await this.pointProxyAt(page))) {
        throw new UobError(
          "TARGET_NOT_FOUND",
          `Refusing to run ${name}: could not point the browser proxy at the authorized window.`,
          {
            remediation:
              "The window may have closed, or its title changed mid-call. Take a fresh " +
              "browser_snapshot and retry. knapper will not forward real input without first " +
              "confirming which window will receive it.",
            fixedBy: "obsidian_list_targets",
            details: { tool: name },
          },
        );
      }
      return this.router.focus.run(page, forward);
    };

    try {
      return await call();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!STALE_TARGET.test(message)) throw e;

      // The upstream server can still be holding a page from a window that has
      // since closed. Rebuild once; the raw upstream text carries no code,
      // remediation, or fixedBy, so an agent seeing it has nothing to act on.
      this.logger.info("browser proxy hit a closed target; reinitializing", { tool: name });
      await this.close().catch(() => undefined);
      if (!(await this.init()) || !this.client) {
        throw new UobError("CDP_PORT_CLOSED", `Lost the Obsidian window while calling ${name}.`, {
          remediation:
            "Obsidian was closed or restarted. Relaunch it with the debug port, then retry.",
          fixedBy: "obsidian_launch",
        });
      }
      try {
        return await call();
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        throw new UobError(
          "TARGET_NOT_FOUND",
          `${name} could not reach an Obsidian window after reconnecting.`,
          {
            remediation:
              "Take a fresh browser_snapshot — refs from before the reconnect are stale. If the " +
              "window is gone, list targets and attach again.",
            fixedBy: "obsidian_list_targets",
            details: { tool: name, upstream: retryMessage.slice(0, 400) },
          },
        );
      }
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.tools = undefined;
    if (client) await client.close().catch(() => undefined);
    this.router.releaseDebugger("playwright");
  }
}

/**
 * Drop keys whose value is `undefined` before forwarding.
 *
 * The MCP SDK materializes every optional property of a tool's schema, so an
 * omitted argument arrives as an explicit `undefined`. Upstream then re-validates
 * with its own zod schema, where an enum like `type: "png" | "jpeg"` rejects an
 * explicit `undefined` even though the property is optional — which surfaced as
 * `browser_take_screenshot` failing validation when called with no arguments.
 */
function stripUndefined(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
