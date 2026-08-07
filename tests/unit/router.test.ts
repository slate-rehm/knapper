import { beforeEach, describe, expect, it, vi } from "vitest";

// The router probes the CDP port and reads obsidian.json to decide what is
// reachable. Mocking both lets every transport combination be exercised without a
// live Obsidian, which is what keeps this suite CI-safe.
const probeCdp = vi.fn();
const readGlobalConfig = vi.fn();
const isObsidianRunning = vi.fn();

vi.mock("../../src/connection/cdp/discover.js", () => ({
  probeCdp: (...args: unknown[]) => probeCdp(...args),
}));

vi.mock("../../src/connection/vaults.js", () => ({
  readGlobalConfig: (...args: unknown[]) => readGlobalConfig(...args),
}));

vi.mock("../../src/connection/health.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/connection/health.js")>();
  return {
    ...actual,
    isObsidianRunning: (...args: unknown[]) => isObsidianRunning(...args),
  };
});

const { CapabilityRouter } = await import("../../src/connection/router.js");
const { loadConfig } = await import("../../src/config.js");
const { createLogger } = await import("../../src/util/logger.js");

function makeRouter() {
  return new CapabilityRouter(loadConfig({}, {}), createLogger("silent"));
}

function makeRouterWithTransport(commandTransport: "auto" | "cli" | "playwright") {
  return new CapabilityRouter(loadConfig({ commandTransport }, {}), createLogger("silent"));
}

/** Both transports up. */
function bothAvailable() {
  probeCdp.mockResolvedValue({ Browser: "Chrome/142" });
  readGlobalConfig.mockResolvedValue({ cli: true, vaults: [], raw: {} });
  isObsidianRunning.mockResolvedValue(true);
}

/** CLI enabled, no debug port — the common case for a normally-started Obsidian. */
function cliOnly() {
  probeCdp.mockResolvedValue(undefined);
  readGlobalConfig.mockResolvedValue({ cli: true, vaults: [], raw: {} });
  isObsidianRunning.mockResolvedValue(true);
}

/** Debug port open but the CLI toggle never enabled. */
function playwrightOnly() {
  probeCdp.mockResolvedValue({ Browser: "Chrome/142" });
  readGlobalConfig.mockResolvedValue({ cli: false, vaults: [], raw: {} });
  isObsidianRunning.mockResolvedValue(true);
}

/** Nothing reachable. */
function nothingAvailable() {
  probeCdp.mockResolvedValue(undefined);
  readGlobalConfig.mockResolvedValue({ cli: false, vaults: [], raw: {} });
  isObsidianRunning.mockResolvedValue(false);
}

/**
 * Obsidian is up, but the CLI toggle is off and no debug port is open — so neither
 * the socket nor the renderer route can serve a CLI command.
 */
function cliDisabledAndPortClosed() {
  probeCdp.mockResolvedValue(undefined);
  readGlobalConfig.mockResolvedValue({ cli: false, vaults: [], raw: {} });
  isObsidianRunning.mockResolvedValue(true);
}

/** CLI flag on but Obsidian not running — must not cold-start without CDP. */
function cliEnabledButNotRunning() {
  probeCdp.mockResolvedValue(undefined);
  readGlobalConfig.mockResolvedValue({ cli: true, vaults: [], raw: {} });
  isObsidianRunning.mockResolvedValue(false);
}

beforeEach(() => {
  probeCdp.mockReset();
  readGlobalConfig.mockReset();
  isObsidianRunning.mockReset();
});

