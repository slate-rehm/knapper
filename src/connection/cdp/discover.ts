/**
 * CDP target discovery.
 *
 * Kept pure and dependency-free so it can be unit-tested against captured
 * `/json/list` fixtures without a live Obsidian.
 */

export const OBSIDIAN_MAIN_URL = "app://obsidian.md/index.html";

/** Title suffix Obsidian appends to every window: "… - Obsidian 1.12.7". */
const OBSIDIAN_TITLE_SUFFIX = /\s-\sObsidian\s\d+\.\d+\.\d+$/;

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

export type ObsidianWindowKind = "main" | "popout" | "webview" | "other";

export interface ClassifiedTarget {
  target: CdpTarget;
  kind: ObsidianWindowKind;
  /** Vault name parsed out of the window title, when derivable. */
  vaultName?: string;
  /** Active note name parsed out of the window title, when present. */
  noteName?: string;
}

/**
 * Obsidian builds its window title as:
 *   "<note> - <vault> - Obsidian <version>"  (a note is open)
 *   "<vault> - Obsidian <version>"           (no note open)
 */
export function parseObsidianTitle(title: string): { vaultName?: string; noteName?: string } {
  if (!OBSIDIAN_TITLE_SUFFIX.test(title)) return {};
  const withoutSuffix = title.replace(OBSIDIAN_TITLE_SUFFIX, "");
  const parts = withoutSuffix.split(" - ");
  if (parts.length === 0) return {};
  if (parts.length === 1) {
    const vaultName = parts[0];
    return vaultName ? { vaultName } : {};
  }
  const vaultName = parts[parts.length - 1];
  const noteName = parts.slice(0, -1).join(" - ");
  return {
    ...(vaultName ? { vaultName } : {}),
    ...(noteName ? { noteName } : {}),
  };
}

/**
 * Classify a CDP target.
 *
 * Popout windows are the trap here: Obsidian creates them with
 * `window.open("about:blank")` and then injects a `<base href>`, so their URL is
 * literally `about:blank`. Selecting by URL alone misses them, and filtering
 * `about:blank` as noise discards them.
 */
export function classifyTarget(target: CdpTarget): ClassifiedTarget {
  const titleParts = parseObsidianTitle(target.title);

  if (target.type === "webview") {
    return { target, kind: "webview", ...titleParts };
  }

  if (target.type !== "page") {
    return { target, kind: "other", ...titleParts };
  }

  if (target.url === OBSIDIAN_MAIN_URL || target.url.startsWith("app://obsidian.md/")) {
    return { target, kind: "main", ...titleParts };
  }

  // A page at about:blank carrying Obsidian's title suffix is a popout window.
  if (target.url === "about:blank" && OBSIDIAN_TITLE_SUFFIX.test(target.title)) {
    return { target, kind: "popout", ...titleParts };
  }

  return { target, kind: "other", ...titleParts };
}

export function classifyTargets(targets: CdpTarget[]): ClassifiedTarget[] {
  return targets.map(classifyTarget);
}

/** Every target belonging to Obsidian (main windows and popouts, not webviews). */
export function obsidianWindows(targets: CdpTarget[]): ClassifiedTarget[] {
  return classifyTargets(targets).filter((t) => t.kind === "main" || t.kind === "popout");
}

export interface SelectOptions {
  /** Prefer the window for this vault (matched case-insensitively). */
  vault?: string;
  /** Select this exact target id. */
  targetId?: string;
}

/**
 * Pick the best target to drive. Main windows outrank popouts; a vault match
 * outranks position. Returns undefined when nothing matches so the caller can
 * raise a precise error.
 */
export function selectTarget(
  targets: CdpTarget[],
  opts: SelectOptions = {},
): ClassifiedTarget | undefined {
  const classified = classifyTargets(targets);

  if (opts.targetId !== undefined) {
    return classified.find((t) => t.target.id === opts.targetId);
  }

  const candidates = classified.filter((t) => t.kind === "main" || t.kind === "popout");
  if (candidates.length === 0) return undefined;

  if (opts.vault !== undefined) {
    const wanted = opts.vault.toLowerCase();
    const matched = candidates.filter((t) => t.vaultName?.toLowerCase() === wanted);
    if (matched.length > 0) {
      return matched.find((t) => t.kind === "main") ?? matched[0];
    }
  }

  return candidates.find((t) => t.kind === "main") ?? candidates[0];
}

/** Fetch and parse the target list from a CDP endpoint. */
export async function fetchTargets(cdpUrl: string, timeoutMs = 3000): Promise<CdpTarget[]> {
  const base = cdpUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/json/list`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`CDP endpoint returned ${res.status} ${res.statusText}`);
  }
  const body: unknown = await res.json();
  if (!Array.isArray(body)) {
    throw new Error("CDP /json/list did not return an array");
  }
  return body as CdpTarget[];
}

export interface CdpVersion {
  Browser?: string;
  "Protocol-Version"?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

/** Probe whether a CDP endpoint is reachable at all. */
export async function probeCdp(cdpUrl: string, timeoutMs = 2000): Promise<CdpVersion | undefined> {
  const base = cdpUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as CdpVersion;
  } catch {
    return undefined;
  }
}
