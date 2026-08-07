/**
 * Configuration: CLI flags override env vars override defaults.
 *
 * Cursor plugin `variables` and Claude Code `userConfig` do not unify, so every
 * setting is readable from a plain environment variable and documented per host
 * rather than expressed in three manifest dialects.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isLogLevel, type LogLevel } from "./util/logger.js";
import { parseToolsets, type Toolset } from "./toolsets.js";

/** Transport the MCP server listens on. */
export type TransportKind = "stdio" | "http";
export type CommandTransport = "auto" | "cli" | "playwright";

export const TRANSPORT_KINDS = ["stdio", "http"] as const;

export function isTransportKind(value: string): value is TransportKind {
  return (TRANSPORT_KINDS as readonly string[]).includes(value);
}

export interface Config {
  /** CDP endpoint to attach to. */
  cdpUrl: string;
  /** Port parsed out of cdpUrl, used for launch and error messages. */
  cdpPort: number;
  /** Path to the Obsidian binary. */
  obsidianBin: string;
  /** Target vault name, or undefined to let Obsidian resolve it. */
  vault?: string;
  /**
   * Substring matched against a window's title or URL when choosing a CDP target.
   * Narrows selection when several Obsidian windows are attached; `vault` still
   * wins because it is confirmed against the renderer rather than the title.
   */
  targetMatch?: string;
  /** Which MCP transport to serve. */
  transport: TransportKind;
  /** Listen port for the http transport. */
  httpPort: number;
  /** Listen host for the http transport. Non-loopback values are warned about. */
  httpHost: string;
  /**
   * How many tool calls may run at once. UI mutations are serialized regardless;
   * this caps the read-only calls that are safe to overlap.
   */
  maxConcurrency: number;
  enabledToolsets: Set<Toolset>;
  unknownToolsets: string[];
  logLevel: LogLevel;
  telemetryBuffer: number;
  /**
   * Capture failed network requests alongside console output. Off by default: the
   * two share one ring buffer, and Obsidian's renderer is chatty enough that
   * network events crowd out the plugin errors most sessions are actually after.
   */
  telemetryNetwork: boolean;
  reconnectMs: number;
  /** Directory for screenshots and snapshot files. */
  outputDir: string;
  /** Timeout for a single Obsidian CLI invocation, in ms. */
  cliTimeoutMs: number;
  /** Idle grace for default-profile ownership and disconnected sessions. */
  idleTimeoutMs: number;
  /** Transport preference for renderer commands that both CLI and CDP can serve. */
  commandTransport: CommandTransport;
  /** Session key when this server is bound to one, else undefined. */
  sessionId?: string;
  /**
   * The Obsidian userData directory this server drives. Defaults to the user's own
   * installation; a session points it at a private profile, which is what lets a
   * second Obsidian exist at all (Electron's single-instance lock keys on it).
   */
  userDataDir: string;
  /** `<userDataDir>/obsidian.json` — the vault registry and `cli` flag for this instance. */
  obsidianConfigPath: string;
  /**
   * `XDG_RUNTIME_DIR` for this instance's processes, or undefined outside a session.
   *
   * Obsidian derives its CLI socket path from this variable, so it is what makes a
   * CLI command reach *this* instance rather than whichever one booted last. See
   * `childEnv` for the Wayland hazard that comes with overriding it.
   */
  runtimeDir?: string;
  /**
   * How well the CLI transport is isolated from other sessions.
   *
   * `per-session` — this instance owns its own socket (Linux, runtimeDir set).
   * `shared` — the socket is whatever the platform hands out, so a CLI call may
   * reach another instance; `handleCli` over CDP is the safe route.
   * `none` — no per-session routing is possible at all (Windows keys the pipe on
   * the username, with no env input).
   */
  cliIsolation: CliIsolation;
}

export type CliIsolation = "per-session" | "shared" | "none";

export interface ConfigOverrides {
  cdpUrl?: string;
  obsidianBin?: string;
  vault?: string;
  targetMatch?: string;
  transport?: string;
  httpPort?: number;
  httpHost?: string;
  maxConcurrency?: number;
  toolsets?: string;
  logLevel?: string;
  telemetryBuffer?: number;
  telemetryNetwork?: boolean;
  reconnectMs?: number;
  outputDir?: string;
  cliTimeoutMs?: number;
  commandTransport?: string;
  sessionId?: string;
  userDataDir?: string;
  runtimeDir?: string;
}

export const DEFAULT_CDP_URL = "http://127.0.0.1:9222";

