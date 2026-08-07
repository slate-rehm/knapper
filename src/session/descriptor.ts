/**
 * The session descriptor: what a session *is*, on disk.
 *
 * This is the source of truth for one private scratch session. It is separate from
 * the external authorization registry for existing vaults. A descriptor answers
 * "what is this session". The external registry answers "may I touch this existing
 * vault". Knapper never derives either answer from a file inside a vault.
 *
 * Writes are tmp + rename so a concurrent reader never sees a half-written file.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { sessionPaths, sessionsDir } from "../config.js";
import { assertSessionKey } from "./key.js";

export const SESSION_SCHEMA_VERSION = 4;

export type SessionReadiness =
  | {
      phase: "starting";
      spawnedAt: string;
      requestedPort: number;
      lastProbeAt?: string;
    }
  | { phase: "ready"; readyAt: string }
  | { phase: "stopped"; stoppedAt: string }
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
  /** Provenance for diagnostics. Never used for routing. */
  origin: { cwd: string; branch?: string; label?: string };
  /** Explicit stateless-MCP attribution. The session key remains an internal id. */
  agentHandle?: string;
  /**
   * Filesystem identity recorded at creation. Cleanup must match every field and
   * the derived session path before it can quarantine the scratch directory.
   */
  ownership?: {
    rootPath: string;
    vaultPath: string;
    rootDevice: number;
    rootInode: number;
    vaultDevice: number;
    vaultInode: number;
  };
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
  vault?: {
    id: string;
    name: string;
    path: string;
    grant: "created" | "adopted";
  };
  plugin?: {
    id: string;
    sourceDir: string;
    linkPath: string;
    artifacts?: { manifest: true; main: true; styles: boolean };
    preEnabled?: boolean;
  };
  /** Visible private-profile boundary. Failures warn but do not destroy the workspace. */
  visualIdentity?: { state: "ready" | "degraded"; warnings: string[] };
  /** The connected knapper process that is actively bound to this session. */
  owner?: {
    pid: number;
    pidStartTime?: number;
    startedAt: string;
    exitedAt?: string;
  };
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
    if (
      !Number.isInteger(parsed.schema) ||
      parsed.schema < 1 ||
      parsed.schema > SESSION_SCHEMA_VERSION
    ) {
      return undefined;
    }
    // Version 1 and 2 descriptors only existed after CDP became reachable.
    if (parsed.readiness === undefined && parsed.schema < 3) {
      return {
        ...parsed,
        schema: SESSION_SCHEMA_VERSION,
        readiness: { phase: "ready", readyAt: parsed.createdAt },
      };
    }
    if (parsed.readiness === undefined) return undefined;
    return parsed.schema === SESSION_SCHEMA_VERSION
      ? parsed
      : { ...parsed, schema: SESSION_SCHEMA_VERSION };
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
    // throw, so one piece of debris cannot break workspace discovery.
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
  await patchDescriptor(
    key,
    (d) =>
      d.owner?.pid === process.pid && d.owner.exitedAt === undefined
        ? { ...d, heartbeatAt: now.toISOString() }
        : d,
    env,
  ).catch(() => undefined);
}

/** Remove only the descriptor, leaving the profile and vault in place. */
export async function removeDescriptor(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(descriptorPath(key, env), { force: true });
}
