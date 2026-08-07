/**
 * Typed errors carrying remediation text.
 *
 * Every failure surfaced to an agent must say what to do next. The four
 * precondition states below are deliberately distinct: lumping them into one
 * "cannot connect" is what makes this class of tool frustrating to use.
 */

export type ErrorCode =
  | "OBSIDIAN_NOT_RUNNING"
  | "CLI_DISABLED"
  | "CDP_PORT_CLOSED"
  | "ARGV_CORRUPTION"
  | "VAULT_NOT_FOUND"
  | "APP_UNAVAILABLE"
  | "CAPABILITY_UNAVAILABLE"
  | "DEBUGGER_CONFLICT"
  | "STALE_REF"
  | "EVAL_FAILED"
  | "TARGET_NOT_FOUND"
  | "TIMEOUT"
  | "INVALID_ARGUMENT"
  | "PLUGIN_NOT_FOUND"
  /** Refused to *delete* a vault knapper did not create. Never downgrade this. */
  | "VAULT_NOT_MANAGED"
  /**
   * Refused to *operate on* a vault the user never authorized. A fifth precondition
   * state, deliberately distinct from VAULT_NOT_MANAGED: that one is about deletion
   * provenance, this one is about consent to touch the vault at all.
   */
  | "VAULT_NOT_AUTHORIZED"
  /**
   * A session key was given but no descriptor backs it. Distinct from
   * OBSIDIAN_NOT_RUNNING: the instance may be perfectly alive, but this server was
   * pointed at a session that was closed, reaped, or never created. Resolving it
   * silently to the user's own installation is exactly what must not happen.
   */
  | "SESSION_NOT_FOUND"
  /**
   * The instance a session describes is gone, but the session record remains.
   * Separate from SESSION_NOT_FOUND so the remediation can be "restart it" rather
   * than "create one".
   */
  | "SESSION_NOT_RUNNING"
  /** The launched Obsidian process failed before it exposed a CDP endpoint. */
  | "OBSIDIAN_LAUNCH_FAILED"
  /** Another MCP server currently owns the installation's default profile. */
  | "DEFAULT_PROFILE_BUSY"
  | "WORKSPACE_BUSY"
  | "INTERNAL";

export interface UobErrorOptions {
  /** What the agent (or user) should do to resolve this. */
  remediation?: string;
  /** Tool name that fixes this condition, when one exists. */
  fixedBy?: string;
  /** Structured detail merged into the JSON payload. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class UobError extends Error {
  readonly code: ErrorCode;
  readonly remediation?: string;
  readonly fixedBy?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts: UobErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "UobError";
    this.code = code;
    this.remediation = opts.remediation;
    this.fixedBy = opts.fixedBy;
    this.details = opts.details;
  }

  /** Human-readable text combining message, remediation, and the fixing tool. */
  toText(): string {
    const parts = [this.message];
    if (this.remediation) parts.push(this.remediation);
    if (this.fixedBy) parts.push(`Fix with the \`${this.fixedBy}\` tool.`);
    return parts.join("\n\n");
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.remediation ? { remediation: this.remediation } : {}),
      ...(this.fixedBy ? { fixedBy: this.fixedBy } : {}),
      ...this.details,
    };
  }
}

/** Sentinel string Obsidian prints on stdout when the CLI toggle is off. */
export const CLI_DISABLED_MARKER = "Command line interface is not enabled.";

/** Sentinel string Obsidian prints when `vault=` names an unregistered vault. */
export const VAULT_NOT_FOUND_MARKER = "Vault not found.";

export function launchCommandForPlatform(port: number, vault?: string): string {
  const vaultArg = vault ? ` (then open the "${vault}" vault)` : "";
  switch (process.platform) {
    case "darwin":
      return `/Applications/Obsidian.app/Contents/MacOS/Obsidian --remote-debugging-port=${port}${vaultArg}`;
    case "win32":
      return `"%LOCALAPPDATA%\\Obsidian\\Obsidian.exe" --remote-debugging-port=${port}${vaultArg}`;
    default:
      return `obsidian --remote-debugging-port=${port}${vaultArg}`;
  }
}

export function obsidianNotRunning(port: number): UobError {
  return new UobError("OBSIDIAN_NOT_RUNNING", "Obsidian is not running.", {
    remediation: `Start it with the debug port enabled:\n  ${launchCommandForPlatform(port)}`,
    fixedBy: "obsidian_launch",
  });
}

export function cliDisabled(): UobError {
  return new UobError("CLI_DISABLED", "Obsidian's command line interface is disabled.", {
    remediation:
      'Enable it in Settings > General > Advanced > "Command line interface", or let this server ' +
      "flip the global `cli` flag for you. Note this cannot be fixed through the CLI itself, since " +
      "the CLI is what is disabled.",
    fixedBy: "obsidian_setup_cli",
  });
}

export function cdpPortClosed(url: string): UobError {
  return new UobError("CDP_PORT_CLOSED", `No CDP endpoint reachable at ${url}.`, {
    remediation:
      "Obsidian only opens a debug port when launched with `--remote-debugging-port`. Because of " +
      "Electron's single-instance lock, adding the flag to an already-running instance silently " +
      "does nothing — Obsidian must be fully quit and cold-started with the flag.",
    fixedBy: "obsidian_launch",
    details: { cdpUrl: url },
  });
}

export function argvCorruption(configPath: string, tokens: string[]): UobError {
  return new UobError(
    "ARGV_CORRUPTION",
    `Obsidian's launch flags file contains single-dash token(s) that corrupt every CLI invocation: ${tokens.join(", ")}.`,
    {
      remediation:
        `Obsidian strips only \`--\`-prefixed flags from argv, so a single-dash token survives and ` +
        `becomes the command name, making every call fail with \`Command "${tokens[0]}" not found.\` ` +
        `Edit ${configPath} and use a double dash (e.g. \`--disable-gpu\`), or remove the line.`,
      details: { configPath, tokens },
    },
  );
}

