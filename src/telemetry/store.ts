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

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  log: 20,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Plugin ids appear in stack frames as `.obsidian/plugins/<id>/main.js`. Handles
 * both POSIX and Windows separators since stacks carry native paths.
 */
const PLUGIN_FRAME = /[/\\]plugins[/\\]([^/\\]+)[/\\]/;

export function attributePlugin(...texts: (string | undefined)[]): string | undefined {
  for (const text of texts) {
    if (!text) continue;
    const match = PLUGIN_FRAME.exec(text);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export class TelemetryStore {
  private readonly buffer: TelemetryRecord[] = [];
  private seq = 0;
  private droppedCount = 0;

  constructor(private readonly capacity: number = 2000) {}

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
  summary(since?: number): { errors: number; warnings: number; total: number } {
    let errors = 0;
    let warnings = 0;
    let total = 0;
    for (const r of this.buffer) {
      if (since !== undefined && r.seq <= since) continue;
      if (r.source === "marker") continue;
      total++;
      if (r.level === "error") errors++;
      else if (r.level === "warn") warnings++;
    }
    return { errors, warnings, total };
  }

  clear(): void {
    this.buffer.length = 0;
    this.droppedCount = 0;
  }
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
