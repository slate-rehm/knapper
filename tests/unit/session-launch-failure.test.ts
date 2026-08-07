import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launch = vi.fn();

vi.mock("../../src/connection/launch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/connection/launch.js")>();
  return {
    ...actual,
    launchObsidian: (...args: unknown[]) => launch(...args),
    quitObsidian: vi.fn().mockResolvedValue(false),
  };
});

const { createSession, restartSession } = await import("../../src/session/registry.js");
const { readDescriptor, writeDescriptor, SESSION_SCHEMA_VERSION } =
  await import("../../src/session/descriptor.js");
const { sessionPaths } = await import("../../src/config.js");
const { UobError } = await import("../../src/util/errors.js");

let home: string;
let env: NodeJS.ProcessEnv;

function processFailure(): InstanceType<typeof UobError> {
  return new UobError(
    "OBSIDIAN_LAUNCH_FAILED",
    "Obsidian terminated with SIGSEGV before CDP became reachable.",
    {
      details: { signal: "SIGSEGV", stderrTail: "fatal startup detail" },
    },
  );
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "knap-launch-failure-"));
  env = { ...process.env, KNAP_HOME: home };
  launch.mockReset().mockRejectedValue(processFailure());
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("session launch failures", () => {
  it("records a failed create and exposes the launch details", async () => {
    let error: unknown;
    try {
      await createSession({ obsidianBin: "obsidian", env });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: "SESSION_NOT_RUNNING",
      fixedBy: "obsidian_workspace_create",
      details: expect.objectContaining({
        launchError: expect.objectContaining({ signal: "SIGSEGV" }),
      }),
    });
    const key = (error as { details: { session: string } }).details.session;
    expect((await readDescriptor(key, env))?.readiness.phase).toBe("failed");
  });

  it("records a failed restart and exposes the launch details", async () => {
    const key = "restart-a3f19c22";
    const paths = sessionPaths(key, env);
    await writeDescriptor(
      {
        schema: SESSION_SCHEMA_VERSION,
        key,
        createdAt: "2026-08-05T12:00:00.000Z",
        heartbeatAt: "2026-08-05T12:00:00.000Z",
        readiness: { phase: "ready", readyAt: "2026-08-05T12:00:00.000Z" },
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

    await expect(restartSession(key, { env })).rejects.toMatchObject({
      code: "SESSION_NOT_RUNNING",
      fixedBy: "obsidian_workspace_restart",
      details: expect.objectContaining({
        launchError: expect.objectContaining({ signal: "SIGSEGV" }),
      }),
    });
    expect((await readDescriptor(key, env))?.readiness.phase).toBe("failed");
  });
});