describe("refreshAvailability", () => {
  it("reports both transports when both are up", async () => {
    bothAvailable();
    expect(await makeRouter().refreshAvailability()).toEqual({
      playwright: true,
      cli: true,
      cliCdp: true,
      local: true,
    });
  });

  it("treats a closed port as no Playwright layer", async () => {
    cliOnly();
    const availability = await makeRouter().refreshAvailability();
    expect(availability.playwright).toBe(false);
    expect(availability.cli).toBe(true);
  });

  it("keeps the local layer available even with nothing else reachable", async () => {
    nothingAvailable();
    expect((await makeRouter().refreshAvailability()).local).toBe(true);
  });

  it("caches briefly so a burst of tool calls does not re-probe the port each time", async () => {
    bothAvailable();
    const router = makeRouter();
    await router.refreshAvailability();
    await router.refreshAvailability();
    await router.refreshAvailability();
    expect(probeCdp).toHaveBeenCalledTimes(1);
  });

  it("re-probes when forced", async () => {
    bothAvailable();
    const router = makeRouter();
    await router.refreshAvailability();
    await router.refreshAvailability(true);
    expect(probeCdp).toHaveBeenCalledTimes(2);
  });
});

describe("resolve", () => {
  it("honors an explicit command transport", async () => {
    bothAvailable();
    expect(await makeRouterWithTransport("playwright").resolve("evaluate")).toBe("playwright");
    expect(await makeRouterWithTransport("cli").resolve("evaluate")).toBe("cli");
  });
  it("prefers the CLI for evaluate, avoiding the restart Playwright would need", async () => {
    bothAvailable();
    expect(await makeRouter().resolve("evaluate")).toBe("cli");
  });

  it("falls back to Playwright for evaluate when the CLI is disabled", async () => {
    playwrightOnly();
    expect(await makeRouter().resolve("evaluate")).toBe("playwright");
  });

  it("routes Playwright-only capabilities to Playwright", async () => {
    bothAvailable();
    const router = makeRouter();
    expect(await router.resolve("realInput")).toBe("playwright");
    expect(await router.resolve("ariaSnapshot")).toBe("playwright");
    expect(await router.resolve("eventStream")).toBe("playwright");
  });

  it("prefers Playwright for screenshots but accepts the CLI window capture", async () => {
    bothAvailable();
    expect(await makeRouter().resolve("screenshot")).toBe("playwright");
    cliOnly();
    expect(await makeRouter().resolve("screenshot")).toBe("cliCdp");
  });

  it("serves local capabilities regardless of transport state", async () => {
    nothingAvailable();
    const router = makeRouter();
    expect(await router.resolve("launch")).toBe("local");
  });
});

describe("CLI timeout demotion", () => {
  it("returns the timeout and routes later commands through Playwright", async () => {
    bothAvailable();
    const router = makeRouter();
    const { UobError } = await import("../../src/util/errors.js");
    const run = vi
      .spyOn(router.cli, "run")
      .mockRejectedValueOnce(new UobError("TIMEOUT", "slow CLI"));

    await expect(router.cliCommand(["version"])).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await router.resolve("cliCommand")).toBe("playwright");
    expect(router.commandTransportStatus).toMatchObject({
      mode: "auto",
      selected: "playwright",
      cliDegradedUntil: expect.any(String),
      lastCliTimeoutAt: expect.any(String),
    });
  });
});

describe("CLI JSON evaluation", () => {
  it("lets Obsidian serialize a multiline IIFE instead of wrapping it", async () => {
    cliOnly();
    const router = makeRouter();
    vi.spyOn(router.fence, "resolve").mockResolvedValue({
      id: "abc",
      name: "scratch",
      path: "/tmp/scratch",
      grant: "adopted",
    });
    const evaluate = vi.spyOn(router.cli, "evaluate").mockResolvedValue('=> {"editor":true}\n');
    const code = "(() => {\n  return { editor: true };\n})()";

    await expect(router.evaluateJson<{ editor: boolean }>(code)).resolves.toMatchObject({
      value: { editor: true },
      layer: "cli",
    });
    expect(evaluate).toHaveBeenCalledWith(code, "scratch");
  });

  it("preserves a scalar string returned by the CLI", async () => {
    cliOnly();
    const router = makeRouter();
    vi.spyOn(router.fence, "resolve").mockResolvedValue({
      id: "abc",
      name: "scratch",
      path: "/tmp/scratch",
      grant: "adopted",
    });
    vi.spyOn(router.cli, "evaluate").mockResolvedValue("=> ready\n");

    await expect(router.evaluateJson<string>('"ready"')).resolves.toMatchObject({ value: "ready" });
  });
});

