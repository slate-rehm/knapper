/**
 * Bounded telemetry store with cursor-based tailing.
 *
 * The cursor is the key ergonomic: an agent reads once to get a cursor, performs an
 * action, then reads `since: cursor` to see exactly what that action produced. That
 * is far more reliable than re-reading a blob and diffing it, and it is what makes
 * "did my plugin change work?" answerable in one call.
 *
 * The store deliberately outlives any single connection, so a reconnect does not
 * lose history.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "log" | "warn" | "error";

export type RecordSource = "console" | "pageerror" | "exception" | "network" | "marker";

export interface TelemetryRecord {
  /** Monotonic sequence number; also the cursor value. */
  seq: number;
  timestamp: number;
  source: RecordSource;
  level: LogLevel;
  text: string;
  stack?: string;
  /** Plugin id inferred from stack frames, when attributable. */
  plugin?: string;
  /** Marker label, for `source: "marker"` records. */
  label?: string;
  url?: string;
  /** Extra structured detail (network status, method, etc.). */
  meta?: Record<string, unknown>;
}

export interface QueryOptions {
  /** Return only records with a seq strictly greater than this. */
  since?: number;
  level?: LogLevel;
  /** Minimum severity, e.g. "warn" returns warn and error. */
  minLevel?: LogLevel;
  plugin?: string;
  /** Case-insensitive regular expression applied to text and stack. */
  pattern?: string;
  source?: RecordSource;
  /** Only records newer than this many milliseconds ago. */
  withinMs?: number;
  limit?: number;
}

export interface QueryResult {
  records: TelemetryRecord[];
  /** Cursor to pass as `since` on the next call. */
  cursor: number;
  /** Total matching records before `limit` was applied. */
  matched: number;
  /** Records evicted by the ring buffer since the process started. */
  dropped: number;
}

export interface TelemetryStoreOptions {
  /** Optional append-only JSONL path for records that must survive process restarts. */
  jsonlPath?: string;
}

export interface TelemetryPersistenceSummary {
  enabled: boolean;
  loaded: number;
  loadErrors: number;
  writeErrors: number;
}

export interface TelemetryRecordCounts {
  total: number;
  byLevel: Record<LogLevel, number>;
  bySource: Record<RecordSource, number>;
}

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  log: 20,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Plugin ids appear in stack frames as `.obsidian/plugins/<id>/main.js`, in
 * Obsidian's `plugin:<id>:` source URLs, or as `app://…/plugins/<id>/`.
 */
const PLUGIN_PATH_FRAME = /[/\\]plugins[/\\]([^/\\]+)[/\\]/;
const PLUGIN_SOURCE_FRAME = /plugin:([^:/\s]+):/gi;
const MAX_JSONL_BYTES = 16 * 1024 * 1024;
const FSYNC_EVERY_RECORDS = 32;

export function attributePlugin(...texts: (string | undefined)[]): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    const pathMatch = PLUGIN_PATH_FRAME.exec(text);
    if (pathMatch?.[1]) return pathMatch[1];
    PLUGIN_SOURCE_FRAME.lastIndex = 0;
    const sourceMatch = PLUGIN_SOURCE_FRAME.exec(text);
    if (sourceMatch?.[1]) return sourceMatch[1];
  }
  return undefined;
}

export class TelemetryStore {
  private readonly buffer: TelemetryRecord[] = [];
  private seq = 0;
  private droppedCount = 0;
  private readonly jsonlPath?: string;
  private loadedCount = 0;
  private loadErrorCount = 0;
  private writeErrorCount = 0;
  private persistenceFd?: number;
  private persistenceBytes = 0;
  private recordsSinceSync = 0;
  private recordsSinceCompaction = 0;

  constructor(
    private readonly capacity: number = 2000,
    options: TelemetryStoreOptions = {},
  ) {
    this.jsonlPath = options.jsonlPath;
    if (this.jsonlPath !== undefined) {
      const needsCompaction = this.loadJsonl(this.jsonlPath);
      if (needsCompaction) this.replacePersistenceWithBuffer();
    }
  }

