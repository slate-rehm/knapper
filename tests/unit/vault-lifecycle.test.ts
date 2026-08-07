import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANAGED_MARKER,
  assertVaultRemovable,
  createManagedVault,
  readManagedMarker,
  removeManagedVault,
  vaultAuthorizationRegistryPath,
  writeManagedMarker,
  type VaultEntry,
} from "../../src/connection/vaults.js";

const NOW = new Date("2026-07-26T00:00:00.000Z");

interface TestRegistry {
  configPath: string;
  env: NodeJS.ProcessEnv;
  home: string;
}

/** Create isolated Obsidian and Knapper registries. */
async function fakeRegistry(): Promise<TestRegistry> {
  const root = await mkdtemp(join(tmpdir(), "knap-reg-"));
  const home = join(root, "knap-home");
  const configPath = join(root, "obsidian.json");
  await writeFile(configPath, JSON.stringify({ vaults: {} }), "utf8");
  return { configPath, env: { ...process.env, KNAP_HOME: home }, home };
}

async function scratchFixture(): Promise<TestRegistry & { target: string }> {
  const fixture = await fakeRegistry();
  const key = "scratch-a3f19c22";
  const target = join(fixture.home, "sessions", key, key);
  return { ...fixture, target };
}

const entry = (path: string): VaultEntry => ({ id: "x", path, name: "v", open: false });

