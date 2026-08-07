/** Workspace-scoped durable telemetry behind one stable store reference. */

import { access, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  TelemetryStore,
  type QueryOptions,
  type QueryResult,
  type TelemetryPersistenceSummary,
  type TelemetryRecord,
  type TelemetryRecordCounts,
} from "./store.js";

const WORKSPACE_HANDLE = /^wsp_[A-Za-z0-9_-]{32}$/;

/**
 * Tool handlers and capture hooks keep one store reference for the server lifetime.
 * This facade changes only its delegate when a request selects another workspace.
 */
export class WorkspaceTelemetryStore extends TelemetryStore {
  private readonly stores = new Map<string, TelemetryStore>();
  private active: TelemetryStore;
  private activeScope = "default";

  constructor(
    private readonly workspaceCapacity: number,
    private readonly telemetryDir: string,
  ) {
    super(1);
    this.active = this.storeFor("default");
  }

  select(scope: "default" | string): void {
    if (scope !== "default" && !WORKSPACE_HANDLE.test(scope)) {
      throw new Error("Invalid telemetry workspace scope.");
    }
    this.active = this.storeFor(scope);
    this.activeScope = scope;
  }

  /** Move a closed workspace's telemetry into its retained or quarantined root. */
  async archive(scope: string, destinationRoot: string): Promise<string | undefined> {
    if (!WORKSPACE_HANDLE.test(scope)) throw new Error("Invalid telemetry workspace scope.");
    if (this.activeScope === scope) {
      throw new Error("Cannot archive telemetry while its workspace is active.");
    }
    const source = join(this.telemetryDir, `${scope}.jsonl`);
    const destinationDir = join(destinationRoot, "telemetry");
    const destination = join(destinationDir, "events.jsonl");
    this.stores.get(scope)?.closePersistence();
    try {
      await access(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.stores.delete(scope);
        return undefined;
      }
      throw error;
    }
    await mkdir(destinationDir, { recursive: true, mode: 0o700 });
    try {
      await rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.stores.delete(scope);
        return undefined;
      }
      throw error;
    }
    this.stores.delete(scope);
    return destination;
  }

  private storeFor(scope: string): TelemetryStore {
    const existing = this.stores.get(scope);
    if (existing !== undefined) return existing;
    const filename = scope === "default" ? "events.jsonl" : `${scope}.jsonl`;
    const store = new TelemetryStore(this.workspaceCapacity, {
      jsonlPath: join(this.telemetryDir, filename),
    });
    this.stores.set(scope, store);
    return store;
  }

  override get size(): number {
    return this.active.size;
  }

  override get dropped(): number {
    return this.active.dropped;
  }

  override get cursor(): number {
    return this.active.cursor;
  }

  override add(
    record: Omit<TelemetryRecord, "seq" | "timestamp"> & { timestamp?: number },
  ): TelemetryRecord {
    return this.active.add(record);
  }

  override mark(label: string): TelemetryRecord {
    return this.active.mark(label);
  }

  override query(opts: QueryOptions = {}): QueryResult {
    return this.active.query(opts);
  }

  override sinceMarker(label: string, opts: Omit<QueryOptions, "since"> = {}): QueryResult {
    return this.active.sinceMarker(label, opts);
  }

  override summary(
    since?: number,
    plugin?: string,
  ): { errors: number; warnings: number; total: number } {
    return this.active.summary(since, plugin);
  }

  override recordCounts(): TelemetryRecordCounts {
    return this.active.recordCounts();
  }

  override persistenceSummary(): TelemetryPersistenceSummary {
    return this.active.persistenceSummary();
  }

  override clear(): void {
    this.active.clear();
  }

  override closePersistence(): void {
    for (const store of this.stores.values()) store.closePersistence();
  }
}
