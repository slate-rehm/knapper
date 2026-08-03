import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePluginDir } from "../../src/session/plugin-link.js";

const dirs: string[] = [];

async function pluginDir(files: { manifest?: unknown; main?: boolean; styles?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "knap-plugin-"));
  dirs.push(dir);
  if (files.manifest !== undefined) {
    await writeFile(join(dir, "manifest.json"), JSON.stringify(files.manifest), "utf8");
  }
  if (files.main === true) await writeFile(join(dir, "main.js"), "module.exports = {};\n", "utf8");
  if (files.styles === true) await writeFile(join(dir, "styles.css"), "/* test */\n", "utf8");
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("validatePluginDir", () => {
  it("accepts a loadable plugin directory", async () => {
    const dir = await pluginDir({ manifest: { id: "demo" }, main: true, styles: true });
    await expect(validatePluginDir(dir)).resolves.toEqual({
      pluginId: "demo",
      artifacts: { manifest: true, main: true, styles: true },
    });
  });

  it("rejects a missing manifest", async () => {
    await expect(validatePluginDir(await pluginDir({ main: true }))).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects a missing main.js", async () => {
    await expect(
      validatePluginDir(await pluginDir({ manifest: { id: "demo" } })),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { missing: ["main.js"] } });
  });

  it("rejects an explicit id that differs from the manifest", async () => {
    const dir = await pluginDir({ manifest: { id: "demo" }, main: true });
    await expect(validatePluginDir(dir, "other")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { pluginId: "other", manifestId: "demo" },
    });
  });
});
