/**
 * Reaping abandoned sessions.
 *
 * A session outlives the knapper process that made it, deliberately: an MCP client
 * restarting must not destroy the agent's Obsidian and vault. The cost is that a
 * genuinely abandoned session leaves a whole Electron profile and a scratch vault
 * behind, so something has to collect them.
 *
 * This component can clean up with no agent in the loop, so its rules
 * are conservative on purpose:
 *
 *  - A session with a connected MCP owner is never reaped. After that owner exits,
 *    the session remains recoverable for the configured idle grace.
 *  - CDP unreachability is not a signal at all. It is the normal state for the
 *    45 seconds an instance takes to restart, and reaping on it would delete a
 *    healthy session mid-restart.
 *  - Cleanup moves only a verified Knapper scratch root into recoverable trash.
 *  - It verifies the derived layout, real paths, symlink state, device, and inode.
 *  - External vault authorizations never grant cleanup authority.
 */

import { registryLockPath } from "../config.js";
import { withFileLock } from "../util/filelock.js";
import type { Logger } from "../util/logger.js";
import {
  listSessions,
  quarantineSessionUnlocked,
  releaseSessionUnlocked,
  sessionCleanupEligibleAt,
  sessionCleanupExpired,
  sessionOwnerAlive,
  stopSessionUnlocked,
  type SessionState,
} from "./registry.js";

export interface ReapCandidate {
  key: string;
  state: SessionState;
  vaultPath?: string;
  reason: string;
}

export interface ReapReport {
  /** What would be (or was) removed. */
  candidates: ReapCandidate[];
  /** Keys actually reaped. Empty on a dry run. */
  reaped: string[];
  /** Sessions left alone, with why. */
  kept: { key: string; reason: string }[];
  dryRun: boolean;
}

export interface ReapOptions {
  /** Report without deleting anything. */
  dryRun?: boolean;
  /** Also reap `orphaned` sessions, not just `stale` ones. */
  force?: boolean;
  /** Never reap this session, even if it looks stale. */
  keep?: string;
  /** Quarantine the complete verified scratch root. */
  deleteVaults?: boolean;
  logger?: Logger;
  now?: Date;
  env?: NodeJS.ProcessEnv;
  /** Grace after the owning MCP process disconnects. Defaults to 24 hours. */
  idleTimeoutMs?: number;
}

/**
 * Collect abandoned sessions.
 *
 * Called by the server janitor. Workspace creation also performs exact cleanup on
 * a local failure after an internal descriptor exists.
 */
export async function reapStaleSessions(opts: ReapOptions = {}): Promise<ReapReport> {
  const env = opts.env ?? process.env;
  const dryRun = opts.dryRun === true;

  const run = async (): Promise<ReapReport> => {
    const sessions = await listSessions({
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      env,
    });

    const candidates: ReapCandidate[] = [];
    const kept: { key: string; reason: string }[] = [];
    const idleTimeoutMs = opts.idleTimeoutMs ?? 24 * 60 * 60_000;

    for (const s of sessions) {
      const key = s.descriptor.key;
      if (key === opts.keep) {
        kept.push({ key, reason: "current session" });
        continue;
      }
      if (await sessionOwnerAlive(s.descriptor)) {
        kept.push({ key, reason: "owning MCP server is connected" });
        continue;
      }
      const cleanupAt = sessionCleanupEligibleAt(s.descriptor, idleTimeoutMs);
      if (
        opts.force !== true &&
        !sessionCleanupExpired(s.descriptor, opts.now ?? new Date(), idleTimeoutMs)
      ) {
        kept.push({ key, reason: `owner disconnected; cleanup after ${cleanupAt}` });
        continue;
      }
      candidates.push({
        key,
        state: s.state,
        ...(s.descriptor.vault !== undefined ? { vaultPath: s.descriptor.vault.path } : {}),
        reason:
          s.state === "live"
            ? `owner disconnected and no heartbeat since ${s.descriptor.heartbeatAt}`
            : s.state === "stale"
              ? `no process and no heartbeat since ${s.descriptor.heartbeatAt}`
              : opts.force === true
                ? "owner disconnected (forced)"
                : `owner disconnected and no heartbeat since ${s.descriptor.heartbeatAt}`,
      });
    }

    const reaped: string[] = [];
    if (!dryRun) {
      for (const candidate of candidates) {
        try {
          const stop = await stopSessionUnlocked(candidate.key, { env });
          if (stop.state === "quitFailed") {
            kept.push({ key: candidate.key, reason: "reap failed: Obsidian did not stop" });
            continue;
          }
          if (opts.deleteVaults === true) {
            await quarantineSessionUnlocked(candidate.key, { env });
          } else {
            await releaseSessionUnlocked(candidate.key, { env });
          }
          reaped.push(candidate.key);
          opts.logger?.info("reaped abandoned session", { session: candidate.key });
        } catch (e) {
          // One undeletable session must not stop the rest, and its refusal is
          // usually correct — an adopted vault, or a path that moved.
          opts.logger?.warn("could not reap session", {
            session: candidate.key,
            error: String(e),
          });
          kept.push({ key: candidate.key, reason: `reap failed: ${String(e)}` });
        }
      }
    }

    return { candidates, reaped, kept, dryRun };
  };

  // Serialized against concurrent create/close from other knapper processes, so a
  // session being provisioned right now cannot be seen half-written and reaped.
  return withFileLock(registryLockPath(env), run, { timeoutMs: 15_000 });
}