/**
 * The user's own Obsidian userData directory, which holds their vault registry and
 * the global `cli` toggle. Honors the same platform conventions Electron uses.
 *
 * A session overrides this with a private profile, so most code should read
 * `config.userDataDir` rather than calling this. It stays exported because two
 * things genuinely mean *the user's own installation*: `knapper authorize`, which
 * is a human pointing at a vault they can see in their own app, and the reaper's
 * refusal to ever delete this directory.
 */
export function defaultObsidianUserDataDir(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "obsidian");
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "obsidian");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "obsidian");
  }
}

/** Path to `obsidian.json`, which contains the vault registry and the `cli` flag. */
export function obsidianConfigPath(userDataDir = defaultObsidianUserDataDir()): string {
  return join(userDataDir, "obsidian.json");
}

/**
 * Path to the Linux launch-flags file read by distro wrapper scripts. Single-dash
 * tokens here corrupt every CLI invocation, so the doctor checks it.
 *
 * Deliberately NOT session-scoped, and it takes no userData argument. The Arch
 * wrapper reads `${XDG_CONFIG_HOME:-$HOME/.config}/obsidian/user-flags.conf` —
 * a fixed path, resolved before Electron ever sees `--user-data-dir`. Every
 * session therefore inherits the same flags, so the corruption check stays a
 * global concern. Pointing this at a session profile would silently disable one
 * of the four precondition states.
 */
export function userFlagsPath(): string {
  return join(defaultObsidianUserDataDir(), "user-flags.conf");
}

/**
 * Root for everything knapper stores on disk: session profiles, scratch vaults,
 * screenshots, and the descriptors the reaper walks.
 *
 * One helper so no other module hand-builds these paths — the reaper deletes
 * inside this tree, and a second opinion about where it lives is how a delete
 * escapes it.
 */
export function knapperHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KNAP_HOME;
  if (override !== undefined && override !== "") return resolve(override);
  return join(homedir(), ".knapper_mcp");
}

export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(knapperHome(env), "sessions");
}

/** Durable explicit agent handles used by stateless MCP clients. */
export function agentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(knapperHome(env), "agents");
}

/** Explicit workspace-handle records. The records never contain vault content. */
export function workspacesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(knapperHome(env), "workspaces");
}

/** Recoverable session roots awaiting an explicit purge. */
export function trashDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(knapperHome(env), "trash");
}

export function sessionRoot(key: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(sessionsDir(env), key);
}

/** Lock guarding session create/close/reap across knapper processes. */
export function registryLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(knapperHome(env), "registry.lock");
}

/** Short coordination lock for atomic default-profile lease updates. */
export function defaultProfileLeaseLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(knapperHome(env), "default-profile-lease.lock");
}

/** Ownership record for the installation's default Obsidian profile. */
export function defaultProfileLeasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(knapperHome(env), "default-profile-lease.json");
}

/** Per-session directory layout. The only place these names are spelled. */
export interface SessionPaths {
  root: string;
  descriptor: string;
  lock: string;
  userDataDir: string;
  outputDir: string;
  runtimeDir: string;
  vaultDir: string;
}

export function sessionPaths(key: string, env: NodeJS.ProcessEnv = process.env): SessionPaths {
  const root = sessionRoot(key, env);
  return {
    root,
    descriptor: join(root, "session.json"),
    lock: join(root, "session.lock"),
    userDataDir: join(root, "userdata"),
    outputDir: join(root, "output"),
    runtimeDir: join(root, "run"),
    // Named for the session, not "vault", because Obsidian derives a vault's NAME
    // from its directory basename. A fixed name would make every session's vault
    // identically named: legal, since each session has its own registry, but it
    // renders workspace diagnostics, every window title, and `targetMatch`
    // unable to tell two sessions apart.
    vaultDir: join(root, key),
  };
}

/**
 * Where Obsidian will bind this session's CLI socket, given a runtime dir.
 *
 * Mirrors the app's own formula, read from `obsidian.asar`:
 *   win32 → `\\.\pipe\obsidian-cli-<username>`
 *   else  → `join((!darwin && XDG_RUNTIME_DIR) || homedir(), ".obsidian-cli.sock")`
 * Only the Linux branch takes input from the environment, which is why per-session
 * CLI routing is a Linux-only capability.
 */
export function cliSocketPathFor(runtimeDir?: string): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), ".obsidian-cli.sock");
    case "win32":
      return `\\\\.\\pipe\\obsidian-cli-${process.env.USERNAME ?? "user"}`;
    default:
      return join(runtimeDir ?? process.env.XDG_RUNTIME_DIR ?? homedir(), ".obsidian-cli.sock");
  }
}

/**
 * Unix domain socket paths are capped at 108 bytes by `sockaddr_un.sun_path`, and
 * the session key is the only part callers control. Checked when a session is
 * minted so the failure is a typed message about the key rather than an opaque
 * ENAMETOOLONG from `bind()` at launch, long after the name was chosen.
 */
