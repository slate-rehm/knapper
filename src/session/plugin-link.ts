/**
 * Symlinking a plugin build directory into a vault's `.obsidian/plugins`.
 *
 * Extracted so `obsidian_link_plugin` and session provisioning share one copy of
 * the refusal rule rather than two that can drift: an existing *symlink* may be
 * replaced, a real directory may not. That distinction is the only thing standing
 * between a dev loop and someone's installed plugin being silently destroyed.
 */

import { lstat, mkdir, readFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { UobError } from "../util/errors.js";

export interface LinkPluginResult {
  pluginId: string;
  sourceDir: string;
  linkPath: string;
}

/** Read the plugin id from a project's manifest. */
export async function readPluginId(sourceDir: string, override?: string): Promise<string> {
  if (override !== undefined && override !== "") return override;

  let manifest: { id?: string };
  try {
    manifest = JSON.parse(await readFile(join(sourceDir, "manifest.json"), "utf8")) as {
      id?: string;
    };
  } catch {
    throw new UobError("INVALID_ARGUMENT", `No manifest.json in ${sourceDir}.`, {
      remediation:
        "Point sourceDir at the plugin project root (the directory holding manifest.json), or pass " +
        "pluginId explicitly.",
      details: { sourceDir },
    });
  }

  const id = manifest.id;
  if (id === undefined || id === "") {
    throw new UobError("INVALID_ARGUMENT", "manifest.json has no id field.", {
      details: { sourceDir },
    });
  }
  return id;
}

export function pluginLinkPath(vaultPath: string, pluginId: string): string {
  return join(vaultPath, ".obsidian", "plugins", pluginId);
}

export async function linkPlugin(
  vaultPath: string,
  sourceDir: string,
  pluginIdOverride?: string,
): Promise<LinkPluginResult> {
  const pluginId = await readPluginId(sourceDir, pluginIdOverride);
  const linkPath = pluginLinkPath(vaultPath, pluginId);
  await mkdir(join(vaultPath, ".obsidian", "plugins"), { recursive: true });

  try {
    const st = await lstat(linkPath);
    if (st.isSymbolicLink()) {
      await unlink(linkPath);
    } else {
      throw new UobError(
        "INVALID_ARGUMENT",
        `${linkPath} exists and is not a symlink — refusing to clobber.`,
        {
          remediation:
            "A real directory here is an installed plugin, not a dev link. Remove it yourself if " +
            "replacing it is really what you want.",
          details: { linkPath },
        },
      );
    }
  } catch (e) {
    if (e instanceof UobError) throw e;
    // Nothing there yet, which is the ordinary case.
  }

  await symlink(sourceDir, linkPath);
  return { pluginId, sourceDir, linkPath };
}

/** Remove a dev symlink. Refuses anything that is not one. */
export async function unlinkPlugin(vaultPath: string, pluginId: string): Promise<string> {
  const linkPath = pluginLinkPath(vaultPath, pluginId);
  try {
    const st = await lstat(linkPath);
    if (!st.isSymbolicLink()) {
      throw new UobError("INVALID_ARGUMENT", `${linkPath} is not a symlink.`, {
        details: { linkPath },
      });
    }
    await unlink(linkPath);
  } catch (e) {
    if (e instanceof UobError) throw e;
    throw new UobError("INVALID_ARGUMENT", `No symlink at ${linkPath}.`, { details: { linkPath } });
  }
  return linkPath;
}

/** Best-effort unlink for teardown paths, where a missing link is not an error. */
export async function unlinkPluginIfPresent(vaultPath: string, pluginId: string): Promise<boolean> {
  try {
    await unlinkPlugin(vaultPath, pluginId);
    return true;
  } catch {
    return false;
  }
}
