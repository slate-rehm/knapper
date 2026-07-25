/**
 * Prefer Playwright evaluate when CDP is up (richer than CLI JSON.stringify).
 */

import type { CapabilityRouter } from "../connection/router.js";
import { evalJson } from "../obsidian/helpers.js";

export async function rendererEval<T>(router: CapabilityRouter, code: string): Promise<T> {
  const availability = await router.refreshAvailability();
  if (availability.playwright) {
    router.claimDebugger("playwright");
    return router.playwright.evaluate<T>(code);
  }
  return evalJson<T>(router, code);
}
