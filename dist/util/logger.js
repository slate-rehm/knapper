/**
 * Logging for a stdio MCP server.
 *
 * Everything goes to stderr. Writing a single byte to stdout corrupts the JSON-RPC
 * framing and the client silently disconnects, so there is no code path here that
 * touches stdout.
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error", "silent"];
const RANK = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};
export function isLogLevel(value) {
  return LOG_LEVELS.includes(value);
}
function format(level, scope, msg, meta) {
  const ts = new Date().toISOString();
  const prefix = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  if (meta === undefined) return `${prefix} ${msg}`;
  let rendered;
  try {
    rendered = typeof meta === "string" ? meta : JSON.stringify(meta);
  } catch {
    rendered = String(meta);
  }
  return `${prefix} ${msg} ${rendered}`;
}
export function createLogger(level, scope = "uob") {
  const threshold = RANK[level];
  const emit = (at, msg, meta) => {
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
//# sourceMappingURL=logger.js.map
