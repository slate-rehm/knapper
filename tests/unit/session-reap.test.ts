/**
 * Reaper safety.
 *
 * This is the one component that deletes with no agent in the loop, so the tests
 * are written around what it must REFUSE rather than what it collects.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDescriptor, SESSION_SCHEMA_VERSION } from "../../src/session/descriptor.js";
import { reapStaleSessions } from "../../src/session/reap.js";
import { sessionState, STALE_AFTER_MS } from "../../src/session/registry.js";
import { writeManagedMarker } from "../../src/connection/vaults.js";
import { sessionPaths } from "../../src/config.js";

let home: string;
let env: NodeJS.ProcessEnv;
const NOW = new Date("2026-07-28T12:00:00.000Z");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "knap-reap-"));
  env = { ...process.env, KNAP_HOME: home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const exists = async (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/**
 * Build a session on disk. `pid` defaults to a reliably-dead one so the default
 * fixture is "abandoned"; pass process.pid for a live-looking session.
 */
async function makeSession(
  key: string,
  opts: {
    heartbeatAgeMs?: number;
    pid?: number;
    grant?: "created" | "adopted";
    /** Put the vault somewhere other than inside the session root. */
    vaultPath?: string;
  } = {},
): Promise<{ vaultPath: string; userDataDir: string }> {
  const paths = sessionPaths(key, env);
  const vaultPath = opts.vaultPath ?? paths.vaultDir;
  await mkdir(paths.userDataDir, { recursive: true });
  await mkdir(vaultPath, { recursive: true });
  await writeManagedMarker(vaultPath, NOW, opts.grant ?? "created");
  await writeFile(
    join(paths.userDataDir, "obsidian.json"),
    JSON.stringify({ vaults: { abc: { path: vaultPath, ts: 1, open: true } }, cli: true }),
    "utf8",
  );
  await writeDescriptor(
    {
      schema: SESSION_SCHEMA_VERSION,
      key,
      createdAt: NOW.toISOString(),
      heartbeatAt: new Date(NOW.getTime() - (opts.heartbeatAgeMs ?? 0)).toISOString(),
      readiness: { phase: "ready", readyAt: NOW.toISOString() },
      origin: { cwd: "/tmp/wt" },
      instance: {
        userDataDir: paths.userDataDir,
        runtimeDir: paths.runtimeDir,
        outputDir: paths.outputDir,
        cdpPort: 40000,
        cdpUrl: "http://127.0.0.1:40000",
        obsidianBin: "obsidian",
        // 2^30 is above any kernel's pid_max, so it can never be alive.
        pid: opts.pid ?? 2 ** 30,
      },
      vault: {
        id: "abc",
        name: key,
        path: vaultPath,
        grant: opts.grant ?? "created",
      },
    },
    env,
  );
  return { vaultPath, userDataDir: paths.userDataDir };
}

describe("sessionState", () => {
  it("is orphaned when the process is gone but the heartbeat is recent", async () => {
    await makeSession("recent-a3f19c22");
    const { readDescriptor } = await import("../../src/session/descriptor.js");
    const d = await readDescriptor("recent-a3f19c22", env);
    expect(await sessionState(d!, NOW)).toBe("orphaned");
  });

  it("is stale once the heartbeat is old and no process remains", async () => {
    await makeSession("old-a3f19c22", { heartbeatAgeMs: STALE_AFTER_MS + 60_000 });
    const { readDescriptor } = await import("../../src/session/descriptor.js");
    const d = await readDescriptor("old-a3f19c22", env);
    expect(await sessionState(d!, NOW)).toBe("stale");
  });
});

