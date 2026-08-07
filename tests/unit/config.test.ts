import { describe, expect, it } from "vitest";
import { loadConfig, DEFAULT_CDP_URL } from "../../src/config.js";
import { parseToolsets, DEFAULT_TOOLSETS, TOOLSETS } from "../../src/toolsets.js";
import {
  CAPABILITY_PREFERENCE,
  CAPABILITIES,
  EXCLUSIVE_DEBUGGER_LAYERS,
} from "../../src/capabilities.js";

describe("parseToolsets", () => {
  it("defaults to an empty operational toolset", () => {
    expect([...parseToolsets(undefined).enabled].sort()).toEqual([...DEFAULT_TOOLSETS].sort());
    expect([...parseToolsets("").enabled].sort()).toEqual([...DEFAULT_TOOLSETS].sort());
  });

  it("enables everything for `all`", () => {
    expect(parseToolsets("all").enabled.size).toBe(TOOLSETS.length);
  });

  it("parses a comma-separated list, tolerating whitespace and case", () => {
    const { enabled } = parseToolsets(" Core , VAULT ");
    expect([...enabled].sort()).toEqual(["core", "vault"]);
  });

  it("collects unknown names instead of throwing, so a typo cannot break startup", () => {
    const { enabled, unknown } = parseToolsets("core,nonsense");
    expect([...enabled]).toEqual(["core"]);
    expect(unknown).toEqual(["nonsense"]);
  });

  it("keeps the operational surface empty when every name is invalid", () => {
    const { enabled, unknown } = parseToolsets("bogus,alsobogus");
    expect([...enabled].sort()).toEqual([...DEFAULT_TOOLSETS].sort());
    expect(unknown).toEqual(["bogus", "alsobogus"]);
  });
});

