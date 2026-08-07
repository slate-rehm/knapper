import { describe, expect, it, vi } from "vitest";
import { TelemetryCapture } from "../../src/telemetry/capture.js";
import { TelemetryStore } from "../../src/telemetry/store.js";
import { createLogger } from "../../src/util/logger.js";

/**
 * TelemetryCapture's seam bugs are about *when* listeners attach, not about
 * Playwright itself. These tests drive a fake context/page so a wrong WeakSet /
 * armed-flag interaction fails the assertion.
 */

function fakePage() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    isClosed: () => false,
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    listenerCount(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
    emit(event: string, value?: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(value);
    },
  };
}

function fakeContext(pages: ReturnType<typeof fakePage>[]) {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    pages: () => pages,
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    },
    listenerCount(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

function makeCapture(
  context: ReturnType<typeof fakeContext>,
  pageAuthorized: boolean | (() => boolean | Promise<boolean>) = true,
) {
  const store = new TelemetryStore(100);
  const isPageAuthorized = vi
    .fn()
    .mockImplementation(() =>
      typeof pageAuthorized === "function" ? pageAuthorized() : Promise.resolve(pageAuthorized),
    );
  const router = {
    refreshAvailability: vi.fn().mockResolvedValue({ playwright: true }),
    claimDebugger: vi.fn(),
    playwright: {
      connect: vi.fn().mockResolvedValue(context),
      isPageAuthorized,
    },
  };
  const capture = new TelemetryCapture(router as never, store, createLogger("silent"));
  return { capture, router, store, context, isPageAuthorized };
}

describe("TelemetryCapture.arm — the vault fence", () => {
  it("REFUSES to wire a window whose vault is not authorized", async () => {
    // Console lines and page errors quote note titles and file contents, so an
    // unauthorized window's stream would exfiltrate exactly what the fence blocks
    // on the tool surface.
    const page = fakePage();
    const context = fakeContext([page]);
    const { capture } = makeCapture(context, false);

    const result = await capture.arm();

    expect(page.listenerCount("console")).toBe(0);
    expect(page.listenerCount("pageerror")).toBe(0);
    expect(result.pages).toBe(0);
  });

  it("still reports itself armed so a later authorized window gets wired", async () => {
    const page = fakePage();
    const context = fakeContext([page]);
    const { capture } = makeCapture(context, false);

    const result = await capture.arm();

    expect(result.armed).toBe(true);
    expect(context.listenerCount("page")).toBe(1);
  });

  it("fails closed when the authorization lookup throws", async () => {
    const page = fakePage();
    const context = fakeContext([page]);
    const { capture } = makeCapture(context, () => {
      throw new Error("authorization unavailable");
    });

    const result = await capture.arm();

    expect(result).toEqual({ armed: true, pages: 0 });
    expect(page.listenerCount("console")).toBe(0);
  });

  it("drops events after a subscribed page loses authorization", async () => {
    let authorized = true;
    const page = fakePage();
    const context = fakeContext([page]);
    const { capture, store, isPageAuthorized } = makeCapture(context, () => authorized);
    await capture.arm();
    authorized = false;

    page.emit("pageerror", new Error("private note title"));
    await vi.waitFor(() => expect(isPageAuthorized).toHaveBeenCalledTimes(3));

    expect(store.query().records).toEqual([]);
  });

  it("drops events from listeners retained after capture resets", async () => {
    const page = fakePage();
    const context = fakeContext([page]);
    const { capture, store, isPageAuthorized } = makeCapture(context);
    await capture.arm();
    const checksBeforeReset = isPageAuthorized.mock.calls.length;

    capture.reset();
    page.emit("pageerror", new Error("old session content"));

    expect(store.query().records).toEqual([]);
    expect(isPageAuthorized).toHaveBeenCalledTimes(checksBeforeReset);
  });
});

describe("TelemetryCapture.arm", () => {
  it("does not double-subscribe console listeners on a second arm", async () => {
    const page = fakePage();
    const context = fakeContext([page]);
    const { capture } = makeCapture(context);

    const first = await capture.arm();
    const second = await capture.arm();

    expect(first.pages).toBe(1);
    expect(second.pages).toBe(1);
    expect(page.listenerCount("console")).toBe(1);
    expect(context.listenerCount("page")).toBe(1);
  });

  it("reports only subscriptions that remain authorized", async () => {
    let authorized = true;
    const page = fakePage();
    const context = fakeContext([page]);
    const { capture } = makeCapture(context, () => authorized);

    expect((await capture.arm()).pages).toBe(1);
    authorized = false;
    expect((await capture.arm()).pages).toBe(0);
  });

  it("wires network listeners when network is enabled after a plain arm", async () => {
    // Previously wirePage bailed on WeakSet hit, so arm({network:true}) after
    // arm() left network capture silently dead while isNetworkEnabled flipped true.
    const page = fakePage();
    const context = fakeContext([page]);
    const { capture } = makeCapture(context);

    await capture.arm();
    expect(page.listenerCount("requestfailed")).toBe(0);

    await capture.arm({ network: true });
    expect(capture.isNetworkEnabled).toBe(true);
    expect(page.listenerCount("requestfailed")).toBe(1);
    expect(page.listenerCount("response")).toBe(1);
    // Console listeners must still be single.
    expect(page.listenerCount("console")).toBe(1);
  });

  it("re-subscribes the context page listener after a reconnect to a new context", async () => {
    const page1 = fakePage();
    const context1 = fakeContext([page1]);
    const { capture, router } = makeCapture(context1);

    await capture.arm();
    expect(context1.listenerCount("page")).toBe(1);

    const page2 = fakePage();
    const context2 = fakeContext([page2]);
    router.playwright.connect.mockResolvedValue(context2);

    await capture.arm();
    expect(context2.listenerCount("page")).toBe(1);
    expect(page2.listenerCount("console")).toBe(1);
  });

  it("re-wires the same pages after availability drops and returns", async () => {
    const page = fakePage();
    const context = fakeContext([page]);
    const { capture, router, store } = makeCapture(context);

    await capture.arm();
    router.refreshAvailability.mockResolvedValueOnce({ playwright: false });
    await capture.arm();
    await capture.arm();
    page.emit("pageerror", new Error("after reconnect"));
    await vi.waitFor(() => expect(store.query().records).toHaveLength(1));

    expect(store.query().records[0]?.text).toContain("after reconnect");
  });
});
