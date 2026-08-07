import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  communityPluginsEnabledConfig,
  formatVaultSetupResult,
  preflightVaultSetup,
  runningObsidianVersion,
} from "../../src/tools/provisioning.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("runningObsidianVersion", () => {
  it("does not invoke the binary while Obsidian is stopped", async () => {
    const run = vi.fn();
    const version = await runningObsidianVersion({ cli: { run } } as never, {
      running: false,
      cliEnabled: true,
      argvCorruption: undefined,
    });

    expect(version).toMatch(/stopped/);
    expect(run).not.toHaveBeenCalled();
  });

  it("extracts the version from startup noise", async () => {
    const run = vi.fn().mockResolvedValue("Loaded app\n1.13.4\nReady\n");
    await expect(
      runningObsidianVersion({ cli: { run } } as never, {
        running: true,
        cliEnabled: true,
        argvCorruption: undefined,
      }),
    ).resolves.toBe("1.13.4");
  });
});

describe("vault setup preflight", () => {
  it("reports every setup step and its failure", () => {
    expect(
      formatVaultSetupResult(
        "test-vault",
        {
          preflight: { status: "verified" },
          communityPlugins: { status: "unchanged" },
          trust: { status: "changed" },
          pluginEnabled: { status: "unchanged" },
          pluginLoaded: { status: "failed", error: "The plugin is not loaded." },
        },
        [{ step: "pluginLoaded", error: "The plugin is not loaded." }],
      ),
    ).toBe(
      [
        'Vault "test-vault" setup completed with 1 failed step(s).',
        "Setup steps:",
        "- Preflight: verified",
        "- Community plugins: unchanged",
        "- Restricted mode: changed",
        "- Plugin enabled: unchanged",
        "- Plugin loaded: failed — The plugin is not loaded.",
      ].join("\n"),
    );
  });

  it("preserves every existing app setting while enabling community plugins", () => {
    expect(
      communityPluginsEnabledConfig({
        alwaysUpdateLinks: true,
        newFileLocation: "folder",
        newFileFolderPath: "Inbox",
        vimMode: true,
        readableLineLength: false,
      }),
    ).toEqual({
      alwaysUpdateLinks: true,
      newFileLocation: "folder",
      newFileFolderPath: "Inbox",
      vimMode: true,
      readableLineLength: false,
      communityPluginEnabled: true,
    });
  });

  it("backs up malformed JSON and leaves the vault file unchanged", async () => {
    const vault = await tempRoot("knapper-setup-vault-");
    const home = await tempRoot("knapper-setup-home-");
    const obsidian = join(vault, ".obsidian");
    const appPath = join(obsidian, "app.json");
    await mkdir(obsidian);
    await writeFile(appPath, "{ malformed", "utf8");

    await expect(
      preflightVaultSetup(vault, undefined, {
        ...process.env,
        KNAP_HOME: home,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { backupPath: expect.stringContaining(home) },
    });

    await expect(readFile(appPath, "utf8")).resolves.toBe("{ malformed");
    const backups = await readdir(join(home, "backups", "invalid-json"));
    expect(backups).toHaveLength(1);
  });

  it("refuses a missing requested plugin before setup mutates the vault", async () => {
    const vault = await tempRoot("knapper-setup-plugin-");
    const home = await tempRoot("knapper-setup-plugin-home-");
    await mkdir(join(vault, ".obsidian"));
    await writeFile(join(vault, ".obsidian", "app.json"), '{"vimMode":true}\n');

    await expect(
      preflightVaultSetup(vault, "missing-plugin", { ...process.env, KNAP_HOME: home }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", fixedBy: "obsidian_link_plugin" });
    await expect(readFile(join(vault, ".obsidian", "app.json"), "utf8")).resolves.toContain(
      '"vimMode":true',
    );
  });
});
