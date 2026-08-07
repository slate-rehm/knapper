import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import type { CapabilityRouter } from "../../src/connection/router.js";
import { runDevCycle } from "../../src/devcycle/dev-cycle.js";
import { logsSinceMark } from "../../src/devcycle/helpers.js";
import {
  deltaChanged,
  emptySnapshot,
  formatWorkspaceDelta,
  workspaceDelta,
} from "../../src/devcycle/workspace-delta.js";
import type { ServerContext } from "../../src/server.js";
import { TelemetryStore } from "../../src/telemetry/store.js";
import { registerAuthoringTools } from "../../src/tools/authoring.js";
import { pluginListContains, registerObsidianTools } from "../../src/tools/obsidian.js";
import { registerPluginDevTools } from "../../src/tools/plugin-dev.js";
import { ToolRegistry, type ToolOutcome } from "../../src/tools/registry.js";
import { createLogger } from "../../src/util/logger.js";
import { readPluginData } from "../../src/obsidian/helpers.js";

const artifactRoots: string[] = [];
afterEach(async () =>
  Promise.all(artifactRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

async function testConfig(): Promise<Config> {
  const outputDir = await mkdtemp(join(tmpdir(), "knap-devcycle-artifacts-"));
  artifactRoots.push(outputDir);
  return { vault: "test-vault", outputDir } as Config;
}

const config = { vault: "test-vault", outputDir: ".knapper" } as Config;

function outcomeJson(outcome: ToolOutcome): Record<string, unknown> {
  if (typeof outcome !== "object" || outcome === null || !("json" in outcome)) {
    throw new Error("Expected a structured tool outcome.");
  }
  return outcome.json as Record<string, unknown>;
}

function outcomeText(outcome: ToolOutcome): string {
  if (typeof outcome !== "object" || outcome === null || !("text" in outcome)) {
    throw new Error("Expected a text tool outcome.");
  }
  return outcome.text;
}

function registryFor(...toolsets: ("core" | "plugin-dev" | "authoring")[]): ToolRegistry {
  return new ToolRegistry(new Set(toolsets), createLogger("error"), 2);
}

function context(
  registry: ToolRegistry,
  router: Partial<CapabilityRouter>,
  telemetry = new TelemetryStore(50),
): ServerContext {
  return {
    registry,
    router,
    telemetry,
    config,
  } as unknown as ServerContext;
}

describe("development-cycle truth signals", () => {
  it("recognizes enabled plugin IDs in JSON and tabular output", () => {
    expect(pluginListContains([{ id: "example", enabled: true }], "", "example")).toBe(true);
    expect(pluginListContains(undefined, "example\tExample Plugin\n", "example")).toBe(true);
    expect(pluginListContains(["other"], "other\tOther\n", "example")).toBe(false);
  });

  it("reads persisted plugin data and conventional runtime settings", async () => {
    const evaluateJson = vi.fn(async () => ({
      value: { persisted: null, runtime: { model: "test" } },
    }));

    await expect(
      readPluginData({ evaluateJson } as unknown as CapabilityRouter, "example", "vault"),
    ).resolves.toEqual({ persisted: null, runtime: { model: "test" } });
    expect(evaluateJson).toHaveBeenCalledWith(
      expect.stringContaining("await p.loadData()"),
      expect.objectContaining({ vault: "vault" }),
    );
    expect(evaluateJson).toHaveBeenCalledWith(
      expect.stringContaining('"settings" in p'),
      expect.any(Object),
    );
  });

  it("keeps warning counts aligned with the plugin-filtered records", () => {
    const telemetry = new TelemetryStore(50);
    const mark = telemetry.mark("before");
    telemetry.add({
      source: "console",
      level: "warn",
      text: "other",
      plugin: "other",
    });
    telemetry.add({
      source: "console",
      level: "warn",
      text: "target",
      plugin: "example",
    });

    const slice = logsSinceMark(telemetry, mark.seq, "example");

    expect(slice.records.map((record) => record.text)).toEqual(["target"]);
    expect(slice.warnings).toBe(1);
    expect(slice.errors).toBe(0);
  });

  it("counts errors outside the 200 displayed records", () => {
    const telemetry = new TelemetryStore(500);
    const mark = telemetry.mark("before-many");
    telemetry.add({
      source: "console",
      level: "error",
      text: "early error",
      plugin: "example",
    });
    for (let index = 0; index < 250; index++) {
      telemetry.add({
        source: "console",
        level: "info",
        text: `later ${index}`,
        plugin: "example",
      });
    }

    const slice = logsSinceMark(telemetry, mark.seq, "example");

    expect(slice.records).toHaveLength(200);
    expect(slice.records.some((record) => record.text === "early error")).toBe(false);
    expect(slice.errors).toBe(1);
  });

  it("counts unattributed and other-plugin errors against the verdict", () => {
    const telemetry = new TelemetryStore(50);
    const mark = telemetry.mark("before-mixed-errors");
    telemetry.add({
      source: "pageerror",
      level: "error",
      text: "unknown source",
    });
    telemetry.add({
      source: "console",
      level: "error",
      text: "other",
      plugin: "other",
    });
    telemetry.add({
      source: "console",
      level: "error",
      text: "target",
      plugin: "example",
    });

    const slice = logsSinceMark(telemetry, mark.seq, "example");

    expect(slice).toMatchObject({
      errors: 1,
      allErrors: 3,
      pluginErrors: 1,
      unattributedErrors: 1,
      otherPluginErrors: 1,
    });
  });

  it("does not capture a screenshot by default and verifies live plugin health", async () => {
    const health = {
      id: "example-plugin",
      exists: true,
      kind: "community",
      loaded: true,
      enabled: true,
      name: "Example",
      version: "1.0.0",
      commands: [],
    } as const;
    const router = {
      cliCommand: vi.fn(async () => ""),
      refreshAvailability: vi.fn(async () => ({ playwright: false })),
      evaluateJson: vi.fn(async () => ({ value: health })),
    } as unknown as CapabilityRouter;
    const capture = { tryArm: vi.fn(async () => undefined) };

    const outcome = await runDevCycle(
      router,
      await testConfig(),
      new TelemetryStore(50),
      capture as never,
      { pluginId: "example-plugin", waitMs: 0, vault: "test-vault" },
      {},
    );
    const json = outcomeJson(outcome);

    expect(json.verdict).toBe("clean");
    expect(json.health).toMatchObject({
      exists: true,
      enabled: true,
      loaded: true,
    });
    expect(json.screenshot).toEqual({
      mode: "none",
      captured: false,
      file: null,
    });
    expect("images" in (outcome as object)).toBe(false);
    expect(router.refreshAvailability).toHaveBeenCalledTimes(1);
  });

  it("does not report clean when reload leaves the plugin unloaded", async () => {
    const router = {
      cliCommand: vi.fn(async () => ""),
      refreshAvailability: vi.fn(async () => ({ playwright: false })),
      evaluateJson: vi.fn(async () => ({
        value: {
          id: "example-plugin",
          exists: true,
          kind: "community",
          loaded: false,
          enabled: true,
          name: "Example",
          version: "1.0.0",
          commands: [],
        },
      })),
    } as unknown as CapabilityRouter;

    const outcome = await runDevCycle(
      router,
      await testConfig(),
      new TelemetryStore(50),
      { tryArm: vi.fn(async () => undefined) } as never,
      { pluginId: "example-plugin", waitMs: 0 },
      {},
    );

    expect(outcomeJson(outcome).verdict).toBe("errors");
    expect("text" in outcome && outcome.text).toContain("not loaded");
  });

  it("captures an image only when full screenshot mode is explicit", async () => {
    const screenshot = vi.fn(async () => Buffer.from("image"));
    const router = {
      cliCommand: vi.fn(async () => ""),
      refreshAvailability: vi.fn(async () => ({ playwright: true })),
      claimDebugger: vi.fn(),
      resolveVault: vi.fn(async () => ({ name: "test-vault" })),
      playwright: {
        evaluate: vi.fn(async () => ({
          id: "example-plugin",
          exists: true,
          kind: "community",
          loaded: true,
          enabled: true,
          name: "Example",
          version: "1.0.0",
          commands: [],
        })),
        page: vi.fn(async () => ({ screenshot })),
      },
    } as unknown as CapabilityRouter;

    const outcome = await runDevCycle(
      router,
      await testConfig(),
      new TelemetryStore(50),
      { tryArm: vi.fn(async () => undefined) } as never,
      { pluginId: "example-plugin", waitMs: 0, screenshot: "full" },
      {},
    );

    expect(outcomeJson(outcome).screenshot).toMatchObject({
      mode: "full",
      captured: true,
      file: { mimeType: "image/png", size: 5, inline: false },
    });
    expect("images" in outcome).toBe(false);
    expect(screenshot).toHaveBeenCalledWith({ type: "png" });
  });

  it("detects a custom view even when the markdown leaf count does not change", () => {
    const before = {
      ...emptySnapshot(),
      openLeaves: 1,
      viewTypes: { markdown: 1 },
    };
    const after = {
      ...emptySnapshot(),
      openLeaves: 1,
      viewTypes: { markdown: 1, "example-view": 1 },
    };
    const delta = workspaceDelta(before, after);

    expect(deltaChanged(delta)).toBe(true);
    expect(formatWorkspaceDelta(delta)).toContain(
      '  view types: {"markdown":1} → {"markdown":1,"example-view":1}',
    );
  });

  it("ignores view-type key insertion order", () => {
    const delta = workspaceDelta(
      { ...emptySnapshot(), viewTypes: { markdown: 1, sigla: 2 } },
      { ...emptySnapshot(), viewTypes: { sigla: 2, markdown: 1 } },
    );

    expect(deltaChanged(delta)).toBe(false);
  });
});

describe("plugin and authoring tool contracts", () => {
  it("discovers plugin commands through the renderer and returns an explicit empty result", async () => {
    const registry = registryFor("core", "plugin-dev");
    const router = {
      cliCommand: vi.fn(async () => {
        throw new Error("The CLI command table must not serve plugin commands.");
      }),
      refreshAvailability: vi.fn(async () => ({ playwright: false })),
      evaluateJson: vi.fn(async () => ({ value: [] })),
    } as unknown as CapabilityRouter;
    registerObsidianTools(context(registry, router));

    const definition = registry.get("obsidian_plugin_commands");
    const outcome = await definition!.handler({
      id: "example-plugin",
      vault: "test-vault",
    });

    expect(definition?.capability).toBe("evaluate");
    expect(outcomeJson(outcome)).toEqual({
      pluginId: "example-plugin",
      count: 0,
      commands: [],
    });
    expect(router.cliCommand).not.toHaveBeenCalled();
    expect(router.evaluateJson).toHaveBeenCalledOnce();
    expect(router.evaluateJson).toHaveBeenCalledWith(
      expect.stringContaining("app.commands?.commands"),
      { vault: "test-vault" },
    );
  });

  it("returns explicit empty theme and snippet arrays", async () => {
    const registry = registryFor("authoring");
    const router = {
      cliCommand: vi.fn(async () => ""),
    } as unknown as CapabilityRouter;
    registerAuthoringTools(context(registry, router));

    const themes = await registry.get("obsidian_themes")!.handler({});
    const snippets = await registry.get("obsidian_snippets")!.handler({});

    expect(outcomeJson(themes)).toEqual({ items: [], count: 0 });
    expect(outcomeJson(snippets)).toEqual({ items: [], count: 0 });
    expect(outcomeText(themes)).toBe('{"items":[],"count":0}');
    expect(outcomeText(snippets)).toBe('{"items":[],"count":0}');
  });

  it("marks repeatable plugin and setup-facing state operations as idempotent", () => {
    const registry = registryFor("core", "plugin-dev", "authoring");
    const router = {} as CapabilityRouter;
    registerObsidianTools(context(registry, router));
    registerAuthoringTools(context(registry, router));
    registerPluginDevTools(context(registry, router));

    for (const name of [
      "obsidian_plugin_enable",
      "obsidian_plugin_disable",
      "obsidian_plugin_install",
      "obsidian_plugin_uninstall",
      "obsidian_theme_set",
    ]) {
      expect(registry.get(name)?.annotations?.idempotentHint, name).toBe(true);
    }
  });
});
