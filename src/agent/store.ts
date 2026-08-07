/**
 * Explicit agent handles for stateless MCP requests.
 *
 * MCP clientInfo identifies client software, not a person or a trusted caller.
 * These opaque handles provide durable attribution and coordination only. They
 * are not authentication credentials.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentsDir } from "../config.js";
import { UobError } from "../util/errors.js";
import { withFileLock } from "../util/filelock.js";

const AGENT_HANDLE = /^agt_[A-Za-z0-9_-]{32}$/;
export const AGENT_IDLE_MS = 24 * 60 * 60 * 1000;

export interface ObservedClient {
  name: string;
  version: string;
  title?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface AgentRecord {
  schema: 1;
  handle: string;
  label: string;
  purpose?: string;
  cwd?: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
  observedClients: ObservedClient[];
}

export interface OpenAgentOptions {
  label: string;
  purpose?: string;
  cwd?: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

function mintAgentHandle(): string {
  return `agt_${randomBytes(24).toString("base64url")}`;
}

function agentPath(handle: string, env: NodeJS.ProcessEnv): string {
  if (!AGENT_HANDLE.test(handle)) {
    throw new UobError("INVALID_ARGUMENT", "The agent handle is malformed.", {
      remediation: "Create a new handle with obsidian_agent_open.",
      fixedBy: "obsidian_agent_open",
    });
  }
  return join(agentsDir(env), `${handle}.json`);
}

async function writeAgent(record: AgentRecord, env: NodeJS.ProcessEnv): Promise<void> {
  const dir = agentsDir(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = agentPath(record.handle, env);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export async function openAgent(opts: OpenAgentOptions): Promise<AgentRecord> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const handle = mintAgentHandle();
  const record: AgentRecord = {
    schema: 1,
    handle,
    label: opts.label.trim(),
    ...(opts.purpose !== undefined ? { purpose: opts.purpose } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    createdAt: now.toISOString(),
    lastActivityAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + AGENT_IDLE_MS).toISOString(),
    observedClients: [],
  };
  if (record.label === "") {
    throw new UobError("INVALID_ARGUMENT", "The agent label cannot be empty.");
  }
  await writeAgent(record, env);
  return record;
}

export async function readAgent(
  handle: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentRecord | undefined> {
  try {
    const record = JSON.parse(await readFile(agentPath(handle, env), "utf8")) as AgentRecord;
    return record.schema === 1 && record.handle === handle ? record : undefined;
  } catch (error) {
    if (error instanceof UobError) throw error;
    return undefined;
  }
}

export async function requireAgent(
  handle: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentRecord> {
  const record = await readAgent(handle, env);
  if (record === undefined) {
    throw new UobError("INVALID_ARGUMENT", `Agent handle ${handle} does not exist or expired.`, {
      remediation: "Create a new handle with obsidian_agent_open.",
      fixedBy: "obsidian_agent_open",
    });
  }
  const expiresAt = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new UobError("INVALID_ARGUMENT", `Agent handle ${handle} expired.`, {
      remediation: "Create a new handle with obsidian_agent_open.",
      fixedBy: "obsidian_agent_open",
    });
  }
  return record;
}

export async function touchAgent(
  handle: string,
  client?: { name: string; version: string; title?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentRecord> {
  return withFileLock(`${agentPath(handle, env)}.lock`, async () => {
    const record = await requireAgent(handle, env);
    const now = new Date();
    const observedClients = [...record.observedClients];
    if (client !== undefined) {
      const existing = observedClients.find(
        (candidate) => candidate.name === client.name && candidate.version === client.version,
      );
      if (existing !== undefined) {
        existing.lastSeenAt = now.toISOString();
        if (client.title !== undefined) existing.title = client.title;
      } else {
        observedClients.push({
          ...client,
          firstSeenAt: now.toISOString(),
          lastSeenAt: now.toISOString(),
        });
      }
    }
    const next: AgentRecord = {
      ...record,
      lastActivityAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + AGENT_IDLE_MS).toISOString(),
      observedClients,
    };
    await writeAgent(next, env);
    return next;
  });
}

export async function listAgents(env: NodeJS.ProcessEnv = process.env): Promise<AgentRecord[]> {
  let names: string[];
  try {
    names = await readdir(agentsDir(env));
  } catch {
    return [];
  }
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) => readAgent(name.slice(0, -5), env).catch(() => undefined)),
  );
  return records
    .filter((record): record is AgentRecord => record !== undefined)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function closeAgent(
  handle: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const record = await readAgent(handle, env);
  if (record === undefined) {
    throw new UobError("INVALID_ARGUMENT", `Agent handle ${handle} does not exist.`, {
      remediation: "Create a new handle with obsidian_agent_open.",
      fixedBy: "obsidian_agent_open",
    });
  }
  await rm(agentPath(handle, env), { force: true });
  return true;
}
