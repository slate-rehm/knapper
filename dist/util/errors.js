/**
 * Typed errors carrying remediation text.
 *
 * Every failure surfaced to an agent must say what to do next. The four
 * precondition states below are deliberately distinct: lumping them into one
 * "cannot connect" is what makes this class of tool frustrating to use.
 */
export class UobError extends Error {
  code;
  remediation;
  fixedBy;
  details;
  constructor(code, message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "UobError";
    this.code = code;
    this.remediation = opts.remediation;
    this.fixedBy = opts.fixedBy;
    this.details = opts.details;
  }
  /** Human-readable text combining message, remediation, and the fixing tool. */
  toText() {
    const parts = [this.message];
    if (this.remediation) parts.push(this.remediation);
    if (this.fixedBy) parts.push(`Fix with the \`${this.fixedBy}\` tool.`);
    return parts.join("\n\n");
  }
  toJSON() {
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
export function launchCommandForPlatform(port, vault) {
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
export function obsidianNotRunning(port) {
  return new UobError("OBSIDIAN_NOT_RUNNING", "Obsidian is not running.", {
    remediation: `Start it with the debug port enabled:\n  ${launchCommandForPlatform(port)}`,
    fixedBy: "obsidian_launch",
  });
}
export function cliDisabled() {
  return new UobError("CLI_DISABLED", "Obsidian's command line interface is disabled.", {
    remediation:
      'Enable it in Settings > General > Advanced > "Command line interface", or let this server ' +
      "flip the global `cli` flag for you. Note this cannot be fixed through the CLI itself, since " +
      "the CLI is what is disabled.",
    fixedBy: "obsidian_setup_cli",
  });
}
export function cdpPortClosed(url) {
  return new UobError("CDP_PORT_CLOSED", `No CDP endpoint reachable at ${url}.`, {
    remediation:
      "Obsidian only opens a debug port when launched with `--remote-debugging-port`. Because of " +
      "Electron's single-instance lock, adding the flag to an already-running instance silently " +
      "does nothing — Obsidian must be fully quit and cold-started with the flag.",
    fixedBy: "obsidian_launch",
    details: { cdpUrl: url },
  });
}
export function argvCorruption(configPath, tokens) {
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
export function vaultNotFound(name, known) {
  return new UobError("VAULT_NOT_FOUND", `Obsidian does not know a vault named "${name}".`, {
    remediation:
      known.length > 0
        ? `Registered vaults: ${known.join(", ")}.`
        : "No vaults are registered. Open one in Obsidian first.",
    details: { requested: name, knownVaults: known },
  });
}
export function appUnavailable() {
  return new UobError("APP_UNAVAILABLE", "`window.app` is not available on the attached target.", {
    remediation:
      "The attached target is either not an Obsidian window or has not finished loading. List the " +
      "available targets and attach explicitly. Note that Obsidian popout windows report their URL " +
      "as `about:blank`, so they are easy to mistake for blank tabs.",
    fixedBy: "obsidian_list_targets",
  });
}
export function capabilityUnavailable(capability, reason) {
  return new UobError(
    "CAPABILITY_UNAVAILABLE",
    `Capability "${capability}" is unavailable: ${reason}`,
    {
      details: { capability },
    },
  );
}
export function debuggerConflict(holder) {
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
/** Normalize any thrown value into a UobError. */
export function toUobError(e) {
  if (e instanceof UobError) return e;
  if (e instanceof Error) {
    return new UobError("INTERNAL", e.message, { cause: e, details: { stack: e.stack } });
  }
  return new UobError("INTERNAL", String(e));
}
//# sourceMappingURL=errors.js.map
