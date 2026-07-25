/**
 * Multi-window verification.
 *
 * Two situations break naive CDP target selection and neither is exotic during
 * plugin development:
 *
 *   1. A popout window. Obsidian creates these with `window.open("about:blank")`
 *      and injects a `<base href>`, so the target's URL is literally `about:blank`.
 *      Selecting by URL misses it; filtering `about:blank` as noise discards it.
 *   2. Two vaults open at once. Both main windows share the identical URL
 *      `app://obsidian.md/index.html`, so only `app.vault.getName()` can tell them
 *      apart — and there is exactly one BrowserContext holding all of them.
 *
 * Run with Obsidian already launched on --remote-debugging-port=9222:
 *   node scripts/spike-multiwindow.mjs
 */

import { chromium } from "playwright-core";
import { classifyTargets, selectTarget, fetchTargets } from "../dist/connection/cdp/discover.js";

const CDP_URL = process.env.OBSIDIAN_CDP_URL ?? "http://127.0.0.1:9222";

const browser = await chromium.connectOverCDP(CDP_URL, { noDefaults: true, isLocal: true });
const context = browser.contexts()[0];

console.log(`contexts: ${browser.contexts().length} (expected exactly 1)`);

const main = context.pages().find((p) => p.url().startsWith("app://obsidian.md/"));
if (!main) throw new Error("no Obsidian main window attached");

console.log(`main vault: ${await main.evaluate(() => window.app?.vault?.getName?.())}`);

// ---------------------------------------------------------------- popout case
console.log("\n--- opening a popout leaf ---");
const popoutAppeared = context.waitForEvent("page", { timeout: 15_000 }).catch(() => undefined);

await main.evaluate(async () => {
  const app = window.app;
  const file = app.vault.getMarkdownFiles()[0];
  // Obsidian's own API for tearing a leaf out into its own OS window.
  const leaf = app.workspace.openPopoutLeaf();
  if (file) await leaf.openFile(file);
});

const popoutPage = await popoutAppeared;
await new Promise((r) => setTimeout(r, 2500));

const targets = await fetchTargets(CDP_URL);
const classified = classifyTargets(targets);

console.log("classified targets:");
for (const t of classified) {
  console.log(
    `  [${t.kind.padEnd(7)}] url=${(t.target.url || "(none)").slice(0, 42).padEnd(42)} vault=${t.vaultName ?? "-"} title=${t.target.title.slice(0, 40)}`,
  );
}

const popouts = classified.filter((t) => t.kind === "popout");
const mains = classified.filter((t) => t.kind === "main");

console.log(`\nmain windows detected: ${mains.length}`);
console.log(`popouts detected:      ${popouts.length}`);
console.log(
  popouts.length > 0
    ? `PASS: popout classified despite url="${popouts[0].target.url}"`
    : "WARN: no popout classified — the popout may not have opened",
);

const selected = selectTarget(targets);
console.log(
  selected?.kind === "main"
    ? "PASS: selectTarget still prefers the main window over the popout"
    : `FAIL: selectTarget chose ${selected?.kind}`,
);

// Every window, popout included, lands in the single context.
console.log(`pages in contexts()[0]: ${context.pages().length}`);
console.log(
  browser.contexts().length === 1
    ? "PASS: exactly one BrowserContext holds every window"
    : `FAIL: ${browser.contexts().length} contexts`,
);

// ------------------------------------------------------- vault disambiguation
console.log("\n--- vault identity per window ---");
for (const page of context.pages()) {
  if (page.isClosed()) continue;
  const name = await page.evaluate(() => window.app?.vault?.getName?.()).catch(() => undefined);
  console.log(`  url=${page.url().slice(0, 40).padEnd(40)} vault=${name ?? "(no app)"}`);
}

console.log(
  "\nNote: two main windows for different vaults share the identical URL, so " +
    "app.vault.getName() is the only reliable discriminator.",
);

// ------------------------------------------------------------------- clean up
if (popoutPage && !popoutPage.isClosed()) {
  await main.evaluate(() => {
    // Close popout leaves without touching the user's main window.
    window.app.workspace.iterateAllLeaves((leaf) => {
      const win = leaf.view?.containerEl?.ownerDocument?.defaultView;
      if (win && win !== window) leaf.detach();
    });
  });
  console.log("\ncleaned up popout leaves");
}

await browser.close();
