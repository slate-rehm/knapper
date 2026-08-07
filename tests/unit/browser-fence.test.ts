import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_BROWSER_TOOLS,
  BLOCKED_BROWSER_TOOLS,
  INPUT_BROWSER_TOOLS,
} from "../../src/browser/allowlist.js";
import { BrowserProxy, contextForPage } from "../../src/browser/proxy.js";
import { PlaywrightSession, safeWindowSummary } from "../../src/connection/cdp/session.js";
import { createLogger } from "../../src/util/logger.js";

const REMOVED_TOOLS = [
  "browser_evaluate",
  "browser_tabs",
  "browser_console_messages",
  "browser_find",
  "browser_generate_locator",
  "browser_verify_element_visible",
  "browser_verify_list_visible",
  "browser_verify_text_visible",
  "browser_verify_value",
];

describe("browser tool allowlist", () => {
  it("does not expose unsafe or redundant browser tools", () => {
    for (const name of REMOVED_TOOLS) {
      expect(ALLOWED_BROWSER_TOOLS.has(name)).toBe(false);
      expect(BLOCKED_BROWSER_TOOLS.has(name)).toBe(true);
    }
  });

  it("keeps every input tool on the public allowlist", () => {
    for (const name of INPUT_BROWSER_TOOLS) {
      expect(ALLOWED_BROWSER_TOOLS.has(name)).toBe(true);
    }
  });
});

describe("browser context facade", () => {
  it("does not expose page creation or the owning browser", async () => {
    const approvedPage = {};
    const context = {
      pages: () => [approvedPage, {}],
      newPage: vi.fn(async () => ({})),
      browser: vi.fn(() => ({ contexts: () => [context] })),
    } as never;
    const facade = contextForPage(context, approvedPage as never);

    expect(facade.pages()).toEqual([approvedPage]);
    expect(facade.browser()).toBeNull();
    await expect(facade.newPage()).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(context.newPage).not.toHaveBeenCalled();
  });
});

describe("safeWindowSummary", () => {
  const window = {
    targetId: "target-7",
    kind: "main" as const,
    title: "Secret note - Private vault - Obsidian 1.12.7",
    url: "file:///private/vault/Secret%20note.md",
    vaultName: "Private vault",
  };

  it("removes all renderer metadata for an unauthorized window", () => {
    expect(safeWindowSummary(window, false)).toEqual({
      targetId: "target-7",
      kind: "main",
      authorized: false,
    });
  });

  it("keeps renderer metadata for an authorized window", () => {
    expect(safeWindowSummary(window, true)).toEqual({
      ...window,
      authorized: true,
    });
  });
});

describe("PlaywrightSession window privacy", () => {
  function sessionFixture(authorized: boolean) {
    const page = {};
    const isVaultAuthorized = vi.fn(async () => authorized);
    const session = new PlaywrightSession({
      cdpUrl: "http://127.0.0.1:9222",
      resolveVault: vi.fn(async () => ({ name: "Authorized vault" })),
      isVaultAuthorized,
      logger: createLogger("silent"),
    });
    vi.spyOn(session, "windows").mockResolvedValue([
      {
        page: page as never,
        kind: "main",
        title: "Secret note - Private vault - Obsidian 1.12.7",
        url: "file:///private/vault/Secret%20note.md",
        vaultName: "Private vault",
      },
    ]);
    vi.spyOn(session, "targetIdFor").mockResolvedValue("target-7");
    vi.spyOn(session, "vaultNameOf").mockResolvedValue("Private vault");
    return { session, isVaultAuthorized };
  }

  it("applies authorization before it returns window metadata", async () => {
    const { session, isVaultAuthorized } = sessionFixture(false);

    expect(await session.windowSummaries()).toEqual([
      { targetId: "target-7", kind: "main", authorized: false },
    ]);
    expect(isVaultAuthorized).toHaveBeenCalledWith("Private vault");
  });

  it("does not put an unauthorized vault name in a pinned-page refusal", async () => {
    const { session } = sessionFixture(false);
    session.attachTo("target-7");

    let failure: unknown;
    try {
      await session.page();
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "VAULT_NOT_AUTHORIZED" });
    expect(JSON.stringify(failure)).not.toContain("Private vault");
    expect(String(failure)).not.toContain("Private vault");
  });
});

function proxyFixture(authorized: boolean) {
  const page = {};
  const upstreamCall = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  const focusRun = vi.fn(async (_page: unknown, call: () => Promise<unknown>) => call());
  const playwright = {
    page: vi.fn(async () => page),
    targetIdFor: vi.fn(async () => "target-1"),
    isPageAuthorized: vi.fn(async () => authorized),
  };
  const router = {
    playwright,
    focus: { run: focusRun },
    refreshAvailability: vi.fn(async () => ({ playwright: true })),
  };
  const proxy = new BrowserProxy(
    { cdpUrl: "http://127.0.0.1:9222" } as never,
    router as never,
    createLogger("silent"),
  );
  Reflect.set(proxy, "client", { callTool: upstreamCall });
  Reflect.set(proxy, "proxiedTargetId", "target-1");
  Reflect.set(proxy, "proxiedPage", page);
  return { proxy, playwright, upstreamCall, focusRun };
}

describe("BrowserProxy fencing", () => {
  it("authorizes and targets read calls before forwarding", async () => {
    const fixture = proxyFixture(true);

    await fixture.proxy.callTool("browser_snapshot", {});

    expect(fixture.playwright.page).toHaveBeenCalledOnce();
    expect(fixture.playwright.targetIdFor).toHaveBeenCalledWith(
      await fixture.playwright.page.mock.results[0]?.value,
    );
    expect(fixture.playwright.isPageAuthorized).toHaveBeenCalledOnce();
    expect(fixture.upstreamCall).toHaveBeenCalledOnce();
    expect(fixture.focusRun).not.toHaveBeenCalled();
  });

  it("fails closed before a read reaches an unauthorized page", async () => {
    const fixture = proxyFixture(false);

    await expect(fixture.proxy.callTool("browser_snapshot", {})).rejects.toMatchObject({
      code: "TARGET_NOT_FOUND",
    });

    expect(fixture.upstreamCall).not.toHaveBeenCalled();
  });

  it("keeps focus emulation around allowed input", async () => {
    const fixture = proxyFixture(true);

    await fixture.proxy.callTool("browser_click", { target: "e1" });

    expect(fixture.focusRun).toHaveBeenCalledOnce();
    expect(fixture.upstreamCall).toHaveBeenCalledWith({
      name: "browser_click",
      arguments: { target: "e1" },
    });
  });
});
