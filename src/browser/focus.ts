/**
 * Scoped focus emulation, so input lands in an Obsidian window that is not the
 * foreground window.
 *
 * Chromium routes synthetic input through the renderer, but a page that believes
 * it is unfocused behaves accordingly: `document.hasFocus()` is false, CodeMirror
 * parks its cursor, Obsidian drops `.is-focused`, and hotkey handlers gated on
 * focus never fire. `Emulation.setFocusEmulationEnabled` flips that belief.
 *
 * Playwright can do this for us — it is one of the defaults `noDefaults: true`
 * turns off in `cdp/session.ts` — but it applies the flag permanently and
 * context-wide, which leaves the user's live Obsidian behaving as though it always
 * has focus. So we opt out there and re-enable it here for the duration of a single
 * dispatch, reverting in a `finally`. Scope is the whole difference.
 *
 * Deliberately absent: `Page.bringToFront`. It raises and activates the OS window,
 * which is exactly what a tool driving someone's daily-driver notes app must never
 * do. Emulation alone is enough for renderer-level input, which is every Obsidian
 * hotkey; the app-level Electron menu accelerators it cannot reach are unreachable
 * by any CDP input, foreground or not.
 *
 * That refusal is also what makes concurrent sessions possible at the input layer.
 * Focus emulation is renderer-scoped, so N agents can each hold it on their own
 * window simultaneously and the refcounts below never collide — each process owns a
 * disjoint set of Pages on a disjoint browser. Raising an OS window is a genuinely
 * global act with no per-session equivalent: adding `bringToFront` would make every
 * session fight over the desktop's single foreground slot.
 */

import type { CDPSession, Page } from "playwright-core";
import type { Logger } from "../util/logger.js";
import type { PlaywrightSession } from "../connection/cdp/session.js";

interface PageFocusState {
  cdp: CDPSession;
  /**
   * How many holders currently want emulation on. `browser_keydown` and
   * `browser_keyup` are a pair spanning two tool calls, so the hold has to outlive
   * a single dispatch without a concurrent reader switching it off underneath.
   */
  depth: number;
}

export class FocusEmulator {
  private states = new Map<Page, PageFocusState>();
  /** Per-page holds parked by browser_keydown, keyed by the key still held down. */
  private heldKeys = new Map<Page, Map<string, () => Promise<void>>>();
  private warnedUnsupported = false;

  constructor(
    private readonly session: PlaywrightSession,
    private readonly logger: Logger,
  ) {}

  /**
   * Chromium reverts a session's emulation overrides when that session detaches,
   * so the session is cached per page and held open rather than attached per call.
   */
  private async stateFor(page: Page): Promise<PageFocusState> {
    const existing = this.states.get(page);
    if (existing) return existing;
    const cdp = await this.session.cdpSessionFor(page);
    const state: PageFocusState = { cdp, depth: 0 };
    this.states.set(page, state);
    return state;
  }

  /**
   * Turn emulation on for `page`, returning a release function.
   *
   * Never throws on the enable path. If a runtime does not support these commands
   * the right outcome is input that still works when the window happens to be
   * focused, not every input tool failing — background input is an improvement
   * here, not a precondition.
   */
  async acquire(page: Page): Promise<() => Promise<void>> {
    let state: PageFocusState;
    try {
      state = await this.stateFor(page);
    } catch (e) {
      this.warnUnsupported(e);
      return async () => undefined;
    }

    if (state.depth === 0) {
      try {
        // Electron can be ignoring input entirely; clear that before dispatching.
        await state.cdp.send("Input.setIgnoreInputEvents", { ignore: false });
        await state.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      } catch (e) {
        this.warnUnsupported(e);
        this.states.delete(page);
        await state.cdp.detach().catch(() => undefined);
        return async () => undefined;
      }
    }
    state.depth += 1;

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await this.release(page);
    };
  }

  /**
   * Drop one hold, disabling emulation when the last one goes.
   *
   * Never throws: this runs in a `finally`, and a teardown failure must not
   * replace the error from the input it was wrapping.
   */
  private async release(page: Page): Promise<void> {
    const state = this.states.get(page);
    if (!state) return;
    state.depth = Math.max(0, state.depth - 1);
    if (state.depth > 0) return;
    try {
      await state.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    } catch {
      // Page closed, or the session went away with the window. Either way the
      // override died with it.
    }
  }

  /** Run `fn` with `page` emulating focus, reverting even when `fn` throws. */
  async run<T>(page: Page, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(page);
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  /**
   * Park a hold against a physically held key.
   *
   * `browser_keydown` and `browser_keyup` bracket a modifier across two tool calls,
   * so the emulation hold has to survive between them. Re-pressing a key that is
   * already down releases the previous hold rather than stacking a second one,
   * which is what leaked emulation in the obvious retry loop.
   */
  trackHeldKey(page: Page, key: string, release: () => Promise<void>): void {
    let held = this.heldKeys.get(page);
    if (!held) {
      held = new Map();
      this.heldKeys.set(page, held);
    }
    const previous = held.get(key);
    if (previous) void previous().catch(() => undefined);
    held.set(key, release);
  }

  /** Release the hold for a key. No-op when the key was never tracked. */
  async releaseHeldKey(page: Page, key: string): Promise<void> {
    const held = this.heldKeys.get(page);
    const release = held?.get(key);
    if (!held || !release) return;
    held.delete(key);
    if (held.size === 0) this.heldKeys.delete(page);
    await release().catch(() => undefined);
  }

  /**
   * Force every hold off. Called when the CDP connection drops and on shutdown, so
   * a `browser_keydown` with no matching `browser_keyup` cannot leave the user's
   * window emulating focus for the rest of its life.
   */
  async dispose(): Promise<void> {
    const holds = [...this.heldKeys.values()].flatMap((m) => [...m.values()]);
    this.heldKeys.clear();
    await Promise.all(holds.map((release) => release().catch(() => undefined)));

    const states = [...this.states.values()];
    this.states.clear();
    await Promise.all(
      states.map(async (state) => {
        try {
          if (state.depth > 0) {
            await state.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
          }
        } catch {
          // best effort
        }
        await state.cdp.detach().catch(() => undefined);
      }),
    );
  }

  private warnUnsupported(e: unknown): void {
    if (this.warnedUnsupported) return;
    this.warnedUnsupported = true;
    this.logger.warn(
      "focus emulation unavailable; input will only land while Obsidian is the foreground window",
      { error: e instanceof Error ? e.message : String(e) },
    );
  }
}
