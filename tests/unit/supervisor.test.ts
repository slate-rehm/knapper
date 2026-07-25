import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffDelay,
  ConnectionSupervisor,
  type SupervisedSession,
} from "../../src/connection/supervisor.js";
import type { Logger } from "../../src/util/logger.js";

interface RecordedLog {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
}

function recordingLogger(): { logger: Logger; entries: RecordedLog[] } {
  const entries: RecordedLog[] = [];
  const make = (): Logger => ({
    debug: (msg) => entries.push({ level: "debug", msg }),
    info: (msg) => entries.push({ level: "info", msg }),
    warn: (msg) => entries.push({ level: "warn", msg }),
    error: (msg) => entries.push({ level: "error", msg }),
    child: () => make(),
  });
  return { logger: make(), entries };
}

/** A session whose liveness the test flips at will, counting probes. */
function fakeSession(alive: boolean): SupervisedSession & { alive: boolean; probes: number } {
  return {
    alive,
    probes: 0,
    async healthCheck() {
      this.probes += 1;
      return this.alive;
    },
  };
}

describe("backoffDelay", () => {
  it("doubles from the seed and stops at the cap", () => {
    const noJitter = () => 0.5;
    expect(backoffDelay(2000, 0, 30_000, noJitter)).toBe(2000);
    expect(backoffDelay(2000, 1, 30_000, noJitter)).toBe(4000);
    expect(backoffDelay(2000, 4, 30_000, noJitter)).toBe(30_000);
    expect(backoffDelay(2000, 40, 30_000, noJitter)).toBe(30_000);
  });

  it("applies bounded jitter in both directions", () => {
    expect(backoffDelay(1000, 0, 30_000, () => 0)).toBe(800);
    expect(backoffDelay(1000, 0, 30_000, () => 1)).toBe(1200);
  });

  it("never returns a delay that would spin hot", () => {
    expect(backoffDelay(0, 0, 30_000, () => 0)).toBeGreaterThan(0);
  });
});

describe("ConnectionSupervisor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports attached and logs the transition once", async () => {
    const session = fakeSession(true);
    const { logger, entries } = recordingLogger();
    const sup = new ConnectionSupervisor({
      session,
      logger,
      reconnectMs: 100,
      probeIntervalMs: 500,
      random: () => 0.5,
    });

    sup.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(sup.connectionState).toBe("attached");

    await vi.advanceTimersByTimeAsync(1500);
    expect(session.probes).toBeGreaterThan(2);
    // Routine healthy probes must not be announced; only the transition is.
    expect(entries.filter((e) => e.level === "info")).toHaveLength(1);
    sup.stop();
  });

  it("backs off exponentially instead of spinning while Obsidian is down", async () => {
    const session = fakeSession(false);
    const { logger, entries } = recordingLogger();
    const sup = new ConnectionSupervisor({
      session,
      logger,
      reconnectMs: 100,
      maxDelayMs: 1000,
      random: () => 0.5,
    });

    sup.start();
    await vi.advanceTimersByTimeAsync(10_000);

    // Fixed-interval retries at the 100ms seed would be 100 probes in 10s.
    expect(session.probes).toBeLessThan(20);
    expect(sup.connectionState).toBe("detached");
    // A server started before Obsidian must stay quiet.
    expect(entries.filter((e) => e.level === "warn" || e.level === "error")).toHaveLength(0);
    sup.stop();
  });

  it("warns on loss, then resets the backoff after reattaching", async () => {
    const session = fakeSession(true);
    const { logger, entries } = recordingLogger();
    const sup = new ConnectionSupervisor({
      session,
      logger,
      reconnectMs: 100,
      probeIntervalMs: 200,
      maxDelayMs: 1000,
      random: () => 0.5,
    });

    sup.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(sup.connectionState).toBe("attached");

    session.alive = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sup.connectionState).toBe("detached");
    expect(entries.filter((e) => e.level === "warn")).toHaveLength(1);

    session.alive = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(sup.connectionState).toBe("attached");
    expect(entries.filter((e) => e.level === "info")).toHaveLength(2);

    // Backoff reset means the next failure retries at the seed again.
    const before = session.probes;
    session.alive = false;
    await vi.advanceTimersByTimeAsync(300);
    expect(session.probes).toBeGreaterThan(before);
    sup.stop();
  });

  it("suppresses overlapping probes", async () => {
    let resolve: (v: boolean) => void = () => undefined;
    let calls = 0;
    const session: SupervisedSession = {
      healthCheck() {
        calls += 1;
        return new Promise<boolean>((r) => {
          resolve = r;
        });
      },
    };
    const { logger } = recordingLogger();
    const sup = new ConnectionSupervisor({ session, logger, reconnectMs: 50 });

    const first = sup.probeOnce();
    await sup.probeOnce();
    expect(calls).toBe(1);
    resolve(true);
    await first;
    sup.stop();
  });

  it("treats a throwing health check as a dead connection", async () => {
    const session: SupervisedSession = {
      healthCheck: () => Promise.reject(new Error("boom")),
    };
    const { logger } = recordingLogger();
    const sup = new ConnectionSupervisor({ session, logger, reconnectMs: 50 });
    await expect(sup.probeOnce()).resolves.toBe(false);
    expect(sup.connectionState).toBe("detached");
    sup.stop();
  });

  it("clears its timer on stop so the event loop can drain", async () => {
    const session = fakeSession(false);
    const { logger } = recordingLogger();
    const sup = new ConnectionSupervisor({ session, logger, reconnectMs: 50 });

    sup.start();
    await vi.advanceTimersByTimeAsync(200);
    sup.stop();
    const after = session.probes;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.probes).toBe(after);
    expect(vi.getTimerCount()).toBe(0);
    expect(sup.started).toBe(false);
  });

  it("ignores a repeated start and a repeated stop", async () => {
    const session = fakeSession(true);
    const { logger } = recordingLogger();
    const sup = new ConnectionSupervisor({ session, logger, reconnectMs: 100 });

    sup.start();
    sup.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(session.probes).toBe(1);

    sup.stop();
    sup.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
