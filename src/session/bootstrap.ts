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

import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { sessionPaths, type SessionPaths } from "../config.js";
import { UobError } from "../util/errors.js";
import { chromium } from "playwright-core";

export interface SeedOptions {
  key: string;
  now: Date;
  env?: NodeJS.ProcessEnv;
}

export interface SeededSession {
  paths: SessionPaths;
  vault: {
    id: string;
    name: string;
    path: string;
    grant: "created" | "adopted";
  };
}

export const SESSION_IDENTITY_PLUGIN_ID = "knapper-session-identity";

export interface SessionReadinessProbe {
  identityLoaded: boolean;
  identityVisible: boolean;
  titleIdentified: boolean;
  desktopIdentified: boolean;
  requestedPlugin: null | {
    exists: boolean;
    enabled: boolean;
    loaded: boolean;
  };
}

function sessionIdentityMain(key: string): string {
  return `const { Plugin, Notice } = require("obsidian");
const SESSION = ${JSON.stringify(key)};
const PREFIX = "[KNAPPER TEST SESSION " + SESSION + "] ";
const ICON = "data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="10" fill="#b42318"/><path d="M13 48V16h8v13l16-13h12L31 31l20 17H39L21 33v15z" fill="white"/></svg>');

module.exports = class KnapperSessionIdentity extends Plugin {
  onload() {
    const install = (candidate) => {
      const win = candidate?.win ?? candidate ?? window;
      const doc = win.document;
      if (!doc?.body) return;
      doc.body.classList.add("knapper-test-session");
      doc.body.dataset.knapperSession = SESSION;
      let icon = doc.querySelector("link[data-knapper-session-icon]");
      if (!icon) {
        icon = doc.createElement("link");
        icon.rel = "icon";
        icon.dataset.knapperSessionIcon = SESSION;
        doc.head.append(icon);
      }
      icon.href = ICON;
      const desktopIdentified = icon.href.startsWith("data:image/svg+xml");
      doc.body.dataset.knapperDesktopIdentity = desktopIdentified ? "ready" : "degraded";
      let banner = doc.querySelector(".knapper-session-banner");
      if (!banner) {
        banner = doc.createElement("div");
        banner.className = "knapper-session-banner";
        banner.setAttribute("role", "status");
        const mark = doc.createElement("span");
        mark.className = "knapper-session-icon";
        mark.setAttribute("aria-hidden", "true");
        mark.textContent = "K";
        banner.append(mark, "KNAPPER TEST SESSION · " + SESSION + " · PRIVATE PROFILE");
        doc.body.prepend(banner);
      }
      const identifyTitle = () => {
        if (!doc.title.startsWith(PREFIX)) doc.title = PREFIX + doc.title.replace(/^\\[KNAPPER TEST SESSION [^\\]]+\\] /, "");
      };
      identifyTitle();
      const observer = new win.MutationObserver(identifyTitle);
      const title = doc.querySelector("title");
      if (title) observer.observe(title, { childList: true, subtree: true, characterData: true });
      this.register(() => observer.disconnect());
      doc.addEventListener("click", (event) => {
        const target = event.target instanceof win.Element ? event.target : null;
        if (!target?.closest(".workspace-drawer-vault-switcher, .vault-switcher, [data-testid='vault-switcher'], .modal.mod-vault-switcher")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        new Notice("Vault switching is disabled in a Knapper private session.");
      }, true);

      const openVault = this.app.commands?.commands?.["app:open-vault"];
      if (openVault) {
        const callback = openVault.callback;
        const checkCallback = openVault.checkCallback;
        const block = () => new Notice("Vault switching is disabled in a Knapper private session.");
        openVault.callback = block;
        openVault.checkCallback = (checking) => {
          if (!checking) block();
          return false;
        };
        this.register(() => {
          openVault.callback = callback;
          openVault.checkCallback = checkCallback;
        });
      }
    };
    this.app.workspace.onLayoutReady(() => install(window));
    this.registerEvent(this.app.workspace.on("window-open", install));
  }
};
`;
}

const SESSION_IDENTITY_CSS = `.knapper-session-banner {
  position: fixed;
  inset: 0 0 auto 0;
  z-index: 1000000;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #b42318;
  color: #fff;
  border-bottom: 2px solid #fff;
  font: 700 12px/1 system-ui, sans-serif;
  letter-spacing: 0.08em;
  pointer-events: none;
}
.knapper-session-icon {
  width: 18px;
  height: 18px;
  margin-inline-end: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  color: #b42318;
  border-radius: 4px;
  font-weight: 900;
}
.knapper-test-session .app-container { padding-top: 30px; }
.knapper-test-session .workspace-drawer-vault-switcher,
.knapper-test-session .vault-switcher,
.knapper-test-session [data-testid="vault-switcher"],
.knapper-test-session .modal.mod-vault-switcher { display: none !important; }
`;

