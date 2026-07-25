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

function makeCapture(context: ReturnType<typeof fakeContext>) {
  const store = new TelemetryStore(100);
  const router = {
    refreshAvailability: vi.fn().mockResolvedValue({ playwright: true }),
    claimDebugger: vi.fn(),
    playwright: {
      connect: vi.fn().mockResolvedValue(context),
    },
  };
  const capture = new TelemetryCapture(router as never, store, createLogger("silent"));
  return { capture, router, store, context };
}

describe("TelemetryCapture.arm", () => {
  it("does not double-subscribe console listeners on a second arm", async () => {
    const page = fakePage();
    const context = fakeContext([page]);
    const { capture } = makeCapture(context);

    await capture.arm();
    await capture.arm();

    expect(page.listenerCount("console")).toBe(1);
    expect(context.listenerCount("page")).toBe(1);
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
});
