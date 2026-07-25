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
export declare class UobError extends Error {
  readonly code: ErrorCode;
  readonly remediation?: string;
  readonly fixedBy?: string;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, opts?: UobErrorOptions);
  /** Human-readable text combining message, remediation, and the fixing tool. */
  toText(): string;
  toJSON(): Record<string, unknown>;
}
/** Sentinel string Obsidian prints on stdout when the CLI toggle is off. */
export declare const CLI_DISABLED_MARKER = "Command line interface is not enabled.";
/** Sentinel string Obsidian prints when `vault=` names an unregistered vault. */
export declare const VAULT_NOT_FOUND_MARKER = "Vault not found.";
export declare function launchCommandForPlatform(port: number, vault?: string): string;
export declare function obsidianNotRunning(port: number): UobError;
export declare function cliDisabled(): UobError;
export declare function cdpPortClosed(url: string): UobError;
export declare function argvCorruption(configPath: string, tokens: string[]): UobError;
export declare function vaultNotFound(name: string, known: string[]): UobError;
export declare function appUnavailable(): UobError;
export declare function capabilityUnavailable(capability: string, reason: string): UobError;
export declare function debuggerConflict(holder: string): UobError;
/** Normalize any thrown value into a UobError. */
export declare function toUobError(e: unknown): UobError;
