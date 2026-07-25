/**
 * Phase-0 verification spikes, kept in the repo so the findings can be re-checked
 * against a new Obsidian or Playwright version rather than trusted from memory.
 *
 *   Gate A — is real mouse input reliable over connectOverCDP against a headed
 *            Electron app? (Playwright #41286 reports out-of-order mouse events.)
 *   Gate B — can Obsidian's CLI `dev:cdp` coexist with a live Playwright
 *            attachment, given Electron allows one debugger client per WebContents?
 *
 * Run with Obsidian already launched via --remote-debugging-port=9222:
 *   node scripts/spike-gates.mjs
 */

import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CDP_URL = process.env.OBSIDIAN_CDP_URL ?? "http://127.0.0.1:9222";
const CLICK_TRIALS = 20;

const results = {};

function log(...args) {
  console.log(...args);
}

const browser = await chromium.connectOverCDP(CDP_URL, { noDefaults: true, isLocal: true });
const context = browser.contexts()[0];
const pages = context.pages();
log(`attached: ${pages.length} page(s) in ${browser.contexts().length} context(s)`);

const page = pages.find((p) => p.url().startsWith("app://obsidian.md/"));
if (!page) throw new Error("no Obsidian main window found");

const vaultName = await page.evaluate(() => window.app?.vault?.getName?.());
log(`vault: ${vaultName}`);

// ---------------------------------------------------------------- Gate A
// Inject a probe that records the order of mouse events and the click count, so a
// dropped or reordered click is measurable rather than inferred.
await page.evaluate(() => {
  const el = document.createElement("div");
  el.id = "uob-spike-target";
  Object.assign(el.style, {
    position: "fixed",
    top: "120px",
    left: "120px",
    width: "220px",
    height: "120px",
    zIndex: "99999",
    background: "#c33",
  });
  el.textContent = "spike target";
  document.body.appendChild(el);

  window.__uobSpike = { clicks: 0, order: [] };
  for (const type of ["mousedown", "mouseup", "click"]) {
    el.addEventListener(type, () => {
      window.__uobSpike.order.push(type);
      if (type === "click") window.__uobSpike.clicks++;
    });
  }
});

async function runClickTrials(strategy) {
  await page.evaluate(() => {
    window.__uobSpike.clicks = 0;
    window.__uobSpike.order = [];
  });

  const locator = page.locator("#uob-spike-target");
  for (let i = 0; i < CLICK_TRIALS; i++) {
    if (strategy === "mouse") await locator.click({ timeout: 5000 });
    else await locator.evaluate((el) => el.click());
  }

  const probe = await page.evaluate(() => window.__uobSpike);
  // A correct sequence per click is mousedown, mouseup, click.
  const outOfOrder = [];
  for (let i = 0; i + 2 < probe.order.length; i += 3) {
    const triple = probe.order.slice(i, i + 3).join(",");
    if (triple !== "mousedown,mouseup,click" && triple !== "click,,") outOfOrder.push(triple);
  }

  return {
    strategy,
    trials: CLICK_TRIALS,
    received: probe.clicks,
    dropped: CLICK_TRIALS - probe.clicks,
    outOfOrderSequences: outOfOrder.slice(0, 5),
  };
}

results.gateA_mouse = await runClickTrials("mouse");
log("Gate A (page.mouse via locator.click):", JSON.stringify(results.gateA_mouse));

results.gateA_domClick = await runClickTrials("dom");
log("Gate A (locator.evaluate el.click):", JSON.stringify(results.gateA_domClick));

// Keyboard was reported stable in the same upstream tests; confirm here.
await page.evaluate(() => {
  const input = document.createElement("input");
  input.id = "uob-spike-input";
  Object.assign(input.style, { position: "fixed", top: "260px", left: "120px", zIndex: "99999" });
  document.body.appendChild(input);
  input.focus();
});
const typed = "obsidian-keyboard-probe-12345";
await page.locator("#uob-spike-input").fill("");
await page.locator("#uob-spike-input").pressSequentially(typed, { delay: 5 });
const readBack = await page.locator("#uob-spike-input").inputValue();
results.gateA_keyboard = { sent: typed, received: readBack, ok: readBack === typed };
log("Gate A (keyboard):", JSON.stringify(results.gateA_keyboard));

await page.evaluate(() => {
  document.getElementById("uob-spike-target")?.remove();
  document.getElementById("uob-spike-input")?.remove();
  delete window.__uobSpike;
});

// ---------------------------------------------------------------- Gate B
// Ask the CLI to attach its own in-process debugger while Playwright holds one.
async function cli(args, timeout = 15000) {
  try {
    const { stdout, stderr } = await execFileAsync("obsidian", args, { timeout });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return { ok: false, error: e.message, stdout: (e.stdout ?? "").trim() };
  }
}

results.gateB_devCdp = await cli([
  "dev:cdp",
  "method=Runtime.evaluate",
  'params={"expression":"1+1"}',
]);
log("Gate B (dev:cdp while Playwright attached):", JSON.stringify(results.gateB_devCdp));

results.gateB_cliEvalCoexist = await cli(["eval", "code=app.vault.getName()"]);
log("Gate B (cli eval while attached):", JSON.stringify(results.gateB_cliEvalCoexist));

// Confirm Playwright still works after the CLI touched the debugger.
results.gateB_playwrightAfter = {
  vault: await page.evaluate(() => window.app?.vault?.getName?.()),
};
log("Gate B (playwright still alive):", JSON.stringify(results.gateB_playwrightAfter));

// ------------------------------------------------- ariaSnapshot availability
try {
  const snap = await page.locator(".workspace-leaf").first().ariaSnapshot({ mode: "ai" });
  results.ariaSnapshot = { ok: true, length: snap.length, sample: snap.slice(0, 200) };
} catch (e) {
  results.ariaSnapshot = { ok: false, error: e.message };
}
log("ariaSnapshot:", JSON.stringify(results.ariaSnapshot).slice(0, 400));

results.accessibilitySnapshotExists = typeof page.accessibility?.snapshot === "function";
log("page.accessibility.snapshot exists:", results.accessibilitySnapshotExists);

await browser.close();
log("\n=== SUMMARY ===");
log(JSON.stringify(results, null, 2));
