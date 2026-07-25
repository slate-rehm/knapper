import { describe, expect, it } from "vitest";
import { CallLock, DEFAULT_QUEUE_TIMEOUT_MS } from "../../src/util/concurrency.js";
import { UobError } from "../../src/util/errors.js";

/** A promise plus its resolver, so a test decides exactly when an op finishes. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let queued microtasks settle without depending on wall-clock time. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Tracks concurrent occupancy so a test can assert a ceiling was never crossed. */
class Occupancy {
  current = 0;
  peak = 0;

  enter(): void {
    this.current += 1;
    this.peak = Math.max(this.peak, this.current);
  }

  exit(): void {
    this.current -= 1;
  }
}

describe("CallLock exclusive mode", () => {
  it("never lets two mutating operations overlap", async () => {
    const lock = new CallLock({ maxShared: 4 });
    const occupancy = new Occupancy();
    const gates = [deferred(), deferred(), deferred()];

    const runs = gates.map((gate) =>
      lock.run("exclusive", "obsidian_notice", async () => {
        occupancy.enter();
        await gate.promise;
        occupancy.exit();
      }),
    );

    await flush();
    expect(occupancy.current).toBe(1);

    for (const gate of gates) {
      gate.resolve();
      await flush();
    }

    await Promise.all(runs);
    expect(occupancy.peak).toBe(1);
  });

  it("blocks a read-only operation while a mutation holds the lock", async () => {
    const lock = new CallLock({ maxShared: 4 });
    const order: string[] = [];
    const gate = deferred();

    const write = lock.run("exclusive", "obsidian_notice", async () => {
      order.push("write:start");
      await gate.promise;
      order.push("write:end");
    });

    await flush();
    const read = lock.run("shared", "obsidian_status", async () => {
      order.push("read");
    });

    await flush();
    expect(order).toEqual(["write:start"]);

    gate.resolve();
    await Promise.all([write, read]);
    expect(order).toEqual(["write:start", "write:end", "read"]);
  });

  it("blocks a mutation while read-only operations are in flight", async () => {
    const lock = new CallLock({ maxShared: 4 });
    const order: string[] = [];
    const gate = deferred();

    const read = lock.run("shared", "obsidian_status", async () => {
      order.push("read:start");
      await gate.promise;
      order.push("read:end");
    });

    await flush();
    const write = lock.run("exclusive", "obsidian_notice", async () => {
      order.push("write");
    });

    await flush();
    expect(order).toEqual(["read:start"]);

    gate.resolve();
    await Promise.all([read, write]);
    expect(order).toEqual(["read:start", "read:end", "write"]);
  });
});

describe("CallLock shared mode", () => {
  it("overlaps read-only operations up to maxShared and no further", async () => {
    const lock = new CallLock({ maxShared: 3 });
    const occupancy = new Occupancy();
    const gates = Array.from({ length: 8 }, () => deferred());

    const runs = gates.map((gate) =>
      lock.run("shared", "obsidian_status", async () => {
        occupancy.enter();
        await gate.promise;
        occupancy.exit();
      }),
    );

    await flush();
    expect(occupancy.current).toBe(3);

    for (const gate of gates) {
      gate.resolve();
      await flush();
    }

    await Promise.all(runs);
    expect(occupancy.peak).toBe(3);
  });
});

describe("CallLock fairness", () => {
  it("does not starve a waiting mutation behind a continuous stream of readers", async () => {
    const lock = new CallLock({ maxShared: 2 });
    const order: string[] = [];
    const first = deferred();

    const held = lock.run("shared", "read:0", async () => {
      order.push("read:0");
      await first.promise;
    });

    await flush();

    const write = lock.run("exclusive", "write", async () => {
      order.push("write");
    });

    // Readers arriving after the writer must queue behind it, not overtake it
    // while the lock still has a free shared slot.
    const laterReaders = [1, 2, 3, 4].map((n) =>
      lock.run("shared", `read:${n}`, async () => {
        order.push(`read:${n}`);
      }),
    );

    await flush();
    expect(order).toEqual(["read:0"]);

    first.resolve();
    await Promise.all([held, write, ...laterReaders]);

    expect(order[0]).toBe("read:0");
    expect(order[1]).toBe("write");
    expect(order.slice(2).sort()).toEqual(["read:1", "read:2", "read:3", "read:4"]);
  });
});

describe("CallLock release semantics", () => {
  it("releases the lock when the operation throws", async () => {
    const lock = new CallLock({ maxShared: 2 });

    await expect(
      lock.run("exclusive", "obsidian_notice", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    expect(lock.stats()).toEqual({ activeShared: 0, activeExclusive: false, queued: 0 });
    await expect(lock.run("exclusive", "obsidian_notice", async () => "next")).resolves.toBe(
      "next",
    );
  });

  it("releases a shared slot when a read-only operation throws", async () => {
    const lock = new CallLock({ maxShared: 1 });

    await expect(
      lock.run("shared", "obsidian_status", () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    await expect(lock.run("shared", "obsidian_status", async () => "ok")).resolves.toBe("ok");
  });
});

describe("CallLock re-entrancy", () => {
  it("lets a nested call inherit the held lock instead of deadlocking on itself", async () => {
    const lock = new CallLock({ maxShared: 2, queueTimeoutMs: 50 });

    const result = await lock.run("exclusive", "obsidian_dev_cycle", async () => {
      const inner = await lock.run("exclusive", "obsidian_reload_plugin", async () => "inner");
      const innerRead = await lock.run("shared", "obsidian_status", async () => "read");
      return `${inner}+${innerRead}`;
    });

    expect(result).toBe("inner+read");
    expect(lock.stats()).toEqual({ activeShared: 0, activeExclusive: false, queued: 0 });
  });

  it("reports ownership only inside a held call", async () => {
    const lock = new CallLock({ maxShared: 2 });
    expect(lock.held()).toBe(false);
    await lock.run("shared", "obsidian_status", async () => {
      expect(lock.held()).toBe(true);
    });
    expect(lock.held()).toBe(false);
  });
});

describe("CallLock queue timeout", () => {
  it("fails a queued call with a typed, actionable error", async () => {
    const lock = new CallLock({ maxShared: 2, queueTimeoutMs: 5 });
    const gate = deferred();

    const held = lock.run("exclusive", "obsidian_dev_cycle", async () => {
      await gate.promise;
    });
    await flush();

    const queued = lock.run("shared", "obsidian_status", async () => "never");
    const err = await queued.catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UobError);
    const uob = err as UobError;
    expect(uob.code).toBe("TIMEOUT");
    expect(uob.remediation).toMatch(/modal/i);
    expect(uob.toJSON()).toMatchObject({
      code: "TIMEOUT",
      tool: "obsidian_status",
      mode: "shared",
      activeExclusive: true,
    });

    gate.resolve();
    await held;
  });

  it("does not leave a timed-out waiter blocking the queue", async () => {
    const lock = new CallLock({ maxShared: 1, queueTimeoutMs: 5 });
    const gate = deferred();

    const held = lock.run("exclusive", "obsidian_notice", async () => {
      await gate.promise;
    });
    await flush();

    await expect(lock.run("exclusive", "obsidian_notice", async () => "a")).rejects.toBeInstanceOf(
      UobError,
    );

    gate.resolve();
    await held;

    expect(lock.stats()).toEqual({ activeShared: 0, activeExclusive: false, queued: 0 });
    await expect(lock.run("exclusive", "obsidian_notice", async () => "b")).resolves.toBe("b");
  });

  it("defaults to a wait budget generous enough for a queue of slow mutations", () => {
    expect(DEFAULT_QUEUE_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