  get size(): number {
    return this.buffer.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /** Current cursor without reading anything. */
  get cursor(): number {
    return this.seq;
  }

  add(
    record: Omit<TelemetryRecord, "seq" | "timestamp"> & { timestamp?: number },
  ): TelemetryRecord {
    const entry: TelemetryRecord = {
      ...record,
      seq: ++this.seq,
      timestamp: record.timestamp ?? Date.now(),
    };

    // Attribute lazily so callers do not have to.
    if (entry.plugin === undefined) {
      const attributed = attributePlugin(entry.stack, entry.url, entry.text);
      if (attributed !== undefined) entry.plugin = attributed;
    }

    this.buffer.push(entry);
    while (this.buffer.length > this.capacity) {
      this.buffer.shift();
      this.droppedCount++;
    }
    this.persistLine(entry);
    return entry;
  }

  /** Insert a named marker so a dev cycle can bracket a region of logs. */
  mark(label: string): TelemetryRecord {
    return this.add({ source: "marker", level: "info", text: `--- ${label} ---`, label });
  }

  query(opts: QueryOptions = {}): QueryResult {
    let regex: RegExp | undefined;
    if (opts.pattern !== undefined && opts.pattern !== "") {
      try {
        regex = new RegExp(opts.pattern, "i");
      } catch {
        regex = undefined;
      }
    }

    const cutoff = opts.withinMs !== undefined ? Date.now() - opts.withinMs : undefined;
    const minSeverity = opts.minLevel !== undefined ? SEVERITY[opts.minLevel] : undefined;

    const matches = this.buffer.filter((r) => {
      if (opts.since !== undefined && r.seq <= opts.since) return false;
      if (opts.level !== undefined && r.level !== opts.level) return false;
      if (minSeverity !== undefined && SEVERITY[r.level] < minSeverity) return false;
      if (opts.plugin !== undefined && r.plugin !== opts.plugin) return false;
      if (opts.source !== undefined && r.source !== opts.source) return false;
      if (cutoff !== undefined && r.timestamp < cutoff) return false;
      if (regex !== undefined && !regex.test(r.text) && !regex.test(r.stack ?? "")) return false;
      return true;
    });

    const limit = opts.limit ?? 100;
    // Keep the most recent when capping, since that is what callers want.
    const records = matches.length > limit ? matches.slice(matches.length - limit) : matches;

    return {
      records,
      cursor: this.seq,
      matched: matches.length,
      dropped: this.droppedCount,
    };
  }

  /** Records since a marker with the given label, most recent marker wins. */
  sinceMarker(label: string, opts: Omit<QueryOptions, "since"> = {}): QueryResult {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      const record = this.buffer[i];
      if (record?.source === "marker" && record.label === label) {
        return this.query({ ...opts, since: record.seq });
      }
    }
    return this.query(opts);
  }

  /** Counts by level, for the compact summary appended to mutating tool results. */
  summary(since?: number, plugin?: string): { errors: number; warnings: number; total: number } {
    let errors = 0;
    let warnings = 0;
    let total = 0;
    for (const r of this.buffer) {
      if (since !== undefined && r.seq <= since) continue;
      if (r.source === "marker") continue;
      if (plugin !== undefined && r.plugin !== plugin) continue;
      total++;
      if (r.level === "error") errors++;
      else if (r.level === "warn") warnings++;
    }
    return { errors, warnings, total };
  }

  /** Privacy-safe record counts for status output. */
  recordCounts(): TelemetryRecordCounts {
    const byLevel: Record<LogLevel, number> = {
      debug: 0,
      info: 0,
      log: 0,
      warn: 0,
      error: 0,
    };
    const bySource: Record<RecordSource, number> = {
      console: 0,
      pageerror: 0,
      exception: 0,
      network: 0,
      marker: 0,
    };
    for (const record of this.buffer) {
      byLevel[record.level]++;
      bySource[record.source]++;
    }
    return { total: this.buffer.length, byLevel, bySource };
  }

  /** Persistence health without exposing the configured filesystem path. */
  persistenceSummary(): TelemetryPersistenceSummary {
    return {
      enabled: this.jsonlPath !== undefined,
      loaded: this.loadedCount,
      loadErrors: this.loadErrorCount,
      writeErrors: this.writeErrorCount,
    };
  }

  clear(): void {
    this.buffer.length = 0;
    this.droppedCount = 0;
    this.replacePersistenceWithCursor();
  }

  /** Flush and release the durable file before a workspace archive moves it. */
  closePersistence(): void {
    if (this.persistenceFd === undefined) return;
    try {
      fsyncSync(this.persistenceFd);
    } catch {
      this.writeErrorCount++;
    }
    try {
      closeSync(this.persistenceFd);
    } catch {
      this.writeErrorCount++;
    }
    this.persistenceFd = undefined;
    this.recordsSinceSync = 0;
  }

