import { open, lstat, mkdir, realpath, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { UobError } from "./errors.js";

export interface ArtifactFile {
  path: string;
  mimeType: string;
  size: number;
  inline: false;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function resolveArtifactPath(
  outputDir: string,
  requested: string | undefined,
  defaultName: string,
): Promise<string> {
  const name = requested ?? defaultName;
  if (isAbsolute(name)) {
    throw new UobError("INVALID_ARGUMENT", "Artifact paths must be relative.", {
      remediation: "Set KNAP_SCREENSHOT_DIR to authorize a different artifact directory.",
      details: { path: name, outputDir },
    });
  }

  const root = resolve(outputDir);
  const target = resolve(root, name);
  if (!contained(root, target)) {
    throw new UobError("INVALID_ARGUMENT", "The artifact path escapes the configured directory.", {
      remediation: "Use a relative filename below KNAP_SCREENSHOT_DIR.",
      details: { path: name, outputDir: root },
    });
  }

  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  const relParent = relative(root, dirname(target));
  let current = root;
  for (const part of relParent.split(sep).filter((entry) => entry !== "" && entry !== ".")) {
    current = resolve(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new UobError("INVALID_ARGUMENT", "Artifact directories cannot contain symlinks.", {
          remediation: "Choose a plain directory below KNAP_SCREENSHOT_DIR.",
          details: { path: current },
        });
      }
    } catch (error) {
      if (error instanceof UobError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 }).catch((mkdirError: NodeJS.ErrnoException) => {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      });
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new UobError("INVALID_ARGUMENT", "Artifact directories cannot contain symlinks.", {
          remediation: "Choose a plain directory below KNAP_SCREENSHOT_DIR.",
          details: { path: current },
        });
      }
    }
  }

  const canonicalParent = await realpath(dirname(target));
  if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(`${canonicalRoot}${sep}`)) {
    throw new UobError("INVALID_ARGUMENT", "The artifact directory resolves outside its root.", {
      remediation: "Remove the symlink and use a directory below KNAP_SCREENSHOT_DIR.",
      details: { path: target, outputDir: canonicalRoot },
    });
  }

  return target;
}

async function openArtifactExclusive(path: string): Promise<FileHandle> {
  return open(path, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") {
      throw new UobError("INVALID_ARGUMENT", "The artifact file already exists.", {
        remediation: "Choose a new filename. Knapper does not overwrite artifacts.",
        details: { path },
      });
    }
    throw error;
  });
}

/** Reserve a new artifact file below the configured output directory. */
export async function reserveArtifactPath(
  outputDir: string,
  requested: string | undefined,
  defaultName: string,
): Promise<string> {
  const target = await resolveArtifactPath(outputDir, requested, defaultName);
  const handle = await openArtifactExclusive(target);
  await handle.close();
  return target;
}

export async function saveArtifact(
  outputDir: string,
  requested: string | undefined,
  defaultName: string,
  data: Uint8Array,
  mimeType: string,
): Promise<ArtifactFile> {
  const path = await resolveArtifactPath(outputDir, requested, defaultName);
  const handle = await openArtifactExclusive(path);
  try {
    await handle.writeFile(data);
    const size = (await handle.stat()).size;
    await handle.close();
    return { path, mimeType, size, inline: false };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function artifactFile(path: string, mimeType: string): Promise<ArtifactFile> {
  return { path, mimeType, size: (await stat(path)).size, inline: false };
}
