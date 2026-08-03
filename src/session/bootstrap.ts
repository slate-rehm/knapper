/**
 * Seeding a virgin Obsidian profile for a session.
 *
 * Everything here runs *before* the first spawn, which is what makes it safe.
 * `writeCliFlag`'s docstring warns that editing `obsidian.json` while Obsidian is
 * running is discarded — a live instance holds the file in memory and rewrites it
 * on exit. A session satisfies that precondition by construction rather than by
 * hoping: nothing is running yet, because this is what decides what will run.
 *
 * Two ordering constraints, both read out of `obsidian.asar` and confirmed live:
 *
 *  - The vault directory must exist first. On boot the main process prunes the
 *    registry with `(!r.path || !fs.existsSync(r.path)) && delete P[e]`, so seeding
 *    an entry for a directory that is not there yet deletes it and the app opens
 *    the vault picker instead.
 *  - `open: true` is what makes the app boot straight into the vault. Without it
 *    the window is a vault switcher, and `PlaywrightSession.page()` finds no
 *    authorized Obsidian window to drive.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { sessionPaths, type SessionPaths } from "../config.js";
import { forbiddenRoot, readManagedMarker, writeManagedMarker } from "../connection/vaults.js";
import { UobError } from "../util/errors.js";
import { chromium } from "playwright-core";

export interface SeedOptions {
  key: string;
  /** Vault directory. Defaults to the session's own `vault/`. */
  vaultPath?: string;
  /**
   * Use an already-authorized vault instead of creating one. Its marker is left
   * alone, and `closeSession` will never delete it.
   */
  adopt?: boolean;
  now: Date;
  env?: NodeJS.ProcessEnv;
}

export interface SeededSession {
  paths: SessionPaths;
  vault: { id: string; name: string; path: string; grant: "created" | "adopted" };
}

export function pluginTrustStorageKey(vaultId: string): string {
  return `enable-plugin-${vaultId}`;
}

/** Grant plugin trust inside a disposable profile, then reload its renderer. */
export async function trustDisposableVault(cdpUrl: string, vaultId: string): Promise<void> {
  const browser = await chromium.connectOverCDP(cdpUrl, {
    noDefaults: true,
    isLocal: true,
    timeout: 10_000,
  });
  try {
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error("CDP exposed no browser context");
    const deadline = Date.now() + 10_000;
    let page = context
      .pages()
      .find((candidate) => candidate.url().startsWith("app://obsidian.md/"));
    while (page === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      page = context.pages().find((candidate) => candidate.url().startsWith("app://obsidian.md/"));
    }
    if (page === undefined) throw new Error("CDP exposed no Obsidian renderer");
    await page.evaluate((key) => localStorage.setItem(key, "true"), pluginTrustStorageKey(vaultId));
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
  } catch (error) {
    throw new UobError("APP_UNAVAILABLE", "Could not grant plugin trust in the disposable vault.", {
      remediation:
        "Restart the session, or create it without pluginSourceDir and enable the plugin manually.",
      cause: error,
      details: { vaultId },
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * The minimum `obsidian.json` an instance needs.
 *
 * Only two keys, matching what a real profile carries: `vaults` and `cli`. Seeding
 * `cli: true` means the CLI transport is live on the very first boot — no
 * `obsidian_setup_cli` round trip and no cold restart to make it stick.
 */
export function seedGlobalConfig(vaultId: string, vaultPath: string, now: Date): string {
  return JSON.stringify({
    vaults: { [vaultId]: { path: vaultPath, ts: now.getTime(), open: true } },
    cli: true,
  });
}

export async function seedSessionProfile(opts: SeedOptions): Promise<SeededSession> {
  const env = opts.env ?? process.env;
  const paths = sessionPaths(opts.key, env);
  const vaultPath = resolve(opts.vaultPath ?? paths.vaultDir);

  const forbidden = forbiddenRoot(vaultPath);
  if (forbidden !== undefined) {
    throw new UobError("INVALID_ARGUMENT", `Refusing to use ${forbidden} as a session vault.`, {
      remediation: "Pass a dedicated directory, or omit vaultPath to use the session's own.",
      details: { path: vaultPath },
    });
  }

  // Decide about the vault BEFORE creating anything, so a refusal leaves no
  // half-made session root behind and — far more importantly — writes no marker.
  //
  // The marker is the entire delete authority: `removeManagedVault` deletes
  // exactly what carries one. Seeding used to stamp `created` on whatever
  // directory it was handed, so pointing a session at a vault of real notes made
  // those notes disposable, and automatic cleanup later deleted them while doing
  // precisely what it had been told. `createManagedVault` has refused non-empty
  // directories since it was written; this path is the second way in and must
  // refuse them too.
  const existing = await readManagedMarker(vaultPath);
  const preexisting = await readdir(vaultPath).catch(() => undefined);

  let grant: "created" | "adopted";
  if (opts.adopt === true) {
    if (existing === undefined) {
      throw new UobError(
        "VAULT_NOT_AUTHORIZED",
        `Refusing to adopt "${basename(vaultPath)}" — it carries no knapper marker.`,
        {
          remediation:
            "Run `knapper authorize <vault>` yourself first. Adoption is a consent step, and a tool " +
            "cannot grant it on the user's behalf.",
          details: { path: vaultPath },
        },
      );
    }
    // Preserve the user's own marker verbatim; rewriting it as `created` would
    // quietly convert a consent grant into a delete permission.
    grant = existing.grant === "adopted" ? "adopted" : "created";
  } else {
    const occupants = (preexisting ?? []).filter((e) => !e.startsWith("."));
    if (existing === undefined && occupants.length > 0) {
      throw new UobError(
        "INVALID_ARGUMENT",
        `Refusing to use non-empty directory ${vaultPath} as a session vault.`,
        {
          remediation:
            "Pass an empty or non-existent directory, or omit vaultPath to get the session's own. " +
            "To work in a vault that already holds notes, run `knapper authorize <vault>` and pass " +
            "it as adoptVault — that grants access without making it deletable.",
          details: { path: vaultPath, entries: occupants.slice(0, 10) },
        },
      );
    }
    grant = "created";
  }

  await mkdir(paths.userDataDir, { recursive: true });
  await mkdir(paths.outputDir, { recursive: true });
  // 0700: the CLI socket lands here, and it is a control channel into a live app.
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(join(vaultPath, ".obsidian"), { recursive: true });

  if (existing === undefined) await writeManagedMarker(vaultPath, opts.now, "created");

  // Same write obsidian_create_vault performs, but before first boot rather than
  // after a cold restart — Obsidian registers a vault's commands only once it has
  // opened it, so `plugins:restrict` is genuinely absent this early.
  await writeFile(
    join(vaultPath, ".obsidian", "app.json"),
    JSON.stringify({ communityPluginEnabled: true }),
    "utf8",
  );

  // 16 hex chars to match the ids Obsidian and createManagedVault generate.
  const vaultId = randomBytes(8).toString("hex");
  await writeFile(
    join(paths.userDataDir, "obsidian.json"),
    seedGlobalConfig(vaultId, vaultPath, opts.now),
    "utf8",
  );

  return {
    paths,
    // The vault's *name* is its directory basename — that is how readGlobalConfig
    // derives it, and it is the identity the fence matches on.
    vault: { id: vaultId, name: basename(vaultPath), path: vaultPath, grant },
  };
}
