/**
 * Cooperative ownership for the installation's default Obsidian profile.
 *
 * Session-bound servers need no lease because their profile, CLI socket, and CDP
 * port are private. Unbound MCP servers all point at the same app, so a short
 * record prevents separate hosts from interleaving calls against one window.
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFile, rm } from "node:fs/promises";
import { defaultProfileLeaseLockPath, defaultProfileLeasePath } from "../config.js";
import { readPidStartTime } from "../connection/health.js";
import { UobError } from "../util/errors.js";
import { withFileLock } from "../util/filelock.js";
import { writeFileAtomic } from "../util/atomic-json.js";

export interface DefaultProfileLeaseRecord {
  token: string;
  pid: number;
  pidStartTime?: number;
  hostname: string;
  cwd: string;
  acquiredAt: string;
  lastActivityAt: string;
  expiresAt: string;
  activeCalls: number;
}

export interface DefaultProfileLeaseStatus {
  state: "free" | "owned" | "busy" | "expired";
  owner?: Omit<DefaultProfileLeaseRecord, "token">;
  retryAfterMs?: number;
}

export interface DefaultProfileLeaseOptions {
  idleTimeoutMs: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  pid?: number;
  cwd?: string;
  hostname?: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isLeaseRecord(value: unknown): value is DefaultProfileLeaseRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Partial<DefaultProfileLeaseRecord>;
  return (
    typeof record.token === "string" &&
    Number.isInteger(record.pid) &&
    Number(record.pid) > 0 &&
    (record.pidStartTime === undefined || Number.isFinite(record.pidStartTime)) &&
    typeof record.hostname === "string" &&
    typeof record.cwd === "string" &&
    Number.isFinite(Date.parse(record.acquiredAt ?? "")) &&
    Number.isFinite(Date.parse(record.lastActivityAt ?? "")) &&
    Number.isFinite(Date.parse(record.expiresAt ?? "")) &&
    Number.isInteger(record.activeCalls) &&
    Number(record.activeCalls) >= 0
  );
}

export class DefaultProfileLease {
  private readonly token = randomUUID();
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly cwd: string;
  private readonly host: string;

  constructor(private readonly opts: DefaultProfileLeaseOptions) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => new Date());
    this.pid = opts.pid ?? process.pid;
    this.cwd = opts.cwd ?? process.cwd();
    this.host = opts.hostname ?? hostname();
  }

  private async read(): Promise<DefaultProfileLeaseRecord | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(defaultProfileLeasePath(this.env), "utf8"));
      if (isLeaseRecord(parsed)) return parsed;
      throw new UobError("DEFAULT_PROFILE_BUSY", "The default-profile lease record is malformed.", {
        remediation:
          "Inspect the lease record and its owner before you remove it. Knapper will not overwrite an invalid ownership record.",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof UobError) throw error;
      throw new UobError(
        "DEFAULT_PROFILE_BUSY",
        "Knapper could not read the default-profile lease.",
        {
          remediation:
            "Check the lease file permissions and owner before you retry. Knapper will not assume that the profile is free.",
          cause: error,
        },
      );
    }
  }

  private async write(record: DefaultProfileLeaseRecord): Promise<void> {
    const path = defaultProfileLeasePath(this.env);
    await writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
      directoryMode: 0o700,
    });
  }

  private async ownerAlive(record: DefaultProfileLeaseRecord): Promise<boolean> {
    if (record.hostname !== this.host) return true;
    if (!processAlive(record.pid)) return false;
    if (record.pidStartTime === undefined) return true;
    return (await readPidStartTime(record.pid)) === record.pidStartTime;
  }

  private withoutToken(
    record: DefaultProfileLeaseRecord,
  ): Omit<DefaultProfileLeaseRecord, "token"> {
    const { token: _token, ...owner } = record;
    return owner;
  }

  async status(): Promise<DefaultProfileLeaseStatus> {
    const record = await this.read();
    if (record === undefined) return { state: "free" };
    const retryAfterMs = Math.max(0, Date.parse(record.expiresAt) - this.now().getTime());
    const timedOut =
      retryAfterMs === 0 && (record.activeCalls === 0 || record.hostname !== this.host);
    if (!(await this.ownerAlive(record)) || timedOut) {
      return { state: "expired", owner: this.withoutToken(record), retryAfterMs: 0 };
    }
    if (record.token === this.token) return { state: "owned", owner: this.withoutToken(record) };
    return { state: "busy", owner: this.withoutToken(record), retryAfterMs };
  }

  private async acquire(tool: string): Promise<void> {
    await withFileLock(defaultProfileLeaseLockPath(this.env), async () => {
      const now = this.now();
      const existing = await this.read();
      const own = existing?.token === this.token;
      const timedOut =
        existing !== undefined &&
        Date.parse(existing.expiresAt) <= now.getTime() &&
        (existing.activeCalls === 0 || existing.hostname !== this.host);
      const expired = existing === undefined || !(await this.ownerAlive(existing)) || timedOut;

      if (!own && !expired && existing !== undefined) {
        const retryAfterMs = Math.max(0, Date.parse(existing.expiresAt) - now.getTime());
        throw new UobError(
          "DEFAULT_PROFILE_BUSY",
          "Another Knapper MCP server owns the default Obsidian profile.",
          {
            remediation:
              "Create an isolated workspace with obsidian_workspace_create, then retry the original tool with its workspaceHandle.",
            fixedBy: "obsidian_workspace_create",
            details: {
              tool,
              owner: this.withoutToken(existing),
              retryAfterMs,
            },
          },
        );
      }

      const acquiredAt = own && existing !== undefined ? existing.acquiredAt : now.toISOString();
      await this.write({
        token: this.token,
        pid: this.pid,
        ...(process.platform === "linux" ? { pidStartTime: await readPidStartTime(this.pid) } : {}),
        hostname: this.host,
        cwd: this.cwd,
        acquiredAt,
        lastActivityAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.opts.idleTimeoutMs).toISOString(),
        activeCalls: (own ? (existing?.activeCalls ?? 0) : 0) + 1,
      });
    });
  }

  private async touch(activeDelta = 0): Promise<void> {
    await withFileLock(defaultProfileLeaseLockPath(this.env), async () => {
      const existing = await this.read();
      if (existing?.token !== this.token) return;
      const now = this.now();
      await this.write({
        ...existing,
        lastActivityAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.opts.idleTimeoutMs).toISOString(),
        activeCalls: Math.max(0, existing.activeCalls + activeDelta),
      });
    });
  }

  async run<T>(tool: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(tool);
    const heartbeat = setInterval(
      () => void this.touch().catch(() => undefined),
      Math.min(30_000, Math.max(5_000, Math.floor(this.opts.idleTimeoutMs / 3))),
    );
    heartbeat.unref();
    let value: T | undefined;
    let callError: unknown;
    try {
      value = await fn();
    } catch (error) {
      callError = error;
    }
    clearInterval(heartbeat);
    let releaseError: unknown;
    try {
      await this.touch(-1);
    } catch (error) {
      releaseError = error;
    }
    if (callError !== undefined && releaseError !== undefined) {
      throw new AggregateError(
        [callError, releaseError],
        "The tool call and default-profile lease cleanup both failed.",
      );
    }
    if (callError !== undefined) throw callError;
    if (releaseError !== undefined) throw releaseError;
    return value as T;
  }

  async release(): Promise<void> {
    await withFileLock(defaultProfileLeaseLockPath(this.env), async () => {
      const existing = await this.read();
      if (existing?.token !== this.token) return;
      if (existing.activeCalls > 0) {
        throw new UobError(
          "DEFAULT_PROFILE_BUSY",
          "The default Obsidian profile still has active Knapper calls.",
          { remediation: "Wait for the in-flight calls to finish, then retry." },
        );
      }
      await rm(defaultProfileLeasePath(this.env), { force: true });
    });
  }
}
