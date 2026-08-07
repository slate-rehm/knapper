import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { applySessionConfig } from "../../src/server.js";
import type { SessionDescriptor } from "../../src/session/descriptor.js";

function descriptor(): SessionDescriptor {
  return {
    schema: 2,
    key: "bound-a3f19c22",
    createdAt: "2026-08-04T12:00:00.000Z",
    heartbeatAt: "2026-08-04T12:00:00.000Z",
    readiness: { phase: "ready", readyAt: "2026-08-04T12:00:01.000Z" },
    origin: { cwd: "/tmp/plugin" },
    instance: {
      userDataDir: "/tmp/session/userdata",
      runtimeDir: "/tmp/session/run",
      outputDir: "/tmp/session/output",
      cdpPort: 43123,
      cdpUrl: "http://127.0.0.1:43123",
      obsidianBin: "obsidian",
    },
    vault: {
      id: "abc",
      name: "bound-vault",
      path: "/tmp/session/vault",
      grant: "created",
    },
  };
}

describe("applySessionConfig", () => {
  it("moves every target-specific setting to the session", () => {
    const config = loadConfig({}, {});
    config.targetMatch = "default-profile-window";
    applySessionConfig(config, descriptor());

    expect(config).toMatchObject({
      sessionId: "bound-a3f19c22",
      cdpUrl: "http://127.0.0.1:43123",
      cdpPort: 43123,
      userDataDir: "/tmp/session/userdata",
      obsidianConfigPath: "/tmp/session/userdata/obsidian.json",
      runtimeDir: "/tmp/session/run",
      outputDir: "/tmp/session/output",
      vault: "bound-vault",
      cliIsolation: "per-session",
    });
    expect(config.targetMatch).toBeUndefined();
  });

  it("refuses a session that is still starting", () => {
    const pending = descriptor();
    pending.readiness = {
      phase: "starting",
      spawnedAt: "2026-08-04T12:00:00.000Z",
      requestedPort: 0,
    };
    expect(() => applySessionConfig(loadConfig({}, {}), pending)).toThrow(/not ready/);
  });
});
