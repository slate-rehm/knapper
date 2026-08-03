/**
 * Session keys and descriptors.
 *
 * `assertSessionKey` is the only guard between an agent-supplied string and a path
 * join inside the session root — the same root the reaper deletes within. It is
 * tested as a security boundary, not a formatting nicety.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSessionKey, mintSessionKey, slugify } from "../../src/session/key.js";
import {
  listDescriptors,
  readDescriptor,
  removeDescriptor,
  patchDescriptor,
  writeDescriptor,
  SESSION_SCHEMA_VERSION,
  type SessionDescriptor,
} from "../../src/session/descriptor.js";
import { knapperHome, sessionPaths } from "../../src/config.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "knap-home-"));
  env = { ...process.env, KNAP_HOME: home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function descriptor(key: string): SessionDescriptor {
  return {
    schema: SESSION_SCHEMA_VERSION,
    key,
    createdAt: "2026-07-28T12:00:00.000Z",
    heartbeatAt: "2026-07-28T12:00:00.000Z",
    readiness: { phase: "ready", readyAt: "2026-07-28T12:00:00.000Z" },
    origin: { cwd: "/home/bear/wt/feature", branch: "dev", label: "feature" },
    instance: {
      userDataDir: join(home, "sessions", key, "userdata"),
      runtimeDir: join(home, "sessions", key, "run"),
      outputDir: join(home, "sessions", key, "output"),
      cdpPort: 33813,
      cdpUrl: "http://127.0.0.1:33813",
      obsidianBin: "obsidian",
    },
  };
}

describe("knapperHome", () => {
  it("honours KNAP_HOME and defaults to ~/.knapper_mcp", () => {
    expect(knapperHome(env)).toBe(home);
    expect(knapperHome({ ...process.env, KNAP_HOME: "" })).toMatch(/\.knapper_mcp$/);
  });
});

describe("assertSessionKey", () => {
  it("accepts a minted key", () => {
    const key = mintSessionKey("my-plugin", env);
    expect(() => assertSessionKey(key)).not.toThrow();
    expect(key).toMatch(/^my-plugin-[0-9a-f]{8}$/);
  });

  it.each([
    ["../../etc/passwd", "traversal"],
    ["..", "parent"],
    ["a/b-a3f19c22", "separator"],
    ["/abs-a3f19c22", "absolute"],
    ["UPPER-a3f19c22", "uppercase"],
    ["no-suffix", "missing hex"],
    ["", "empty"],
    ["sess-a3f19c2", "short hex"],
    ["sess-a3f19c22x", "long hex"],
  ])("rejects %s (%s)", (bad) => {
    // Rejection rather than sanitization: a key that does not match is a bug or an
    // attack, and quietly repairing it would hide both.
    expect(() => assertSessionKey(bad)).toThrow(/not a valid knapper session key/);
  });

  it("refuses a traversal key before it reaches the filesystem", async () => {
    // "Malformed key" must stay distinguishable from "no such session": the latter
    // becomes SESSION_NOT_FOUND, the former must never be swallowed into it.
    await expect(readDescriptor("../../../etc", env)).rejects.toThrow(/not a valid/);
    await expect(removeDescriptor("../../../etc", env)).rejects.toThrow(/not a valid/);
  });

  it("still reports a well-formed but absent key as simply missing", async () => {
    expect(await readDescriptor("gone-a3f19c22", env)).toBeUndefined();
  });
});

describe("slugify", () => {
  it.each([
    ["My Plugin!", "my-plugin"],
    ["  spaced  ", "spaced"],
    ["a-very-long-label-indeed", "a-very-long"],
    ["!!!", "session"],
    ["", "session"],
  ])("%s -> %s", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("never leaves a trailing dash for the key to double up on", () => {
    expect(slugify("exactly-long-x")).not.toMatch(/-$/);
  });
});

describe("mintSessionKey", () => {
  it("does not collide for the same label, so two agents on one branch differ", () => {
    const keys = new Set(Array.from({ length: 50 }, () => mintSessionKey("same", env)));
    expect(keys.size).toBe(50);
  });

  it("refuses a label whose CLI socket path would overflow sun_path", () => {
    // Caught where the name is chosen; otherwise Obsidian fails to bind minutes
    // later with an opaque ENAMETOOLONG and nothing points back at the label.
    const deep = { ...env, KNAP_HOME: `/${"d".repeat(90)}` };
    expect(() => mintSessionKey("plugin", deep)).toThrow(/socket path/);
  });
});

describe("descriptor round-trip", () => {
  it("writes and reads back", async () => {
    const d = descriptor(mintSessionKey("demo", env));
    await writeDescriptor(d, env);
    expect(await readDescriptor(d.key, env)).toEqual(d);
  });

  it("is atomic: a reader never observes a partial file", async () => {
    const d = descriptor(mintSessionKey("demo", env));
    await writeDescriptor(d, env);
    // Simulate the torn write the tmp+rename exists to prevent.
    await writeFile(sessionPaths(d.key, env).descriptor, '{"schema":1,"key":"dem', "utf8");
    expect(await readDescriptor(d.key, env)).toBeUndefined();
    await writeDescriptor(d, env);
    expect((await readDescriptor(d.key, env))?.key).toBe(d.key);
    // And no .tmp debris is left behind.
    const text = await readFile(sessionPaths(d.key, env).descriptor, "utf8");
    expect(JSON.parse(text).key).toBe(d.key);
  });

  it("ignores a descriptor whose key does not match its filename", async () => {
    const a = mintSessionKey("aaa", env);
    const b = mintSessionKey("bbb", env);
    await writeDescriptor({ ...descriptor(b), key: b }, env);
    // Hand-craft a mismatch, which would otherwise let one session impersonate another.
    const wrong = { ...descriptor(a), key: b };
    await writeDescriptor({ ...wrong, key: a }, env);
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(sessionPaths(a, env).root, { recursive: true });
    await wf(sessionPaths(a, env).descriptor, JSON.stringify(wrong), "utf8");
    expect(await readDescriptor(a, env)).toBeUndefined();
  });

  it("patches in place", async () => {
    const d = descriptor(mintSessionKey("demo", env));
    await writeDescriptor(d, env);
    await patchDescriptor(d.key, (c) => ({ ...c, heartbeatAt: "2026-07-28T13:00:00.000Z" }), env);
    expect((await readDescriptor(d.key, env))?.heartbeatAt).toBe("2026-07-28T13:00:00.000Z");
  });

  it("patching a missing session is a no-op rather than a throw", async () => {
    expect(await patchDescriptor("gone-a3f19c22", (c) => c, env)).toBeUndefined();
  });

  it("lists every session, oldest first, skipping debris", async () => {
    const older = descriptor(mintSessionKey("older", env));
    const newer = {
      ...descriptor(mintSessionKey("newer", env)),
      createdAt: "2026-07-29T00:00:00.000Z",
    };
    await writeDescriptor(older, env);
    await writeDescriptor(newer, env);

    // A stray directory that is not a session key must not break listing.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "sessions", "not-a-session"), { recursive: true });

    expect((await listDescriptors(env)).map((d) => d.key)).toEqual([older.key, newer.key]);
  });

  it("returns an empty list when nothing has been created yet", async () => {
    expect(await listDescriptors({ ...process.env, KNAP_HOME: join(home, "nope") })).toEqual([]);
  });

  it("removes only the descriptor", async () => {
    const d = descriptor(mintSessionKey("demo", env));
    await writeDescriptor(d, env);
    await removeDescriptor(d.key, env);
    expect(await readDescriptor(d.key, env)).toBeUndefined();
    expect(await listDescriptors(env)).toEqual([]);
  });
});
