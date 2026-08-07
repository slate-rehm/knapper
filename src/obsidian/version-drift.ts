/**
 * Detect Obsidian self-update drift.
 *
 * The in-app updater downloads `obsidian-<version>.asar` into the config
 * directory (next to obsidian.json) and only loads it on the next launch, so the
 * on-disk version and the running version can differ for days. Doctor reports it
 * as a line, not a precondition: the app works either way, but an agent debugging
 * "my fix depends on a newer Obsidian" should see the gap.
 */

import { execFile } from "node:child_process";
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

export type VersionComparison = "match" | "different" | "unavailable";

export interface ObsidianVersionSources {
  running: string | null | undefined;
  downloadedAsar: string | null | undefined;
  installedPackage: string | null | undefined;
  installedPackageSource: string | null | undefined;
}

export interface ObsidianVersions {
  running: string | null;
  downloadedAsar: string | null;
  installedPackage: string | null;
  installedPackageSource: string | null;
  comparisons: {
    runningVsDownloaded: VersionComparison;
    runningVsInstalled: VersionComparison;
    downloadedVsInstalled: VersionComparison;
  };
}

export interface InstalledPackageVersion {
  version: string;
  source: string;
}

export interface PackageVersionRuntime {
  platform: NodeJS.Platform;
  run(command: string, args: string[]): Promise<string>;
}

interface PackageVersionQuery {
  source: string;
  command: string;
  args: string[];
}

const PACKAGE_VERSION_QUERIES: PackageVersionQuery[] = [
  { source: "pacman", command: "pacman", args: ["-Q", "obsidian"] },
  {
    source: "dpkg",
    command: "dpkg-query",
    args: ["--show", "--showformat=${Version}", "obsidian"],
  },
  { source: "rpm", command: "rpm", args: ["-q", "--queryformat", "%{VERSION}", "obsidian"] },
  {
    source: "flatpak",
    command: "flatpak",
    args: ["info", "--show-version", "md.obsidian.Obsidian"],
  },
  { source: "snap", command: "snap", args: ["list", "obsidian"] },
];

const defaultPackageVersionRuntime: PackageVersionRuntime = {
  platform: process.platform,
  run: (command, args) =>
    new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 1_500, maxBuffer: 64 * 1024 }, (error, stdout) =>
        error === null ? resolve(stdout) : reject(error),
      );
    }),
};

function normalizedVersion(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : (extractSemver(value) ?? null);
}

function compareVersionSources(left: string | null, right: string | null): VersionComparison {
  if (left === null || right === null) return "unavailable";
  return compareVersions(left, right) === 0 ? "match" : "different";
}

/** Build an explicit comparison report from the three independent version sources. */
export function buildObsidianVersions(sources: ObsidianVersionSources): ObsidianVersions {
  const running = normalizedVersion(sources.running);
  const downloadedAsar = normalizedVersion(sources.downloadedAsar);
  const installedPackage = normalizedVersion(sources.installedPackage);

  return {
    running,
    downloadedAsar,
    installedPackage,
    installedPackageSource:
      installedPackage === null ? null : (sources.installedPackageSource ?? null),
    comparisons: {
      runningVsDownloaded: compareVersionSources(running, downloadedAsar),
      runningVsInstalled: compareVersionSources(running, installedPackage),
      downloadedVsInstalled: compareVersionSources(downloadedAsar, installedPackage),
    },
  };
}

/** Read the installed Obsidian version from Linux package databases. */
export async function detectInstalledObsidianPackageVersion(
  runtime: PackageVersionRuntime = defaultPackageVersionRuntime,
): Promise<InstalledPackageVersion | undefined> {
  if (runtime.platform !== "linux") return undefined;

  for (const query of PACKAGE_VERSION_QUERIES) {
    try {
      const version = extractSemver(await runtime.run(query.command, query.args));
      if (version !== undefined) return { version, source: query.source };
    } catch {
      // Missing package managers and packages are expected while probing.
    }
  }
  return undefined;
}

/**
 * Drift verdict: only a downloaded version *newer* than the running one counts.
 * Older leftovers are normal — Obsidian does not delete superseded asars.
 *
 * @deprecated Use `buildObsidianVersions` for source-specific comparisons.
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
