/**
 * The Obsidian native CLI transport.
 *
 * This is not a conventional argv-parsed CLI. Invoking the binary attempts a
 * single-instance lock; failing to get it means an instance is already running, so
 * the process becomes a *client* that forwards `{argv, tty, cwd}` over an IPC
 * socket to the running app, which executes `window.handleCli(argv)` in the
 * renderer and pipes the result back. Consequences that shape this module:
 *
 *  - It cannot work headlessly; the GUI must be running.
 *  - Commands arriving before the renderer is layout-ready are *queued*, not
 *    rejected, so they block rather than fail. Hence a generous default timeout.
 *  - Failures are reported as ordinary stdout strings with exit code 0, so the
 *    sentinel markers must be string-matched.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { wrapExpression } from "../../util/serialize.js";
import {
  CLI_DISABLED_MARKER,
  VAULT_NOT_FOUND_MARKER,
  cliDisabled,
  UobError,
} from "../../util/errors.js";

export interface CliOptions {
  obsidianBin: string;
  timeoutMs: number;
  /**
   * `XDG_RUNTIME_DIR` for spawned CLI clients, which is what routes a command to
   * one specific instance. Undefined means the ambient one, i.e. whichever Obsidian
   * currently owns the shared socket.
   */
  runtimeDir?: string;
  /**
   * Passed as `--user-data-dir` on every invocation so this process loses the
   * target instance's singleton lock and becomes a *forwarding client*. Without it
   * a CLI call can win the default profile's lock instead and cold-boot an entirely
   * new Obsidian rather than talking to the session's. Obsidian's own argv
   * prefilter drops `--`-prefixed tokens before `handleCli` sees them, so the flag
   * never reaches the command.
   */
  userDataDir?: string;
}

export interface CliResult {
  stdout: string;
  stderr: string;
}

/**
 * Environment for a spawned Obsidian process.
 *
 * `ELECTRON_RUN_AS_NODE=1` tells an Electron binary to behave as a bare Node
 * runtime, which makes `require("electron")` fail — and Obsidian's `app.asar`
 * requires it on the first line. Electron-based MCP clients (Claude Code, Cursor,
 * VS Code, Claude Desktop) set this for their child processes, so it arrives in
 * our environment through no fault of the user's, and we inherit it straight into
 * the CLI. Every call then dies with `Cannot find module 'electron'`, which looks
 * like a broken Obsidian install rather than an inherited env var.
 *
 * Stripping it is always correct here: we are launching a desktop application, and
 * never want it as a plain Node process.
 *
 * `runtimeDir` selects which Obsidian instance this process talks to, because the
 * app derives its CLI socket path from `XDG_RUNTIME_DIR`. Overriding that variable
 * has a second, non-obvious effect that must be compensated for here — see
 * `waylandDisplayFor`.
 */
export function childEnv(runtimeDir?: string): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _stripped, ...rest } = process.env;
  if (runtimeDir === undefined) return rest;

  const env: NodeJS.ProcessEnv = { ...rest, XDG_RUNTIME_DIR: runtimeDir };
  const wayland = waylandDisplayFor(rest);
  if (wayland !== undefined) env.WAYLAND_DISPLAY = wayland;
  return env;
}

/**
 * Absolute Wayland socket path to pin before `XDG_RUNTIME_DIR` is overridden, or
 * undefined when nothing needs pinning.
 *
 * `XDG_RUNTIME_DIR` is not Obsidian's variable. It is also where a Wayland client
 * resolves a relative `WAYLAND_DISPLAY` such as `wayland-1`. Point it at an empty
 * per-session directory and Electron never reaches the compositor: no window, no
 * renderer, no `DevToolsActivePort`, no CLI socket — just a main process spinning
 * at 25% CPU indefinitely, with nothing in any log to say why. A byte-for-byte
 * copy of a known-good profile fails the same way, which is what pins the cause on
 * the variable rather than the profile.
 *
 * libwayland accepts an absolute `WAYLAND_DISPLAY` and uses it verbatim without
 * consulting `XDG_RUNTIME_DIR`, so resolving it against the real runtime dir first
 * keeps the compositor connection intact. `DBUS_SESSION_BUS_ADDRESS` already
 * carries an absolute `unix:path=`, so it needs no equivalent.
 */
