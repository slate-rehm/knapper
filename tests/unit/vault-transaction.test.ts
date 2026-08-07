import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverVaultTransaction } from "../../src/connection/vault-transaction.js";
import {
  createManagedVault,
  removeManagedVault,
  vaultAuthorizationRegistryPath,
  type VaultEntry,
} from "../../src/connection/vaults.js";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  configPath: string;
  target: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "knap-transaction-"));
  roots.push(root);
  const home = join(root, "knap-home");
  const configPath = join(root, "obsidian.json");
  const target = join(root, "vaults", "scratch");
  await writeFile(configPath, '{"theme":"moon","vaults":{}}', "utf8");
  return { root, home, env: { ...process.env, KNAP_HOME: home }, configPath, target };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

const entry = (path: string): VaultEntry => ({ id: "vault", path, name: "scratch", open: false });

describe("vault lifecycle transactions", () => {
  for (const phase of [
    "journaled",
    "directory-created",
    "obsidian-written",
    "authorization-written",
    "before-commit",
  ]) {
    it(`rolls back a create fault after ${phase}`, async () => {
      const f = await fixture();
      const originalConfig = await readFile(f.configPath, "utf8");

      await expect(
        createManagedVault(f.target, NOW, f.configPath, f.env, {
          fault: (current) => {
            if (current === phase) throw new Error(`fault:${phase}`);
          },
        }),
      ).rejects.toThrow(`fault:${phase}`);

      expect(await readFile(f.configPath, "utf8")).toBe(originalConfig);
      expect(await fileExists(vaultAuthorizationRegistryPath(f.env))).toBe(false);
      expect(await fileExists(f.target)).toBe(false);
      expect(await fileExists(join(f.home, "vault-transactions", "current.json"))).toBe(false);

      const trash = join(f.home, "trash");
      const trashEntries = (await fileExists(trash)) ? await readdir(trash) : [];
      expect(trashEntries).toHaveLength(phase === "journaled" ? 0 : 1);
    });
  }

  for (const phase of ["journaled", "unregister-written", "before-commit"]) {
    it(`rolls back an unregister fault after ${phase}`, async () => {
      const f = await fixture();
      await createManagedVault(f.target, NOW, f.configPath, f.env);
      const authorizationPath = vaultAuthorizationRegistryPath(f.env);
      const originalConfig = await readFile(f.configPath, "utf8");
      const originalAuthorization = await readFile(authorizationPath, "utf8");

      await expect(
        removeManagedVault(f.target, [entry(f.target)], false, f.configPath, f.env, {
          fault: (current) => {
            if (current === phase) throw new Error(`fault:${phase}`);
          },
        }),
      ).rejects.toThrow(`fault:${phase}`);

      expect(await readFile(f.configPath, "utf8")).toBe(originalConfig);
      expect(await readFile(authorizationPath, "utf8")).toBe(originalAuthorization);
      expect((await stat(f.target)).isDirectory()).toBe(true);
      expect(await fileExists(join(f.home, "vault-transactions", "current.json"))).toBe(false);
    });
  }

  it("recovers an uncommitted create before the next lifecycle operation", async () => {
    const f = await fixture();
    const authorizationPath = vaultAuthorizationRegistryPath(f.env);
    const originalConfig = await readFile(f.configPath, "utf8");
    let journal = "";
    let partialConfig = "";
    let partialAuthorization = "";
    let obsidianBackup = Buffer.alloc(0);
    let transactionId = "";

    await expect(
      createManagedVault(f.target, NOW, f.configPath, f.env, {
        fault: async (phase) => {
          if (phase !== "authorization-written") return;
          const journalPath = join(f.home, "vault-transactions", "current.json");
          journal = await readFile(journalPath, "utf8");
          transactionId = (JSON.parse(journal) as { id: string }).id;
          const transactionDirectory = join(f.home, "vault-transactions", transactionId);
          obsidianBackup = await readFile(join(transactionDirectory, "obsidian.backup"));
          partialConfig = await readFile(f.configPath, "utf8");
          partialAuthorization = await readFile(authorizationPath, "utf8");
          throw new Error("simulated process stop");
        },
      }),
    ).rejects.toThrow("simulated process stop");

    const firstTrash = join(f.home, "trash", (await readdir(join(f.home, "trash")))[0]!);
    await mkdir(join(f.root, "vaults"), { recursive: true });
    await rename(firstTrash, f.target);
    const transactionDirectory = join(f.home, "vault-transactions", transactionId);
    await mkdir(transactionDirectory, { recursive: true });
    await writeFile(join(transactionDirectory, "obsidian.backup"), obsidianBackup);
    await writeFile(join(f.home, "vault-transactions", "current.json"), journal);
    await writeFile(f.configPath, partialConfig);
    await writeFile(authorizationPath, partialAuthorization);

    await recoverVaultTransaction(f.configPath, authorizationPath, f.env);

    expect(await readFile(f.configPath, "utf8")).toBe(originalConfig);
    expect(await fileExists(authorizationPath)).toBe(false);
    expect(await fileExists(f.target)).toBe(false);
    expect(await readdir(join(f.home, "trash"))).toHaveLength(1);
    expect(await fileExists(join(f.home, "vault-transactions", "current.json"))).toBe(false);
  });
});
