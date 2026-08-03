import { describe, expect, it } from "vitest";
import {
  compareVersions,
  extractSemver,
  latestAsarVersion,
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