describe("the external vault authorization registry", () => {
  it("stores authority outside the vault and ignores a legacy marker", async () => {
    const fixture = await fakeRegistry();
    const target = await mkdtemp(join(tmpdir(), "knap-v-"));
    await writeFile(
      join(target, MANAGED_MARKER),
      JSON.stringify({ managedBy: "knapper", grant: "created" }),
      "utf8",
    );

    expect(await readManagedMarker(target, fixture.env)).toBeUndefined();
    await writeManagedMarker(target, NOW, "adopted", fixture.env);
    expect(await readManagedMarker(target, fixture.env)).toMatchObject({ grant: "adopted" });
    expect(await readdir(target)).toEqual([MANAGED_MARKER]);
    expect(
      JSON.parse(await readFile(vaultAuthorizationRegistryPath(fixture.env), "utf8")),
    ).toMatchObject({ schema: 1, authorizations: [expect.objectContaining({ path: target })] });
  });

  it("serializes concurrent grants without losing one", async () => {
    const fixture = await fakeRegistry();
    const first = await mkdtemp(join(tmpdir(), "knap-first-"));
    const second = await mkdtemp(join(tmpdir(), "knap-second-"));

    await Promise.all([
      writeManagedMarker(first, NOW, "adopted", fixture.env),
      writeManagedMarker(second, NOW, "adopted", fixture.env),
    ]);

    const registry = JSON.parse(
      await readFile(vaultAuthorizationRegistryPath(fixture.env), "utf8"),
    ) as { authorizations: unknown[] };
    expect(registry.authorizations).toHaveLength(2);
  });

  it("does not transfer authority to a replacement directory", async () => {
    const fixture = await fakeRegistry();
    const parent = await mkdtemp(join(tmpdir(), "knap-replaced-"));
    const target = join(parent, "vault");
    await mkdir(target);
    await writeManagedMarker(target, NOW, "adopted", fixture.env);
    await rm(target, { recursive: true });
    await mkdir(target);

    expect(await readManagedMarker(target, fixture.env)).toBeUndefined();
  });

  it("fails closed and preserves an invalid registry", async () => {
    const fixture = await fakeRegistry();
    const target = await mkdtemp(join(tmpdir(), "knap-invalid-registry-"));
    const registryPath = vaultAuthorizationRegistryPath(fixture.env);
    await mkdir(fixture.home, { recursive: true });
    await writeFile(registryPath, "not json", "utf8");

    expect(await readManagedMarker(target, fixture.env)).toBeUndefined();
    await expect(writeManagedMarker(target, NOW, "adopted", fixture.env)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(await readFile(registryPath, "utf8")).toBe("not json");
  });
});

describe("createManagedVault", () => {
  it("creates the directory, writes the external grant, and registers it", async () => {
    const fixture = await fakeRegistry();
    const target = join(await mkdtemp(join(tmpdir(), "knap-v-")), "scratch");

    const result = await createManagedVault(target, NOW, fixture.configPath, fixture.env);
    expect(result.createdDirectory).toBe(true);
    expect(result.marker.managedBy).toBe("knapper");
    expect(await readManagedMarker(target, fixture.env)).toBeDefined();
    await expect(stat(join(target, MANAGED_MARKER))).rejects.toThrow();

    const registry = JSON.parse(await readFile(fixture.configPath, "utf8"));
    expect(Object.values(registry.vaults)).toContainEqual(
      expect.objectContaining({ path: target, open: false }),
    );
  });

  it("refuses a directory that contains a visible file", async () => {
    const fixture = await fakeRegistry();
    const target = await mkdtemp(join(tmpdir(), "knap-notes-"));
    await writeFile(join(target, "MyNotes.md"), "# real content", "utf8");

    await expect(createManagedVault(target, NOW, fixture.configPath, fixture.env)).rejects.toThrow(
      /non-empty/i,
    );
    expect(await readManagedMarker(target, fixture.env)).toBeUndefined();
  });

  it("counts hidden files when it checks whether a directory is empty", async () => {
    const fixture = await fakeRegistry();
    const target = await mkdtemp(join(tmpdir(), "knap-hidden-"));
    await writeFile(join(target, ".private-note"), "private", "utf8");

    await expect(
      createManagedVault(target, NOW, fixture.configPath, fixture.env),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: expect.objectContaining({ entries: [".private-note"] }),
    });
  });

  it("validates both registries before it creates a directory", async () => {
    const fixture = await fakeRegistry();
    const target = join(fixture.home, "new-vault");
    await mkdir(fixture.home, { recursive: true });
    await writeFile(vaultAuthorizationRegistryPath(fixture.env), "not json", "utf8");

    await expect(
      createManagedVault(target, NOW, fixture.configPath, fixture.env),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(stat(target)).rejects.toThrow();
    expect(JSON.parse(await readFile(fixture.configPath, "utf8"))).toEqual({ vaults: {} });
  });

  it("rejects a file path before it changes either registry", async () => {
    const fixture = await fakeRegistry();
    const target = join(fixture.home, "not-a-directory");
    await mkdir(fixture.home, { recursive: true });
    await writeFile(target, "keep", "utf8");
    const originalConfig = await readFile(fixture.configPath, "utf8");

    await expect(
      createManagedVault(target, NOW, fixture.configPath, fixture.env),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readFile(target, "utf8")).toBe("keep");
    expect(await readFile(fixture.configPath, "utf8")).toBe(originalConfig);
    await expect(stat(vaultAuthorizationRegistryPath(fixture.env))).rejects.toThrow();
  });

  it("rejects a new vault below a symbolic-link directory", async () => {
    const fixture = await fakeRegistry();
    const actualParent = join(fixture.home, "actual");
    const linkedParent = join(fixture.home, "linked");
    await mkdir(actualParent, { recursive: true });
    await symlink(actualParent, linkedParent);
    const target = join(linkedParent, "vault");

    await expect(createManagedVault(target, NOW, fixture.configPath, fixture.env)).rejects.toThrow(
      /symbolic-link ancestor/i,
    );
    await expect(stat(join(actualParent, "vault"))).rejects.toThrow();
    expect(JSON.parse(await readFile(fixture.configPath, "utf8"))).toEqual({ vaults: {} });
    await expect(stat(vaultAuthorizationRegistryPath(fixture.env))).rejects.toThrow();
  });

  it("refuses the home directory and filesystem root", async () => {
    const fixture = await fakeRegistry();
    await expect(
      createManagedVault(homedir(), NOW, fixture.configPath, fixture.env),
    ).rejects.toThrow(/refusing/i);
    await expect(createManagedVault("/", NOW, fixture.configPath, fixture.env)).rejects.toThrow(
      /refusing/i,
    );
  });

  it("is idempotent and keeps one registry entry", async () => {
    const fixture = await fakeRegistry();
    const target = join(await mkdtemp(join(tmpdir(), "knap-v-")), "scratch");
    const first = await createManagedVault(target, NOW, fixture.configPath, fixture.env);
    const second = await createManagedVault(target, NOW, fixture.configPath, fixture.env);
    expect(second.id).toBe(first.id);
    const registry = JSON.parse(await readFile(fixture.configPath, "utf8"));
    expect(Object.keys(registry.vaults)).toHaveLength(1);
  });
});

describe("assertVaultRemovable", () => {
  it("refuses a vault with no external authorization", async () => {
    const fixture = await fakeRegistry();
    const userVault = await mkdtemp(join(tmpdir(), "knap-user-"));
    await writeFile(join(userVault, "Journal.md"), "private", "utf8");

    await expect(
      assertVaultRemovable(userVault, [entry(userVault)], fixture.env),
    ).rejects.toMatchObject({ code: "VAULT_NOT_MANAGED" });
  });

  it("refuses a forged marker inside the session scratch boundary", async () => {
    const fixture = await scratchFixture();
    await mkdir(fixture.target, { recursive: true });
    await writeFile(
      join(fixture.target, MANAGED_MARKER),
      JSON.stringify({ managedBy: "knapper", grant: "created" }),
    );

    await expect(
      assertVaultRemovable(fixture.target, [entry(fixture.target)], fixture.env),
    ).rejects.toMatchObject({ code: "VAULT_NOT_MANAGED" });
  });

  it("refuses a directory that contains another registered vault", async () => {
    const fixture = await scratchFixture();
    await createManagedVault(fixture.target, NOW, fixture.configPath, fixture.env);
    const nested = join(fixture.target, "inner");
    await mkdir(nested, { recursive: true });

    await expect(
      assertVaultRemovable(fixture.target, [entry(fixture.target), entry(nested)], fixture.env),
    ).rejects.toThrow(/contains 1 other registered vault/i);
  });

  it("refuses home and root", async () => {
    const fixture = await fakeRegistry();
    await expect(assertVaultRemovable(homedir(), [], fixture.env)).rejects.toThrow(
      /home directory/i,
    );
    await expect(assertVaultRemovable("/", [], fixture.env)).rejects.toThrow(/refusing/i);
  });

  it("refuses a created grant outside the session scratch boundary", async () => {
    const fixture = await fakeRegistry();
    const target = await mkdtemp(join(tmpdir(), "knap-external-"));
    await writeManagedMarker(target, NOW, "created", fixture.env);

    await expect(assertVaultRemovable(target, [entry(target)], fixture.env)).rejects.toMatchObject({
      code: "VAULT_NOT_MANAGED",
    });
  });

  it("does not let a created grant authorize session scratch deletion", async () => {
    const fixture = await scratchFixture();
    await mkdir(fixture.target, { recursive: true });
    await writeManagedMarker(fixture.target, NOW, "created", fixture.env);
    await expect(
      assertVaultRemovable(fixture.target, [entry(fixture.target)], fixture.env),
    ).rejects.toMatchObject({ code: "VAULT_NOT_MANAGED" });
  });
});

describe("removeManagedVault", () => {
  it("unregisters without deleting by default", async () => {
    const fixture = await scratchFixture();
    await createManagedVault(fixture.target, NOW, fixture.configPath, fixture.env);

    const result = await removeManagedVault(
      fixture.target,
      [entry(fixture.target)],
      false,
      fixture.configPath,
      fixture.env,
    );
    expect(result.unregistered).toBe(true);
    expect(result.deletedDirectory).toBe(false);
    expect(await readManagedMarker(fixture.target, fixture.env)).toBeDefined();
    expect(JSON.parse(await readFile(fixture.configPath, "utf8")).vaults).toEqual({});
  });

  it("refuses file deletion even at a session-shaped path", async () => {
    const fixture = await scratchFixture();
    await createManagedVault(fixture.target, NOW, fixture.configPath, fixture.env);

    await expect(
      removeManagedVault(
        fixture.target,
        [entry(fixture.target)],
        true,
        fixture.configPath,
        fixture.env,
      ),
    ).rejects.toMatchObject({ code: "VAULT_NOT_MANAGED" });
    expect((await stat(fixture.target)).isDirectory()).toBe(true);
    expect(await readManagedMarker(fixture.target, fixture.env)).toBeDefined();
  });

  it("leaves an unauthorized vault and its registry entry untouched", async () => {
    const fixture = await fakeRegistry();
    const userVault = await mkdtemp(join(tmpdir(), "knap-user-"));
    await writeFile(join(userVault, "Journal.md"), "private", "utf8");
    await writeFile(
      fixture.configPath,
      JSON.stringify({ vaults: { u1: { path: userVault, open: true } } }),
      "utf8",
    );

    await expect(
      removeManagedVault(userVault, [entry(userVault)], true, fixture.configPath, fixture.env),
    ).rejects.toMatchObject({ code: "VAULT_NOT_MANAGED" });

    expect(await readdir(userVault)).toContain("Journal.md");
    expect(Object.keys(JSON.parse(await readFile(fixture.configPath, "utf8")).vaults)).toEqual([
      "u1",
    ]);
  });
});
