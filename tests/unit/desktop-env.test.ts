import { describe, expect, it, vi } from "vitest";
import {
  resolveDesktopEnvironment,
  type DesktopEnvironmentRuntime,
  type PathInfo,
} from "../../src/connection/desktop-env.js";

function fakeRuntime(
  paths: Record<string, PathInfo>,
  lists: Record<string, string[]> = {},
  systemd = "",
): DesktopEnvironmentRuntime {
  return {
    getuid: () => 1000,
    pathInfo: async (path) => paths[path],
    list: async (path) => lists[path] ?? [],
    showUserEnvironment: vi.fn().mockResolvedValue(systemd),
  };
}

const directory = (uid = 1000): PathInfo => ({ kind: "directory", uid, mtimeMs: 1 });
const socket = (mtimeMs = 1): PathInfo => ({ kind: "socket", uid: 1000, mtimeMs });

describe("resolveDesktopEnvironment", () => {
  it("preserves an explicit display without consulting systemd", async () => {
    const runtime = fakeRuntime({ "/tmp/.X11-unix/X7": socket() });
    const result = await resolveDesktopEnvironment({ DISPLAY: ":7" }, runtime);

    expect(result).toMatchObject({ source: "ambient", transport: "x11", recovered: [] });
    expect(runtime.showUserEnvironment).not.toHaveBeenCalled();
  });

  it("bootstraps systemd from the validated user runtime and bus", async () => {
    const runtime = fakeRuntime(
      {
        "/run/user/1000": directory(),
        "/run/user/1000/bus": socket(),
        "/tmp/.X11-unix/X3": socket(),
      },
      {},
      [
        "DISPLAY=:3",
        "WAYLAND_DISPLAY=wayland-1",
        "XDG_RUNTIME_DIR=/run/user/1000",
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      ].join("\n"),
    );

    const result = await resolveDesktopEnvironment({}, runtime);

    expect(result).toMatchObject({ source: "systemd-user", transport: "x11" });
    expect(result.env).toMatchObject({
      DISPLAY: ":3",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    expect(runtime.showUserEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      }),
    );
  });

  it("chooses the lowest valid X11 socket when systemd is unavailable", async () => {
    const runtime = fakeRuntime(
      {
        "/run/user/1000": directory(),
        "/tmp/.X11-unix/X0": socket(),
        "/tmp/.X11-unix/X2": socket(),
      },
      { "/tmp/.X11-unix": ["X2", "X0_", "X0"] },
    );
    runtime.showUserEnvironment = vi.fn().mockRejectedValue(new Error("no user bus"));

    const result = await resolveDesktopEnvironment({}, runtime);

    expect(result).toMatchObject({ source: "x11-socket", transport: "x11" });
    expect(result.env.DISPLAY).toBe(":0");
  });

  it("chooses the newest Wayland socket when X11 is unavailable", async () => {
    const runtime = fakeRuntime(
      {
        "/run/user/1000": directory(),
        "/run/user/1000/wayland-0": socket(10),
        "/run/user/1000/wayland-1": socket(20),
      },
      {
        "/tmp/.X11-unix": [],
        "/run/user/1000": ["wayland-0", "wayland-1", "wayland-1.lock"],
      },
    );

    const result = await resolveDesktopEnvironment({}, runtime);

    expect(result).toMatchObject({ source: "wayland-socket", transport: "wayland" });
    expect(result.env.WAYLAND_DISPLAY).toBe("/run/user/1000/wayland-1");
  });

  it("replaces an inherited Wayland endpoint after it proves unusable", async () => {
    const runtime = fakeRuntime(
      {
        "/run/user/1000": directory(),
        "/run/user/1000/bus": socket(),
        "/run/user/1000/wayland-1": socket(),
      },
      {},
      [
        "WAYLAND_DISPLAY=wayland-1",
        "XDG_RUNTIME_DIR=/run/user/1000",
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
      ].join("\n"),
    );

    const result = await resolveDesktopEnvironment(
      { WAYLAND_DISPLAY: "wayland-dead", XDG_RUNTIME_DIR: "/tmp/private-runtime" },
      runtime,
    );

    expect(result).toMatchObject({ source: "systemd-user", transport: "wayland" });
    expect(result.env.WAYLAND_DISPLAY).toBe("/run/user/1000/wayland-1");
    expect(result.env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
  });

  it("replaces a stale local X11 display with the discovered socket", async () => {
    const runtime = fakeRuntime(
      {
        "/run/user/1000": directory(),
        "/tmp/.X11-unix/X0": socket(),
      },
      { "/tmp/.X11-unix": ["X0"] },
    );

    const result = await resolveDesktopEnvironment({ DISPLAY: ":99" }, runtime);

    expect(result).toMatchObject({ source: "x11-socket", transport: "x11" });
    expect(result.env.DISPLAY).toBe(":0");
  });

  it("removes a rejected Wayland endpoint when it falls back to X11", async () => {
    const runtime = fakeRuntime(
      {
        "/run/user/1000": directory(),
        "/tmp/.X11-unix/X0": socket(),
      },
      { "/tmp/.X11-unix": ["X0"] },
    );

    const result = await resolveDesktopEnvironment(
      { WAYLAND_DISPLAY: "wayland-dead", XDG_RUNTIME_DIR: "/tmp/private-runtime" },
      runtime,
    );

    expect(result).toMatchObject({ source: "x11-socket", transport: "x11" });
    expect(result.env.WAYLAND_DISPLAY).toBeUndefined();
  });

  it("removes a rejected X11 endpoint when it falls back to Wayland", async () => {
    const runtime = fakeRuntime(
      {
        "/run/user/1000": directory(),
        "/run/user/1000/wayland-0": socket(),
      },
      { "/run/user/1000": ["wayland-0"] },
    );

    const result = await resolveDesktopEnvironment(
      { DISPLAY: ":99", XDG_RUNTIME_DIR: "/run/user/1000" },
      runtime,
    );

    expect(result).toMatchObject({ source: "wayland-socket", transport: "wayland" });
    expect(result.env.DISPLAY).toBeUndefined();
  });
});
