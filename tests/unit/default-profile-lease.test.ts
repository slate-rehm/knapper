import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultProfileLease } from "../../src/session/default-profile-lease.js";
import { defaultProfileLeasePath } from "../../src/config.js";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "knap-profile-lease-"));
  env = { KNAP_HOME: root };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("DefaultProfileLease", () => {
  it("allows one owner and gives the contender an actionable error", async () => {
    const first = new DefaultProfileLease({ idleTimeoutMs: 60_000, env });
    const second = new DefaultProfileLease({ idleTimeoutMs: 60_000, env });
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquisition = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const held = first.run("obsidian_command", async () => {
      acquired();
      await gate;
    });
    await acquisition;

    await expect(second.run("browser_click", async () => undefined)).rejects.toMatchObject({
      code: "DEFAULT_PROFILE_BUSY",
      fixedBy: "obsidian_workspace_create",
      details: expect.objectContaining({ tool: "browser_click" }),
    });

    release();
    await held;
    await first.release();
  });

  it("reclaims an idle lease after the configured grace", async () => {
    let now = new Date("2026-08-04T12:00:00Z");
    const clock = () => now;
    const first = new DefaultProfileLease({ idleTimeoutMs: 30_000, env, now: clock });
    await first.run("obsidian_status", async () => undefined);
    now = new Date(now.getTime() + 31_000);

    const second = new DefaultProfileLease({ idleTimeoutMs: 30_000, env, now: clock });
    await expect(second.run("obsidian_command", async () => "ok")).resolves.toBe("ok");
    await second.release();
  });

  it("releases only its own record", async () => {
    const first = new DefaultProfileLease({ idleTimeoutMs: 30_000, env });
    await first.run("obsidian_status", async () => undefined);
    const second = new DefaultProfileLease({ idleTimeoutMs: 30_000, env });
    await second.release();
    expect((await first.status()).state).toBe("owned");
    await first.release();
  });

  it("reclaims an expired active lease from another host", async () => {
    let now = new Date("2026-08-04T12:00:00Z");
    const clock = () => now;
    let acquired!: () => void;
    let release!: () => void;
    const acquisition = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remote = new DefaultProfileLease({
      idleTimeoutMs: 30_000,
      env,
      now: clock,
      hostname: "remote-host",
    });
    const held = remote.run("browser_click", async () => {
      acquired();
      await gate;
    });
    await acquisition;
    now = new Date(now.getTime() + 31_000);

    const local = new DefaultProfileLease({
      idleTimeoutMs: 30_000,
      env,
      now: clock,
      hostname: "local-host",
    });
    await expect(local.run("obsidian_command", async () => "ok")).resolves.toBe("ok");
    release();
    await held;
    await local.release();
  });

  it("does not let a malformed expiry block the profile", async () => {
    const path = defaultProfileLeasePath(env);
    await mkdir(root, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        token: "untrusted",
        pid: process.pid,
        hostname: "remote-host",
        cwd: root,
        acquiredAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        expiresAt: "not-a-date",
        activeCalls: 1,
      }),
    );
    const lease = new DefaultProfileLease({ idleTimeoutMs: 30_000, env });

    await expect(lease.run("obsidian_status", async () => "ok")).resolves.toBe("ok");
    await lease.release();
  });
});
