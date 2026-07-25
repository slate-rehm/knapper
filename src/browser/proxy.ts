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
import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { Logger } from "../util/logger.js";
import { UobError } from "../util/errors.js";
import { BLOCKED_BROWSER_TOOLS, isAllowedBrowserTool } from "./allowlist.js";

export { BLOCKED_BROWSER_TOOLS, ALLOWED_BROWSER_TOOLS } from "./allowlist.js";

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
    const context = await session.connect();
    this.router.claimDebugger("playwright");

    const server = await createConnection(
      {
        capabilities: ["vision", "testing"],
        browser: { isolated: false },
        outputDir: this.config.outputDir,
      },
      async () => context,
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "unified-obsidian-mcp", version: "0.1.0" });
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

  /** Forward a tool call, translating unavailability into an actionable error. */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!isAllowedBrowserTool(name)) {
      throw new UobError("INVALID_ARGUMENT", `The "${name}" tool is intentionally not exposed.`, {
        remediation:
          "It is unsafe against a live Obsidian window, filtered from the ui allowlist, or " +
          "reimplemented natively. Use obsidian_* tools or an allowed browser_* tool instead.",
      });
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

    return this.client.callTool({
      name,
      arguments: stripUndefined(args),
    }) as Promise<CallToolResult>;
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