describe("reapStaleSessions", () => {
  it("reports without deleting on a dry run", async () => {
    const { vaultPath } = await makeSession("old-a3f19c22", {
      heartbeatAgeMs: STALE_AFTER_MS + 60_000,
    });
    const report = await reapStaleSessions({ dryRun: true, now: NOW, env, deleteVaults: true });
    expect(report.candidates.map((c) => c.key)).toEqual(["old-a3f19c22"]);
    expect(report.reaped).toEqual([]);
    expect(await exists(vaultPath)).toBe(true);
  });

  it("collects a long-abandoned session", async () => {
    const { vaultPath } = await makeSession("old-a3f19c22", {
      heartbeatAgeMs: STALE_AFTER_MS + 60_000,
    });
    const report = await reapStaleSessions({ now: NOW, env, deleteVaults: true });
    expect(report.reaped).toEqual(["old-a3f19c22"]);
    expect(await exists(vaultPath)).toBe(false);
    expect(await exists(sessionPaths("old-a3f19c22", env).root)).toBe(false);
  });

  it("leaves a merely-orphaned session alone without force", async () => {
    // The app died a moment ago and the agent is probably about to restart it.
    await makeSession("recent-a3f19c22");
    const report = await reapStaleSessions({ now: NOW, env });
    expect(report.reaped).toEqual([]);
    expect(report.kept.map((k) => k.reason)).toContain("recently active; use force to reap");
  });

  it("collects an orphaned session when forced", async () => {
    await makeSession("recent-a3f19c22");
    const report = await reapStaleSessions({ force: true, now: NOW, env });
    expect(report.reaped).toEqual(["recent-a3f19c22"]);
  });

  it("does not treat a recycled pid as a live instance", async () => {
    // Liveness is "this pid is still MY Obsidian", not "some process has this
    // number". The fixture points at this very test runner: alive, but not an
    // Obsidian and not in this session's scope, so it must not count as live.
    // (The genuine live case needs a real instance and is covered by
    // scripts/sessions-live.mjs, which asserts one session survives another's
    // restart.)
    await makeSession("reused-a3f19c22", {
      heartbeatAgeMs: STALE_AFTER_MS + 60_000,
      pid: process.pid,
    });
    const { readDescriptor } = await import("../../src/session/descriptor.js");
    const d = await readDescriptor("reused-a3f19c22", env);
    expect(await sessionState(d!, NOW)).toBe("stale");
  });

  it("never reaps the caller's own session", async () => {
    await makeSession("mine-a3f19c22", { heartbeatAgeMs: STALE_AFTER_MS + 60_000 });
    const report = await reapStaleSessions({ keep: "mine-a3f19c22", now: NOW, env });
    expect(report.reaped).toEqual([]);
    expect(report.kept.map((k) => k.reason)).toContain("current session");
  });

  it("refuses to delete an adopted vault, and says so", async () => {
    // Authorization is consent to operate, never permission to delete. The
    // descriptor claiming ownership must not override the marker on disk.
    const { vaultPath } = await makeSession("adopt-a3f19c22", {
      heartbeatAgeMs: STALE_AFTER_MS + 60_000,
      grant: "adopted",
    });
    const report = await reapStaleSessions({ now: NOW, env, deleteVaults: true });
    expect(await exists(vaultPath)).toBe(true);
    expect(report.reaped).toEqual(["adopt-a3f19c22"]);
  });

  it("never deletes a vault outside the session directory", async () => {
    // Automatic cleanup reclaims a session's own scratch space. A vault the caller
    // pointed elsewhere is a directory a human chose, and an abandoned profile is
    // not a reason to delete it — only an explicit obsidian_close_session is.
    const outside = join(home, "elsewhere", "MyNotes");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "Important.md"), "# my life's work\n", "utf8");
    await makeSession("outside-a3f19c22", {
      heartbeatAgeMs: STALE_AFTER_MS + 60_000,
      vaultPath: outside,
    });

    const report = await reapStaleSessions({ now: NOW, env, deleteVaults: true });
    expect(report.reaped).toEqual(["outside-a3f19c22"]);
    expect(await exists(join(outside, "Important.md"))).toBe(true);
    // The session's own profile is still reclaimed; only the vault is spared.
    expect(await exists(sessionPaths("outside-a3f19c22", env).root)).toBe(false);
  });

  it("keeps the vault when deleteVaults is not set", async () => {
    const { vaultPath } = await makeSession("keep-a3f19c22", {
      heartbeatAgeMs: STALE_AFTER_MS + 60_000,
    });
    await reapStaleSessions({ now: NOW, env });
    expect(await exists(vaultPath)).toBe(true);
  });

  it("does nothing when there are no sessions", async () => {
    const report = await reapStaleSessions({ now: NOW, env });
    expect(report).toMatchObject({ candidates: [], reaped: [], kept: [] });
  });
});
