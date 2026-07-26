import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { VaultFence } from "../../src/connection/fence.js";
import {
  MANAGED_MARKER,
  assertVaultRemovable,
  writeManagedMarker,
  type VaultEntry,
} from "../../src/connection/vaults.js";
import { buildArgs } from "../../src/connection/cli/exec.js";
import { createLogger } from "../../src/util/logger.js";

/**
 * The fence is the thing standing between an agent and someone's real notes, so
 * these tests are written as statements about what it refuses. Every case uses a
 * throwaway registry and real tmpdirs — the marker contract is a filesystem fact,
 * and mocking the filesystem would test the mock.
 */

const NOW = new Date("2026-07-26T00:00:00.000Z");
const logger = createLogger("silent");

interface Fixture {
  configPath: string;
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
  return { configPath, vaultPath: (name) => join(root, name) };
}

const makeFence = (f: Fixture, defaultVault?: string) =>
  new VaultFence({
    configPath: f.configPath,
    logger,
    ...(defaultVault !== undefined ? { defaultVault } : {}),
  });

describe("VaultFence.resolve — refusing to guess", () => {
  it("REFUSES a registered vault with no marker, which is any vault the user made", async () => {
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
    await writeManagedMarker(f.vaultPath("a"), NOW, "adopted");
    await writeManagedMarker(f.vaultPath("b"), NOW, "adopted");
    const fence = makeFence(f);

    await expect(fence.resolve()).rejects.toThrow(/ambiguous/i);
  });

  it("uses the only authorized vault when exactly one exists", async () => {
    const f = await fixture(["scratch", "RealNotes"]);
    await writeManagedMarker(f.vaultPath("scratch"), NOW, "created");
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
  it("stops authorizing as soon as the marker is gone", async () => {
    // `knapper revoke` runs in a different process, so a cached negative would let
    // a revoked vault stay reachable for the life of the server. Positives may be
    // cached; negatives may not.
    const f = await fixture(["scratch"]);
    await writeManagedMarker(f.vaultPath("scratch"), NOW, "adopted");
    const fence = makeFence(f);

    expect((await fence.resolve("scratch")).name).toBe("scratch");

    await rm(join(f.vaultPath("scratch"), MANAGED_MARKER));
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

    await writeManagedMarker(f.vaultPath("scratch"), NOW, "adopted");
    expect((await fence.resolve("scratch")).grant).toBe("adopted");
  });
});

describe("assertVaultRemovable — authorization is not permission to delete", () => {
  const entries: VaultEntry[] = [];

  it("REFUSES to delete a vault the user authorized", async () => {
    // This is the invariant that makes `knapper authorize` safe to run against a
    // vault of real notes. If an adopted grant fed the delete path, the consent
    // step would be a loaded gun.
    const dir = await mkdtemp(join(tmpdir(), "knap-adopted-"));
    await writeManagedMarker(dir, NOW, "adopted");

    await expect(assertVaultRemovable(dir, entries)).rejects.toMatchObject({
      code: "VAULT_NOT_MANAGED",
    });
  });

  it("allows deleting a vault knapper created", async () => {
    const dir = await mkdtemp(join(tmpdir(), "knap-created-"));
    await writeManagedMarker(dir, NOW, "created");

    await expect(assertVaultRemovable(dir, entries)).resolves.toMatchObject({
      managedBy: "knapper",
    });
  });

  it("treats a pre-fence marker with no grant as created, so old scratch vaults stay removable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "knap-legacy-"));
    await writeFile(
      join(dir, MANAGED_MARKER),
      JSON.stringify({ managedBy: "knapper", createdAt: NOW.toISOString(), note: "legacy" }),
      "utf8",
    );

    await expect(assertVaultRemovable(dir, entries)).resolves.toBeDefined();
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
