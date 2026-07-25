/**
 * CDP target discovery.
 *
 * Kept pure and dependency-free so it can be unit-tested against captured
 * `/json/list` fixtures without a live Obsidian.
 */
export declare const OBSIDIAN_MAIN_URL = "app://obsidian.md/index.html";
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
export declare function parseObsidianTitle(title: string): {
  vaultName?: string;
  noteName?: string;
};
/**
 * Classify a CDP target.
 *
 * Popout windows are the trap here: Obsidian creates them with
 * `window.open("about:blank")` and then injects a `<base href>`, so their URL is
 * literally `about:blank`. Selecting by URL alone misses them, and filtering
 * `about:blank` as noise discards them.
 */
export declare function classifyTarget(target: CdpTarget): ClassifiedTarget;
export declare function classifyTargets(targets: CdpTarget[]): ClassifiedTarget[];
/** Every target belonging to Obsidian (main windows and popouts, not webviews). */
export declare function obsidianWindows(targets: CdpTarget[]): ClassifiedTarget[];
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
export declare function selectTarget(
  targets: CdpTarget[],
  opts?: SelectOptions,
): ClassifiedTarget | undefined;
/** Fetch and parse the target list from a CDP endpoint. */
export declare function fetchTargets(cdpUrl: string, timeoutMs?: number): Promise<CdpTarget[]>;
export interface CdpVersion {
  Browser?: string;
  "Protocol-Version"?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}
/** Probe whether a CDP endpoint is reachable at all. */
export declare function probeCdp(
  cdpUrl: string,
  timeoutMs?: number,
): Promise<CdpVersion | undefined>;
