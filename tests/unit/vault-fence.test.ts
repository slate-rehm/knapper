import { describe, expect, it } from "vitest";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VaultFence } from "../../src/connection/fence.js";
import {
  MANAGED_MARKER,
  assertVaultRemovable,
  removeManagedMarker,
  writeManagedMarker,
  type VaultEntry,
} from "../../src/connection/vaults.js";
import { buildArgs } from "../../src/connection/cli/exec.js";
import { createLogger } from "../../src/util/logger.js";
import { sessionPaths } from "../../src/config.js";
import { SESSION_SCHEMA_VERSION, writeDescriptor } from "../../src/session/descriptor.js";

/**
 * The fence is the thing standing between an agent and someone's real notes, so
 * these tests are written as statements about what it refuses. Every case uses a
 * throwaway registries and real temporary directories. Authorization identity is
 * a filesystem fact, so a filesystem mock would not test the safety boundary.
 */

const NOW = new Date("2026-07-26T00:00:00.000Z");
const logger = createLogger("silent");

interface Fixture {
  configPath: string;
  env: NodeJS.ProcessEnv;
  vaultPath: (name: string) => string;
}

/** A throwaway obsidian.json plus vault directories, registered but unauthorized. */
async function fixture(names: string[]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "knap-fence-"));
  const configPath = join(root, "obsidian.json");
  const vaults: Record<string, { path: string; open: boolean }> = {};
  for (const [i, name] of names.entries()) {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    vaults[`id${i}`] = { path, open: false };
  }
  await writeFile(configPath, JSON.stringify({ vaults }), "utf8");
  const env = { ...process.env, KNAP_HOME: join(root, "knap-home") };
  return { configPath, env, vaultPath: (name) => join(root, name) };
}

const makeFence = (f: Fixture, defaultVault?: string) =>
  new VaultFence({
    configPath: f.configPath,
    env: f.env,
    logger,
    ...(defaultVault !== undefined ? { defaultVault } : {}),
  });

describe("VaultFence.resolve — refusing to guess", () => {
  it("REFUSES a registered vault with no authorization", async () => {
    const f = await fixture(["RealNotes"]);
    const fence = makeFence(f);

    await expect(fence.resolve("RealNotes")).rejects.toMatchObject({
      code: "VAULT_NOT_AUTHORIZED",
    });
  });

  it("REFUSES when nothing is authorized and no vault was named", async () => {
    // The pre-fence behaviour here was the worst one: no `vault=` token meant the
    // Obsidian CLI silently targeted whichever vault was last focused.
    const f = await fixture(["RealNotes", "OtherNotes"]);
    const fence = makeFence(f);

    await expect(fence.resolve()).rejects.toMatchObject({ code: "VAULT_NOT_AUTHORIZED" });
  });

  it("REFUSES to pick when two vaults are authorized", async () => {
    const f = await fixture(["a", "b"]);
    await writeManagedMarker(f.vaultPath("a"), NOW, "adopted", f.env);
    await writeManagedMarker(f.vaultPath("b"), NOW, "adopted", f.env);
    const fence = makeFence(f);

    await expect(fence.resolve()).rejects.toThrow(/ambiguous/i);
  });

  it("uses the only authorized vault when exactly one exists", async () => {
    const f = await fixture(["scratch", "RealNotes"]);
    await writeManagedMarker(f.vaultPath("scratch"), NOW, "created", f.env);
    const fence = makeFence(f);

    const resolved = await fence.resolve();
    expect(resolved.name).toBe("scratch");
    expect(resolved.grant).toBe("created");
  });

  it("refuses an authorized session default that names an unauthorized vault", async () => {
    // OBSIDIAN_VAULT is a preference, not a grant. Treating it as one would let a
    // client config authorize a vault the user never consented to.
    const f = await fixture(["RealNotes"]);
    const fence = makeFence(f, "RealNotes");

    await expect(fence.resolve()).rejects.toMatchObject({ code: "VAULT_NOT_AUTHORIZED" });
  });

  it("distinguishes an unknown vault from an unauthorized one", async () => {
    const f = await fixture(["RealNotes"]);
    const fence = makeFence(f);

    await expect(fence.resolve("NoSuchVault")).rejects.toMatchObject({ code: "VAULT_NOT_FOUND" });
  });
});

describe("VaultFence — revocation takes effect without a restart", () => {
  it("stops authorizing as soon as the registry record is gone", async () => {
    // `knapper revoke` runs in a different process, so a cached negative would let
    // a revoked vault stay reachable for the life of the server. Positives may be
    // cached; negatives may not.
    const f = await fixture(["scratch"]);
    await writeManagedMarker(f.vaultPath("scratch"), NOW, "adopted", f.env);
    const fence = makeFence(f);

    expect((await fence.resolve("scratch")).name).toBe("scratch");

    await removeManagedMarker(f.vaultPath("scratch"), f.env);
    fence.invalidate();

    await expect(fence.resolve("scratch")).rejects.toMatchObject({
      code: "VAULT_NOT_AUTHORIZED",
    });
  });

  it("picks up a fresh grant without a restart", async () => {
    const f = await fixture(["scratch"]);
    const fence = makeFence(f);

    await expect(fence.resolve("scratch")).rejects.toMatchObject({
      code: "VAULT_NOT_AUTHORIZED",
    });

    await writeManagedMarker(f.vaultPath("scratch"), NOW, "adopted", f.env);
    expect((await fence.resolve("scratch")).grant).toBe("adopted");
  });
});

