/**
 * Logging for a stdio MCP server.
 *
 * Everything goes to stderr. Writing a single byte to stdout corrupts the JSON-RPC
 * framing and the client silently disconnects, so there is no code path here that
 * touches stdout.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
}

function format(level: LogLevel, scope: string, msg: string, meta?: unknown): string {
  const ts = new Date().toISOString();
  const prefix = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  if (meta === undefined) return `${prefix} ${msg}`;
  let rendered: string;
  try {
    rendered = typeof meta === "string" ? meta : JSON.stringify(meta);
  } catch {
    rendered = String(meta);
  }
  return `${prefix} ${msg} ${rendered}`;
}

export function createLogger(level: LogLevel, scope = "uob"): Logger {
  const threshold = RANK[level];

  const emit = (at: LogLevel, msg: string, meta?: unknown): void => {
    if (RANK[at] < threshold) return;
    process.stderr.write(`${format(at, scope, msg, meta)}\n`);
  };

  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
    child: (childScope) => createLogger(level, `${scope}:${childScope}`),
  };
}