export function waylandDisplayFor(env: NodeJS.ProcessEnv): string | undefined {
  const display = env.WAYLAND_DISPLAY;
  if (display === undefined || display === "" || display.startsWith("/")) return undefined;
  const realRuntime = env.XDG_RUNTIME_DIR;
  if (realRuntime === undefined || realRuntime === "") return undefined;
  return join(realRuntime, display);
}

/**
 * Commands that genuinely have no vault to scope to.
 *
 * Everything else must carry `vault=`. These three answer questions about the
 * installation rather than about notes, and the health probe needs `version` to
 * work before any vault has been resolved.
 */
export const VAULT_AGNOSTIC_COMMANDS = new Set(["version", "help", "__completions"]);

/**
 * Build the argv for an Obsidian CLI call.
 *
 * `vault=` must be the very first token, before the command name. Obsidian's own
 * pre-filter drops every `--`-prefixed token except a small whitelist, so callers
 * must express options as `key=value` or bare flags rather than `--flag`.
 *
 * Omitting `vault=` is not "use the default" — Obsidian falls back to whichever
 * vault the user last focused, which makes the target a property of where they
 * happened to click last. That silent coin flip is why this throws instead of
 * building an unscoped call: the fence resolves a vault up front, and a command
 * arriving here without one means a caller bypassed it.
 */
export function buildArgs(command: string[], vault?: string): string[] {
  if (vault !== undefined && vault !== "") return [`vault=${vault}`, ...command];

  const name = command[0] ?? "";
  if (!VAULT_AGNOSTIC_COMMANDS.has(name)) {
    throw new UobError(
      "VAULT_NOT_AUTHORIZED",
      `Refusing to run the Obsidian CLI command "${name}" without a vault.`,
      {
        remediation:
          "With no `vault=` token Obsidian targets whichever vault was last focused, so this call " +
          "could land anywhere. Pass an explicit `vault` argument, or set OBSIDIAN_VAULT for the " +
          "session. This is a bug in knapper if you did not call the CLI directly.",
        details: { command: name },
      },
    );
  }
  return [...command];
}

/** Quote a value for the `key=value` grammar, escaping newlines and tabs. */
export function cliValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/**
 * Make a program safe to send through the `key=value` argv grammar.
 *
 * `cliValue` escapes a newline to the two characters `\` and `n`, and nothing on
 * Obsidian's side turns them back. For most commands that is right — the value is
 * data. For `eval` the value is *source code*, so those two characters land in the
 * middle of a program and it dies with `Invalid or unexpected token`, which reads
 * like a syntax error in the caller's own JavaScript rather than a transport bug.
 * Every multi-line eval failed this way.
 *
 * Base64 sidesteps the grammar: the payload becomes one line of `[A-Za-z0-9+/=]`
 * with nothing left for the escaper to touch. Single-line code is passed through
 * untouched so the common case stays readable in logs.
 *
 * The payload runs as a `new Function` body, not through `eval`, because this
 * tool's contract is "a bare expression, or a statement body with an explicit
 * return" — and a top-level `return` is a syntax error inside eval. `wrapExpression`
 * supplies the `return` for a bare expression and leaves an existing one alone.
 * The body still sees globals, which is where `app` lives.
 */
export function encodeEvalSource(code: string): string {
  if (!/[\n\r]/.test(code)) return code;
  const b64 = Buffer.from(wrapExpression(code), "utf8").toString("base64");
  return `new Function(atob(${JSON.stringify(b64)}))()`;
}

export interface ClassifyCliOptions {
  /**
   * When true, leave bare `Error: …` lines for `classifyEvalOutput` — Obsidian
   * prints in-page throws the same way it prints CLI failures, both with exit 0.
   */
  allowEvalErrors?: boolean;
}

/**
 * Strip the optional `Error: ` prefix Obsidian adds to many CLI failures.
 * Measured against 1.12.7: unknown commands print
 * `Error: Command "…" not found. It may require a plugin to be enabled.`
 */
function cliErrorBody(trimmed: string): string {
  return trimmed.replace(/^Error:\s*/, "");
}

/**
 * Classify CLI stdout, since Obsidian reports failures as ordinary output with
 * exit code 0 rather than as a non-zero exit. Pure, so the sentinel handling can
 * be tested without spawning anything.
 *
 * Returns undefined when the output represents success.
 */