export async function seedSessionIdentityPlugin(vaultPath: string, key: string): Promise<void> {
  const pluginDir = join(vaultPath, ".obsidian", "plugins", SESSION_IDENTITY_PLUGIN_ID);
  await mkdir(pluginDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(
      join(pluginDir, "manifest.json"),
      `${JSON.stringify(
        {
          id: SESSION_IDENTITY_PLUGIN_ID,
          name: "Knapper Test Session Identity",
          version: "1.0.0",
          minAppVersion: "1.0.0",
          description: "Marks and confines a Knapper private Obsidian session.",
          isDesktopOnly: true,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    ),
    writeFile(join(pluginDir, "main.js"), sessionIdentityMain(key), {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(join(pluginDir, "styles.css"), SESSION_IDENTITY_CSS, {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);
}

export function pluginTrustStorageKey(vaultId: string): string {
  return `enable-plugin-${vaultId}`;
}

/** Grant plugin trust inside a disposable profile, then reload its renderer. */
export async function trustDisposableVault(cdpUrl: string, vaultId: string): Promise<void> {
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl, {
      noDefaults: true,
      isLocal: true,
      timeout: 10_000,
    });
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
    await browser?.close().catch(() => undefined);
  }
}

/** Verify the visible session boundary and an optional requested plugin after trust reload. */
export async function verifyDisposableVaultReadiness(
  cdpUrl: string,
  key: string,
  pluginId?: string,
): Promise<SessionReadinessProbe> {
  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl, {
      noDefaults: true,
      isLocal: true,
      timeout: 10_000,
    });
    const context = browser.contexts()[0];
    if (context === undefined) throw new Error("CDP exposed no browser context");
    const pageDeadline = Date.now() + 10_000;
    let page = context
      .pages()
      .find((candidate) => candidate.url().startsWith("app://obsidian.md/"));
    while (page === undefined && Date.now() < pageDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      page = context.pages().find((candidate) => candidate.url().startsWith("app://obsidian.md/"));
    }
    if (page === undefined) throw new Error("CDP exposed no Obsidian renderer");
    const source = `(() => {
      const identityId = ${JSON.stringify(SESSION_IDENTITY_PLUGIN_ID)};
      const expectedKey = ${JSON.stringify(key)};
      const requestedId = ${pluginId === undefined ? "undefined" : JSON.stringify(pluginId)};
      const requested = requestedId === undefined ? null : {
        exists: app.plugins?.manifests?.[requestedId] != null,
        enabled: app.plugins?.enabledPlugins?.has(requestedId) === true,
        loaded: app.plugins?.getPlugin?.(requestedId) != null,
      };
      return {
        identityLoaded: app.plugins?.getPlugin?.(identityId) != null,
        identityVisible:
          document.body.dataset.knapperSession === expectedKey &&
          document.querySelector(".knapper-session-banner") != null,
        titleIdentified: document.title.startsWith("[KNAPPER TEST SESSION " + expectedKey + "] "),
        desktopIdentified:
          document.body.dataset.knapperDesktopIdentity === "ready" &&
          document.querySelector(".knapper-session-icon") != null &&
          document.querySelector("link[data-knapper-session-icon]") != null,
        requestedPlugin: requested,
      };
    })()`;
    const deadline = Date.now() + 10_000;
    let result: SessionReadinessProbe;
    do {
      result = (await page.evaluate(source)) as SessionReadinessProbe;
      const requestedReady =
        result.requestedPlugin === null ||
        (result.requestedPlugin.exists &&
          result.requestedPlugin.enabled &&
          result.requestedPlugin.loaded);
      if (
        result.identityLoaded &&
        result.identityVisible &&
        result.titleIdentified &&
        result.desktopIdentified &&
        requestedReady
      ) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    return result;
  } finally {
    await browser?.close().catch(() => undefined);
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
  const vaultPath = paths.vaultDir;

  // A private workspace always owns a newly-created root. It cannot adopt a path
  // supplied by an agent, which removes the only route from session cleanup to a
  // user's vault. The non-recursive root creation also makes key collisions fail
  // closed instead of merging with old hidden files.
  await mkdir(dirname(paths.root), { recursive: true, mode: 0o700 });
  await mkdir(paths.root, { mode: 0o700 });
  await mkdir(paths.userDataDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.outputDir, { recursive: true });
  // 0700: the CLI socket lands here, and it is a control channel into a live app.
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(join(vaultPath, ".obsidian"), { recursive: true });
  await seedSessionIdentityPlugin(vaultPath, opts.key);

  // Same write obsidian_create_vault performs, but before first boot rather than
  // after a cold restart — Obsidian registers a vault's commands only once it has
  // opened it, so `plugins:restrict` is genuinely absent this early.
  await writeFile(
    join(vaultPath, ".obsidian", "app.json"),
    JSON.stringify({ communityPluginEnabled: true }),
    "utf8",
  );
  await writeFile(
    join(vaultPath, ".obsidian", "community-plugins.json"),
    `${JSON.stringify([SESSION_IDENTITY_PLUGIN_ID], null, 2)}\n`,
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
    vault: {
      id: vaultId,
      name: basename(vaultPath),
      path: vaultPath,
      grant: "created",
    },
  };
}
