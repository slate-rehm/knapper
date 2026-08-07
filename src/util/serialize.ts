/**
 * Safe serialization of values crossing the CDP boundary.
 *
 * `page.evaluate` results and CLI stdout both arrive as untrusted shapes that can
 * contain cycles, functions, DOM nodes, or BigInts. Everything here degrades to a
 * descriptive string rather than throwing, because a tool that fails to *report* a
 * result is worse than one that reports it imprecisely.
 */

import { DEFAULT_RESULT_CAP, truncateText, type Truncated } from "./truncate.js";

/** JSON.stringify with cycle detection and non-JSON type handling. */
export function safeStringify(value: unknown, indent = 2): string {
  const ancestors: object[] = [];

  const replacer = function (this: unknown, _key: string, val: unknown): unknown {
    if (typeof val === "bigint") return `${val.toString()}n`;
    if (typeof val === "function") return `[Function: ${val.name || "anonymous"}]`;
    if (typeof val === "symbol") return val.toString();
    // Match JSON semantics. Object properties disappear and array entries become
    // null. renderResult handles a top-level undefined value before it gets here.
    if (typeof val === "undefined") return undefined;
    if (typeof val === "number" && !Number.isFinite(val)) return String(val);
    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack };
    }
    if (typeof val === "object" && val !== null) {
      // JSON.stringify visits a value depth-first. Remove completed branches so
      // a shared reference can appear normally while an ancestor still marks a
      // true cycle.
      const depth = ancestors.lastIndexOf(this as object);
      if (depth >= 0) ancestors.length = depth + 1;
      if (ancestors.includes(val)) return "[Circular]";
      ancestors.push(val);
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
export function renderResult(value: unknown, cap = DEFAULT_RESULT_CAP): Truncated {
  if (value === null) return { text: "null", truncated: false };
  if (value === undefined) return { text: "undefined", truncated: false };
  if (typeof value === "string") return truncateText(value, cap);
  return truncateText(safeStringify(value), cap);
}

/**
 * Parse CLI stdout that is expected to be JSON, tolerating the `=> ` prefix the
 * `eval` command prepends and surrounding whitespace.
 *
 * Obsidian prints the literal `(no output)` when an eval returns `undefined`.
 */
export function parseCliJson<T = unknown>(stdout: string): T | undefined {
  const cleaned = stdout.trim().replace(/^=>\s*/, "");
  if (cleaned === "" || cleaned === "(no output)") return undefined;
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return undefined;
  }
}

/**
 * Allow both expression and statement bodies for renderer eval.
 *
 * A bare expression gets an implicit return so callers can pass
 * `app.vault.getName()` as well as a full statement body or an IIFE.
 * Shared by the Playwright session and the CLI `evaluateJson` path — the CLI
 * path previously wrapped with `{ ${code} }` and discarded IIFE return values.
 *
 * IIFEs must be detected *before* the "contains `;`" statement heuristic: an
 * IIFE body almost always has semicolons, and returning it unchanged leaves
 * `(() => { … })()` as an expression statement whose value is discarded.
 */
export function wrapExpression(code: string): string {
  const trimmed = code.trim();
  const looksLikeStatements =
    /^(?:const|let|var|return|if|for|while|switch|try|throw|function|class)\b/.test(trimmed);
  if (looksLikeStatements) {
    return trimmed.includes("return") ? trimmed : `${trimmed}\nreturn undefined;`;
  }

  // IIFE: (() => { … })() or (function () { … })(), optional trailing semicolon.
  if (/^\([\s\S]*\)\s*\(\s*\)\s*;?\s*$/.test(trimmed)) {
    return `return (${trimmed.replace(/;?\s*$/, "")});`;
  }

  if (trimmed.includes(";") || trimmed.includes("\n")) {
    return trimmed.includes("return") ? trimmed : `${trimmed}\nreturn undefined;`;
  }
  return `return (${trimmed});`;
}
