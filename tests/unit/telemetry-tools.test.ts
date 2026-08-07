import { describe, expect, it, vi } from "vitest";
import { TelemetryStore } from "../../src/telemetry/store.js";
import { registerTelemetryTools } from "../../src/tools/telemetry.js";
import type { ToolDefinition } from "../../src/tools/registry.js";

function setupStatus(playwrightAvailable: boolean, pages = 0) {
  const definitions = new Map<string, ToolDefinition>();
  const windows = vi
    .fn()
    .mockResolvedValue([
      { title: "Private Note - Secret Vault", vaultName: "Secret Vault", kind: "main" },
    ]);
  const capture = {
    isArmed: false,
    isNetworkEnabled: false,
    arm: vi.fn().mockResolvedValue({ armed: true, pages }),
  };
  const telemetry = new TelemetryStore();
  registerTelemetryTools({
    registry: { add: (definition: ToolDefinition) => definitions.set(definition.name, definition) },
    router: {
      refreshAvailability: vi.fn().mockResolvedValue({ playwright: playwrightAvailable }),
      playwright: { windows },
    },
    telemetry,
    capture,
  } as never);
  return {
    logs: definitions.get("obsidian_logs")!,
    status: definitions.get("obsidian_telemetry_status")!,
    capture,
    telemetry,
    windows,
  };
}

describe("obsidian_telemetry_status privacy", () => {
  it("reports authorized subscription summaries without enumerating window metadata", async () => {
    const { status, windows } = setupStatus(true, 2);

    const outcome = (await status.handler({})) as { text: string; json: Record<string, unknown> };

    expect(windows).not.toHaveBeenCalled();
    expect(outcome.text).not.toContain("Private Note");
    expect(JSON.stringify(outcome.json)).not.toContain("Secret Vault");
    expect(outcome.json).toMatchObject({
      pagesSubscribed: 2,
      subscriptions: [{ authorized: true }, { authorized: true }],
    });
    expect(outcome.json).not.toHaveProperty("windows");
  });

  it("returns explicit empty subscriptions and zero record counts", async () => {
    const { status, capture } = setupStatus(false);

    const outcome = (await status.handler({})) as { json: Record<string, unknown> };

    expect(capture.arm).not.toHaveBeenCalled();
    expect(outcome.json).toMatchObject({
      pagesSubscribed: 0,
      subscriptions: [],
      counts: {
        total: 0,
        byLevel: { debug: 0, info: 0, log: 0, warn: 0, error: 0 },
        bySource: { console: 0, pageerror: 0, exception: 0, network: 0, marker: 0 },
      },
    });
  });

  it("renders explicit query counts for text-only MCP clients", async () => {
    const { logs } = setupStatus(false);

    const outcome = (await logs.handler({})) as { text: string; json: Record<string, unknown> };

    expect(outcome.text).toContain("(no matching records)");
    expect(outcome.text).toContain("Records: 0 returned, 0 matched. Cursor: 0. Dropped: 0.");
    expect(outcome.json).toMatchObject({ returned: 0, matched: 0, cursor: 0, dropped: 0 });
  });
});
