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
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLI_DISABLED_MARKER,
  VAULT_NOT_FOUND_MARKER,
  cliDisabled,
  UobError,
} from "../../util/errors.js";

export interface CliOptions {
  obsidianBin: string;
  vault?: string;
  timeoutMs: number;
}

export interface CliResult {
  stdout: string;
  stderr: string;
}

/** Path to the IPC socket the CLI client connects to. Useful for liveness checks. */
export function cliSocketPath(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), ".obsidian-cli.sock");
    case "win32":
      return `\\\\.\\pipe\\obsidian-cli-${process.env.USERNAME ?? "user"}`;
    default: {
      const runtime = process.env.XDG_RUNTIME_DIR;
      return runtime ? join(runtime, ".obsidian-cli.sock") : join(homedir(), ".obsidian-cli.sock");
    }
  }
}

/**
 * Build the argv for an Obsidian CLI call.
 *
 * `vault=` must be the very first token, before the command name. Obsidian's own
 * pre-filter drops every `--`-prefixed token except a small whitelist, so callers
 * must express options as `key=value` or bare flags rather than `--flag`.
 */
export function buildArgs(command: string[], vault?: string): string[] {
  return vault !== undefined && vault !== "" ? [`vault=${vault}`, ...command] : [...command];
}

/** Quote a value for the `key=value` grammar, escaping newlines and tabs. */
export function cliValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
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
    const vault = overrides.vault ?? this.opts.vault;
    const args = buildArgs(command, vault);
    const timeout = overrides.timeoutMs ?? this.opts.timeoutMs;

    const { stdout } = await this.exec(args, timeout, command[0] ?? "(none)");
    const trimmed = stdout.trim();

    if (trimmed.includes(CLI_DISABLED_MARKER)) {
      throw cliDisabled();
    }

    if (trimmed === VAULT_NOT_FOUND_MARKER) {
      throw new UobError("VAULT_NOT_FOUND", `Obsidian does not know a vault named "${vault}".`, {
        remediation: "List the registered vaults and use one of those names.",
        details: { requested: vault },
      });
    }

    // A surviving single-dash token in the distro wrapper's flags file lands in
    // argv[0] and is reported as an unknown command.
    const unknownCommand = /^Command "(-[^"]*)" not found\./.exec(trimmed);
    if (unknownCommand) {
      throw new UobError(
        "ARGV_CORRUPTION",
        `Obsidian rejected "${unknownCommand[1]}" as a command name, which means a single-dash launch flag is leaking into CLI argv.`,
        {
          remediation:
            "Edit Obsidian's user-flags.conf and use a double dash (e.g. `--disable-gpu`), or remove the line.",
          details: { token: unknownCommand[1] },
        },
      );
    }

    return stdout;
  }

  private exec(args: string[], timeoutMs: number, label: string): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.opts.obsidianBin,
        args,
        { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
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

  /** Run `eval` and return the raw stdout. */
  async evaluate(code: string): Promise<string> {
    return this.run(["eval", `code=${cliValue(code)}`]);
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
