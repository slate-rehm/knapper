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
export declare function cliSocketPath(): string;
/**
 * Build the argv for an Obsidian CLI call.
 *
 * `vault=` must be the very first token, before the command name. Obsidian's own
 * pre-filter drops every `--`-prefixed token except a small whitelist, so callers
 * must express options as `key=value` or bare flags rather than `--flag`.
 */
export declare function buildArgs(command: string[], vault?: string): string[];
/** Quote a value for the `key=value` grammar, escaping newlines and tabs. */
export declare function cliValue(value: string): string;
export declare class ObsidianCli {
  private readonly opts;
  constructor(opts: CliOptions);
  get binary(): string;
  /**
   * Run a raw CLI command. Returns stdout on success and throws a typed error for
   * the sentinel failure strings Obsidian prints with exit code 0.
   */
  run(
    command: string[],
    overrides?: {
      vault?: string;
      timeoutMs?: number;
    },
  ): Promise<string>;
  private exec;
  /** Run `eval` and return the raw stdout. */
  evaluate(code: string): Promise<string>;
  /** Whether the CLI responds at all, used by the health probe. */
  isReachable(): Promise<boolean>;
}
