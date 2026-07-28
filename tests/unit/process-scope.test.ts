/**
 * Scoping a /proc scan to one Obsidian instance.
 *
 * The argv strings below are captured verbatim from a live machine, because the
 * whole risk here is a predicate that looks right against invented input. Two
 * shapes matter and pull in opposite directions:
 *
 *  - The *main* process carries the obsidian marker but, when launched normally,
 *    carries no `--user-data-dir` at all.
 *  - The *network utility* child carries `--user-data-dir` and nothing obsidian-ish.
 *
 * So the predicate has to be a conjunction. Matching on the directory alone would
 * sweep helper processes into a SIGTERM loop — the mirror image of the bug commit
 * 5af5361 fixed by making the marker match structural.
 */

import { describe, expect, it } from "vitest";
import {
  cmdlineUserDataDir,
  isObsidianCmdline,
  matchesScope,
} from "../../src/connection/health.js";
import { defaultObsidianUserDataDir } from "../../src/config.js";

const nul = (...argv: string[]): string => `${argv.join("\0")}\0`;

/** Real argv of a default-profile Obsidian: no --user-data-dir token at all. */
const MAIN_DEFAULT = nul(
  "/usr/lib/electron39/electron",
  "/usr/lib/obsidian/app.asar",
  "--disable-gpu",
  "--enable-wayland-ime",
  "--remote-debugging-port=9222",
  "--remote-allow-origins=*",
  "--ozone-platform-hint=auto",
);

/** Real argv of the network utility child: has the dir, lacks the marker. */
const NETWORK_UTILITY = nul(
  "/proc/self/exe",
  "--type=utility",
  "--utility-sub-type=network.mojom.NetworkService",
  "--lang=en-US",
  "--service-sandbox-type=none",
  "--user-data-dir=/home/bear/.config/obsidian",
  "--standard-schemes=app",
  "--log-level=3",
);

/** A session's main process, as this repo now launches it. */
const MAIN_SESSION = nul(
  "/usr/lib/electron39/electron",
  "/usr/lib/obsidian/app.asar",
  "--disable-gpu",
  "--user-data-dir=/home/bear/.knapper_mcp/sessions/demo-a3f19c22/userdata",
  "--remote-debugging-port=0",
  "--remote-allow-origins=*",
);

const SESSION_DIR = "/home/bear/.knapper_mcp/sessions/demo-a3f19c22/userdata";
const OTHER_SESSION_DIR = "/home/bear/.knapper_mcp/sessions/other-b7c2d301/userdata";

describe("cmdlineUserDataDir", () => {
  it("reads the --flag=value form", () => {
    expect(cmdlineUserDataDir(MAIN_SESSION)).toBe(SESSION_DIR);
  });

  it("reads the two-token form Chromium also accepts", () => {
    expect(cmdlineUserDataDir(nul("electron", "app.asar", "--user-data-dir", SESSION_DIR))).toBe(
      SESSION_DIR,
    );
  });

  it("returns undefined when the flag is absent", () => {
    expect(cmdlineUserDataDir(MAIN_DEFAULT)).toBeUndefined();
  });

  it("normalizes before comparing, so a non-canonical path still matches", () => {
    const messy = nul("electron", "app.asar", `--user-data-dir=${SESSION_DIR}/../userdata`);
    expect(cmdlineUserDataDir(messy)).toBe(SESSION_DIR);
  });

  it("scans per token rather than over the whole buffer", () => {
    // A shell that merely mentions the flag in a quoted string is one argv token.
    const shell = nul("bash", "-c", `nohup obsidian --user-data-dir=${SESSION_DIR} &`);
    expect(cmdlineUserDataDir(shell)).toBeUndefined();
  });
});

describe("matchesScope", () => {
  it("matches a session's main process to its own scope", () => {
    expect(matchesScope(MAIN_SESSION, { userDataDir: SESSION_DIR })).toBe(true);
  });

  it("does NOT match one session's process to another session's scope", () => {
    expect(matchesScope(MAIN_SESSION, { userDataDir: OTHER_SESSION_DIR })).toBe(false);
  });

  it("does NOT match a session's process to the default scope", () => {
    // The guarantee that an agent's restart cannot kill the user's own Obsidian.
    expect(matchesScope(MAIN_SESSION, {})).toBe(false);
  });

  it("does NOT match the user's own Obsidian to a session scope", () => {
    expect(matchesScope(MAIN_DEFAULT, { userDataDir: SESSION_DIR })).toBe(false);
  });

  it("matches the default profile whether the flag is absent or explicit", () => {
    expect(matchesScope(MAIN_DEFAULT, {})).toBe(true);
    const explicit = nul(
      "/usr/lib/electron39/electron",
      "/usr/lib/obsidian/app.asar",
      `--user-data-dir=${defaultObsidianUserDataDir()}`,
    );
    expect(matchesScope(explicit, {})).toBe(true);
  });

  it("never matches the network utility, which has the dir but not the marker", () => {
    // The conjunction's whole reason for existing: this process would otherwise be
    // SIGTERMed as if it were an Obsidian instance.
    expect(isObsidianCmdline(NETWORK_UTILITY)).toBe(false);
    expect(cmdlineUserDataDir(NETWORK_UTILITY)).toBe("/home/bear/.config/obsidian");
    expect(matchesScope(NETWORK_UTILITY, {})).toBe(false);
    expect(matchesScope(NETWORK_UTILITY, { userDataDir: "/home/bear/.config/obsidian" })).toBe(
      false,
    );
  });

  it("never matches a shell that merely mentions obsidian", () => {
    expect(matchesScope(nul("bash", "-c", "nohup obsidian --foo &"), {})).toBe(false);
  });
});
