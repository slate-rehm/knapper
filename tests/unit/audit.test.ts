import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditDay, JsonlAuditWriter } from "../../src/audit/writer.js";
import { requestId, toolAuditEvent } from "../../src/audit/event.js";

describe("audit persistence", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("uses stable UTC dates for daily files", () => {
    expect(auditDay(new Date("2026-08-06T00:00:00.000Z"))).toBe("2026-08-06");
    expect(auditDay(new Date("2026-08-06T23:59:59.999Z"))).toBe("2026-08-06");
  });

  it("hashes a request id that could contain private text", () => {
    const id = requestId({ requestId: "raw message with spaces" });
    expect(id).toMatch(/^sha256:[a-f0-9]{24}$/);
    expect(id).not.toContain("raw message");
  });

  it("redacts client-controlled argument keys", () => {
    const event = toolAuditEvent({
      timestamp: "2026-08-06T17:00:00.000Z",
      requestId: "request-keys",
      tool: "example",
      durationMs: 1,
      queueMs: 0,
      outcome: "success",
      args: { "private key with spaces": "secret", normal_key: 1 },
    });

    expect(event.arguments.keys).toEqual(["[redacted]", "normal_key"]);
    expect(JSON.stringify(event.arguments)).not.toContain("private key");
  });

  it("writes private JSONL files and removes files outside retention", async () => {
    const home = await mkdtemp(join(tmpdir(), "knapper-audit-"));
    roots.push(home);
    const directory = join(home, "audit");
    await mkdir(directory, { mode: 0o755 });
    const writer = new JsonlAuditWriter({
      home,
      retentionDays: 2,
      now: () => new Date("2026-08-06T12:00:00.000Z"),
    });
    const event = toolAuditEvent({
      timestamp: "2026-08-06T17:00:00.000Z",
      requestId: "request-1",
      tool: "example",
      durationMs: 5,
      queueMs: 1,
      outcome: "success",
      args: {},
    });

    await writer.write(event);
    await writeFile(join(directory, "audit-2026-08-04.jsonl"), "{}\n");
    await writeFile(join(directory, "audit-2026-08-05.jsonl"), "{}\n");
    const nextWriter = new JsonlAuditWriter({
      home,
      retentionDays: 2,
      now: () => new Date("2026-08-06T12:00:00.000Z"),
    });
    await nextWriter.write(event);

    expect((await readdir(directory)).sort()).toEqual([
      "audit-2026-08-05.jsonl",
      "audit-2026-08-06.jsonl",
    ]);
    const path = join(directory, "audit-2026-08-06.jsonl");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ event: "tool.call" });
  });
});