describe("VaultFence — private session identity", () => {
  it("refuses a replacement directory at the session vault path", async () => {
    const root = await mkdtemp(join(tmpdir(), "knap-session-fence-"));
    const env = { ...process.env, KNAP_HOME: root };
    const key = "scratch-a3f19c22";
    const paths = sessionPaths(key, env);
    await mkdir(paths.vaultDir, { recursive: true });
    const [canonical, identity] = await Promise.all([
      realpath(paths.vaultDir),
      stat(paths.vaultDir),
    ]);
    await writeDescriptor(
      {
        schema: SESSION_SCHEMA_VERSION,
        key,
        createdAt: NOW.toISOString(),
        heartbeatAt: NOW.toISOString(),
        readiness: { phase: "ready", readyAt: NOW.toISOString() },
        origin: { cwd: root },
        ownership: {
          rootPath: await realpath(paths.root),
          vaultPath: canonical,
          rootDevice: (await stat(paths.root)).dev,
          rootInode: (await stat(paths.root)).ino,
          vaultDevice: identity.dev,
          vaultInode: identity.ino,
        },
        instance: {
          userDataDir: paths.userDataDir,
          outputDir: paths.outputDir,
          obsidianBin: "obsidian",
        },
        vault: { id: "session-id", name: key, path: paths.vaultDir, grant: "created" },
      },
      env,
    );
    const configPath = join(paths.userDataDir, "obsidian.json");
    await mkdir(paths.userDataDir, { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ vaults: { "session-id": { path: paths.vaultDir, open: true } } }),
    );
    const fence = new VaultFence({
      configPath,
      env,
      logger,
      sessionKey: key,
      sessionVaultPath: paths.vaultDir,
    });
    expect((await fence.resolve(key)).grant).toBe("created");

    const descriptorFile = join(paths.root, "session.json");
    const persisted = JSON.parse(await readFile(descriptorFile, "utf8"));
    delete persisted.vault.path;
    await writeFile(descriptorFile, JSON.stringify(persisted));
    fence.invalidate();
    await expect(fence.resolve(key)).rejects.toMatchObject({ code: "VAULT_NOT_AUTHORIZED" });
    persisted.vault.path = paths.vaultDir;
    await writeFile(descriptorFile, JSON.stringify(persisted));
    fence.invalidate();
    expect((await fence.resolve(key)).grant).toBe("created");

    const replaced = `${paths.vaultDir}-replaced`;
    await rename(paths.vaultDir, replaced);
    await mkdir(paths.vaultDir);
    expect((await lstat(paths.vaultDir)).isDirectory()).toBe(true);
    fence.invalidate();
    await expect(fence.resolve(key)).rejects.toMatchObject({ code: "VAULT_NOT_AUTHORIZED" });
  });
});

describe("assertVaultRemovable — authorization is not permission to delete", () => {
  const entries: VaultEntry[] = [];

  async function scratch(): Promise<{ path: string; env: NodeJS.ProcessEnv }> {
    const home = await mkdtemp(join(tmpdir(), "knap-home-"));
    const key = "scratch-a3f19c22";
    const path = join(home, "sessions", key, key);
    await mkdir(path, { recursive: true });
    return { path, env: { ...process.env, KNAP_HOME: home } };
  }

  it("REFUSES to delete a vault the user authorized", async () => {
    // This is the invariant that makes `knapper authorize` safe to run against a
    // vault of real notes. If an adopted grant fed the delete path, the consent
    // step would be a loaded gun.
    const dir = await mkdtemp(join(tmpdir(), "knap-adopted-"));
    const env = { ...process.env, KNAP_HOME: join(dir, "knap-home") };
    await writeManagedMarker(dir, NOW, "adopted", env);

    await expect(assertVaultRemovable(dir, entries, env)).rejects.toMatchObject({
      code: "VAULT_NOT_MANAGED",
    });
  });

  it("does not let an external record grant session scratch deletion", async () => {
    const { path, env } = await scratch();
    await writeManagedMarker(path, NOW, "created", env);

    await expect(assertVaultRemovable(path, entries, env)).rejects.toMatchObject({
      code: "VAULT_NOT_MANAGED",
    });
  });

  it("keeps legacy markers inactive", async () => {
    const { path, env } = await scratch();
    await writeFile(
      join(path, MANAGED_MARKER),
      JSON.stringify({ managedBy: "knapper", createdAt: NOW.toISOString(), note: "legacy" }),
      "utf8",
    );

    await expect(assertVaultRemovable(path, entries, env)).rejects.toMatchObject({
      code: "VAULT_NOT_MANAGED",
    });
  });
});

describe("buildArgs — no unscoped CLI calls", () => {
  it("throws rather than building a command with no vault= token", async () => {
    expect(() => buildArgs(["note:delete", "path=A.md"])).toThrow(/without a vault/i);
  });

  it("still allows the three commands that have no vault to scope to", () => {
    expect(buildArgs(["version"])).toEqual(["version"]);
    expect(buildArgs(["__completions"])).toEqual(["__completions"]);
    expect(buildArgs(["help"])).toEqual(["help"]);
  });

  it("puts vault= first, before the command name", () => {
    expect(buildArgs(["note:open", "path=A.md"], "v")).toEqual([
      "vault=v",
      "note:open",
      "path=A.md",
    ]);
  });
});
