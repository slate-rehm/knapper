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

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/server";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import type { Config } from "../config.js";
import type { CapabilityRouter } from "../connection/router.js";
import type { Logger } from "../util/logger.js";
import { UobError } from "../util/errors.js";
import {
  ALLOWED_BROWSER_TOOLS,
  BLOCKED_BROWSER_TOOLS,
  isAllowedBrowserTool,
  isInputBrowserTool,
} from "./allowlist.js";
import { clickTarget } from "./native.js";
import { saveArtifact } from "../util/artifacts.js";

export { BLOCKED_BROWSER_TOOLS, ALLOWED_BROWSER_TOOLS } from "./allowlist.js";

/** Playwright's wording when the page, context, or browser died under us. */
const STALE_TARGET = /(target|page|context|browser).{0,40}(has been closed|closed)/i;
const CLICK_TIMEOUT = /timeout\s+\d+ms exceeded|TimeoutError/i;

function invalidScreenshotFilename(value: unknown): UobError {
  return new UobError(
    "INVALID_ARGUMENT",
    `Invalid screenshot filename: ${typeof value === "string" ? value : String(value)}.`,
    {
      remediation:
        "Use a relative, unused filename that stays inside the configured screenshot directory.",
    },
  );
}

async function nearestRealPath(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

/** Refuse screenshot paths that can overwrite or escape the configured output directory. */
export async function validateScreenshotFilename(outputDirectory: string, value: unknown) {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim() === "" || isAbsolute(value)) {
    throw invalidScreenshotFilename(value);
  }

  const outputDir = resolve(outputDirectory);
  const target = resolve(outputDir, value);
  const relativeTarget = relative(outputDir, target);
  if (
    relativeTarget === "" ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw invalidScreenshotFilename(value);
  }

  try {
    await lstat(target);
    throw new UobError("INVALID_ARGUMENT", `The screenshot target already exists: ${value}.`, {
      remediation: "Choose a new relative filename inside the configured screenshot directory.",
      details: { filename: value },
    });
  } catch (error) {
    if (error instanceof UobError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // Existing symlinked parents can redirect an approved relative path outside
  // outputDir, including when the final parent does not exist yet.
  const [realOutputDir, realParent] = await Promise.all([
    nearestRealPath(outputDir),
    nearestRealPath(dirname(target)),
  ]);
  const relativeParent = relative(realOutputDir, realParent);
  if (
    relativeParent === ".." ||
    relativeParent.startsWith(`..${sep}`) ||
    isAbsolute(relativeParent)
  ) {
    throw invalidScreenshotFilename(value);
  }
}

export interface ProxiedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/**
 * Give the upstream server a context that contains only the approved page.
 *
 * Playwright MCP keeps its own current-tab state. Passing the real context lets
 * that state move to any Obsidian window. The facade preserves context operations
 * but hides every other page and suppresses later page events.
 */
export function contextForPage(context: BrowserContext, page?: Page): BrowserContext {
  let facade: BrowserContext;
  facade = new Proxy(context, {
    get(target, property) {
      if (property === "pages") return () => (page === undefined ? [] : [page]);
      if (property === "newPage") {
        return async () => {
          throw new UobError(
            "INVALID_ARGUMENT",
            "Knapper does not allow the browser backend to create a new page.",
            {
              remediation:
                "Open the window in Obsidian, then select an authorized target from obsidian_list_targets.",
              fixedBy: "obsidian_list_targets",
            },
          );
        };
      }
      if (property === "browser") return () => null;

      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;

      if (
        property === "on" ||
        property === "addListener" ||
        property === "once" ||
        property === "off" ||
        property === "removeListener"
      ) {
        return (event: unknown, ...args: unknown[]) => {
          if (event === "page") return facade;
          return Reflect.apply(value, target, [event, ...args]) as unknown;
        };
      }

      return (...args: unknown[]) => Reflect.apply(value, target, args) as unknown;
    },
  });
  return facade;
}

const FALLBACK_PROPERTIES = {
  target: { type: "string" },
  element: { type: "string" },
  text: { type: "string" },
  regex: { type: "string" },
  function: { type: "string" },
  filename: { type: "string" },
  key: { type: "string" },
  action: { type: "string" },
  level: { type: "string" },
  type: { type: "string" },
  scale: { type: "string" },
  button: { type: "string" },
  promptText: { type: "string" },
  startTarget: { type: "string" },
  startElement: { type: "string" },
  endTarget: { type: "string" },
  endElement: { type: "string" },
  doubleClick: { type: "boolean" },
  accept: { type: "boolean" },
  all: { type: "boolean" },
  fullPage: { type: "boolean" },
  boxes: { type: "boolean" },
  depth: { type: "number" },
  time: { type: "number" },
  x: { type: "number" },
  y: { type: "number" },
  deltaX: { type: "number" },
  deltaY: { type: "number" },
  values: { type: "array", items: { type: "string" } },
  modifiers: { type: "array", items: { type: "string" } },
  paths: { type: "array", items: { type: "string" } },
  fields: { type: "array", items: { type: "object" } },
  data: { type: "object" },
} satisfies Record<string, unknown>;

const DESCRIBED_FALLBACK_PROPERTIES = Object.fromEntries(
  Object.entries(FALLBACK_PROPERTIES).map(([name, schema]) => [
    name,
    { ...schema, description: `Fallback Playwright argument: ${name}.` },
  ]),
);

/** Stable degraded-mode descriptors; upstream validates the same args again on call. */
function fallbackTools(): ProxiedTool[] {
  return [...ALLOWED_BROWSER_TOOLS].sort().map((name) => ({
    name,
    description: `Playwright browser operation ${name}.`,
    inputSchema: { type: "object", properties: DESCRIBED_FALLBACK_PROPERTIES },
  }));
}

export class BrowserProxy {
  private client?: Client;
  private tools?: ProxiedTool[];
  private initializing?: Promise<void>;
  private proxiedTargetId?: string;
  private proxiedPage?: Page;
  private callTail: Promise<void> = Promise.resolve();

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
    const session = this.router.playwright;
    this.router.claimDebugger("playwright");

    const context = await session.connect();
    const { client, tools } = await this.createClient(contextForPage(context));

    this.client = client;
    this.tools = tools;
    this.logger.info(`browser proxy ready with ${tools.length} tools`);
  }

  private async createClient(
    context: BrowserContext,
  ): Promise<{ client: Client; tools: ProxiedTool[] }> {
    const { createConnection } = await import("@playwright/mcp");
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

    const client = new Client({ name: "knapper", version: "0.1.0" });
    await client.connect(clientTransport);

    const listed = await client.listTools();
    const tools = listed.tools
      .filter((t) => isAllowedBrowserTool(t.name))
      .map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.inputSchema as Record<string, unknown>,
        ...(t.outputSchema !== undefined
          ? { outputSchema: t.outputSchema as Record<string, unknown> }
          : {}),
      }));

    const skipped = listed.tools.filter(
      (t) => !isAllowedBrowserTool(t.name) && !BLOCKED_BROWSER_TOOLS.has(t.name),
    );
    if (skipped.length > 0) {
      this.logger.debug("upstream tools not on ui allowlist", {
        names: skipped.map((t) => t.name),
      });
    }

    this.logger.debug("browser proxy client created", {
      exposed: tools.length,
      upstream: listed.tools.length,
      blocked: listed.tools.filter((t) => BLOCKED_BROWSER_TOOLS.has(t.name)).length,
    });
    return { client, tools };
  }

  /** The allowlisted tool descriptors, or an empty list when unavailable. */
  async listTools(): Promise<ProxiedTool[]> {
    try {
      await this.init();
      return this.tools ?? fallbackTools();
    } catch (e) {
      this.logger.debug("using degraded browser descriptors", {
        error: e instanceof Error ? e.message : String(e),
      });
      return fallbackTools();
    }
  }

  /**
   * Point the proxied server at the window knapper is pinned to.
   *
   * The proxy gets a new single-page context facade for the pinned CDP target.
   * Best effort: a failure here must not take down the attach call, which still
   * succeeds for the native layer.
   */
  async selectPinnedPage(): Promise<boolean> {
    return this.serialized(async () => {
      try {
        if (!(await this.init()) || !this.client) return false;
        const page = await this.router.playwright.page();
        return await this.pointProxyAt(page);
      } catch (e) {
        this.logger.warn("could not point the browser proxy at the pinned window", {
          error: e instanceof Error ? e.message : String(e),
        });
        return false;
      }
    });
  }

  /**
   * Bind upstream to `page` and no other page.
   *
   * Returns false rather than throwing so `obsidian_attach` can report partial
   * success, but `callTool` treats false as a refusal. Forwarding any operation to
   * whatever tab the proxy happened to latch onto is the failure mode this exists
   * to prevent.
   */
  private async pointProxyAt(page: Page): Promise<boolean> {
    try {
      const targetId = await this.router.playwright.targetIdFor(page);
      if (targetId === undefined || !(await this.router.playwright.isPageAuthorized(page))) {
        return false;
      }

      if (this.client && this.proxiedTargetId === targetId && this.proxiedPage === page) {
        return true;
      }

      const context = await this.router.playwright.connect();
      const oldClient = this.client;
      this.client = undefined;
      this.proxiedTargetId = undefined;
      this.proxiedPage = undefined;
      if (oldClient) await oldClient.close().catch(() => undefined);

      const created = await this.createClient(contextForPage(context, page));
      this.client = created.client;
      this.tools ??= created.tools;

      // Re-resolve after the asynchronous rebuild. This detects a closed window,
      // a changed pin, or a vault switch before any proxied operation can run.
      const verifiedPage = await this.router.playwright.page();
      const verifiedTargetId = await this.router.playwright.targetIdFor(verifiedPage);
      if (verifiedTargetId !== targetId || !(await this.router.playwright.isPageAuthorized(page))) {
        await created.client.close().catch(() => undefined);
        this.client = undefined;
        return false;
      }

      this.proxiedTargetId = targetId;
      this.proxiedPage = page;
      this.logger.debug("browser proxy retargeted", { targetId });
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

    return this.serialized(() => this.callToolLocked(name, args));
  }

  private async callToolLocked(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (name === "browser_take_screenshot") {
      await validateScreenshotFilename(this.config.outputDir, args.filename);
    }

    const availability = await this.router.refreshAvailability();
    if (!availability.playwright) {
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

    // Keep the most common keyboard path out of the upstream tab manager. Its
    // first-tab initialization can leave Electron's renderer focus state active
    // after the input call, even though the OS window never came to the front.
    if (name === "browser_press_key") {
      const key = args.key;
      if (typeof key !== "string" || key === "") {
        throw new UobError("INVALID_ARGUMENT", "key is required.", {
          remediation: "Pass a Playwright key name or chord, such as Escape or Control+p.",
        });
      }
      const page = await this.router.playwright.page();
      await this.router.focus.run(page, () => page.keyboard.press(key));
      return { content: [{ type: "text", text: `Pressed ${key}.` }] };
    }

    const ready = await this.init();
    if (!ready || !this.client) {
      throw new UobError(
        "CDP_PORT_CLOSED",
        `Browser automation is unavailable: no CDP endpoint at ${this.config.cdpUrl}.`,
        {
          remediation: "Cold-start Obsidian with the debug port, then retry the same browser tool.",
          fixedBy: "obsidian_launch",
          details: { tool: name },
        },
      );
    }

    /**
     * Every call needs the fence and an exact target. Real input also needs focus
     * emulation. These controls stay here because the upstream server accepts a
     * shared BrowserContext and otherwise keeps independent current-tab state.
     */
    const call = async (): Promise<CallToolResult> => {
      const page = await this.router.playwright.page();
      if (!(await this.pointProxyAt(page))) {
        throw new UobError(
          "TARGET_NOT_FOUND",
          `Refusing to run ${name}: could not point the browser proxy at the authorized window.`,
          {
            remediation:
              "The window may have closed or switched vaults. Take a fresh " +
              "browser_snapshot and retry. knapper will not forward a browser call without first " +
              "confirming which window will receive it.",
            fixedBy: "obsidian_list_targets",
            details: { tool: name },
          },
        );
      }

      const forward = async (): Promise<CallToolResult> =>
        this.client!.callTool({
          name,
          arguments:
            name === "browser_take_screenshot"
              ? Object.fromEntries(
                  Object.entries(stripUndefined(args)).filter(([key]) => key !== "filename"),
                )
              : stripUndefined(args),
        }) as Promise<CallToolResult>;

      if (!isInputBrowserTool(name)) {
        const result = await forward();
        if (name !== "browser_take_screenshot" || result.isError) return result;
        const image = result.content.find((part) => part.type === "image");
        if (image?.type !== "image") {
          throw new UobError("APP_UNAVAILABLE", "The browser screenshot returned no image.", {
            remediation: "Take a fresh browser snapshot, then retry the screenshot.",
          });
        }
        const extension = image.mimeType === "image/jpeg" ? "jpg" : "png";
        const file = await saveArtifact(
          this.config.outputDir,
          typeof args.filename === "string" ? args.filename : undefined,
          `browser-${Date.now()}.${extension}`,
          Buffer.from(image.data, "base64"),
          image.mimeType,
        );
        return {
          content: [{ type: "text", text: `Browser screenshot saved to ${file.path}` }],
          structuredContent: file,
        };
      }
      return this.router.focus.run(page, forward);
    };

    try {
      return await call();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (name === "browser_click" && CLICK_TIMEOUT.test(message)) {
        const text = await clickTarget(this.router, args);
        return { content: [{ type: "text", text }] };
      }
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
    this.proxiedTargetId = undefined;
    this.proxiedPage = undefined;
    if (client) await client.close().catch(() => undefined);
    this.router.releaseDebugger("playwright");
  }

  /** Serialize upstream's mutable page state across shared and exclusive tools. */
  private async serialized<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.callTail;
    let release = (): void => undefined;
    this.callTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
    }
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