describe("resolve failures name the right precondition", () => {
  it("blames the closed port for a Playwright-only capability", async () => {
    cliOnly();
    await expect(makeRouter().resolve("realInput")).rejects.toMatchObject({
      code: "CDP_PORT_CLOSED",
    });
  });

  it("explains that Obsidian must be fully quit before the debug flag applies", async () => {
    cliOnly();
    await expect(makeRouter().resolve("ariaSnapshot")).rejects.toMatchObject({
      remediation: expect.stringMatching(/fully quit/i),
    });
  });

  it("falls back to the renderer for a CLI command when the CLI is disabled", async () => {
    // Obsidian's own main process serves a CLI request by evaluating
    // `window.handleCli(argv)` in the renderer, so Playwright is a genuine second
    // route rather than a degraded one — and the only route on macOS and Windows.
    playwrightOnly();
    await expect(makeRouter().resolve("cliCommand")).resolves.toBe("playwright");
  });

  it("still blames the disabled CLI when neither route is available", async () => {
    // The precondition states must stay distinguishable: adding the fallback must
    // not collapse "CLI is off" into a generic "cannot connect".
    cliDisabledAndPortClosed();
    await expect(makeRouter().resolve("cliCommand")).rejects.toMatchObject({
      code: "CLI_DISABLED",
      fixedBy: "obsidian_setup_cli",
    });
  });

  it("points at the doctor when a mixed-preference capability has no transport", async () => {
    nothingAvailable();
    await expect(makeRouter().resolve("evaluate")).rejects.toMatchObject({
      code: "OBSIDIAN_NOT_RUNNING",
      fixedBy: "obsidian_doctor",
    });
  });

  it("does not treat CLI-enabled-but-not-running as an available CLI layer", async () => {
    // Otherwise resolve succeeds and execFile cold-starts Obsidian without CDP.
    cliEnabledButNotRunning();
    const availability = await makeRouter().refreshAvailability();
    expect(availability.cli).toBe(false);
    await expect(makeRouter().resolve("cliCommand")).rejects.toMatchObject({
      code: "OBSIDIAN_NOT_RUNNING",
    });
  });
});

describe("debugger tracking", () => {
  it("records the holder for diagnostics", async () => {
    bothAvailable();
    const router = makeRouter();
    expect(router.currentDebuggerHolder).toBeUndefined();
    router.claimDebugger("playwright");
    expect(router.currentDebuggerHolder).toBe("playwright");
    router.releaseDebugger("playwright");
    expect(router.currentDebuggerHolder).toBeUndefined();
  });

  it("does not refuse the other CDP transport, since the two were measured to coexist", async () => {
    bothAvailable();
    const router = makeRouter();
    router.claimDebugger("playwright");
    // Gate B: dev:cdp still works while connectOverCDP is attached.
    expect(() => router.claimDebugger("cliCdp")).not.toThrow();
    expect(await router.resolve("rawCdp")).toBe("playwright");
  });

  it("ignores a release from a layer that does not hold it", async () => {
    bothAvailable();
    const router = makeRouter();
    router.claimDebugger("playwright");
    router.releaseDebugger("cliCdp");
    expect(router.currentDebuggerHolder).toBe("playwright");
  });
});

describe("runtime rebinding", () => {
  it("rebuilds target-specific transports after the config changes", async () => {
    nothingAvailable();
    const config = loadConfig({}, {});
    const router = new CapabilityRouter(config, createLogger("silent"));
    const oldCli = router.cli;
    const oldPlaywright = router.playwright;

    config.sessionId = "bound-a3f19c22";
    config.userDataDir = "/tmp/bound/userdata";
    config.obsidianConfigPath = "/tmp/bound/userdata/obsidian.json";
    config.runtimeDir = "/tmp/bound/run";
    config.cdpUrl = "http://127.0.0.1:43123";
    config.cdpPort = 43123;
    await router.rebind();

    expect(router.cli).not.toBe(oldCli);
    expect(router.playwright).not.toBe(oldPlaywright);
    expect(router.supervisor.started).toBe(true);
    await router.dispose();
  });
});
