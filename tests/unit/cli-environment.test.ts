import type { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ObsidianCli } from "../../src/connection/cli/exec.js";

describe("ObsidianCli desktop environment", () => {
  it("uses the recovered desktop endpoint for a session CLI client", async () => {
    const execute = vi.fn(
      (
        _binary: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "1.12.7\n", "");
      },
    );
    const desktopEnvironment = vi.fn().mockResolvedValue({
      ELECTRON_RUN_AS_NODE: "1",
      XDG_RUNTIME_DIR: "/run/user/1000",
      WAYLAND_DISPLAY: "wayland-1",
      DISPLAY: ":0",
    });
    const cli = new ObsidianCli(
      {
        obsidianBin: "obsidian",
        timeoutMs: 15_000,
        runtimeDir: "/tmp/session-runtime",
        userDataDir: "/tmp/session-profile",
      },
      { execFile: execute as unknown as typeof execFile, desktopEnvironment },
    );

    await expect(cli.run(["version"])).resolves.toBe("1.12.7\n");

    expect(execute).toHaveBeenCalledWith(
      "obsidian",
      ["--user-data-dir=/tmp/session-profile", "version"],
      expect.objectContaining({
        env: expect.objectContaining({
          XDG_RUNTIME_DIR: "/tmp/session-runtime",
          WAYLAND_DISPLAY: "/run/user/1000/wayland-1",
          DISPLAY: ":0",
        }),
      }),
      expect.any(Function),
    );
    const options = execute.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(desktopEnvironment).toHaveBeenCalledTimes(1);
  });

  it("retries desktop discovery after a transient failure", async () => {
    const execute = vi.fn(
      (
        _binary: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "1.12.7\n", ""),
    );
    const desktopEnvironment = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({ DISPLAY: ":0" });
    const cli = new ObsidianCli(
      { obsidianBin: "obsidian", timeoutMs: 15_000 },
      { execFile: execute as unknown as typeof execFile, desktopEnvironment },
    );

    await expect(cli.run(["version"])).rejects.toThrow("transient");
    await expect(cli.run(["version"])).resolves.toBe("1.12.7\n");
    expect(desktopEnvironment).toHaveBeenCalledTimes(2);
  });
});
