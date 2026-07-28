/**
 * Advisory locking across knapper processes.
 *
 * `CallLock` guards one process's tool dispatch; this guards the few resources
 * several knapper processes genuinely share — the session registry, and ownership
 * of an individual session.
 *
 * Built on `open(path, "wx")` (O_CREAT|O_EXCL) rather than `flock`, for two
 * reasons: node exposes no `flock` without a native addon, and `flock` is a no-op
 * on some network filesystems, which would make the lock silently stop working
 * rather than fail. Exclusive create is atomic on every local filesystem.
 *
 * The cost of that choice is that a crashed holder leaves the file behind, so a
 * lock records who took it and when, and a later contender may break one whose
 * owner is provably gone. Staleness is decided by process liveness first and a
 * timeout only as a backstop — a wall-clock rule alone would either break a
 * healthy long operation or leave a dead one's lock forever.
 */

import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { UobError } from "./errors.js";

export interface FileLockOptions {
  /** How long to wait for a contended lock before giving up. */
  timeoutMs?: number;
  /** How old a lock may get before a dead owner's file is broken. */
  staleMs?: number;
  /** Poll interval while waiting. */
  retryMs?: number;
}

interface LockRecord {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Matches CallLock's queue timeout: the longest a legitimate hold should last. */
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_RETRY_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Should an existing lock file be broken?
 *
 * Only when its owner is gone, or it is old enough that no legitimate hold could
 * still be running. A lock held by another host is never broken: we cannot check
 * liveness there, and guessing would defeat the point.
 */
async function isStale(path: string, staleMs: number): Promise<boolean> {
  let record: LockRecord;
  try {
    record = JSON.parse(await readFile(path, "utf8")) as LockRecord;
  } catch {
    // Unreadable or truncated: a crash mid-write. Nothing can be learned from it.
    return true;
  }

  if (record.hostname !== hostname()) return false;
  if (typeof record.pid === "number" && !isAlive(record.pid)) return true;

  const age = Date.now() - Date.parse(record.acquiredAt);
  return Number.isFinite(age) && age > staleMs;
}

/**
 * Run `fn` holding an exclusive lock on `lockPath`.
 *
 * Always released, including when `fn` throws — a leaked lock is worse than the
 * race it was taken to prevent, because the next contender waits the full timeout
 * before it can even diagnose the problem.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;

  await mkdir(dirname(lockPath), { recursive: true });

  const deadline = Date.now() + timeoutMs;
  let acquired = false;

  while (!acquired) {
    try {
      const handle = await open(lockPath, "wx");
      const record: LockRecord = {
        pid: process.pid,
        hostname: hostname(),
        acquiredAt: new Date().toISOString(),
      };
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.close();
      acquired = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;

      if (await isStale(lockPath, staleMs)) {
        // Break it and retry rather than take it directly: two processes may reach
        // this line together, and the exclusive create on the next pass is what
        // decides between them.
        await rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }

      if (Date.now() >= deadline) {
        let holder = "unknown";
        try {
          const record = JSON.parse(await readFile(lockPath, "utf8")) as LockRecord;
          holder = `pid ${record.pid} on ${record.hostname} since ${record.acquiredAt}`;
        } catch {
          /* leave unknown */
        }
        throw new UobError("TIMEOUT", `Timed out waiting for the lock at ${lockPath}.`, {
          remediation:
            "Another knapper process is holding it. Wait for it to finish, or remove the lock file " +
            "if you are certain that process is gone.",
          details: { lockPath, holder, timeoutMs },
        });
      }

      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}
