/**
 * Native browser helpers reimplemented from @playwright/mcp `skillOnly` tools.
 *
 * Upstream filters these out of MCP `tools/list` but they are still useful against
 * Obsidian when exposed with Obsidian-specific descriptions.
 */

import type { Page } from "playwright-core";
import type { CapabilityRouter } from "../connection/router.js";
import { UobError } from "../util/errors.js";

function targetLocator(page: Page, target: string) {
  if (/^e\d+$/.test(target)) return page.locator(`aria-ref=${target}`);
  if (target.startsWith("aria-ref=")) return page.locator(target);
  return page.locator(target);
}

async function page(router: CapabilityRouter): Promise<Page> {
  await router.playwright.connect();
  return router.playwright.page();
}

export async function reloadWindow(router: CapabilityRouter): Promise<string> {
  const p = await page(router);
  const usedCommand = await p
    .evaluate(async () => {
      const app = (
        globalThis as { app?: { commands?: { executeCommandById: (id: string) => Promise<void> } } }
      ).app;
      if (!app?.commands) return false;
      try {
        await app.commands.executeCommandById("app:reload");
        return true;
      } catch {
        return false;
      }
    })
    .catch(() => false);

  if (usedCommand) {
    return (
      "Reloaded Obsidian via the app:reload command (same as the command palette reload). " +
      "Transient UI state (open modals, unsaved buffers) may be lost."
    );
  }

  await p.reload();
  return (
    "Reloaded the renderer with page.reload() because app:reload was unavailable. " +
    "This is equivalent to refreshing the window and is heavier than obsidian_dev_cycle plugin reload."
  );
}

export async function checkTarget(
  router: CapabilityRouter,
  args: Record<string, unknown>,
): Promise<string> {
  const target = args.target;
  if (typeof target !== "string" || target === "") {
    throw new UobError("INVALID_ARGUMENT", "target is required (snapshot ref or CSS selector).");
  }
  const locator = targetLocator(await page(router), target);
  await locator.check();
  return `Checked ${target}.`;
}

export async function pressSequentially(
  router: CapabilityRouter,
  args: Record<string, unknown>,
): Promise<string> {
  const text = args.text;
  if (typeof text !== "string") {
    throw new UobError("INVALID_ARGUMENT", "text is required.");
  }
  const p = await page(router);
  await p.keyboard.type(text);
  if (args.submit === true) await p.keyboard.press("Enter");
  return `Typed ${text.length} character(s) key-by-key${args.submit === true ? " and pressed Enter" : ""}.`;
}

export async function keyDown(
  router: CapabilityRouter,
  args: Record<string, unknown>,
): Promise<string> {
  const key = args.key;
  if (typeof key !== "string" || key === "") {
    throw new UobError("INVALID_ARGUMENT", "key is required.");
  }
  await (await page(router)).keyboard.down(key);
  return `Key down: ${key}. Pair with browser_keyup.`;
}

export async function keyUp(
  router: CapabilityRouter,
  args: Record<string, unknown>,
): Promise<string> {
  const key = args.key;
  if (typeof key !== "string" || key === "") {
    throw new UobError("INVALID_ARGUMENT", "key is required.");
  }
  await (await page(router)).keyboard.up(key);
  return `Key up: ${key}.`;
}
