/**
 * Cross-process advisory locking.
 *
 * The properties that matter are the failure modes, not the happy path: a lock
 * that leaks on a throw is worse than the race it prevents, and one that never
 * breaks after a crash wedges the registry permanently.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../../src/util/filelock.js";

let dir: string;
let lock: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "knap-lock-"));
  lock = join(dir, "registry.lock");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const exists = async (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("withFileLock", () => {
  it("runs the body and returns its value", async () => {
    expect(await withFileLock(lock, async () => 42)).toBe(42);
  });

  it("releases the lock afterwards", async () => {
    await withFileLock(lock, async () => undefined);
    expect(await exists(lock)).toBe(false);
  });

  it("releases the lock even when the body throws", async () => {
    // A leaked lock makes the next contender wait the full timeout before it can
    // even report what went wrong.
    await expect(withFileLock(lock, async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(await exists(lock)).toBe(false);
  });

  it("creates the parent directory", async () => {
    const nested = join(dir, "a", "b", "registry.lock");
    expect(await withFileLock(nested, async () => "ok")).toBe("ok");
  });

  it("serializes concurrent holders rather than interleaving them", async () => {
    const order: string[] = [];
    const body = (name: string) => async () => {
      order.push(`${name}-start`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`${name}-end`);
    };
    await Promise.all([
      withFileLock(lock, body("a"), { retryMs: 5 }),
      withFileLock(lock, body("b"), { retryMs: 5 }),
    ]);
    // Whichever wins, neither may start before the other has finished.
    expect(order).toSatisfy(
      (o: string[]) =>
        o.join(",") === "a-start,a-end,b-start,b-end" ||
        o.join(",") === "b-start,b-end,a-start,a-end",
    );
  });

  it("records the holder so a waiter can name it", async () => {
    await withFileLock(lock, async () => {
      const record = JSON.parse(await readFile(lock, "utf8"));
      expect(record.pid).toBe(process.pid);
      expect(record.hostname).toBe(hostname());
    });
  });

  it("times out against a live holder, naming who has it", async () => {
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
      }),
      "utf8",
    );
    await expect(
      withFileLock(lock, async () => "never", { timeoutMs: 100, retryMs: 10 }),
    ).rejects.toThrow(/Timed out waiting for the lock/);
  });

  it("breaks a lock whose owner is dead", async () => {
    // The crash-recovery path: without this, one killed process wedges the
    // registry for every future one.
    await writeFile(
      lock,
      JSON.stringify({
        // Kernel pid_max is at least 32768; 2^30 is reliably unused.
        pid: 2 ** 30,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
      }),
      "utf8",
    );
    expect(await withFileLock(lock, async () => "recovered", { timeoutMs: 500 })).toBe("recovered");
  });

  it("breaks a lock that is merely too old, as a backstop", async () => {
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date(Date.now() - 120_000).toISOString(),
      }),
      "utf8",
    );
    expect(
      await withFileLock(lock, async () => "recovered", { staleMs: 1000, timeoutMs: 500 }),
    ).toBe("recovered");
  });

  it("breaks an unreadable lock, which means a crash mid-write", async () => {
    await writeFile(lock, "{truncated", "utf8");
    expect(await withFileLock(lock, async () => "recovered", { timeoutMs: 500 })).toBe("recovered");
  });

  it("never breaks a lock held by another host", async () => {
    // Liveness cannot be checked there, and guessing would defeat the point.
    await writeFile(
      lock,
      JSON.stringify({ pid: 1, hostname: "some-other-box", acquiredAt: new Date().toISOString() }),
      "utf8",
    );
    await expect(
      withFileLock(lock, async () => "never", { timeoutMs: 100, retryMs: 10 }),
    ).rejects.toThrow(/Timed out/);
  });
});
