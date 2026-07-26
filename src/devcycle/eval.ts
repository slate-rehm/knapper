/**
 * Prefer Playwright evaluate when CDP is up (richer than CLI JSON.stringify).
 */

import type { CapabilityRouter } from "../connection/router.js";
import { evalJson } from "../obsidian/helpers.js";

export async function rendererEval<T>(
  router: CapabilityRouter,
  code: string,
  vault?: string,
): Promise<T> {
  const availability = await router.refreshAvailability();
  if (availability.playwright) {
    router.claimDebugger("playwright");
    // Resolve through the fence even on the Playwright path: page() would
    // otherwise pick the session default while the CLI path used the caller's
    // vault, so the two transports could disagree within one composite.
    const resolved = await router.resolveVault(vault);
    return router.playwright.evaluate<T>(code, resolved.name);
  }
  return evalJson<T>(router, code, vault);
}