describe("loadConfig", () => {
  it("parses the command transport preference", () => {
    expect(loadConfig({}, {}).commandTransport).toBe("auto");
    expect(loadConfig({}, { KNAP_COMMAND_TRANSPORT: "cli" }).commandTransport).toBe("cli");
    expect(loadConfig({}, { KNAP_COMMAND_TRANSPORT: "playwright" }).commandTransport).toBe(
      "playwright",
    );
    expect(() => loadConfig({}, { KNAP_COMMAND_TRANSPORT: "invalid" })).toThrow(
      /KNAP_COMMAND_TRANSPORT/,
    );
  });
  it("uses defaults with an empty environment", () => {
    const config = loadConfig({}, {});
    expect(config.cdpUrl).toBe(DEFAULT_CDP_URL);
    expect(config.cdpPort).toBe(9222);
    expect(config.logLevel).toBe("info");
    expect(config.telemetryBuffer).toBe(2000);
    expect(config.telemetryNetwork).toBe(false);
    expect(config.idleTimeoutMs).toBe(86_400_000);
    expect(config.vault).toBeUndefined();
  });

  it("reads and clamps the shared inactivity timeout", () => {
    expect(loadConfig({}, { KNAP_IDLE_TIMEOUT_MS: "120000" }).idleTimeoutMs).toBe(120_000);
    expect(loadConfig({}, { KNAP_IDLE_TIMEOUT_MS: "1000" }).idleTimeoutMs).toBe(30_000);
  });

  it("reads environment variables", () => {
    const config = loadConfig(
      {},
      {
        OBSIDIAN_CDP_URL: "http://127.0.0.1:9333",
        OBSIDIAN_VAULT: "my-vault",
        KNAP_TOOLSETS: "core",
        KNAP_LOG_LEVEL: "debug",
        KNAP_TELEMETRY_BUFFER: "50",
      },
    );
    expect(config.cdpPort).toBe(9333);
    expect(config.vault).toBe("my-vault");
    expect(config.logLevel).toBe("debug");
    expect(config.telemetryBuffer).toBe(50);
    expect([...config.enabledToolsets]).toEqual(["core"]);
  });

  it("lets explicit overrides win over the environment", () => {
    const config = loadConfig({ vault: "flag-vault" }, { OBSIDIAN_VAULT: "env-vault" });
    expect(config.vault).toBe("flag-vault");
  });

  it("ignores an invalid log level rather than failing to start", () => {
    expect(loadConfig({}, { KNAP_LOG_LEVEL: "chatty" }).logLevel).toBe("info");
  });

  it("ignores a non-numeric buffer size", () => {
    expect(loadConfig({}, { KNAP_TELEMETRY_BUFFER: "lots" }).telemetryBuffer).toBe(2000);
  });

  it("accepts the truthy spellings people actually type for network capture", () => {
    for (const raw of ["1", "true", "TRUE", "yes", "on"]) {
      expect(loadConfig({}, { KNAP_TELEMETRY_NETWORK: raw }).telemetryNetwork).toBe(true);
    }
    for (const raw of ["0", "false", "no", "off"]) {
      expect(loadConfig({}, { KNAP_TELEMETRY_NETWORK: raw }).telemetryNetwork).toBe(false);
    }
    // Garbage must not silently arm a noisy capture path.
    expect(loadConfig({}, { KNAP_TELEMETRY_NETWORK: "maybe" }).telemetryNetwork).toBe(false);
  });

  it("derives the port from a URL without one", () => {
    expect(loadConfig({ cdpUrl: "http://localhost" }, {}).cdpPort).toBe(80);
  });

  it("defaults to the stdio transport on loopback", () => {
    const config = loadConfig({}, {});
    expect(config.transport).toBe("stdio");
    expect(config.httpPort).toBe(9223);
    expect(config.httpHost).toBe("127.0.0.1");
  });

  it("reads the transport settings from the environment", () => {
    const config = loadConfig({}, { MCP_TRANSPORT: "http", MCP_PORT: "9999", MCP_HOST: "0.0.0.0" });
    expect(config.transport).toBe("http");
    expect(config.httpPort).toBe(9999);
    expect(config.httpHost).toBe("0.0.0.0");
  });

  it("falls back to stdio for an unrecognized transport rather than failing to start", () => {
    expect(loadConfig({}, { MCP_TRANSPORT: "carrier-pigeon" }).transport).toBe("stdio");
  });

  it("reads the target match filter", () => {
    expect(loadConfig({}, { OBSIDIAN_TARGET_MATCH: "Sandbox" }).targetMatch).toBe("Sandbox");
    expect(loadConfig({}, { OBSIDIAN_TARGET_MATCH: "" }).targetMatch).toBeUndefined();
    expect(loadConfig({}, {}).targetMatch).toBeUndefined();
  });

  it("clamps concurrency to at least one, so a zero cannot wedge every tool call", () => {
    expect(loadConfig({}, {}).maxConcurrency).toBe(4);
    expect(loadConfig({}, { KNAP_MAX_CONCURRENCY: "1" }).maxConcurrency).toBe(1);
    expect(loadConfig({}, { KNAP_MAX_CONCURRENCY: "0" }).maxConcurrency).toBe(1);
    expect(loadConfig({}, { KNAP_MAX_CONCURRENCY: "nope" }).maxConcurrency).toBe(4);
  });

  it("accepts the plan's canonical env names alongside the KNAP_ prefixed ones", () => {
    expect(loadConfig({}, { LOG_LEVEL: "warn" }).logLevel).toBe("warn");
    expect(loadConfig({}, { RECONNECT_MS: "500" }).reconnectMs).toBe(500);
    expect(loadConfig({}, { SCREENSHOT_DIR: "/tmp/shots" }).outputDir).toBe("/tmp/shots");
    // The prefixed name wins where both are set, since it is the documented one.
    expect(loadConfig({}, { KNAP_LOG_LEVEL: "debug", LOG_LEVEL: "warn" }).logLevel).toBe("debug");
  });
});

describe("capability model", () => {
  it("declares a layer preference for every capability", () => {
    for (const capability of CAPABILITIES) {
      expect(CAPABILITY_PREFERENCE[capability].length).toBeGreaterThan(0);
    }
  });

  it("keeps real input, aria snapshots, and event streams Playwright-only", () => {
    for (const capability of ["realInput", "ariaSnapshot", "eventStream"] as const) {
      expect(CAPABILITY_PREFERENCE[capability]).toEqual(["playwright"]);
    }
  });

  it("prefers the CLI for evaluate, since it needs no app restart", () => {
    expect(CAPABILITY_PREFERENCE.evaluate[0]).toBe("cli");
  });

  it("keeps installing plugins CLI-only", () => {
    expect(CAPABILITY_PREFERENCE.pluginInstall).toEqual(["cli"]);
  });

  it("declares no capability that no tool requires", () => {
    // A capability with no caller is dead routing logic that still has to be kept
    // consistent; the registry is the only thing that consumes this table.
    expect(Object.keys(CAPABILITY_PREFERENCE).sort()).toEqual([...CAPABILITIES].sort());
  });

  it("treats the two CDP transports as non-exclusive, per the Gate B measurement", () => {
    // scripts/spike-gates.mjs verified dev:cdp and connectOverCDP coexist.
    expect(EXCLUSIVE_DEBUGGER_LAYERS).toEqual([]);
  });
});