export function classifyCliOutput(
  stdout: string,
  vault?: string,
  opts: ClassifyCliOptions = {},
): UobError | undefined {
  const trimmed = stdout.trim();

  if (trimmed.includes(CLI_DISABLED_MARKER)) return cliDisabled();

  // We strip ELECTRON_RUN_AS_NODE before spawning (see childEnv), so seeing this
  // means something else in the chain re-introduced it — a wrapper script, a shell
  // profile, or a launcher. Name it precisely; the raw stack reads like a broken
  // Obsidian install and sends people reinstalling the app for no reason.
  if (trimmed.includes("Cannot find module 'electron'")) {
    return new UobError(
      "ARGV_CORRUPTION",
      "The Obsidian binary started as a bare Node process and could not load Electron.",
      {
        remediation:
          "ELECTRON_RUN_AS_NODE is set in the environment Obsidian inherited. Unset it for the " +
          "MCP server's process (Electron-based clients such as Claude Code, Cursor, and VS Code " +
          "set it for child processes), or check your Obsidian wrapper script for it.",
        details: { variable: "ELECTRON_RUN_AS_NODE" },
      },
    );
  }

  if (trimmed === VAULT_NOT_FOUND_MARKER) {
    return new UobError("VAULT_NOT_FOUND", `Obsidian does not know a vault named "${vault}".`, {
      remediation: "List the registered vaults and use one of those names.",
      details: { requested: vault },
    });
  }

  const body = cliErrorBody(trimmed);

  // A surviving single-dash token in the distro wrapper's flags file lands in
  // argv[0] and comes back as an unknown command. Live shape includes an
  // optional `Error: ` prefix and a trailing hint sentence.
  const argvCorruption = /^Command "(-[^"]*)" not found\./.exec(body);
  if (argvCorruption) {
    return new UobError(
      "ARGV_CORRUPTION",
      `Obsidian rejected "${argvCorruption[1]}" as a command name, which means a single-dash launch flag is leaking into CLI argv.`,
      {
        remediation:
          "Edit Obsidian's user-flags.conf and use a double dash (e.g. `--disable-gpu`), or remove the line.",
        details: { token: argvCorruption[1] },
      },
    );
  }

  const unknownCommand = /^Command "([^"]*)" not found\./.exec(body);
  if (unknownCommand) {
    return new UobError(
      "INVALID_ARGUMENT",
      `Obsidian CLI command "${unknownCommand[1]}" was not found.`,
      {
        remediation:
          "Check the command name (use completions / `help`), or enable the plugin that provides it.",
        details: { command: unknownCommand[1], output: trimmed },
      },
    );
  }

  const missingPlugin = /^Plugin "([^"]*)" not found\./.exec(body);
  if (missingPlugin) {
    return new UobError("PLUGIN_NOT_FOUND", `Plugin "${missingPlugin[1]}" was not found.`, {
      remediation: "Use the `plugins` CLI command (or obsidian_plugins) to list installed plugins.",
      details: { pluginId: missingPlugin[1], output: trimmed },
    });
  }

  if (body.startsWith("Missing required parameter:")) {
    return new UobError("INVALID_ARGUMENT", trimmed, {
      remediation: "Supply the missing parameter using the CLI's `key=value` grammar.",
      details: { output: trimmed },
    });
  }

  // Remaining `Error: …` lines are CLI failures (exit code is always 0). Skip in
  // eval mode so in-page throws stay classified as EVAL_FAILED.
  if (!opts.allowEvalErrors && trimmed.startsWith("Error:")) {
    return new UobError("INVALID_ARGUMENT", trimmed, {
      remediation:
        "The Obsidian CLI reported a failure on stdout with exit code 0 — treat this message as the error.",
      details: { output: trimmed },
    });
  }

  return undefined;
}

/**
 * Detect an in-page throw in `eval` output.
 *
 * The CLI prints a successful result prefixed with `=> ` and a thrown error bare
 * (often as `Error: <message>` even for ReferenceError/SyntaxError), both with
 * exit code 0. Undefined results are printed as the literal `(no output)`.
 */
export function classifyEvalOutput(stdout: string, code: string): UobError | undefined {
  const trimmed = stdout.trim();
  if (trimmed.startsWith("=>")) return undefined;
  // Obsidian's eval prints this literal for `undefined` / no return value.
  if (trimmed === "" || trimmed === "(no output)") return undefined;
  if (!/^[A-Za-z]*Error: /.test(trimmed)) return undefined;

  return new UobError("EVAL_FAILED", `Evaluation threw in the Obsidian renderer: ${trimmed}`, {
    remediation:
      "This is an error from your code running inside Obsidian, not a connection failure.",
    details: { code, output: trimmed },
  });
}

