/**
 * Detect Obsidian self-update drift.
 *
 * The in-app updater downloads `obsidian-<version>.asar` into the config
 * directory (next to obsidian.json) and only loads it on the next launch, so the
 * on-disk version and the running version can differ for days. Doctor reports it
 * as a line, not a precondition: the app works either way, but an agent debugging
 * "my fix depends on a newer Obsidian" should see the gap.
 */

import { readdir } from "node:fs/promises";

const ASAR_NAME = /^obsidian-(\d+)\.(\d+)\.(\d+)\.asar$/;

/** First `x.y.z` in a free-form version string (CLI output may carry a `v` prefix). */
export function extractSemver(text: string): string | undefined {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

/** Standard semver-ish triple comparison; returns <0, 0, or >0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Newest downloaded-asar version among directory entries, if any. */
export function latestAsarVersion(names: string[]): string | undefined {
  let best: string | undefined;
  for (const name of names) {
    const match = ASAR_NAME.exec(name);
    if (!match) continue;
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    if (best === undefined || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

export interface VersionDrift {
  running: string;
  installed: string;
}

/**
 * Drift verdict: only a downloaded version *newer* than the running one counts.
 * Older leftovers are normal — Obsidian does not delete superseded asars.
 */
export function versionDrift(
  runningText: string,
  installed: string | undefined,
): VersionDrift | undefined {
  const running = extractSemver(runningText);
  if (running === undefined || installed === undefined) return undefined;
  return compareVersions(installed, running) > 0 ? { running, installed } : undefined;
}

/** Newest downloaded-asar version in a directory; undefined when unreadable. */
export async function findDownloadedAsarVersion(dir: string): Promise<string | undefined> {
  try {
    return latestAsarVersion(await readdir(dir));
  } catch {
    return undefined;
  }
}