  private loadJsonl(path: string): boolean {
    if (!existsSync(path)) return false;
    let text: string;
    let truncatedHead = false;
    try {
      const fd = openSync(path, "r");
      try {
        const size = fstatSync(fd).size;
        this.persistenceBytes = size;
        const start = Math.max(0, size - MAX_JSONL_BYTES);
        const buffer = Buffer.alloc(size - start);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const count = readSync(
            fd,
            buffer,
            bytesRead,
            buffer.length - bytesRead,
            start + bytesRead,
          );
          if (count <= 0) break;
          bytesRead += count;
        }
        text = buffer.subarray(0, bytesRead).toString("utf8");
        if (start > 0) {
          truncatedHead = true;
          const firstNewline = text.indexOf("\n");
          text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      this.loadErrorCount++;
      return false;
    }

    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.loadErrorCount++;
        continue;
      }

      if (isCursorCheckpoint(value)) {
        if (value.seq >= this.seq) this.seq = value.seq;
        else this.loadErrorCount++;
        continue;
      }
      if (!isTelemetryRecord(value) || value.seq <= this.seq) {
        this.loadErrorCount++;
        continue;
      }

      this.seq = value.seq;
      this.buffer.push(value);
      this.loadedCount++;
      while (this.buffer.length > this.capacity) {
        this.buffer.shift();
        this.droppedCount++;
      }
    }
    return truncatedHead || this.droppedCount > 0;
  }

  private persistLine(value: TelemetryRecord | CursorCheckpoint): void {
    if (this.jsonlPath === undefined) return;
    try {
      const line = `${JSON.stringify(value)}\n`;
      const fd = this.openPersistence();
      writeSync(fd, line, undefined, "utf8");
      this.persistenceBytes += Buffer.byteLength(line);
      this.recordsSinceSync++;
      this.recordsSinceCompaction++;
      if (this.recordsSinceSync >= FSYNC_EVERY_RECORDS) {
        fsyncSync(fd);
        this.recordsSinceSync = 0;
      }
      if (
        this.persistenceBytes > MAX_JSONL_BYTES ||
        this.recordsSinceCompaction >= Math.max(100, this.capacity)
      ) {
        this.replacePersistenceWithBuffer();
      }
    } catch {
      this.writeErrorCount++;
    }
  }

  private openPersistence(): number {
    if (this.persistenceFd !== undefined) return this.persistenceFd;
    if (this.jsonlPath === undefined) throw new Error("Telemetry persistence is disabled.");
    mkdirSync(dirname(this.jsonlPath), { recursive: true, mode: 0o700 });
    this.persistenceFd = openSync(this.jsonlPath, "a", 0o600);
    return this.persistenceFd;
  }

  private replacePersistenceWithBuffer(): void {
    const lines: string[] = [];
    let bytes = 0;
    for (let index = this.buffer.length - 1; index >= 0; index--) {
      const line = `${JSON.stringify(this.buffer[index])}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (lines.length > 0 && bytes + lineBytes > MAX_JSONL_BYTES) break;
      lines.push(line);
      bytes += lineBytes;
    }
    lines.reverse();
    const content =
      lines.length > 0 ? lines.join("") : `${JSON.stringify({ type: "cursor", seq: this.seq })}\n`;
    this.replacePersistence(content);
  }

  private replacePersistenceWithCursor(): void {
    if (this.jsonlPath === undefined) return;
    this.replacePersistence(`${JSON.stringify({ type: "cursor", seq: this.seq })}\n`);
  }

  private replacePersistence(content: string): void {
    if (this.jsonlPath === undefined) return;
    try {
      this.closePersistence();
      mkdirSync(dirname(this.jsonlPath), { recursive: true, mode: 0o700 });
      const fd = openSync(this.jsonlPath, "w", 0o600);
      try {
        writeSync(fd, content, undefined, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      this.writeErrorCount++;
    }
    this.persistenceBytes = Buffer.byteLength(content);
    this.recordsSinceSync = 0;
    this.recordsSinceCompaction = 0;
  }
}

interface CursorCheckpoint {
  type: "cursor";
  seq: number;
}

const LOG_LEVELS = new Set<LogLevel>(["debug", "info", "log", "warn", "error"]);
const RECORD_SOURCES = new Set<RecordSource>([
  "console",
  "pageerror",
  "exception",
  "network",
  "marker",
]);

function isCursorCheckpoint(value: unknown): value is CursorCheckpoint {
  if (!isObject(value)) return false;
  return value.type === "cursor" && isSequence(value.seq);
}

function isTelemetryRecord(value: unknown): value is TelemetryRecord {
  if (!isObject(value)) return false;
  return (
    isSequence(value.seq) &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    typeof value.source === "string" &&
    RECORD_SOURCES.has(value.source as RecordSource) &&
    typeof value.level === "string" &&
    LOG_LEVELS.has(value.level as LogLevel) &&
    typeof value.text === "string" &&
    optionalString(value.stack) &&
    optionalString(value.plugin) &&
    optionalString(value.label) &&
    optionalString(value.url) &&
    (value.meta === undefined || isObject(value.meta))
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** Render records as compact lines for a text tool response. */
export function formatRecords(records: TelemetryRecord[]): string {
  if (records.length === 0) return "(no matching records)";
  return records
    .map((r) => {
      const time = new Date(r.timestamp).toISOString().slice(11, 23);
      const plugin = r.plugin ? ` {${r.plugin}}` : "";
      const level = r.level.toUpperCase().padEnd(5);
      const head = `${time} ${level}${plugin} ${r.text}`;
      return r.stack ? `${head}\n${indent(r.stack)}` : head;
    })
    .join("\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}
