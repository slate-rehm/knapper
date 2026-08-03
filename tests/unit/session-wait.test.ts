import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const readPortFile = vi.fn();
const probeCdp = vi.fn();
const findPids = vi.fn();
const readStartTime = vi.fn();

vi.mock("../../src/connection/launch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/connection/launch.js")>();
  return { ...actual, readDevToolsPortFile: (...args: unknown[]) => readPortFile(...args) };
});
vi.mock("../../src/connection/cdp/discover.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/connection/cdp/discover.js")>();
  return { ...actual, probeCdp: (...args: unknown[]) => probeCdp(...args) };
});
vi.mock("../../src/connection/health.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/connection/health.js")>();
  return {
    ...actual,
    findObsidianPids: (...args: unknown[]) => findPids(...args),
    readPidStartTime: (...args: unknown[]) => readStartTime(...args),
  };
});

const { waitSession } = await import("../../src/session/registry.js");
const { readDescriptor, writeDescriptor, SESSION_SCHEMA_VERSION } =
  await import("../../src/session/descriptor.js");
const { sessionPaths } = await import("../../src/config.js");

let home: string;
let env: NodeJS.ProcessEnv;
const key = "waiting-a3f19c22";
const spawnedAt = "2026-08-02T12:00:00.000Z";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "knap-wait-"));
  env = { ...process.env, KNAP_HOME: home };
  readPortFile.mockReset();
  probeCdp.mockReset();
  findPids.mockReset().mockResolvedValue([1234]);
  readStartTime.mockReset().mockResolvedValue(5678);
  const paths = sessionPaths(key, env);
  await writeDescriptor(
    {
      schema: SESSION_SCHEMA_VERSION,
      key,
      createdAt: spawnedAt,
      heartbeatAt: spawnedAt,
      readiness: { phase: "starting", spawnedAt, requestedPort: 0 },
      origin: { cwd: "/tmp/worktree" },
      instance: {
        userDataDir: paths.userDataDir,
        runtimeDir: paths.runtimeDir,
        outputDir: paths.outputDir,
        obsidianBin: "obsidian",
      },
    },
    env,
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("waitSession", () => {
  it("finalizes a fresh late CDP port", async () => {
    readPortFile.mockResolvedValue({
      port: 43123,
      browserId: "/devtools/browser/test",
      mtimeMs: Date.parse(spawnedAt) + 1,
    });
    probeCdp.mockResolvedValue({ Browser: "Chrome/142" });

    const descriptor = await waitSession(key, { timeoutMs: 100, env });
    expect(descriptor.readiness.phase).toBe("ready");
    expect(descriptor.instance).toMatchObject({
      cdpPort: 43123,
      cdpUrl: "http://127.0.0.1:43123",
      pid: 1234,
      pidStartTime: 5678,
    });
  });

  it("does not accept a stale port file", async () => {
    readPortFile.mockResolvedValue({
      port: 43123,
      browserId: "/devtools/browser/old",
      mtimeMs: Date.parse(spawnedAt) - 1,
    });
    await expect(waitSession(key, { timeoutMs: 1, env })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect((await readDescriptor(key, env))?.readiness.phase).toBe("starting");
  });

  it("records failure when the scoped process exits", async () => {
    findPids.mockResolvedValue([]);
    await expect(waitSession(key, { timeoutMs: 100, env })).rejects.toMatchObject({
      code: "SESSION_NOT_RUNNING",
    });
    expect((await readDescriptor(key, env))?.readiness.phase).toBe("failed");
  });
});
