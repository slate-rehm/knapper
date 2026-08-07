import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  buildLaunchArgs,
  buildSystemdRunArgs,
  createObsidianLauncher,
} from "../../src/connection/launch.js";

interface FakeChild extends ChildProcess {
  stdout: PassThrough;
  stderr: PassThrough;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4321;
  child.unref = vi.fn().mockReturnValue(child);
  return child;
}

function spawnThen(child: FakeChild, action: () => void): typeof spawn {
  return vi.fn().mockImplementation(() => {
    queueMicrotask(action);
    return child;
  }) as unknown as typeof spawn;
}

function launcherRuntime(
  child: FakeChild,
  overrides: {
    probe?: ReturnType<typeof vi.fn>;
    findPids?: ReturnType<typeof vi.fn>;
    spawnProcess?: typeof spawn;
    desktopTransport?: "x11" | "wayland";
  } = {},
) {
  let clock = 0;
  const probe = overrides.probe ?? vi.fn().mockResolvedValue(undefined);
  const findPids = overrides.findPids ?? vi.fn().mockResolvedValue([]);
  const spawnProcess =
    overrides.spawnProcess ??
    (vi.fn().mockReturnValue(child) as unknown as typeof import("node:child_process").spawn);
  return {
    launch: createObsidianLauncher({
      spawnProcess,
      resolveDesktop: async () => ({
        env: {},
        transport: overrides.desktopTransport ?? "x11",
        source: "ambient",
        recovered: [],
      }),
      isRunning: async () => false,
      findPids,
      readPortFile: async () => undefined,
      readStartTime: async () => 5678,
      probe,
      sleep: async (ms) => {
        clock += ms;
        await Promise.resolve();
      },
      now: () => clock,
      removePortFile: async () => undefined,
    }),
    probe,
    findPids,
    spawnProcess,
  };
}

describe("launchObsidian process observation", () => {
  it("gives private Linux sessions a distinct desktop class", () => {
    const args = buildLaunchArgs(9222, "/tmp/private-profile", "x11");
    if (process.platform === "linux") {
      expect(args).toContain("--class=KnapperTestSession");
    } else {
      expect(args).not.toContain("--class=KnapperTestSession");
    }
    expect(buildLaunchArgs(9222, undefined, "x11")).not.toContain("--class=KnapperTestSession");
  });

  it("builds a transient user service without forwarding unrelated secrets", () => {
    const args = buildSystemdRunArgs({
      unit: "knapper-test.service",
      command: "obsidian",
      args: ["--remote-debugging-port=0"],
      env: {
        HOME: "/home/test",
        XDG_RUNTIME_DIR: "/tmp/private-run",
        WAYLAND_DISPLAY: "/run/user/1000/wayland-1",
        OPENROUTER_API_KEY: "must-not-leak",
      },
      stdoutLog: "/tmp/stdout.log",
      stderrLog: "/tmp/stderr.log",
    });

    expect(args).toContain("--user");
    expect(args).toContain("--collect");
    expect(args).toContain("--setenv=XDG_RUNTIME_DIR=/tmp/private-run");
    expect(args).toContain("--setenv=WAYLAND_DISPLAY=/run/user/1000/wayland-1");
    expect(args).toContain("--property=StandardOutput=append:/tmp/stdout.log");
    expect(args).toEqual(expect.not.arrayContaining([expect.stringContaining("OPENROUTER")]));
    expect(args.slice(-2)).toEqual(["obsidian", "--remote-debugging-port=0"]);
  });

  it("reports a signal and captured output before the launch timeout", async () => {
    const child = fakeChild();
    const runtime = launcherRuntime(child, {
      spawnProcess: spawnThen(child, () => {
        child.stderr.write("fatal startup detail");
        child.emit("exit", null, "SIGSEGV");
      }),
    });

    await expect(
      runtime.launch({
        obsidianBin: "obsidian",
        port: 9222,
        timeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({
      code: "OBSIDIAN_LAUNCH_FAILED",
      fixedBy: "obsidian_launch",
      details: expect.objectContaining({
        signal: "SIGSEGV",
        stderrTail: "fatal startup detail",
      }),
    });
  });

  it("does not mistake a clean wrapper exit for a crash", async () => {
    const child = fakeChild();
    const probe = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ Browser: "Chrome/142" });
    const runtime = launcherRuntime(child, {
      probe,
      findPids: vi.fn().mockResolvedValue([9876]),
      spawnProcess: spawnThen(child, () => child.emit("exit", 0, null)),
    });

    await expect(
      runtime.launch({ obsidianBin: "obsidian", port: 9222, timeoutMs: 5_000 }),
    ).resolves.toMatchObject({ port: 9222, pid: 9876, pidStartTime: 5678 });
  });

  it("keeps polling after a failed wrapper when the scoped app survives", async () => {
    const child = fakeChild();
    const probe = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ Browser: "Chrome/142" });
    const runtime = launcherRuntime(child, {
      probe,
      findPids: vi.fn().mockResolvedValue([9876]),
      spawnProcess: spawnThen(child, () => child.emit("exit", 1, null)),
    });

    await expect(
      runtime.launch({ obsidianBin: "obsidian", port: 9222, timeoutMs: 5_000 }),
    ).resolves.toMatchObject({ port: 9222, pid: 9876 });
  });

  it("bounds output for a live process that never exposes CDP", async () => {
    const child = fakeChild();
    const runtime = launcherRuntime(child, {
      findPids: vi.fn().mockResolvedValue([4321]),
      spawnProcess: spawnThen(child, () => child.stdout.write(`prefix-${"x".repeat(10_000)}`)),
    });

    let error: unknown;
    try {
      await runtime.launch({
        obsidianBin: "obsidian",
        port: 9222,
        timeoutMs: 700,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      code: "TIMEOUT",
      details: expect.objectContaining({ stdoutTail: expect.any(String) }),
    });
    const stdoutTail = (error as { details: { stdoutTail: string } }).details.stdoutTail;
    expect(Buffer.byteLength(stdoutTail)).toBeLessThanOrEqual(8 * 1024);
    expect(stdoutTail.endsWith("x".repeat(100))).toBe(true);
  });

  it("uses explicit Wayland when no X11 endpoint is available", async () => {
    const child = fakeChild();
    const probe = vi.fn().mockResolvedValue({ Browser: "Chrome/142" });
    const runtime = launcherRuntime(child, {
      probe,
      findPids: vi.fn().mockResolvedValue([4321]),
      desktopTransport: "wayland",
    });

    await runtime.launch({
      obsidianBin: "obsidian",
      port: 9222,
      timeoutMs: 1_000,
    });

    expect(runtime.spawnProcess).toHaveBeenCalledWith(
      "obsidian",
      expect.arrayContaining(["--ozone-platform=wayland"]),
      expect.any(Object),
    );
  });
});
