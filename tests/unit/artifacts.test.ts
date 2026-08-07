import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reserveArtifactPath, saveArtifact } from "../../src/util/artifacts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "knapper-artifacts-"));
  roots.push(path);
  return path;
}

describe("artifact files", () => {
  it("writes new files below the configured directory", async () => {
    const outputDir = await root();

    const file = await saveArtifact(
      outputDir,
      "nested/capture.png",
      "unused.png",
      Buffer.from("png"),
      "image/png",
    );

    expect(file).toMatchObject({
      mimeType: "image/png",
      size: 3,
      inline: false,
    });
    await expect(readFile(file.path, "utf8")).resolves.toBe("png");
  });

  it("rejects traversal, absolute paths, and symlinked parents", async () => {
    const outputDir = await root();
    const outside = await root();
    await symlink(outside, join(outputDir, "linked"));

    await expect(
      reserveArtifactPath(outputDir, "../escape.png", "unused.png"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      reserveArtifactPath(outputDir, "/tmp/escape.png", "unused.png"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      reserveArtifactPath(outputDir, "linked/escape.png", "unused.png"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("never overwrites an existing artifact", async () => {
    const outputDir = await root();
    await mkdir(join(outputDir, "nested"));
    const existing = join(outputDir, "nested", "capture.png");
    await writeFile(existing, "keep");

    await expect(
      saveArtifact(
        outputDir,
        "nested/capture.png",
        "unused.png",
        Buffer.from("replace"),
        "image/png",
      ),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(readFile(existing, "utf8")).resolves.toBe("keep");
  });
});
