/**
 * Serialize Playwright console messages with multiple args / objects.
 */

import type { ConsoleMessage } from "playwright-core";
import { truncateText } from "../util/truncate.js";

const MAX_ARG_CHARS = 2000;

export async function consoleMessageText(msg: ConsoleMessage): Promise<string> {
  const preview = msg.text();
  const args = msg.args();
  if (args.length === 0) return preview;

  const needsResolve =
    preview.includes("JSHandle@") ||
    args.length > 1 ||
    (args.length === 1 && (preview === "Object" || preview === "[object Object]"));

  if (!needsResolve) return preview;

  const parts: string[] = [];
  for (const handle of args) {
    try {
      const val = await handle.jsonValue();
      parts.push(formatArg(val));
    } catch {
      parts.push(preview);
      break;
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }
  return parts.length > 0 ? parts.join(" ") : preview;
}

function formatArg(val: unknown): string {
  if (val === null) return "null";
  if (val === undefined) return "undefined";
  if (typeof val === "string") return val;
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "bigint") {
    return String(val);
  }
  if (val instanceof Error || isErrorLike(val)) {
    const e = val as Error;
    const stack = e.stack ?? "";
    return stack !== "" ? stack : `${e.name}: ${e.message}`;
  }
  try {
    const json = JSON.stringify(val, replacer, 2);
    return truncateText(json, MAX_ARG_CHARS).text;
  } catch {
    return Object.prototype.toString.call(val);
  }
}

function isErrorLike(val: unknown): val is { name?: string; message?: string; stack?: string } {
  return (
    typeof val === "object" &&
    val !== null &&
    "message" in val &&
    typeof (val as { message: unknown }).message === "string"
  );
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}
