/**
 * Call admission control for tool dispatch.
 *
 * Every tool in this server ultimately drives ONE live Obsidian window: real
 * mouse input, real keystrokes, a single command palette, one vault on disk. An
 * agent is free to issue overlapping tool calls, and MCP hosts routinely do. Two
 * concurrent clicks, or a plugin reload racing a command invocation, interleave
 * against shared UI state and fail nondeterministically in ways that read like
 * plugin bugs rather than like a race in the tooling.
 *
 * So mutating calls take an exclusive lock and read-only calls take a shared one,
 * bounded by a slot count. This is a readers-writer lock with two deliberate
 * properties:
 *
 *  - Strict FIFO. The queue is only ever granted from the head, so a continuous
 *    stream of read-only calls cannot starve a waiting mutation. Naive RW locks
 *    admit any reader whenever the lock is unheld, which lets a busy agent defer
 *    a write indefinitely.
 *  - A queue-wait timeout. A tool that wedges (an Obsidian modal swallowing
 *    input, a CDP round trip that never settles) would otherwise stall every
 *    subsequent call for the life of the process with no diagnostic. Waiters
 *    fail with an actionable error instead.
 *
 * Re-entrancy: a handler that dispatches another tool call while holding the
 * lock would deadlock against itself, since the nested exclusive acquire waits
 * on a lock its own caller holds. Ownership is therefore tracked in an
 * AsyncLocalStorage, and a nested acquire inherits the held lock instead of
 * queueing. No composite in this repo currently re-enters dispatch (they call
 * shared helpers under `src/devcycle/` directly), but the failure mode is a
 * whole-server hang, so the guard is not left to convention.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { UobError } from "./errors.js";

export type LockMode = "shared" | "exclusive";

/**
 * Default ceiling on how long a call may sit in the queue.
 *
 * Sized against the slowest legitimate wait rather than the slowest call: a
 * single mutation is bounded by the CLI timeout (15s) plus dev-cycle settle and
 * screenshot time, so a handful of queued mutations ahead of you is normal and
 * must not be aborted. 60s is comfortably above that while still surfacing a
 * genuinely wedged call within one agent turn instead of never.
 */
export const DEFAULT_QUEUE_TIMEOUT_MS = 60_000;

interface Waiter {
  mode: LockMode;
  grant: () => void;
  timer?: NodeJS.Timeout;
  label: string;
}

export interface LockStats {
  activeShared: number;
  activeExclusive: boolean;
  queued: number;
}

export interface CallLockOptions {
  /** Read-only calls allowed to run at once. Clamped to at least 1. */
  maxShared: number;
  /** Milliseconds a call may wait for admission before failing. */
  queueTimeoutMs?: number;
}

function queueTimeout(label: string, mode: LockMode, waitedMs: number, stats: LockStats): UobError {
  return new UobError(
    "TIMEOUT",
    `Timed out after ${Math.round(waitedMs / 1000)}s waiting for the tool-call lock (${label}).`,
    {
      remediation:
        "Tool calls are serialized because they drive one live Obsidian window, so this call was " +
        "queued behind another that has not finished. A tool is most likely wedged on the UI — an " +
        "open modal or dialog swallowing input is the usual cause. Take a screenshot or snapshot to " +
        "see the current window state, dismiss anything blocking, then retry. Raise " +
        "KNAP_MAX_CONCURRENCY only if the blocked calls are read-only.",
      details: {
        tool: label,
        mode,
        waitedMs,
        activeShared: stats.activeShared,
        activeExclusive: stats.activeExclusive,
        queued: stats.queued,
      },
    },
  );
}

/**
 * A FIFO readers-writer lock with bounded shared occupancy and re-entrant
 * ownership. Dependency-free by design; this sits on the dispatch path of every
 * tool call and must not fail in interesting ways.
 */
export class CallLock {
  private readonly maxShared: number;
  private readonly queueTimeoutMs: number;
  private readonly queue: Waiter[] = [];
  private readonly ownership = new AsyncLocalStorage<LockMode>();

  private activeShared = 0;
  private activeExclusive = false;

  constructor(options: CallLockOptions) {
    this.maxShared = Math.max(1, Math.floor(options.maxShared));
    this.queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  }

  stats(): LockStats {
    return {
      activeShared: this.activeShared,
      activeExclusive: this.activeExclusive,
      queued: this.queue.length,
    };
  }

  /** True when the current async context already holds the lock. */
  held(): boolean {
    return this.ownership.getStore() !== undefined;
  }

  /**
   * Run `fn` under the requested mode, releasing on both success and failure. A
   * leaked slot deadlocks every later call, which is strictly worse than the
   * race the lock exists to prevent, so release lives in a `finally`.
   */
  async run<T>(mode: LockMode, label: string, fn: () => Promise<T>): Promise<T> {
    // A nested call inherits its caller's grant. Upgrading shared to exclusive is
    // not attempted: it cannot be done without releasing first, and releasing
    // mid-call would hand the UI to someone else halfway through an operation.
    if (this.held()) return fn();

    const release = await this.acquire(mode, label);
    try {
      return await this.ownership.run(mode, fn);
    } finally {
      release();
    }
  }

  private acquire(mode: LockMode, label: string): Promise<() => void> {
    const startedAt = Date.now();
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        mode,
        label,
        grant: () => {
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          resolve(this.releaser(mode));
        },
      };

      if (this.queueTimeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index === -1) return;
          this.queue.splice(index, 1);
          reject(queueTimeout(label, mode, Date.now() - startedAt, this.stats()));
          // Removing a head waiter can unblock the ones behind it.
          this.drain();
        }, this.queueTimeoutMs);
        // Never hold the event loop open on a queued call.
        waiter.timer.unref();
      }

      this.queue.push(waiter);
      this.drain();
    });
  }

  private releaser(mode: LockMode): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (mode === "exclusive") this.activeExclusive = false;
      else this.activeShared -= 1;
      this.drain();
    };
  }

  /**
   * Grant from the head of the queue only. Stopping at the first waiter that
   * cannot be admitted is what makes the lock fair: readers queued behind a
   * pending writer wait for it rather than overtaking it.
   */
  private drain(): void {
    for (;;) {
      const head = this.queue[0];
      if (head === undefined) return;

      if (head.mode === "exclusive") {
        if (this.activeExclusive || this.activeShared > 0) return;
        this.queue.shift();
        this.activeExclusive = true;
      } else {
        if (this.activeExclusive || this.activeShared >= this.maxShared) return;
        this.queue.shift();
        this.activeShared += 1;
      }

      head.grant();
    }
  }
}
