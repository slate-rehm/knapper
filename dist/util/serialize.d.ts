/**
 * Safe serialization of values crossing the CDP boundary.
 *
 * `page.evaluate` results and CLI stdout both arrive as untrusted shapes that can
 * contain cycles, functions, DOM nodes, or BigInts. Everything here degrades to a
 * descriptive string rather than throwing, because a tool that fails to *report* a
 * result is worse than one that reports it imprecisely.
 */
import { type Truncated } from "./truncate.js";
/** JSON.stringify with cycle detection and non-JSON type handling. */
export declare function safeStringify(value: unknown, indent?: number): string;
/** Render an eval result as capped text suitable for a tool response. */
export declare function renderResult(value: unknown, cap?: number): Truncated;
/**
 * Parse CLI stdout that is expected to be JSON, tolerating the `=> ` prefix the
 * `eval` command prepends and surrounding whitespace.
 */
export declare function parseCliJson<T = unknown>(stdout: string): T | undefined;
