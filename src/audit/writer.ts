import { appendFile, chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { knapperHome } from "../config.js";
import type { AuditSink, ToolAuditEvent } from "./types.js";

const FILE_PATTERN = /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/;
export const DEFAULT_AUDIT_RETENTION_DAYS = 14;

/** Use the UTC date from the event clock for stable daily file names. */
export function auditDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export interface JsonlAuditWriterOptions {
  home?: string;
  retentionDays?: number;
  now?: () => Date;
}

export class JsonlAuditWriter implements AuditSink {
  private readonly directory: string;
  private readonly retentionDays: number;
  private readonly now: () => Date;
  private chain: Promise<void> = Promise.resolve();
  private lastPrunedDay?: string;

  constructor(options: JsonlAuditWriterOptions = {}) {
    this.directory = join(options.home ?? knapperHome(), "audit");
    this.retentionDays = Math.max(
      1,
      Math.floor(options.retentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS),
    );
    this.now = options.now ?? (() => new Date());
  }

  write(event: ToolAuditEvent): Promise<void> {
    const pending = this.chain.then(async () => {
      const day = auditDay(this.now());
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      await appendFile(join(this.directory, `audit-${day}.jsonl`), `${JSON.stringify(event)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      if (this.lastPrunedDay !== day) {
        this.lastPrunedDay = day;
        await this.prune().catch(() => undefined);
      }
    });
    this.chain = pending.catch(() => undefined);
    return pending;
  }

  private async prune(): Promise<void> {
    const cutoff = new Date(
      this.now().getTime() - Math.max(0, this.retentionDays - 1) * 86_400_000,
    );
    const oldestDay = auditDay(cutoff);
    const names = (await readdir(this.directory)).filter((name) => FILE_PATTERN.test(name));
    for (const name of names) {
      const day = name.slice("audit-".length, -".jsonl".length);
      if (day < oldestDay) await rm(join(this.directory, name), { force: true });
    }
  }
}
