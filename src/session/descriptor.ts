/**
 * The session descriptor: what a session *is*, on disk.
 *
 * This is the source of truth, and it is deliberately a separate file from a
 * vault's `.knapper-managed` marker. The two answer different questions and are
 * read on different paths: the descriptor answers "what is this session", the
 * marker answers "may I touch this vault". Folding session state into the marker
 * would put a heartbeat write on the file every fence decision consults, where a
 * torn write is a fence outage rather than a session outage. A session may also
 * own zero or several vaults, while the marker is per-vault.
 *
 * Writes are tmp + rename so a concurrent reader never sees a half-written file.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { sessionPaths, sessionsDir } from "../config.js";
import { assertSessionKey } from "./key.js";

export const SESSION_SCHEMA_VERSION = 2;

export type SessionReadiness =
  | { phase: "starting"; spawnedAt: string; requestedPort: number; lastProbeAt?: string }
  | { phase: "ready"; readyAt: string }
  | { phase: "failed"; failedAt: string; reason: string };

export interface SessionDescriptor {
  schema: number;
  key: string;
  createdAt: string;
  /**
   * Bumped while the session is in use. Staleness input for the reaper, never an
   * authorization input — a live process outranks any heartbeat.
   */
  heartbeatAt: string;
  readiness: SessionReadiness;
  /** Provenance for humans and `obsidian_list_sessions`. Never used for routing. */
  origin: { cwd: string; branch?: string; label?: string };
  instance: {
    userDataDir: string;
    /** Undefined outside Linux, where per-session CLI routing is impossible. */
    runtimeDir?: string;
    outputDir: string;
    cdpPort?: number;
    cdpUrl?: string;
    /**
     * The uuid from `DevToolsActivePort` line 2. Recorded so a reattach can prove
     * it reached *this* instance rather than another session that inherited the
     * port after a restart.
     */
    browserId?: string;
    obsidianBin: string;
    pid?: number;
    /**
     * `/proc/<pid>/stat` field 22. A live pid whose start time differs is a
     * different process that merely reused the number, and SIGTERMing it would be
     * someone else's problem.
     */
    pidStartTime?: number;
  };
  /**
   * The vault this session drives. Only ever a `created` grant: an adopted vault
   * belongs to the user and closing a session must not offer to delete it.
   */
  vault?: { id: string; name: string; path: string; grant: "created" | "adopted" };
  plugin?: {
    id: string;
    sourceDir: string;
    linkPath: string;
    artifacts?: { manifest: true; main: true; styles: boolean };
    preEnabled?: boolean;
  };
  /** The knapper process that provisioned this. Diagnostics only. */
  owner?: { pid: number; startedAt: string; exitedAt?: string };
}

export function descriptorPath(key: string, env: NodeJS.ProcessEnv = process.env): string {
  return sessionPaths(assertSessionKey(key), env).descriptor;
}

/**
 * Read a session's descriptor, or undefined when there is no such session.
 *
 * The key is validated *outside* the catch on purpose. "Malformed key" and "no such
 * session" are different answers: callers turn the second into SESSION_NOT_FOUND,
 * while the first is an invalid argument that must not be swallowed — a traversal
 * attempt should be loud, not quietly indistinguishable from a missing file.
 */
export async function readDescriptor(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionDescriptor | undefined> {
  const path = descriptorPath(key, env);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as SessionDescriptor;
    // A descriptor whose key disagrees with its own directory is debris or an
    // impersonation attempt; either way it is not this session.
    if (parsed.key !== key) return undefined;
    // Version 1 descriptors only existed after CDP became reachable. Treat them
    // as ready during the one-release compatibility window.
    if (parsed.readiness === undefined && parsed.schema < SESSION_SCHEMA_VERSION) {
      return {
        ...parsed,
        schema: SESSION_SCHEMA_VERSION,
        readiness: { phase: "ready", readyAt: parsed.createdAt },
      };
    }
    if (parsed.readiness === undefined) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Atomic: a reader mid-write sees the old file, never a truncated one. */
export async function writeDescriptor(
  descriptor: SessionDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = descriptorPath(descriptor.key, env);
  await mkdir(sessionPaths(descriptor.key, env).root, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** Read-modify-write. Returns undefined when the session is already gone. */
export async function patchDescriptor(
  key: string,
  fn: (current: SessionDescriptor) => SessionDescriptor,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionDescriptor | undefined> {
  const current = await readDescriptor(key, env);
  if (current === undefined) return undefined;
  const next = fn(current);
  await writeDescriptor(next, env);
  return next;
}

export async function listDescriptors(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SessionDescriptor[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir(env));
  } catch {
    return [];
  }

  const out: SessionDescriptor[] = [];
  for (const entry of entries) {
    // A directory that is not a well-formed key is not ours; skip rather than
    // throw, so one piece of debris cannot break `obsidian_list_sessions`.
    if (!/^[a-z0-9][a-z0-9-]{0,20}-[0-9a-f]{8}$/.test(entry)) continue;
    const descriptor = await readDescriptor(entry, env);
    if (descriptor !== undefined) out.push(descriptor);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Debounced so the descriptor never becomes a write-hot file: the supervisor ticks
 * far more often than staleness is measured in.
 */
const HEARTBEAT_DEBOUNCE_MS = 30_000;
let lastHeartbeatAt = 0;

export async function touchHeartbeat(
  key: string,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (now.getTime() - lastHeartbeatAt < HEARTBEAT_DEBOUNCE_MS) return;
  lastHeartbeatAt = now.getTime();
  await patchDescriptor(key, (d) => ({ ...d, heartbeatAt: now.toISOString() }), env).catch(
    () => undefined,
  );
}

/** Remove only the descriptor, leaving the profile and vault in place. */
export async function removeDescriptor(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(descriptorPath(key, env), { force: true });
}
