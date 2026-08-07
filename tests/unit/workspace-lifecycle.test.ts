import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const findPids = vi.fn();
const quit = vi.fn();

vi.mock("../../src/connection/health.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/connection/health.js")>();
  return {
    ...actual,
    findObsidianPids: (...args: unknown[]) => findPids(...args),
  };
});

vi.mock("../../src/connection/launch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/connection/launch.js")>();
  return {
    ...actual,
    quitObsidian: (...args: unknown[]) => quit(...args),
  };
});

const { readDescriptor, writeDescriptor, SESSION_SCHEMA_VERSION } =
  await import("../../src/session/descriptor.js");
const { quarantineSession, releaseSession, stopSession } =
  await import("../../src/session/registry.js");
const { sessionPaths } = await import("../../src/config.js");

let home: string;
let env: NodeJS.ProcessEnv;
const key = "lifecycle-a3f19c22";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "knap-workspace-lifecycle-"));
  env = { ...process.env, KNAP_HOME: home };
  findPids.mockReset().mockResolvedValue([]);
  quit.mockReset().mockResolvedValue(true);
  const paths = sessionPaths(key, env);
  await mkdir(paths.userDataDir, { recursive: true });
  await mkdir(paths.outputDir, { recursive: true });
  await mkdir(paths.runtimeDir, { recursive: true });
  await mkdir(paths.vaultDir, { recursive: true });
  await writeFile(join(paths.vaultDir, "Keep.md"), "keep", "utf8");
  const [rootIdentity, vaultIdentity] = await Promise.all([stat(paths.root), stat(paths.vaultDir)]);
  await writeDescriptor(
    {
      schema: SESSION_SCHEMA_VERSION,
      key,
      createdAt: "2026-08-06T12:00:00.000Z",
      heartbeatAt: "2026-08-06T12:00:00.000Z",
      readiness: { phase: "ready", readyAt: "2026-08-06T12:00:00.000Z" },
      origin: { cwd: "/tmp/worktree" },
      ownership: {
        rootPath: await realpath(paths.root),
        vaultPath: await realpath(paths.vaultDir),
        rootDevice: rootIdentity.dev,
        rootInode: rootIdentity.ino,
        vaultDevice: vaultIdentity.dev,
        vaultInode: vaultIdentity.ino,
      },
      instance: {
        userDataDir: paths.userDataDir,
        runtimeDir: paths.runtimeDir,
        outputDir: paths.outputDir,
        cdpPort: 43123,
        cdpUrl: "http://127.0.0.1:43123",
        obsidianBin: "obsidian",
        pid: 1234,
        pidStartTime: 5678,
      },
      vault: { id: "abc", name: key, path: paths.vaultDir, grant: "created" },
    },
    env,
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("two-phase workspace lifecycle", () => {
  it("records an already stopped instance and preserves all files", async () => {
    const result = await stopSession(key, { env });
    expect(result.state).toBe("notRunning");
    expect((await readDescriptor(key, env))?.readiness.phase).toBe("stopped");
    expect(await stat(join(sessionPaths(key, env).vaultDir, "Keep.md"))).toBeTruthy();
  });

  it("records a successful quit without removing files", async () => {
    findPids.mockResolvedValue([1234]);
    const result = await stopSession(key, { timeoutMs: 25, env });
    expect(result).toMatchObject({ state: "quitSucceeded", quit: true });
    expect(quit).toHaveBeenCalledWith({ userDataDir: sessionPaths(key, env).userDataDir }, 25);
    expect(await readDescriptor(key, env)).toBeDefined();
    expect(await stat(join(sessionPaths(key, env).vaultDir, "Keep.md"))).toBeTruthy();
  });

  it("preserves files and the descriptor when quit fails", async () => {
    findPids.mockResolvedValue([1234]);
    quit.mockResolvedValue(false);
    const before = await readDescriptor(key, env);

    expect(await stopSession(key, { timeoutMs: 10, env })).toMatchObject({
      state: "quitFailed",
      quit: false,
    });
    expect(await readDescriptor(key, env)).toEqual(before);
    expect(await stat(join(sessionPaths(key, env).vaultDir, "Keep.md"))).toBeTruthy();
  });

  it("refuses to release or quarantine a live instance and never quits it", async () => {
    findPids.mockResolvedValue([1234]);
    await expect(releaseSession(key, { env })).rejects.toMatchObject({
      fixedBy: "obsidian_workspace_stop",
    });
    await expect(quarantineSession(key, { env })).rejects.toMatchObject({
      fixedBy: "obsidian_workspace_stop",
    });
    expect(quit).not.toHaveBeenCalled();
    expect(await readDescriptor(key, env)).toBeDefined();
  });

  it("releases a stopped session but keeps its vault", async () => {
    await releaseSession(key, { env });
    expect(await readDescriptor(key, env)).toBeUndefined();
    expect(await stat(join(sessionPaths(key, env).vaultDir, "Keep.md"))).toBeTruthy();
    await expect(stat(sessionPaths(key, env).userDataDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("quarantines a stopped session", async () => {
    const result = await quarantineSession(key, { env });
    expect(result.quarantinedPath).toContain(join(home, "trash"));
    expect(await stat(join(result.quarantinedPath!, key, "Keep.md"))).toBeTruthy();
    await expect(stat(sessionPaths(key, env).root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
