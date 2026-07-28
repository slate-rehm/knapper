/**
 * Connection supervisor.
 *
 * `PlaywrightSession` already reconnects lazily: the next call after a drop sees
 * `browser.isConnected() === false` and reattaches. That is not enough on its own
 * for two reasons — a drop stays invisible until a tool call happens to fail, and
 * a flapping Obsidian would be hammered with one immediate reattach per call.
 *
 * This supervisor closes both gaps without becoming a second connection owner. It
 * drives the *same* session object and its only action is the probe itself, which
 * goes through `session.healthCheck()` and therefore through the session's own
 * `connect()`. A tool call reconnecting concurrently is not a race to win: both
 * paths converge on the one session, and overlapping probes are suppressed rather
 * than queued.
 *
 * Obsidian being down is an ordinary state here — the server is routinely started
 * first — so a failed probe is not an error. It backs off quietly and never spins.
 */

import type { Logger } from "../util/logger.js";

/** The slice of `PlaywrightSession` the supervisor needs, kept narrow for tests. */
export interface SupervisedSession {
  healthCheck(): Promise<boolean>;
}

export interface ConnectionSupervisorOptions {
  session: SupervisedSession;
  logger: Logger;
  /** Backoff seed, from `Config.reconnectMs`. */
  reconnectMs: number;
  /** Ceiling for the backoff delay. */
  maxDelayMs?: number;
  /** Cadence of probes while the connection is healthy. */
  probeIntervalMs?: number;
  /** Injectable [0,1) source so tests can pin the jitter. */
  random?: () => number;
  /**
   * Called on each probe to record that this session is still in use.
   *
   * The supervisor is the only thing that ticks reliably whether or not an agent
   * is issuing tool calls, which makes it the right place to prove liveness to the
   * reaper. Debounced by the descriptor layer so this stays cheap.
   */
  onHeartbeat?: () => void;
}

export type SupervisorState = "attached" | "detached";

const DEFAULT_MAX_DELAY_MS = 30_000;
/** Up to ±20% of the delay, enough to desynchronize retries across processes. */
const JITTER_RATIO = 0.2;

/**
 * Exponential backoff with jitter. `attempt` is the count of consecutive failures
 * already recorded, so the first retry waits one seed interval.
 */
export function backoffDelay(
  seedMs: number,
  attempt: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const seed = Math.max(1, seedMs);
  const exponential = Math.min(maxDelayMs, seed * 2 ** Math.max(0, attempt));
  const jitter = exponential * JITTER_RATIO * (random() * 2 - 1);
  return Math.max(1, Math.round(exponential + jitter));
}

export class ConnectionSupervisor {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private probing = false;
  private state: SupervisorState = "detached";
  private failures = 0;

  private readonly maxDelayMs: number;
  private readonly probeIntervalMs: number;
  private readonly random: () => number;
  private readonly logger: Logger;

  constructor(private readonly opts: ConnectionSupervisorOptions) {
    this.logger = opts.logger;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.probeIntervalMs = opts.probeIntervalMs ?? Math.max(opts.reconnectMs * 5, 10_000);
    this.random = opts.random ?? Math.random;
  }

  get connectionState(): SupervisorState {
    return this.state;
  }

  get started(): boolean {
    return this.running;
  }

  /** Begin probing. Idempotent; the first probe is scheduled, never inline. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.debug("supervisor started", {
      seedMs: this.opts.reconnectMs,
      probeIntervalMs: this.probeIntervalMs,
      maxDelayMs: this.maxDelayMs,
    });
    this.schedule(this.opts.reconnectMs);
  }

  /**
   * Stop probing and release the timer. Clearing is mandatory, not hygiene: a live
   * timer keeps the Node event loop alive and the process would never exit after
   * the MCP client closes stdin.
   */
  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Run one probe and record the transition. Exposed for tests and for callers
   * that want an immediate answer; safe to call while a probe is already in
   * flight, in which case it reports the last known state instead of stacking a
   * second attach attempt on the session.
   */
  async probeOnce(): Promise<boolean> {
    if (this.probing) return this.state === "attached";
    this.probing = true;
    this.opts.onHeartbeat?.();
    try {
      const alive = await this.opts.session.healthCheck();
      if (alive) this.onAlive();
      else this.onDead();
      return alive;
    } catch (e) {
      // healthCheck() is contracted not to throw, so this only fires if the
      // session contract changes. Treat it as a dead connection either way.
      this.onDead(e);
      return false;
    } finally {
      this.probing = false;
    }
  }

  private onAlive(): void {
    if (this.state !== "attached") {
      this.state = "attached";
      this.logger.info("Obsidian connection attached");
    } else {
      this.logger.debug("health probe ok");
    }
    this.failures = 0;
    this.schedule(this.probeIntervalMs);
  }

  private onDead(error?: unknown): void {
    if (this.state === "attached") {
      this.state = "detached";
      this.logger.warn(
        "Obsidian connection lost; retrying with backoff",
        error !== undefined ? { error: String(error) } : {},
      );
    }
    const delay = backoffDelay(this.opts.reconnectMs, this.failures, this.maxDelayMs, this.random);
    this.failures += 1;
    // Debug, not warn: a server started before Obsidian would otherwise emit a
    // warning every few seconds for a state that is entirely expected.
    this.logger.debug("health probe failed; backing off", { delay, failures: this.failures });
    this.schedule(delay);
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    const timer = setTimeout(() => {
      this.timer = undefined;
      void this.probeOnce();
    }, delayMs);
    // Belt and braces with stop(): even a leaked supervisor must not be the reason
    // the process refuses to exit.
    timer.unref?.();
    this.timer = timer;
  }
}
