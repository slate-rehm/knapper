/**
 * Capabilities describe *what* a tool needs, decoupled from *which* transport
 * provides it. The router resolves each capability against the layers that are
 * actually reachable right now.
 */
export declare const CAPABILITIES: readonly [
  "evaluate",
  "cliCommand",
  "screenshot",
  "realInput",
  "ariaSnapshot",
  "eventStream",
  "rawCdp",
  "openClosedVault",
  "listVaults",
  "pluginInstall",
  "launch",
];
export type Capability = (typeof CAPABILITIES)[number];
/** The transports that can satisfy a capability. */
export declare const LAYERS: readonly ["playwright", "cli", "cliCdp", "local"];
export type Layer = (typeof LAYERS)[number];
/**
 * Ordered layer preference per capability.
 *
 * `evaluate` prefers the CLI because it needs no app restart, whereas Playwright
 * requires Obsidian to have been cold-started with `--remote-debugging-port`.
 * Anything requiring real input or an event stream is Playwright-only by nature.
 */
export declare const CAPABILITY_PREFERENCE: Record<Capability, readonly Layer[]>;
/**
 * Layers that contend for Electron's single per-WebContents debugger slot.
 * `debugger.attach()` fails if another client already holds it, so these cannot
 * both be live in one session.
 */
export declare const EXCLUSIVE_DEBUGGER_LAYERS: readonly Layer[];
export declare function isCapability(value: string): value is Capability;
