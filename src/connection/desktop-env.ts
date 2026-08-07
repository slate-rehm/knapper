/**
 * Recover the desktop endpoints that Electron needs when an MCP host strips them.
 *
 * The private XDG runtime used by a knapper session must not become the discovery
 * root. It contains the session's CLI socket, not the compositor or user bus. On
 * Linux, `/run/user/<uid>` gives discovery a bootstrap path that needs no ambient
 * desktop variables.
 */

import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const RECOVERED_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
] as const;

type RecoveredKey = (typeof RECOVERED_KEYS)[number];

export type DesktopTransport = "x11" | "wayland" | "unavailable";

export interface DesktopEnvironmentResult {
  env: NodeJS.ProcessEnv;
  transport: DesktopTransport;
  source: "ambient" | "systemd-user" | "x11-socket" | "wayland-socket" | "none";
  recovered: RecoveredKey[];
}

export interface PathInfo {
  kind: "directory" | "socket" | "other";
  uid: number;
  mtimeMs: number;
}

export interface DesktopEnvironmentRuntime {
  getuid(): number | undefined;
  pathInfo(path: string): Promise<PathInfo | undefined>;
  list(path: string): Promise<string[]>;
  showUserEnvironment(env: NodeJS.ProcessEnv): Promise<string>;
}

const defaultRuntime: DesktopEnvironmentRuntime = {
  getuid: () => process.getuid?.(),
  pathInfo: async (path) => {
    try {
      const value = await stat(path);
      return {
        kind: value.isDirectory() ? "directory" : value.isSocket() ? "socket" : "other",
        uid: value.uid,
        mtimeMs: value.mtimeMs,
      };
    } catch {
      return undefined;
    }
  },
  list: async (path) => readdir(path).catch(() => []),
  showUserEnvironment: (env) =>
    new Promise((resolve, reject) => {
      execFile(
        "systemctl",
        ["--user", "show-environment"],
        { env, timeout: 1_500, maxBuffer: 64 * 1024 },
        (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
      );
    }),
};

function parseSystemdEnvironment(text: string): Partial<Record<RecoveredKey, string>> {
  const allowed = new Set<string>(RECOVERED_KEYS);
  const result: Partial<Record<RecoveredKey, string>> = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (!allowed.has(key) || value === "" || value.startsWith("$'")) continue;
    result[key as RecoveredKey] = value;
  }
  return result;
}

function x11Socket(display: string): string | undefined {
  const match = /^:(\d+)(?:\.\d+)?$/.exec(display);
  return match?.[1] === undefined ? undefined : `/tmp/.X11-unix/X${match[1]}`;
}

async function isSocket(path: string, runtime: DesktopEnvironmentRuntime): Promise<boolean> {
  return (await runtime.pathInfo(path))?.kind === "socket";
}

async function usableWaylandPath(
  display: string | undefined,
  runtimeDir: string | undefined,
  runtime: DesktopEnvironmentRuntime,
): Promise<string | undefined> {
  if (display === undefined || display === "") return undefined;
  const path = display.startsWith("/")
    ? display
    : runtimeDir === undefined || runtimeDir === ""
      ? undefined
      : join(runtimeDir, display);
  return path !== undefined && (await isSocket(path, runtime)) ? path : undefined;
}

function mergeRecovered(
  base: NodeJS.ProcessEnv,
  values: Partial<Record<RecoveredKey, string>>,
  replace: readonly RecoveredKey[] = [],
): { env: NodeJS.ProcessEnv; recovered: RecoveredKey[] } {
  const env = { ...base };
  const recovered: RecoveredKey[] = [];
  for (const key of RECOVERED_KEYS) {
    if (
      (env[key] === undefined || env[key] === "" || replace.includes(key)) &&
      values[key] !== undefined
    ) {
      env[key] = values[key];
      recovered.push(key);
    }
  }
  return { env, recovered };
}

