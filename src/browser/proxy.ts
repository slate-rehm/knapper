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
import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { Logger } from "../util/logger.js";
import { UobError } from "../util/errors.js";

/**
 * Tools that are unsafe or meaningless against a live Obsidian window.
 *
 * `browser_close` calls `page.close()`, which closes one of the user's Obsidian
 * windows. `browser_navigate` would `page.goto()` away from the app shell, breaking
 * out of Obsidian entirely. The rest are either irrelevant to an attached Electron
 * app or actively disruptive to a daily-driver window.
 */
export const BLOCKED_BROWSER_TOOLS = new Set([
  "browser_close",
  "browser_navigate",
  "browser_navigate_back",
  "browser_resize",
  "browser_run_code_unsafe",
  "browser_file_upload",
  "browser_pdf_save",
  // Storage tools operate on a profile we do not own and cannot meaningfully isolate.
  "browser_storage_state",
  "browser_set_storage_state",
]);

/** Capabilities we ask @playwright/mcp to enable. */
const ENABLED_CAPABILITIES = ["vision", "testing"] as const;

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
        capabilities: [...ENABLED_CAPABILITIES],
        browser: { isolated: false },
        outputDir: this.config.outputDir,
      } as never,
      async () => context as never,
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "unified-obsidian-mcp", version: "0.1.0" });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const tools = listed.tools
      .filter((t) => !BLOCKED_BROWSER_TOOLS.has(t.name))
      .map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));

    this.client = client;
    this.tools = tools;
    this.logger.info(`browser proxy ready with ${tools.length} tools`, {
      blocked: listed.tools.length - tools.length,
    });
  }

  /** The allowlisted tool descriptors, or an empty list when unavailable. */
  async listTools(): Promise<ProxiedTool[]> {
    await this.init();
    return this.tools ?? [];
  }

  /** Forward a tool call, translating unavailability into an actionable error. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (BLOCKED_BROWSER_TOOLS.has(name)) {
      throw new UobError("INVALID_ARGUMENT", `The "${name}" tool is intentionally not exposed.`, {
        remediation:
          "It is unsafe against a live Obsidian window — it would close, navigate away from, or " +
          "resize the user's real application. Use an obsidian_* tool for that intent instead.",
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

    return this.client.callTool({ name, arguments: args });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.tools = undefined;
    if (client) await client.close().catch(() => undefined);
    this.router.releaseDebugger("playwright");
  }
}
