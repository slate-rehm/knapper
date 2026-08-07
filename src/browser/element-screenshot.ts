/**
 * Element-scoped screenshots paired with a geometry metrics block.
 *
 * The metrics exist because window captures have been observed cropped relative
 * to the real window on Wayland/Hyprland mixed-DPI setups (see
 * `obsidian_screenshot` in tools/devtools.ts). Numbers from the live DOM are
 * trustworthy where pixels are not, so every capture carries its rect,
 * devicePixelRatio, and viewport alongside the image.
 */

import { z } from "zod";
import type { CapabilityRouter } from "../connection/router.js";
import type { ToolOutcome } from "../tools/registry.js";
import { UobError } from "../util/errors.js";
import { saveArtifact } from "../util/artifacts.js";

export const elementScreenshotSchema = {
  target: z
    .string()
    .describe(
      "CSS selector for the element to capture (first match wins). Snapshot refs (eN) are " +
        "internal to the browser_* proxy and do not resolve here — pass a selector, e.g. from " +
        "docs/dom-hooks.md or an obsidian_editor_widgets cssPath.",
    ),
  vault: z.string().optional().describe("Target vault name; overrides the session default"),
  path: z.string().optional().describe("Relative output path below the artifact directory"),
};

export interface ElementMetrics {
  rect: { x: number; y: number; width: number; height: number };
  devicePixelRatio: number;
  viewport: { innerWidth: number; innerHeight: number };
  display: { display: string; visibility: string };
}

export interface ScreenshotClip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The visible part of an element, expressed in viewport CSS pixels. */
export function visibleElementClip(metrics: ElementMetrics): ScreenshotClip | undefined {
  const left = Math.max(0, metrics.rect.x);
  const top = Math.max(0, metrics.rect.y);
  const right = Math.min(metrics.viewport.innerWidth, metrics.rect.x + metrics.rect.width);
  const bottom = Math.min(metrics.viewport.innerHeight, metrics.rect.y + metrics.rect.height);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Renderer source for the metrics block; `null` when nothing matches. */
export function elementMetricsSource(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      devicePixelRatio: window.devicePixelRatio,
      viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
      display: { display: cs.display, visibility: cs.visibility },
    };
  })()`;
}

export async function captureElementScreenshot(
  router: CapabilityRouter,
  outputDir: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const parsed = z.object(elementScreenshotSchema).parse(args);

  await router.playwright.connect();
  const page = await router.playwright.page(parsed.vault);

  // Metrics come from the same selector semantics as the capture below:
  // querySelector and locator.first() both take the first match in document order.
  let metrics: ElementMetrics | null;
  try {
    metrics = (await page.evaluate(elementMetricsSource(parsed.target))) as ElementMetrics | null;
  } catch (error) {
    throw new UobError("INVALID_ARGUMENT", `Invalid CSS selector "${parsed.target}".`, {
      remediation: "Pass a valid CSS selector, not a snapshot ref or plain text label.",
      cause: error,
      details: { target: parsed.target },
    });
  }
  if (metrics === null) {
    throw new UobError("TARGET_NOT_FOUND", `No element matches "${parsed.target}".`, {
      remediation:
        "Verify the selector with obsidian_snapshot (scope=selector) or obsidian_dom first. " +
        "Snapshot refs (eN) do not work here — pass a CSS selector.",
    });
  }

  const clip = visibleElementClip(metrics);
  if (
    clip === undefined ||
    metrics.display.display === "none" ||
    metrics.display.visibility === "hidden"
  ) {
    // Playwright would auto-wait for visibility and then time out with a generic
    // message; refusing with the measured geometry is faster and more actionable.
    throw new UobError(
      "TARGET_NOT_FOUND",
      `"${parsed.target}" matches an element, but it has no visible box ` +
        `(${metrics.rect.width}x${metrics.rect.height}, display: ${metrics.display.display}, ` +
        `visibility: ${metrics.display.visibility}).`,
      {
        remediation:
          "Open or reveal the UI that shows this element, or screenshot a visible ancestor.",
        details: { target: parsed.target, metrics: { ...metrics } },
      },
    );
  }

  // locator.screenshot auto-scrolls and waits for layout stability. A live CM6
  // editor never becomes stable because its cursor and decorations keep changing,
  // so the call waits for the full Playwright timeout. The measured viewport clip
  // captures the same visible box without moving or waiting on the element.
  const buffer = await page.screenshot({
    type: "png",
    clip,
    animations: "disabled",
    caret: "hide",
  });
  const file = await saveArtifact(
    outputDir,
    parsed.path,
    `obsidian-element-${Date.now()}.png`,
    buffer,
    "image/png",
  );

  const lines = [
    `Element screenshot of ${parsed.target}`,
    `rect: ${metrics.rect.width}x${metrics.rect.height} at (${metrics.rect.x}, ${metrics.rect.y})`,
    `devicePixelRatio: ${metrics.devicePixelRatio}, viewport: ${metrics.viewport.innerWidth}x${metrics.viewport.innerHeight}`,
    "Trust the metrics over the pixels when display scaling is in play.",
  ];

  return {
    text: lines.join("\n"),
    json: { target: parsed.target, ...metrics, clip, file },
  };
}
