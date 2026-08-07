import { describe, expect, it } from "vitest";
import {
  buildObsidianVersions,
  compareVersions,
  detectInstalledObsidianPackageVersion,
  extractSemver,
  latestAsarVersion,
  type PackageVersionRuntime,
  versionDrift,
} from "../../src/obsidian/version-drift.js";

describe("latestAsarVersion", () => {
  it("picks the newest downloaded asar among leftovers", () => {
    expect(
      latestAsarVersion(["obsidian-1.12.7.asar", "obsidian-1.13.0.asar", "obsidian-1.9.9.asar"]),
    ).toBe("1.13.0");
  });

  it("ignores unrelated files and malformed names", () => {
    expect(latestAsarVersion(["obsidian.json", "obsidian-1.2.asar", "app.asar"])).toBeUndefined();
  });

  it("compares numerically, not lexically", () => {
    expect(latestAsarVersion(["obsidian-1.9.0.asar", "obsidian-1.10.0.asar"])).toBe("1.10.0");
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });
});

describe("versionDrift", () => {
  it("reports drift only when the downloaded version is newer than the running one", () => {
    expect(versionDrift("v1.12.7", "1.13.0")).toEqual({ running: "1.12.7", installed: "1.13.0" });
    // Superseded leftovers are normal — Obsidian does not delete old asars.
    expect(versionDrift("1.13.0", "1.12.7")).toBeUndefined();
    expect(versionDrift("1.13.0", "1.13.0")).toBeUndefined();
  });

  it("stays silent when either side is unknown", () => {
    expect(versionDrift("(unavailable)", "1.13.0")).toBeUndefined();
    expect(versionDrift("1.12.7", undefined)).toBeUndefined();
  });

  it("extracts the version from noisy CLI output", () => {
    expect(extractSemver("v1.12.7 (installer 1.8.10)")).toBe("1.12.7");
    expect(extractSemver("no version here")).toBeUndefined();
  });
});

describe("buildObsidianVersions", () => {
  it("labels all comparisons by their explicit version sources", () => {
    expect(
      buildObsidianVersions({
        running: "v1.12.7",
        downloadedAsar: "1.13.0",
        installedPackage: "1.12.7-2",
        installedPackageSource: "pacman",
      }),
    ).toEqual({
      running: "1.12.7",
      downloadedAsar: "1.13.0",
      installedPackage: "1.12.7",
      installedPackageSource: "pacman",
      comparisons: {
        runningVsDownloaded: "different",
        runningVsInstalled: "match",
        downloadedVsInstalled: "different",
      },
    });
  });

  it("marks comparisons unavailable when a source has no valid version", () => {
    expect(
      buildObsidianVersions({
        running: "(unavailable)",
        downloadedAsar: null,
        installedPackage: "1.12.7",
        installedPackageSource: "dpkg",
      }),
    ).toEqual({
      running: null,
      downloadedAsar: null,
      installedPackage: "1.12.7",
      installedPackageSource: "dpkg",
      comparisons: {
        runningVsDownloaded: "unavailable",
        runningVsInstalled: "unavailable",
        downloadedVsInstalled: "unavailable",
      },
    });
  });
});

describe("detectInstalledObsidianPackageVersion", () => {
  it("queries package managers without executing the Obsidian binary", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runtime: PackageVersionRuntime = {
      platform: "linux",
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === "flatpak") return "1.13.2\n";
        throw new Error("not installed");
      },
    };

    await expect(detectInstalledObsidianPackageVersion(runtime)).resolves.toEqual({
      version: "1.13.2",
      source: "flatpak",
    });
    expect(calls.map(({ command }) => command)).toEqual(["pacman", "dpkg-query", "rpm", "flatpak"]);
    expect(calls.some(({ command }) => command === "obsidian")).toBe(false);
  });

  it("does not probe package managers outside Linux", async () => {
    const runtime: PackageVersionRuntime = {
      platform: "darwin",
      run: async () => {
        throw new Error("must not run");
      },
    };

    await expect(detectInstalledObsidianPackageVersion(runtime)).resolves.toBeUndefined();
  });
});
