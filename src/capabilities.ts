/**
 * Capabilities describe *what* a tool needs, decoupled from *which* transport
 * provides it. The router resolves each capability against the layers that are
 * actually reachable right now.
 */

export const CAPABILITIES = [
  /** Run JavaScript in the renderer. Either layer can do this. */
  "evaluate",
  /** Invoke an Obsidian CLI command by name. CLI only. */
  "cliCommand",
  /** Capture an image. Playwright captures web contents; the CLI captures the OS window. */
  "screenshot",
  /** Real mouse/keyboard input dispatch. Playwright only. */
  "realInput",
  /** ARIA snapshots with element refs. Playwright only. */
  "ariaSnapshot",
  /** Live console/error/network event subscription. Playwright only. */
  "eventStream",
  /** Raw Chrome DevTools Protocol passthrough. Both, but mutually exclusive. */
  "rawCdp",
  /** Open a vault that is not currently open. CLI only. */
  "openClosedVault",
  /** Enumerate the vault registry. Reads obsidian.json directly. */
  "listVaults",
  /** Install or uninstall a community plugin. CLI only. */
  "pluginInstall",
  /** Start or stop the Obsidian process. Local process control. */
  "launch",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** The transports that can satisfy a capability. */
export const LAYERS = ["playwright", "cli", "cliCdp", "local"] as const;
export type Layer = (typeof LAYERS)[number];

/**
 * Ordered layer preference per capability.
 *
 * `evaluate` prefers the CLI because it needs no app restart, whereas Playwright
 * requires Obsidian to have been cold-started with `--remote-debugging-port`.
 * Anything requiring real input or an event stream is Playwright-only by nature.
 */
export const CAPABILITY_PREFERENCE: Record<Capability, readonly Layer[]> = {
  evaluate: ["cli", "playwright"],
  cliCommand: ["cli"],
  screenshot: ["playwright", "cliCdp"],
  realInput: ["playwright"],
  ariaSnapshot: ["playwright"],
  eventStream: ["playwright"],
  rawCdp: ["playwright", "cliCdp"],
  openClosedVault: ["cli"],
  listVaults: ["local"],
  pluginInstall: ["cli"],
  launch: ["local"],
};

/**
 * Layers that contend for Electron's single per-WebContents debugger slot.
 *
 * Measured empirically (scripts/spike-gates.mjs, Gate B) against Obsidian 1.12.7 /
 * Electron 39.8.10: `dev:cdp` and a live `connectOverCDP` attachment **do** coexist,
 * and Playwright keeps working afterwards. The `--remote-debugging-port` transport
 * is a separate protocol handler from `webContents.debugger`, so they do not
 * contend the way a single `debugger.attach()` slot would.
 *
 * The list is therefore empty: the router tracks which layer is in use for
 * diagnostics but does not refuse to serve. Re-run the spike before assuming this
 * still holds on a new Electron major.
 */
export const EXCLUSIVE_DEBUGGER_LAYERS: readonly Layer[] = [];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}
