import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  MANAGED_MARKER,
  assertVaultRemovable,
  createManagedVault,
  readManagedMarker,
  removeManagedVault,
  type VaultEntry,
} from "../../src/connection/vaults.js";

const NOW = new Date("2026-07-26T00:00:00.000Z");

/** A throwaway obsidian.json so tests never touch the real registry. */
async function fakeRegistry(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "knap-reg-"));
  const path = join(dir, "obsidian.json");
  await writeFile(path, JSON.stringify({ vaults: {} }), "utf8");
  return path;
}

const entry = (path: string): VaultEntry => ({ id: "x", path, name: "v", open: false });

describe("createManagedVault", () => {
  it("creates the directory, writes the marker, and registers it", async () => {
    const cfg = await fakeRegistry();
    const target = join(await mkdtemp(join(tmpdir(), "knap-v-")), "scratch");

    const result = await createManagedVault(target, NOW, cfg);
    expect(result.createdDirectory).toBe(true);
    expect(result.marker.managedBy).toBe("knapper");
    expect(await readManagedMarker(target)).toBeDefined();

    const reg = JSON.parse(await readFile(cfg, "utf8"));
    expect(Object.values(reg.vaults)).toContainEqual(
      expect.objectContaining({ path: target, open: false }),
    );
  });

  it("refuses to adopt a directory that already holds files", async () => {
    const cfg = await fakeRegistry();
    const target = await mkdtemp(join(tmpdir(), "knap-notes-"));
    await writeFile(join(target, "MyNotes.md"), "# real content", "utf8");

    await expect(createManagedVault(target, NOW, cfg)).rejects.toThrow(/non-empty/i);
    // And it must not have left a marker behind that would make it removable later.
    expect(await readManagedMarker(target)).toBeUndefined();
  });

  it("refuses the home directory and filesystem root", async () => {
    const cfg = await fakeRegistry();
    await expect(createManagedVault(homedir(), NOW, cfg)).rejects.toThrow(/refusing/i);
    await expect(createManagedVault("/", NOW, cfg)).rejects.toThrow(/refusing/i);
  });

  it("is idempotent: re-creating keeps one registry entry", async () => {
    const cfg = await fakeRegistry();
    const target = join(await mkdtemp(join(tmpdir(), "knap-v-")), "scratch");
    const a = await createManagedVault(target, NOW, cfg);
    const b = await createManagedVault(target, NOW, cfg);
    expect(b.id).toBe(a.id);
    const reg = JSON.parse(await readFile(cfg, "utf8"));
    expect(Object.keys(reg.vaults)).toHaveLength(1);
  });
});

describe("assertVaultRemovable — the guard on user vaults", () => {
  it("REFUSES a vault with no marker, which is any vault the user made", async () => {
    const userVault = await mkdtemp(join(tmpdir(), "knap-user-"));
    await writeFile(join(userVault, "Journal.md"), "private", "utf8");

    await expect(assertVaultRemovable(userVault, [entry(userVault)])).rejects.toMatchObject({
      code: "VAULT_NOT_MANAGED",
    });
  });

  it("refuses a marker that does not name knapper", async () => {
    const dir = await mkdtemp(join(tmpdir(), "knap-forged-"));
    await writeFile(join(dir, MANAGED_MARKER), JSON.stringify({ managedBy: "something-else" }));
    await expect(assertVaultRemovable(dir, [entry(dir)])).rejects.toMatchObject({
      code: "VAULT_NOT_MANAGED",
    });
  });

  it("refuses a directory that contains another registered vault", async () => {
    const cfg = await fakeRegistry();
    const parent = await mkdtemp(join(tmpdir(), "knap-parent-"));
    await createManagedVault(parent, NOW, cfg);
    const nested = join(parent, "inner");
    await mkdir(nested, { recursive: true });

    await expect(assertVaultRemovable(parent, [entry(parent), entry(nested)])).rejects.toThrow(
      /contains 1 other registered vault/i,
    );
  });

  it("refuses home and root even if someone plants a marker there", async () => {
    await expect(assertVaultRemovable(homedir(), [])).rejects.toThrow(/home directory/i);
    await expect(assertVaultRemovable("/", [])).rejects.toThrow(/refusing/i);
  });

  it("allows a vault knapper created", async () => {
    const cfg = await fakeRegistry();
    const target = join(await mkdtemp(join(tmpdir(), "knap-v-")), "scratch");
    await createManagedVault(target, NOW, cfg);
    await expect(assertVaultRemovable(target, [entry(target)])).resolves.toMatchObject({
      managedBy: "knapper",
    });
  });
});

describe("removeManagedVault", () => {
  it("unregisters without deleting by default", async () => {
    const cfg = await fakeRegistry();
    const target = join(await mkdtemp(join(tmpdir(), "knap-v-")), "scratch");
    await createManagedVault(target, NOW, cfg);

    const result = await removeManagedVault(target, [entry(target)], false, cfg);
    expect(result.unregistered).toBe(true);
    expect(result.deletedDirectory).toBe(false);
    expect(await readdir(target)).toContain(MANAGED_MARKER);
    expect(JSON.parse(await readFile(cfg, "utf8")).vaults).toEqual({});
  });

  it("deletes the directory only when asked", async () => {
    const cfg = await fakeRegistry();
    const target = join(await mkdtemp(join(tmpdir(), "knap-v-")), "scratch");
    await createManagedVault(target, NOW, cfg);

    const result = await removeManagedVault(target, [entry(target)], true, cfg);
    expect(result.deletedDirectory).toBe(true);
    await expect(readdir(target)).rejects.toThrow();
  });

  it("leaves an unmanaged vault entirely untouched, registry included", async () => {
    const cfg = await fakeRegistry();
    const userVault = await mkdtemp(join(tmpdir(), "knap-user-"));
    await writeFile(join(userVault, "Journal.md"), "private", "utf8");
    await writeFile(
      cfg,
      JSON.stringify({ vaults: { u1: { path: userVault, open: true } } }),
      "utf8",
    );

    await expect(
      removeManagedVault(userVault, [entry(userVault)], true, cfg),
    ).rejects.toMatchObject({ code: "VAULT_NOT_MANAGED" });

    expect(await readdir(userVault)).toContain("Journal.md");
    expect(Object.keys(JSON.parse(await readFile(cfg, "utf8")).vaults)).toEqual(["u1"]);
  });
});
