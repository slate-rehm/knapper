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
export declare function attributePlugin(...texts: (string | undefined)[]): string | undefined;
export declare class TelemetryStore {
  private readonly capacity;
  private readonly buffer;
  private seq;
  private droppedCount;
  constructor(capacity?: number);
  get size(): number;
  get dropped(): number;
  /** Current cursor without reading anything. */
  get cursor(): number;
  add(
    record: Omit<TelemetryRecord, "seq" | "timestamp"> & {
      timestamp?: number;
    },
  ): TelemetryRecord;
  /** Insert a named marker so a dev cycle can bracket a region of logs. */
  mark(label: string): TelemetryRecord;
  query(opts?: QueryOptions): QueryResult;
  /** Records since a marker with the given label, most recent marker wins. */
  sinceMarker(label: string, opts?: Omit<QueryOptions, "since">): QueryResult;
  /** Counts by level, for the compact summary appended to mutating tool results. */
  summary(since?: number): {
    errors: number;
    warnings: number;
    total: number;
  };
  clear(): void;
}
/** Render records as compact lines for a text tool response. */
export declare function formatRecords(records: TelemetryRecord[]): string;
