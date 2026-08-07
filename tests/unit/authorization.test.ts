import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAuthorize,
  runListAuthorizations,
  runRevoke,
  type AuthorizeIo,
} from "../../src/authorize.js";
import {
  MANAGED_MARKER,
  readManagedMarker,
  vaultAuthorizationRegistryPath,
} from "../../src/connection/vaults.js";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface Fixture {
  vaultPath: string;
  configPath: string;
  env: NodeJS.ProcessEnv;
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "knap-authorize-")));
  roots.push(root);
  const vaultPath = join(root, "Notes");
  const configPath = join(root, "obsidian.json");
  await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ vaults: { vault1: { path: vaultPath, open: false } } }),
    "utf8",
  );
  return {
    vaultPath,
    configPath,
    env: { ...process.env, KNAP_HOME: join(root, "knap-home") },
  };
}

function io(
  answer: string,
  isTty = true,
): AuthorizeIo & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    outLines,
    errLines,
    isTty,
    out: (line) => outLines.push(line),
    err: (line) => errLines.push(line),
    prompt: async () => answer,
  };
}

describe("vault authorization commands", () => {
  it("does not treat a forged legacy marker as prior authorization", async () => {
    const f = await fixture();
    await writeFile(
      join(f.vaultPath, MANAGED_MARKER),
      JSON.stringify({ managedBy: "knapper", grant: "adopted" }),
      "utf8",
    );
    const terminal = io("Notes", false);

    expect(await runAuthorize(f.vaultPath, terminal, NOW, f.env, f.configPath)).toBe(1);
    expect(terminal.errLines.join("\n")).toMatch(/interactive terminal/i);
    expect(await readManagedMarker(f.vaultPath, f.env)).toBeUndefined();
  });

  it("writes an adopted grant to the private external registry", async () => {
    const f = await fixture();
    const terminal = io("Notes");

    expect(await runAuthorize("Notes", terminal, NOW, f.env, f.configPath)).toBe(0);
    expect(await readManagedMarker(f.vaultPath, f.env)).toMatchObject({ grant: "adopted" });
    expect(terminal.outLines.join("\n")).toContain(vaultAuthorizationRegistryPath(f.env));
    const mode = (await stat(vaultAuthorizationRegistryPath(f.env))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("revokes the external record without changing vault files", async () => {
    const f = await fixture();
    await writeFile(join(f.vaultPath, "Important.md"), "keep", "utf8");
    await runAuthorize("Notes", io("Notes"), NOW, f.env, f.configPath);

    expect(await runRevoke("Notes", io(""), f.env, f.configPath)).toBe(0);
    expect(await readManagedMarker(f.vaultPath, f.env)).toBeUndefined();
    expect(await readFile(join(f.vaultPath, "Important.md"), "utf8")).toBe("keep");
  });

  it("revokes an external record after the vault directory disappears", async () => {
    const f = await fixture();
    await runAuthorize("Notes", io("Notes"), NOW, f.env, f.configPath);
    await rm(f.vaultPath, { recursive: true });

    expect(await runRevoke("Notes", io(""), f.env, f.configPath)).toBe(0);
    const registry = JSON.parse(await readFile(vaultAuthorizationRegistryPath(f.env), "utf8"));
    expect(registry.authorizations).toEqual([]);
  });

  it("lists only records from the external registry", async () => {
    const f = await fixture();
    await runAuthorize("Notes", io("Notes"), NOW, f.env, f.configPath);
    const terminal = io("");

    expect(await runListAuthorizations(terminal, f.env, f.configPath)).toBe(0);
    expect(terminal.outLines.join("\n")).toMatch(/Notes\s+authorized by you/);
  });
});
