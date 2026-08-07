/** Exclusive workspace ownership shared by all Knapper processes. */

import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { knapperHome } from "../config.js";
import { readPidStartTime } from "../connection/health.js";
import { UobError } from "../util/errors.js";
import { withFileLock } from "../util/filelock.js";
import { writeFileAtomic } from "../util/atomic-json.js";

const WORKSPACE_HANDLE = /^wsp_[A-Za-z0-9_-]{32}$/;

export interface WorkspaceLeaseRecord {
  schema: 1;
  workspaceHandle: string;
  token: string;
  pid: number;
  pidStartTime?: number;
  hostname: string;
  cwd: string;
  acquiredAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

export interface WorkspaceLeaseOwner extends Omit<WorkspaceLeaseRecord, "token"> {}

export interface WorkspaceLeaseStatus {
  state: "free" | "owned" | "busy" | "expired";
  owner?: WorkspaceLeaseOwner;
  retryAfterMs?: number;
}

export interface WorkspaceLeaseManagerOptions {
  idleTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  pid?: number;
  cwd?: string;
  hostname?: string;
}

function leaseDir(env: NodeJS.ProcessEnv): string {
  return join(knapperHome(env), "workspace-leases");
}

function leasePath(workspaceHandle: string, env: NodeJS.ProcessEnv): string {
  if (!WORKSPACE_HANDLE.test(workspaceHandle)) {
    throw new UobError("INVALID_ARGUMENT", "The workspace handle is malformed.", {
      remediation: "Create a workspace with obsidian_workspace_create.",
    });
  }
  return join(leaseDir(env), `${workspaceHandle}.json`);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One manager represents one MCP server and can own more than one workspace. */
export class WorkspaceLeaseManager {
  private readonly token = randomUUID();
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly cwd: string;
  private readonly host: string;
  private readonly owned = new Set<string>();

  constructor(private readonly opts: WorkspaceLeaseManagerOptions) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
    this.pid = opts.pid ?? process.pid;
    this.cwd = opts.cwd ?? process.cwd();
    this.host = opts.hostname ?? hostname();
  }

  private async read(workspaceHandle: string): Promise<WorkspaceLeaseRecord | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(leasePath(workspaceHandle, this.env), "utf8"),
      ) as WorkspaceLeaseRecord;
      return parsed.schema === 1 && parsed.workspaceHandle === workspaceHandle ? parsed : undefined;
    } catch (error) {
      if (error instanceof UobError) throw error;
      return undefined;
    }
  }

  private async write(record: WorkspaceLeaseRecord): Promise<void> {
    const path = leasePath(record.workspaceHandle, this.env);
    await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
      directoryMode: 0o700,
    });
  }

  private async ownerAlive(record: WorkspaceLeaseRecord): Promise<boolean> {
    if (record.hostname !== this.host) return true;
    if (!processAlive(record.pid)) return false;
    if (record.pidStartTime === undefined || process.platform !== "linux") return true;
    return (await readPidStartTime(record.pid)) === record.pidStartTime;
  }

  private withoutToken(record: WorkspaceLeaseRecord): WorkspaceLeaseOwner {
    const { token: _token, ...owner } = record;
    return owner;
  }

  private expired(record: WorkspaceLeaseRecord, now: Date): boolean {
    const expiresAt = Date.parse(record.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
  }

  async status(workspaceHandle: string): Promise<WorkspaceLeaseStatus> {
    const record = await this.read(workspaceHandle);
    if (record === undefined) return { state: "free" };
    const retryAfterMs = Math.max(0, Date.parse(record.expiresAt) - this.now().getTime());
    if (!(await this.ownerAlive(record)) || this.expired(record, this.now())) {
      return { state: "expired", owner: this.withoutToken(record), retryAfterMs: 0 };
    }
    if (record.token === this.token) {
      return { state: "owned", owner: this.withoutToken(record) };
    }
    return { state: "busy", owner: this.withoutToken(record), retryAfterMs };
  }

  /** Acquire or renew exclusive ownership of one workspace. */
  async acquire(workspaceHandle: string, tool?: string): Promise<WorkspaceLeaseRecord> {
    const path = leasePath(workspaceHandle, this.env);
    return withFileLock(`${path}.lock`, async () => {
      const now = this.now();
      const existing = await this.read(workspaceHandle);
      const own = existing?.token === this.token;
      const available =
        existing === undefined ||
        own ||
        this.expired(existing, now) ||
        !(await this.ownerAlive(existing));
      if (!available && existing !== undefined) {
        throw new UobError("WORKSPACE_BUSY", `Workspace ${workspaceHandle} is in use.`, {
          remediation:
            "Wait for the current owner to release the workspace, or create another workspace.",
          fixedBy: "obsidian_workspace_create",
          details: {
            ...(tool !== undefined ? { tool } : {}),
            workspaceHandle,
            owner: this.withoutToken(existing),
            retryAfterMs: Math.max(0, Date.parse(existing.expiresAt) - now.getTime()),
          },
        });
      }

      const record: WorkspaceLeaseRecord = {
        schema: 1,
        workspaceHandle,
        token: this.token,
        pid: this.pid,
        ...(process.platform === "linux" ? { pidStartTime: await readPidStartTime(this.pid) } : {}),
        hostname: this.host,
        cwd: this.cwd,
        acquiredAt: own && existing !== undefined ? existing.acquiredAt : now.toISOString(),
        lastActivityAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.opts.idleTimeoutMs).toISOString(),
      };
      await this.write(record);
      this.owned.add(workspaceHandle);
      return record;
    });
  }

  /** Release one lease only when this manager still owns its token. */
  async release(workspaceHandle: string): Promise<void> {
    const path = leasePath(workspaceHandle, this.env);
    await withFileLock(`${path}.lock`, async () => {
      const existing = await this.read(workspaceHandle);
      if (existing?.token === this.token) await rm(path, { force: true });
    });
    this.owned.delete(workspaceHandle);
  }

  /** Release all workspace leases held by this MCP server. */
  async releaseAll(): Promise<void> {
    await Promise.all([...this.owned].map((handle) => this.release(handle)));
  }
}
