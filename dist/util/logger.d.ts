/**
 * Logging for a stdio MCP server.
 *
 * Everything goes to stderr. Writing a single byte to stdout corrupts the JSON-RPC
 * framing and the client silently disconnects, so there is no code path here that
 * touches stdout.
 */
export declare const LOG_LEVELS: readonly ["debug", "info", "warn", "error", "silent"];
export type LogLevel = (typeof LOG_LEVELS)[number];
export declare function isLogLevel(value: string): value is LogLevel;
export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}
export declare function createLogger(level: LogLevel, scope?: string): Logger;
