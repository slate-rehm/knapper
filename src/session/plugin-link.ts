/**
 * Symlinking a plugin build directory into a vault's `.obsidian/plugins`.
 *
 * Extracted so `obsidian_link_plugin` and session provisioning share one copy of
 * the refusal rule rather than two that can drift: an existing *symlink* may be
 * replaced, a real directory may not. That distinction is the only thing standing
 * between a dev loop and someone's installed plugin being silently destroyed.
 */

import { lstat, mkdir, readFile, stat, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { UobError } from "../util/errors.js";

export interface LinkPluginResult {
  pluginId: string;
  sourceDir: string;
  linkPath: string;
  artifacts: { manifest: true; main: true; styles: boolean };
}

export interface ValidatedPluginDir {
  pluginId: string;
  artifacts: { manifest: true; main: true; styles: boolean };
}

/** Validate a directory Obsidian can load directly. */
export async function validatePluginDir(
  sourceDir: string,
  override?: string,
): Promise<ValidatedPluginDir> {
  let manifest: { id?: string };
  try {
    manifest = JSON.parse(await readFile(join(sourceDir, "manifest.json"), "utf8")) as {
      id?: string;
    };
  } catch {
    throw new UobError("INVALID_ARGUMENT", `No manifest.json in ${sourceDir}.`, {
      remediation:
        "Point sourceDir at a loadable plugin directory containing manifest.json and main.js.",
      details: { sourceDir },
    });
  }

  const id = manifest.id;
  if (id === undefined || id === "") {
    throw new UobError("INVALID_ARGUMENT", "manifest.json has no id field.", {
      details: { sourceDir },
    });
  }
  if (override !== undefined && override !== "" && override !== id) {
    throw new UobError(
      "INVALID_ARGUMENT",
      `Plugin id "${override}" does not match manifest id "${id}".`,
      { details: { sourceDir, pluginId: override, manifestId: id } },
    );
  }

  const mainPath = join(sourceDir, "main.js");
  const main = await stat(mainPath).catch(() => undefined);
  if (main?.isFile() !== true) {
    throw new UobError("INVALID_ARGUMENT", `Plugin directory ${sourceDir} has no main.js file.`, {
      remediation: "Build the plugin and point sourceDir at its loadable artifact directory.",
      details: { sourceDir, missing: ["main.js"] },
    });
  }
  const styles = await stat(join(sourceDir, "styles.css")).catch(() => undefined);
  return {
    pluginId: id,
    artifacts: { manifest: true, main: true, styles: styles?.isFile() === true },
  };
}

/** Read and validate the plugin id for compatibility with existing callers. */
export async function readPluginId(sourceDir: string, override?: string): Promise<string> {
  return (await validatePluginDir(sourceDir, override)).pluginId;
}

export function pluginLinkPath(vaultPath: string, pluginId: string): string {
  return join(vaultPath, ".obsidian", "plugins", pluginId);
}

export async function linkPlugin(
  vaultPath: string,
  sourceDir: string,
  pluginIdOverride?: string,
): Promise<LinkPluginResult> {
  const validated = await validatePluginDir(sourceDir, pluginIdOverride);
  const pluginId = validated.pluginId;
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
  return { pluginId, sourceDir, linkPath, artifacts: validated.artifacts };
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