export class ObsidianCli {
  constructor(private readonly opts: CliOptions) {}

  get binary(): string {
    return this.opts.obsidianBin;
  }

  /**
   * Run a raw CLI command. Returns stdout on success and throws a typed error for
   * the sentinel failure strings Obsidian prints with exit code 0.
   */
  async run(
    command: string[],
    overrides: { vault?: string; timeoutMs?: number } = {},
  ): Promise<string> {
    // No session-default fallback on purpose. A default here would silently
    // re-scope any call whose vault the fence failed to resolve, which is exactly
    // the class of bug the fence exists to make impossible.
    const vault = overrides.vault;
    const args = buildArgs(command, vault);
    const timeout = overrides.timeoutMs ?? this.opts.timeoutMs;

    const { stdout } = await this.exec(args, timeout, command[0] ?? "(none)");

    const failure = classifyCliOutput(stdout, vault);
    if (failure) throw failure;

    return stdout;
  }

  /** Raw exec + precondition classification, used by `evaluate` so in-page throws stay EVAL_FAILED. */
  private async runForEval(
    code: string,
    vault: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const args = buildArgs(["eval", `code=${cliValue(encodeEvalSource(code))}`], vault);
    const { stdout } = await this.exec(args, timeoutMs, "eval");
    const failure = classifyCliOutput(stdout, vault, { allowEvalErrors: true });
    if (failure) throw failure;
    return stdout;
  }

  private exec(args: string[], timeoutMs: number, label: string): Promise<CliResult> {
    const argv =
      this.opts.userDataDir !== undefined
        ? [`--user-data-dir=${this.opts.userDataDir}`, ...args]
        : args;
    return new Promise((resolve, reject) => {
      execFile(
        this.opts.obsidianBin,
        argv,
        { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: childEnv(this.opts.runtimeDir) },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ stdout, stderr });
            return;
          }

          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new UobError(
                "OBSIDIAN_NOT_RUNNING",
                `Obsidian binary not found at "${this.opts.obsidianBin}".`,
                {
                  remediation:
                    "Set OBSIDIAN_BIN (or --obsidian-bin) to the Obsidian executable path.",
                  details: { binary: this.opts.obsidianBin },
                },
              ),
            );
            return;
          }

          if ((error as { killed?: boolean }).killed) {
            reject(
              new UobError(
                "TIMEOUT",
                `Obsidian CLI command "${label}" timed out after ${timeoutMs}ms.`,
                {
                  remediation:
                    "The CLI queues commands until the renderer finishes layout, so this usually means " +
                    "Obsidian is still starting up or is not running at all. Verify it is running, then retry.",
                  details: { command: label, timeoutMs },
                },
              ),
            );
            return;
          }

          const message = stderr?.trim() || stdout?.trim() || error.message;
          reject(new UobError("INTERNAL", message, { cause: error, details: { command: label } }));
        },
      );
    });
  }

  /**
   * Run `eval` and return the raw stdout, scoped to `vault`.
   *
   * The vault is a required argument rather than the session default because this
   * method used to read `this.opts.vault` and ignore per-call overrides entirely —
   * so every routed `evaluate` silently ran against the session default no matter
   * which vault the caller asked for.
   *
   * Throws `EVAL_FAILED` when the code threw in the renderer. The CLI reports an
   * in-page throw as ordinary stdout with exit code 0, so it must be detected by
   * shape: a successful result is prefixed `=> `, whereas a throw is printed bare
   * as `Error: <message>`. Without this check a thrown exception is indistinguishable
   * from a successful evaluation that happened to return an error-shaped string.
   */
  async evaluate(code: string, vault: string): Promise<string> {
    const stdout = await this.runForEval(code, vault, this.opts.timeoutMs);

    const failure = classifyEvalOutput(stdout, code);
    if (failure) throw failure;

    return stdout;
  }

  /** Whether the CLI responds at all, used by the health probe. */
  async isReachable(): Promise<boolean> {
    try {
      await this.run(["version"], { timeoutMs: Math.min(this.opts.timeoutMs, 5000) });
      return true;
    } catch {
      return false;
    }
  }
}
