import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const readStartTime = vi.fn();

vi.mock("../../src/connection/health.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/connection/health.js")>();
  return {
    ...actual,
    readPidStartTime: (...args: unknown[]) => readStartTime(...args),
  };
});

const { WorkspaceLeaseManager } = await import("../../src/workspace/lease.js");

let home: string;
let env: NodeJS.ProcessEnv;
let now: Date;
const workspaceHandle = "wsp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "knap-workspace-lease-"));
  env = { ...process.env, KNAP_HOME: home };
  now = new Date("2026-08-06T12:00:00.000Z");
  readStartTime.mockReset().mockResolvedValue(100);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function manager(): InstanceType<typeof WorkspaceLeaseManager> {
  return new WorkspaceLeaseManager({
    idleTimeoutMs: 60_000,
    env,
    now: () => now,
    pid: process.pid,
    hostname: "test-host",
    cwd: "/tmp/test",
  });
}

describe("workspace leases", () => {
  it("allows only one owner and stores private records", async () => {
    const first = manager();
    const second = manager();
    await first.acquire(workspaceHandle, "obsidian_snapshot");

    await expect(second.acquire(workspaceHandle, "obsidian_command")).rejects.toMatchObject({
      code: "WORKSPACE_BUSY",
      details: expect.objectContaining({ workspaceHandle, retryAfterMs: 60_000 }),
    });
    expect(
      (await stat(join(home, "workspace-leases", `${workspaceHandle}.json`))).mode & 0o777,
    ).toBe(0o600);

    await first.release(workspaceHandle);
    await expect(second.acquire(workspaceHandle)).resolves.toMatchObject({ workspaceHandle });
  });

  it("reclaims an expired lease", async () => {
    const first = manager();
    const second = manager();
    await first.acquire(workspaceHandle);
    now = new Date(now.getTime() + 60_001);

    await expect(second.acquire(workspaceHandle)).resolves.toMatchObject({ workspaceHandle });
    expect((await first.status(workspaceHandle)).state).toBe("busy");
  });

  it("does not release a lease whose token changed", async () => {
    const first = manager();
    const second = manager();
    await first.acquire(workspaceHandle);
    now = new Date(now.getTime() + 60_001);
    await second.acquire(workspaceHandle);
    await first.release(workspaceHandle);
    expect((await second.status(workspaceHandle)).state).toBe("owned");
  });

  it("reclaims a lease after PID reuse", async () => {
    const first = manager();
    await first.acquire(workspaceHandle);
    readStartTime.mockResolvedValue(200);
    const second = manager();

    await expect(second.acquire(workspaceHandle)).resolves.toMatchObject({
      pidStartTime: 200,
    });
  });

  it("releases all leases held by one manager", async () => {
    const owner = manager();
    const other = manager();
    const secondHandle = "wsp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    await owner.acquire(workspaceHandle);
    await owner.acquire(secondHandle);
    await owner.releaseAll();

    expect((await other.status(workspaceHandle)).state).toBe("free");
    expect((await other.status(secondHandle)).state).toBe("free");
  });
});
