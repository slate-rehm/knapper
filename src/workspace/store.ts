/** Explicit workspace handles that survive MCP transport and process boundaries. */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspacesDir } from "../config.js";
import { requireAgent } from "../agent/store.js";
import { UobError } from "../util/errors.js";
import { withFileLock } from "../util/filelock.js";

const WORKSPACE_HANDLE = /^wsp_[A-Za-z0-9_-]{32}$/;
export const WORKSPACE_IDLE_MS = 24 * 60 * 60 * 1000;

export interface WorkspaceRecord {
  schema: 1;
  handle: string;
  agentHandle: string;
  kind: "isolated" | "default";
  sessionKey?: string;
  label?: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

function workspacePath(handle: string, env: NodeJS.ProcessEnv): string {
  if (!WORKSPACE_HANDLE.test(handle)) {
    throw new UobError("INVALID_ARGUMENT", "The workspace handle is malformed.", {
      remediation:
        "Create a workspace with obsidian_workspace_create or claim the default profile.",
    });
  }
  return join(workspacesDir(env), `${handle}.json`);
}

async function writeWorkspace(record: WorkspaceRecord, env: NodeJS.ProcessEnv): Promise<void> {
  const dir = workspacesDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = workspacePath(record.handle, env);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export async function createWorkspaceRecord(opts: {
  agentHandle: string;
  kind: "isolated" | "default";
  sessionKey?: string;
  label?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<WorkspaceRecord> {
  const env = opts.env ?? process.env;
  await requireAgent(opts.agentHandle, env);
  const now = opts.now ?? new Date();
  const record: WorkspaceRecord = {
    schema: 1,
    handle: `wsp_${randomBytes(24).toString("base64url")}`,
    agentHandle: opts.agentHandle,
    kind: opts.kind,
    ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
    ...(opts.label !== undefined ? { label: opts.label } : {}),
    createdAt: now.toISOString(),
    lastActivityAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + WORKSPACE_IDLE_MS).toISOString(),
  };
  await writeWorkspace(record, env);
  return record;
}

export async function readWorkspace(
  handle: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceRecord | undefined> {
  try {
    const record = JSON.parse(
      await readFile(workspacePath(handle, env), "utf8"),
    ) as WorkspaceRecord;
    return record.schema === 1 && record.handle === handle ? record : undefined;
  } catch (error) {
    if (error instanceof UobError) throw error;
    return undefined;
  }
}

export async function requireWorkspace(
  handle: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceRecord> {
  const record = await readWorkspace(handle, env);
  if (record === undefined) {
    throw new UobError("SESSION_NOT_FOUND", `Workspace ${handle} does not exist.`, {
      remediation: "Create a workspace with obsidian_workspace_create.",
      fixedBy: "obsidian_workspace_create",
    });
  }
  if (Date.parse(record.expiresAt) <= Date.now()) {
    throw new UobError("SESSION_NOT_FOUND", `Workspace ${handle} expired.`, {
      remediation: "Create or claim a new workspace handle.",
      fixedBy: "obsidian_workspace_create",
    });
  }
  return record;
}

export async function touchWorkspace(
  handle: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceRecord> {
  return withFileLock(`${workspacePath(handle, env)}.lock`, async () => {
    const record = await requireWorkspace(handle, env);
    const now = new Date();
    const next = {
      ...record,
      lastActivityAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + WORKSPACE_IDLE_MS).toISOString(),
    };
    await writeWorkspace(next, env);
    return next;
  });
}

export async function listWorkspaces(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceRecord[]> {
  let names: string[];
  try {
    names = await readdir(workspacesDir(env));
  } catch {
    return [];
  }
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) => readWorkspace(name.slice(0, -5), env).catch(() => undefined)),
  );
  return records
    .filter((record): record is WorkspaceRecord => record !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function removeWorkspaceRecord(
  handle: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(workspacePath(handle, env), { force: true });
}
