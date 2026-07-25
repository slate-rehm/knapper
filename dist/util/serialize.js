/**
 * Safe serialization of values crossing the CDP boundary.
 *
 * `page.evaluate` results and CLI stdout both arrive as untrusted shapes that can
 * contain cycles, functions, DOM nodes, or BigInts. Everything here degrades to a
 * descriptive string rather than throwing, because a tool that fails to *report* a
 * result is worse than one that reports it imprecisely.
 */
import { DEFAULT_RESULT_CAP, truncateText } from "./truncate.js";
/** JSON.stringify with cycle detection and non-JSON type handling. */
export function safeStringify(value, indent = 2) {
  const seen = new WeakSet();
  const replacer = (_key, val) => {
    if (typeof val === "bigint") return `${val.toString()}n`;
    if (typeof val === "function") return `[Function: ${val.name || "anonymous"}]`;
    if (typeof val === "symbol") return val.toString();
    if (typeof val === "undefined") return "[undefined]";
    if (typeof val === "number" && !Number.isFinite(val)) return String(val);
    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack };
    }
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    return val;
  };
  try {
    const out = JSON.stringify(value, replacer, indent);
    return out === undefined ? String(value) : out;
  } catch (e) {
    return `[unserializable: ${e instanceof Error ? e.message : String(e)}]`;
  }
}
/** Render an eval result as capped text suitable for a tool response. */
export function renderResult(value, cap = DEFAULT_RESULT_CAP) {
  if (value === null) return { text: "null", truncated: false };
  if (value === undefined) return { text: "undefined", truncated: false };
  if (typeof value === "string") return truncateText(value, cap);
  return truncateText(safeStringify(value), cap);
}
/**
 * Parse CLI stdout that is expected to be JSON, tolerating the `=> ` prefix the
 * `eval` command prepends and surrounding whitespace.
 */
export function parseCliJson(stdout) {
  const cleaned = stdout.trim().replace(/^=>\s*/, "");
  if (cleaned === "") return undefined;
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}
//# sourceMappingURL=serialize.js.map