export const MAX_SOCKET_PATH_BYTES = 100;

export function cliIsolationFor(runtimeDir: string | undefined): CliIsolation {
  if (process.platform === "win32") return "none";
  if (process.platform === "linux" && runtimeDir !== undefined) return "per-session";
  return "shared";
}

export function defaultObsidianBin(): string {
  switch (process.platform) {
    case "darwin":
      return "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
    case "win32":
      return join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "Obsidian",
        "Obsidian.exe",
      );
    default:
      return "obsidian";
  }
}

function parsePort(url: string): number {
  try {
    const parsed = new URL(url);
    if (parsed.port !== "") return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return 9222;
  }
}

function numberFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Accept the shapes people actually type in an MCP client's env block. */
function boolFrom(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

function commandTransportFrom(raw: string | undefined): CommandTransport {
  const value = raw ?? "auto";
  if (value === "auto" || value === "cli" || value === "playwright") return value;
  throw new Error(`Invalid KNAP_COMMAND_TRANSPORT "${value}". Use auto, cli, or playwright.`);
}

export function loadConfig(overrides: ConfigOverrides = {}, env = process.env): Config {
  const cdpUrl = overrides.cdpUrl ?? env.OBSIDIAN_CDP_URL ?? DEFAULT_CDP_URL;

  const rawLogLevel = overrides.logLevel ?? env.KNAP_LOG_LEVEL ?? env.LOG_LEVEL ?? "info";
  const logLevel: LogLevel = isLogLevel(rawLogLevel) ? rawLogLevel : "info";

  const { enabled, unknown } = parseToolsets(overrides.toolsets ?? env.KNAP_TOOLSETS);

  const vault = overrides.vault ?? env.OBSIDIAN_VAULT;
  const targetMatch = overrides.targetMatch ?? env.OBSIDIAN_TARGET_MATCH;

  const rawTransport = overrides.transport ?? env.MCP_TRANSPORT ?? "stdio";
  const transport: TransportKind = isTransportKind(rawTransport) ? rawTransport : "stdio";

  // The server starts unbound. Workspace tools can bind an internal isolated
  // instance later, but transport configuration never selects one implicitly.
  const sessionId = overrides.sessionId;
  const userDataDir = overrides.userDataDir ?? defaultObsidianUserDataDir();
  const runtimeDir = overrides.runtimeDir;

  return {
    cdpUrl,
    cdpPort: parsePort(cdpUrl),
    obsidianBin: overrides.obsidianBin ?? env.OBSIDIAN_BIN ?? defaultObsidianBin(),
    ...(vault !== undefined && vault !== "" ? { vault } : {}),
    ...(targetMatch !== undefined && targetMatch !== "" ? { targetMatch } : {}),
    transport,
    httpPort: overrides.httpPort ?? numberFrom(env.MCP_PORT, 9223),
    httpHost: overrides.httpHost ?? env.MCP_HOST ?? "127.0.0.1",
    maxConcurrency: Math.max(
      1,
      overrides.maxConcurrency ?? numberFrom(env.KNAP_MAX_CONCURRENCY, 4),
    ),
    enabledToolsets: enabled,
    unknownToolsets: unknown,
    logLevel,
    telemetryBuffer: overrides.telemetryBuffer ?? numberFrom(env.KNAP_TELEMETRY_BUFFER, 2000),
    telemetryNetwork: overrides.telemetryNetwork ?? boolFrom(env.KNAP_TELEMETRY_NETWORK, false),
    reconnectMs:
      overrides.reconnectMs ?? numberFrom(env.KNAP_RECONNECT_MS ?? env.RECONNECT_MS, 2000),
    outputDir:
      overrides.outputDir ??
      env.KNAP_SCREENSHOT_DIR ??
      env.SCREENSHOT_DIR ??
      join(process.cwd(), ".knapper"),
    cliTimeoutMs: overrides.cliTimeoutMs ?? numberFrom(env.KNAP_CLI_TIMEOUT_MS, 15_000),
    idleTimeoutMs: Math.max(30_000, numberFrom(env.KNAP_IDLE_TIMEOUT_MS, 24 * 60 * 60_000)),
    commandTransport: commandTransportFrom(
      overrides.commandTransport ?? env.KNAP_COMMAND_TRANSPORT,
    ),
    ...(sessionId !== undefined ? { sessionId } : {}),
    userDataDir,
    obsidianConfigPath: obsidianConfigPath(userDataDir),
    ...(runtimeDir !== undefined ? { runtimeDir } : {}),
    cliIsolation: cliIsolationFor(runtimeDir),
  };
}