/** Resolve a usable local desktop endpoint without changing explicit caller values. */
export async function resolveDesktopEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  runtime: DesktopEnvironmentRuntime = defaultRuntime,
): Promise<DesktopEnvironmentResult> {
  if (process.platform !== "linux") {
    return { env: { ...base }, transport: "unavailable", source: "ambient", recovered: [] };
  }

  let replaceDisplay = false;
  let replaceWayland = false;
  let validX11 = false;
  if (base.DISPLAY !== undefined && base.DISPLAY !== "") {
    const displaySocket = x11Socket(base.DISPLAY);
    validX11 = displaySocket === undefined || (await isSocket(displaySocket, runtime));
    replaceDisplay = !validX11;
  }
  const validWayland =
    (await usableWaylandPath(base.WAYLAND_DISPLAY, base.XDG_RUNTIME_DIR, runtime)) !== undefined;
  replaceWayland =
    base.WAYLAND_DISPLAY !== undefined && base.WAYLAND_DISPLAY !== "" && !validWayland;

  const forTransport = (
    merged: { env: NodeJS.ProcessEnv; recovered: RecoveredKey[] },
    transport: "x11" | "wayland",
  ): { env: NodeJS.ProcessEnv; recovered: RecoveredKey[] } => {
    if (transport === "x11" && replaceWayland) {
      delete merged.env.WAYLAND_DISPLAY;
      if (!merged.recovered.includes("WAYLAND_DISPLAY")) merged.recovered.push("WAYLAND_DISPLAY");
    }
    if (transport === "wayland" && replaceDisplay) {
      delete merged.env.DISPLAY;
      if (!merged.recovered.includes("DISPLAY")) merged.recovered.push("DISPLAY");
    }
    return merged;
  };

  if (validX11) {
    const merged = forTransport({ env: { ...base }, recovered: [] }, "x11");
    return { ...merged, transport: "x11", source: "ambient" };
  }
  if (validWayland) {
    const merged = forTransport({ env: { ...base }, recovered: [] }, "wayland");
    return { ...merged, transport: "wayland", source: "ambient" };
  }

  const uid = runtime.getuid();
  if (uid === undefined) {
    return { env: { ...base }, transport: "unavailable", source: "none", recovered: [] };
  }
  const userRuntime = `/run/user/${uid}`;
  const runtimeInfo = await runtime.pathInfo(userRuntime);
  if (runtimeInfo?.kind !== "directory" || runtimeInfo.uid !== uid) {
    return { env: { ...base }, transport: "unavailable", source: "none", recovered: [] };
  }

  const busPath = join(userRuntime, "bus");
  const busUsable = await isSocket(busPath, runtime);
  const expectedBus = `unix:path=${busPath}`;
  const infrastructureReplacements: RecoveredKey[] = [];
  const displayReplacements: RecoveredKey[] = replaceDisplay ? ["DISPLAY"] : [];
  if (base.XDG_RUNTIME_DIR !== userRuntime) infrastructureReplacements.push("XDG_RUNTIME_DIR");
  if (busUsable && base.DBUS_SESSION_BUS_ADDRESS !== expectedBus) {
    infrastructureReplacements.push("DBUS_SESSION_BUS_ADDRESS");
  }
  if (busUsable) {
    try {
      const queryEnv = {
        ...base,
        XDG_RUNTIME_DIR: userRuntime,
        DBUS_SESSION_BUS_ADDRESS: expectedBus,
      };
      const systemd = parseSystemdEnvironment(await runtime.showUserEnvironment(queryEnv));
      const displaySocket = systemd.DISPLAY === undefined ? undefined : x11Socket(systemd.DISPLAY);
      if (displaySocket !== undefined && (await isSocket(displaySocket, runtime))) {
        const merged = mergeRecovered(
          base,
          {
            ...systemd,
            XDG_RUNTIME_DIR: systemd.XDG_RUNTIME_DIR ?? userRuntime,
            DBUS_SESSION_BUS_ADDRESS: systemd.DBUS_SESSION_BUS_ADDRESS ?? expectedBus,
          },
          [...infrastructureReplacements, ...displayReplacements],
        );
        return { ...forTransport(merged, "x11"), transport: "x11", source: "systemd-user" };
      }

      const wayland = await usableWaylandPath(
        systemd.WAYLAND_DISPLAY,
        systemd.XDG_RUNTIME_DIR ?? userRuntime,
        runtime,
      );
      if (wayland !== undefined) {
        const merged = mergeRecovered(
          base,
          {
            ...systemd,
            WAYLAND_DISPLAY: wayland,
            XDG_RUNTIME_DIR: systemd.XDG_RUNTIME_DIR ?? userRuntime,
            DBUS_SESSION_BUS_ADDRESS: systemd.DBUS_SESSION_BUS_ADDRESS ?? expectedBus,
          },
          [...infrastructureReplacements, "WAYLAND_DISPLAY"],
        );
        return {
          ...forTransport(merged, "wayland"),
          transport: "wayland",
          source: "systemd-user",
        };
      }
    } catch {
      // Socket discovery below keeps systemd optional.
    }
  }

  const x11Candidates = (await runtime.list("/tmp/.X11-unix"))
    .map((name) => ({ name, match: /^X(\d+)$/.exec(name) }))
    .filter((candidate): candidate is { name: string; match: RegExpExecArray } =>
      Boolean(candidate.match),
    )
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  for (const candidate of x11Candidates) {
    const info = await runtime.pathInfo(join("/tmp/.X11-unix", candidate.name));
    if (info?.kind !== "socket" || (info.uid !== uid && info.uid !== 0)) continue;
    const merged = mergeRecovered(
      base,
      {
        DISPLAY: `:${candidate.match[1]}`,
        XDG_RUNTIME_DIR: userRuntime,
        ...(busUsable ? { DBUS_SESSION_BUS_ADDRESS: expectedBus } : {}),
      },
      [...infrastructureReplacements, ...displayReplacements],
    );
    return { ...forTransport(merged, "x11"), transport: "x11", source: "x11-socket" };
  }

  const waylandCandidates = await Promise.all(
    (await runtime.list(userRuntime))
      .filter((name) => /^wayland-\d+$/.test(name))
      .map(async (name) => ({ name, info: await runtime.pathInfo(join(userRuntime, name)) })),
  );
  waylandCandidates.sort(
    (a, b) => (b.info?.mtimeMs ?? 0) - (a.info?.mtimeMs ?? 0) || a.name.localeCompare(b.name),
  );
  for (const candidate of waylandCandidates) {
    if (candidate.info?.kind !== "socket") continue;
    const merged = mergeRecovered(
      base,
      {
        WAYLAND_DISPLAY: join(userRuntime, candidate.name),
        XDG_RUNTIME_DIR: userRuntime,
        ...(busUsable ? { DBUS_SESSION_BUS_ADDRESS: expectedBus } : {}),
      },
      [...infrastructureReplacements, "WAYLAND_DISPLAY"],
    );
    return {
      ...forTransport(merged, "wayland"),
      transport: "wayland",
      source: "wayland-socket",
    };
  }

  return { env: { ...base }, transport: "unavailable", source: "none", recovered: [] };
}
