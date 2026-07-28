/**
 * Reaping abandoned sessions.
 *
 * A session outlives the knapper process that made it, deliberately: an MCP client
 * restarting must not destroy the agent's Obsidian and vault. The cost is that a
 * genuinely abandoned session leaves a whole Electron profile and a scratch vault
 * behind, so something has to collect them.
 *
 * This is the one component that deletes with no agent in the loop, so its rules
 * are conservative on purpose:
 *
 *  - A session with a live process is NEVER reaped, however old its heartbeat. An
 *    agent that has been thinking for an hour has not abandoned anything.
 *  - CDP unreachability is not a signal at all. It is the normal state for the
 *    45 seconds an instance takes to restart, and reaping on it would delete a
 *    healthy session mid-restart.
 *  - A vault is deleted only through `removeManagedVault`, which independently
 *    re-reads the marker and refuses an `adopted` grant. The descriptor claiming
 *    ownership is not, by itself, permission to delete.
 *  - Only a vault *inside* the session's own directory is ever deleted here. One
 *    the caller pointed elsewhere is a directory a human chose, and reclaiming an
 *    abandoned profile is not a reason to delete it. `obsidian_close_session`
 *    keeps the full behaviour, because there an agent asked for it by name.
 */

import { registryLockPath } from "../config.js";
import { withFileLock } from "../util/filelock.js";
import type { Logger } from "../util/logger.js";
import { closeSessionUnlocked, listSessions, type SessionState } from "./registry.js";

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
  /** Delete scratch vault directories too — only ones inside a session's own root. */
  deleteVaults?: boolean;
  logger?: Logger;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

/**
 * Collect abandoned sessions.
 *
 * Called opportunistically from `obsidian_create_session`, which is where the vast
 * majority of cleanup happens in practice — no daemon required, and an agent that
 * never creates another session was not accumulating debris anyway.
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

    for (const s of sessions) {
      const key = s.descriptor.key;
      if (key === opts.keep) {
        kept.push({ key, reason: "current session" });
        continue;
      }
      if (s.state === "live") {
        kept.push({ key, reason: "Obsidian is running" });
        continue;
      }
      if (s.state === "orphaned" && opts.force !== true) {
        // Recently active but the process is gone — usually a crash the agent is
        // about to recover from with obsidian_restart_session. Needs --force.
        kept.push({ key, reason: "recently active; use force to reap" });
        continue;
      }
      candidates.push({
        key,
        state: s.state,
        ...(s.descriptor.vault !== undefined ? { vaultPath: s.descriptor.vault.path } : {}),
        reason:
          s.state === "stale"
            ? `no process and no heartbeat since ${s.descriptor.heartbeatAt}`
            : "no process (forced)",
      });
    }

    const reaped: string[] = [];
    if (!dryRun) {
      for (const candidate of candidates) {
        try {
          await closeSessionUnlocked(candidate.key, {
            ...(opts.deleteVaults === true ? { deleteVault: true, onlyVaultInsideRoot: true } : {}),
            env,
          });
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