export function vaultNotFound(name: string, known: string[]): UobError {
  return new UobError("VAULT_NOT_FOUND", `Obsidian does not know a vault named "${name}".`, {
    remediation:
      known.length > 0
        ? `Registered vaults: ${known.join(", ")}.`
        : "No vaults are registered. Open one in Obsidian first.",
    details: { requested: name, knownVaults: known },
  });
}

export function appUnavailable(): UobError {
  return new UobError("APP_UNAVAILABLE", "`window.app` is not available on the attached target.", {
    remediation:
      "The attached target is either not an Obsidian window or has not finished loading. List the " +
      "available targets and attach explicitly. Note that Obsidian popout windows report their URL " +
      "as `about:blank`, so they are easy to mistake for blank tabs.",
    fixedBy: "obsidian_list_targets",
  });
}

export function capabilityUnavailable(capability: string, reason: string): UobError {
  return new UobError(
    "CAPABILITY_UNAVAILABLE",
    `Capability "${capability}" is unavailable: ${reason}`,
    {
      details: { capability },
    },
  );
}

export function debuggerConflict(holder: string): UobError {
  return new UobError(
    "DEBUGGER_CONFLICT",
    `The Electron debugger is already held by the ${holder} layer.`,
    {
      remediation:
        "Electron allows only one debugger client per WebContents, so the Obsidian CLI's `dev:cdp` " +
        "and a live Playwright attachment are mutually exclusive. Use one transport per session.",
      details: { holder },
    },
  );
}

/** The command a user runs, in their own terminal, to authorize a vault. */
export function authorizeCommand(vaultPath: string): string {
  return `npx knapper authorize ${JSON.stringify(vaultPath)}`;
}

/**
 * How the fence explains itself to an agent.
 *
 * The remediation deliberately tells the agent *not* to volunteer this command.
 * An agent that answers every refusal with "run this to grant me access" trains
 * the user to authorize reflexively, which is the exact habit the fence exists to
 * prevent. It also cannot run the command itself — `knapper authorize` refuses
 * without an interactive TTY — so suggesting it as a self-service fix is a dead
 * end that reads like a bug.
 *
 * `fixedBy` stays unset on purpose: no tool fixes this, which is the point.
 */
function authorizationRemediation(vaultPath: string | undefined, authorized: string[]): string {
  const known =
    authorized.length > 0
      ? `Authorized vaults: ${authorized.join(", ")}.`
      : "No vaults are authorized yet.";
  const grant =
    vaultPath !== undefined
      ? `The user can grant access by running ${authorizeCommand(vaultPath)} in their own terminal.`
      : "The user grants access by running `npx knapper authorize <vault path>` in their own terminal.";
  return (
    `${known} ${grant} Surface that command only if the user has asked to work in this vault — ` +
    "do not volunteer it, and do not run it yourself; it requires an interactive terminal and " +
    "will refuse. To work in throwaway space instead, use obsidian_create_vault, which authorizes " +
    "what it creates."
  );
}

/** A named vault exists but the user has not authorized knapper to touch it. */
export function vaultNotAuthorized(
  vault: { name: string; path?: string },
  authorized: string[],
): UobError {
  return new UobError(
    "VAULT_NOT_AUTHORIZED",
    `Refusing to touch "${vault.name}" — it has not been authorized for knapper.`,
    {
      remediation: authorizationRemediation(vault.path, authorized),
      details: {
        requested: vault.name,
        ...(vault.path !== undefined ? { path: vault.path } : {}),
        authorizedVaults: authorized,
      },
    },
  );
}

/**
 * No vault was named and the fence cannot pick one.
 *
 * Guessing here is what the fence exists to stop: with no `vault=` token the
 * Obsidian CLI silently targets whichever vault the user last focused.
 */
export function vaultTargetAmbiguous(authorized: string[]): UobError {
  const message =
    authorized.length === 0
      ? "No vault is authorized for knapper, so there is nothing safe to target."
      : `More than one vault is authorized (${authorized.join(", ")}), so the target is ambiguous.`;
  return new UobError("VAULT_NOT_AUTHORIZED", message, {
    remediation:
      authorized.length === 0
        ? authorizationRemediation(undefined, authorized)
        : "Pass an explicit `vault` argument naming one of them, or set OBSIDIAN_VAULT so every " +
          "call in this session resolves the same way. knapper will not guess: with no vault " +
          "named, Obsidian's CLI silently targets whichever vault was last focused.",
    details: { authorizedVaults: authorized },
  });
}

/**
 * Re-throw refusals that a fallback path must never swallow.
 *
 * Several tools try one transport and fall back to another when it fails. That is
 * right for "the CLI is disabled" and wrong for "you may not touch this vault": the
 * answer will not change on a second path, and a fallback is usually *less* scoped
 * than the call it replaces — `obsidian_search` fell back to a metadata scan with
 * no vault at all, turning a clean refusal into an unscoped read attempt.
 *
 * Call this first in any `catch` that leads to a retry.
 */
export function rethrowIfRefused(e: unknown): void {
  if (
    e instanceof UobError &&
    (e.code === "VAULT_NOT_AUTHORIZED" || e.code === "VAULT_NOT_FOUND")
  ) {
    throw e;
  }
}

/** Normalize any thrown value into a UobError. */
export function toUobError(e: unknown): UobError {
  if (e instanceof UobError) return e;
  if (e instanceof Error) {
    return new UobError("INTERNAL", e.message, { cause: e, details: { stack: e.stack } });
  }
  return new UobError("INTERNAL", String(e));
}
