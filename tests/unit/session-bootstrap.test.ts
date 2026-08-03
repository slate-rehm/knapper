/**
 * Seeding a session profile — specifically, what it must refuse.
 *
 * The marker is the whole delete authority: `removeManagedVault` deletes exactly
 * what carries one. So the question that matters here is not "did seeding work"
 * but "into which directories will it write a `created` marker", because every
 * one of those becomes reapable.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginTrustStorageKey, seedSessionProfile } from "../../src/session/bootstrap.js";
import { writeManagedMarker } from "../../src/connection/vaults.js";
import { sessionPaths } from "../../src/config.js";

let home: string;
let env: NodeJS.ProcessEnv;
const NOW = new Date("2026-07-28T12:00:00.000Z");
const KEY = "seed-a3f19c22";

it("uses Obsidian's per-vault plugin trust key", () => {
  expect(pluginTrustStorageKey("abc123")).toBe("enable-plugin-abc123");
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "knap-seed-"));
  env = { ...process.env, KNAP_HOME: home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const marked = async (p: string): Promise<boolean> =>
  stat(join(p, ".knapper-managed")).then(
    () => true,
    () => false,
  );

/** A directory of somebody's real notes: content, and no knapper marker. */
async function userVault(path: string): Promise<string> {
  await mkdir(join(path, ".obsidian"), { recursive: true });
  await writeFile(join(path, "Important.md"), "# my life's work\n", "utf8");
  return path;
}

describe("seedSessionProfile", () => {
  it("creates and marks the session's own scratch vault", async () => {
    const seeded = await seedSessionProfile({ key: KEY, now: NOW, env });
    expect(seeded.vault.grant).toBe("created");
    expect(seeded.vault.path).toBe(sessionPaths(KEY, env).vaultDir);
    expect(await marked(seeded.vault.path)).toBe(true);
  });

  it("accepts an empty directory the caller named", async () => {
    const dir = join(home, "empty");
    await mkdir(dir, { recursive: true });
    const seeded = await seedSessionProfile({ key: KEY, vaultPath: dir, now: NOW, env });
    expect(seeded.vault.grant).toBe("created");
  });

  it("refuses a directory that already holds notes", async () => {
    // The bug this pins: seeding used to stamp a `created` marker on whatever it
    // was handed, which handed the user's real vault to the reaper's delete path.
    const dir = await userVault(join(home, "MyRealNotes"));
    await expect(
      seedSessionProfile({ key: KEY, vaultPath: dir, now: NOW, env }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await marked(dir)).toBe(false);
    expect(await readFile(join(dir, "Important.md"), "utf8")).toContain("life's work");
  });

  it("refuses to adopt a vault carrying no marker", async () => {
    const dir = await userVault(join(home, "NotAuthorized"));
    await expect(
      seedSessionProfile({ key: KEY, vaultPath: dir, adopt: true, now: NOW, env }),
    ).rejects.toMatchObject({ code: "VAULT_NOT_AUTHORIZED" });
  });

  it("keeps an adopted grant adopted, so consent never becomes delete permission", async () => {
    const dir = await userVault(join(home, "Authorized"));
    await writeManagedMarker(dir, NOW, "adopted");
    const seeded = await seedSessionProfile({
      key: KEY,
      vaultPath: dir,
      adopt: true,
      now: NOW,
      env,
    });
    expect(seeded.vault.grant).toBe("adopted");
  });
});
