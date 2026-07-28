import { describe, expect, it, vi } from "vitest";
import { FocusEmulator } from "../../src/browser/focus.js";
import { createLogger } from "../../src/util/logger.js";

/**
 * The failure mode this guards is not "input did not work" — it is emulation left
 * switched on. knapper attaches to the user's daily-driver Obsidian, so a leaked
 * override makes their window behave as permanently focused for the rest of the
 * session, which is the exact thing `noDefaults: true` exists to prevent.
 *
 * A fake CDP session records the command sequence, because ordering is the whole
 * contract: ignore-input off, emulation on, dispatch, emulation off.
 */

function fakeSession(opts: { failOn?: string } = {}) {
  const sent: Array<{ method: string; params?: unknown }> = [];
  let detached = 0;
  const cdp = {
    send: vi.fn(async (method: string, params?: unknown) => {
      if (opts.failOn === method) throw new Error(`${method} unsupported`);
      sent.push({ method, params });
    }),
    detach: vi.fn(async () => {
      detached += 1;
    }),
  };
  const session = { cdpSessionFor: vi.fn(async () => cdp) };
  return {
    session,
    sent,
    enabledCalls: () =>
      sent
        .filter((s) => s.method === "Emulation.setFocusEmulationEnabled")
        .map((s) => (s.params as { enabled: boolean }).enabled),
    detachCount: () => detached,
  };
}

const page = () => ({}) as never;
const emulator = (f: ReturnType<typeof fakeSession>) =>
  new FocusEmulator(f.session as never, createLogger("silent"));

describe("FocusEmulator.run", () => {
  it("enables emulation around the dispatch and disables it after", async () => {
    const f = fakeSession();
    await emulator(f).run(page(), async () => undefined);

    expect(f.sent.map((s) => s.method)).toEqual([
      "Input.setIgnoreInputEvents",
      "Emulation.setFocusEmulationEnabled",
      "Emulation.setFocusEmulationEnabled",
    ]);
    expect(f.enabledCalls()).toEqual([true, false]);
  });

  it("reverts even when the wrapped input throws", async () => {
    const f = fakeSession();
    await expect(
      emulator(f).run(page(), async () => {
        throw new Error("click failed");
      }),
    ).rejects.toThrow("click failed");

    expect(f.enabledCalls()).toEqual([true, false]);
  });

  it("does not toggle emulation off while another holder still wants it", async () => {
    const f = fakeSession();
    const e = emulator(f);
    const p = page();

    const outer = await e.acquire(p);
    await e.run(p, async () => undefined);
    // The nested run must not have switched it off underneath the outer hold.
    expect(f.enabledCalls()).toEqual([true]);

    await outer();
    expect(f.enabledCalls()).toEqual([true, false]);
  });

  it("degrades to a no-op when the runtime does not support focus emulation", async () => {
    // Input that only works in the foreground is worse than input that works
    // everywhere, but far better than every input tool failing outright.
    const f = fakeSession({ failOn: "Emulation.setFocusEmulationEnabled" });
    const ran = vi.fn();

    await emulator(f).run(page(), async () => {
      ran();
    });

    expect(ran).toHaveBeenCalledOnce();
    expect(f.detachCount()).toBe(1);
  });
});

describe("FocusEmulator held keys", () => {
  it("keeps emulation on between browser_keydown and browser_keyup", async () => {
    const f = fakeSession();
    const e = emulator(f);
    const p = page();

    e.trackHeldKey(p, "Shift", await e.acquire(p));
    expect(f.enabledCalls()).toEqual([true]);

    await e.releaseHeldKey(p, "Shift");
    expect(f.enabledCalls()).toEqual([true, false]);
  });

  it("does not stack holds when the same key is pressed twice", async () => {
    // Two downs and one up previously left a hold outstanding forever.
    const f = fakeSession();
    const e = emulator(f);
    const p = page();

    e.trackHeldKey(p, "Control", await e.acquire(p));
    e.trackHeldKey(p, "Control", await e.acquire(p));
    await e.releaseHeldKey(p, "Control");
    await new Promise((r) => setTimeout(r, 0));

    expect(f.enabledCalls()).toEqual([true, false]);
  });

  it("releases an unpaired keydown on dispose", async () => {
    const f = fakeSession();
    const e = emulator(f);
    const p = page();

    e.trackHeldKey(p, "Meta", await e.acquire(p));
    await e.dispose();

    expect(f.enabledCalls().at(-1)).toBe(false);
    expect(f.detachCount()).toBe(1);
  });

  it("ignores a keyup for a key that was never held", async () => {
    const f = fakeSession();
    await expect(emulator(f).releaseHeldKey(page(), "Shift")).resolves.toBeUndefined();
  });
});
