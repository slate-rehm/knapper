# Verified environment facts

Measured against a live instance rather than assumed. Re-run
`node scripts/spike-gates.mjs` (with Obsidian launched on `--remote-debugging-port=9222`)
before trusting any of this on a new Obsidian or Electron major version.

| Component         | Version                                              |
| ----------------- | ---------------------------------------------------- |
| Obsidian          | 1.12.7                                               |
| Electron          | 39.8.10                                              |
| Chromium          | 142.0.7444.265                                       |
| `playwright-core` | 1.62.0-alpha (resolved via `@playwright/mcp@0.0.78`) |

## Gate A — real input over `connectOverCDP` is reliable

Playwright issue #41286 reports `mouseup` arriving before `mousedown` against a headed
browser, silently dropping clicks. **It does not reproduce here.**

- `locator.click()` (real CDP mouse events): 20/20 clicks delivered, every sequence
  correctly ordered `mousedown → mouseup → click`, zero drops.
- `locator.evaluate(el => el.click())`: 20/20 delivered, but only synthesizes a bare
  `click` event — no `mousedown`/`mouseup`. Obsidian handlers that listen for pointer
  events (drag handles, resize gutters) will not react to it.
- Keyboard via `pressSequentially`: exact round-trip.

**Consequence:** real mouse input is the default click strategy. The plan's contingency
of preferring DOM clicks is not needed, and would actively lose fidelity since it skips
the pointer event pair. Assertions on resulting state are still worthwhile, but as
ordinary good practice rather than as a workaround.

## Gate B — the two CDP transports coexist

Electron permits one `webContents.debugger` client, which suggested Obsidian's CLI
`dev:cdp` and a live Playwright attachment would conflict. **They do not.**

With Playwright attached, all three of the following worked in sequence:

1. `obsidian dev:cdp method=Runtime.evaluate params={"expression":"1+1"}` → returned `2`.
2. `obsidian eval code=app.vault.getName()` → returned the vault name.
3. Playwright `page.evaluate` afterwards → still live.

`--remote-debugging-port` is served by a different protocol handler than
`webContents.debugger`, so the single-client rule does not apply across them.

**Consequence:** the router tracks which layer is in use for diagnostics but never
refuses a call on exclusivity grounds. `EXCLUSIVE_DEBUGGER_LAYERS` is empty, and the
`DEBUGGER_CONFLICT` error path is retained only for a future regression.

## Gate C — input reaches an unfocused window

Measured on Obsidian 1.12.7 / Electron 39.8.10 / Chromium 142, Arch Linux with
Hyprland (Wayland), with Obsidian visible but **not** the foreground window, via
`npm run bg-input`.

- `Emulation.setFocusEmulationEnabled` is enabled per input dispatch over a CDP
  session bound to the target page, and disabled again in a `finally`.
- `Control+p` opened the command palette with the terminal focused:
  `obsidian_exercise_hotkey` reported `verdict: "fired"` and
  `.modal.mod-command-palette` was present afterwards.
- `browser_press_sequentially` typed `graph` into the palette input and the value
  round-tripped.
- `document.hasFocus()` was `false` before the dispatch, `true` while a
  `browser_keydown` hold was outstanding, and `false` again after release — so the
  emulation is demonstrably doing the work and is demonstrably reverted.
- A session closed with an unpaired `browser_keydown` left `document.hasFocus()`
  false: `FocusEmulator.dispose()` force-releases holds on shutdown.

`Page.bringToFront` is deliberately not used. It would raise and activate the user's
window, which is the one thing a tool driving a daily-driver app must not do.

**Not reachable by this path:** Electron menu accelerators (the app-level `Cmd+Q` /
`Cmd+W` class) never enter the renderer, so no CDP input triggers them, foreground or
not. Renderer-level bindings — which is every Obsidian command hotkey — do work.

## `page.accessibility.snapshot` is gone

Confirmed absent at runtime (`typeof page.accessibility?.snapshot === "undefined"`).
The snapshot engine is `page.ariaSnapshot()` / `locator.ariaSnapshot()`, and
`{ mode: "ai" }` yields ref-annotated output where only interactable nodes consume a
`ref`, e.g. `- generic "New note" [ref=e5]`. Scoping to a locator works, which is what
`obsidian_snapshot` uses to keep Obsidian's large tree manageable.

## Exactly one BrowserContext

Confirmed: `browser.contexts().length === 1`. Every window, popout, and webview lands in
`contexts()[0].pages()`. Playwright has declared multi-context over CDP out of scope, so
window disambiguation must go through `page.evaluate(() => app.vault.getName())` rather
than through contexts.

## CLI surface

`__completions` returns 102 commands on this install (70 built-ins plus those contributed
by the enabled core plugins), each with `{usage, description, flags}`. Captured to
`tests/fixtures/completions.json`. The count is install-dependent — it reflects which core
plugins are enabled and any `registerCliHandler` calls from plugins, which is precisely why
the tool layer introspects rather than hardcoding a table.

`commands` returns 61 command-palette ids on this install.

Notably there **is** a real content-search command:
`search query=<text> [path=<folder>] [limit=<n>] [total] [case] [format=text|json]`,
so `obsidian_search` does not need the fork's path-substring stub.

## Local environment repairs applied

- `~/.config/obsidian/user-flags.conf` contained `-disable-gpu` with a single dash.
  Obsidian's argv filter strips only `--`-prefixed tokens, so it survived into `argv[0]`
  and every CLI call failed with `Command "-disable-gpu" not found.` Corrected to
  `--disable-gpu`.
- The global `cli` flag was absent (CLI disabled). Set to `true` in `obsidian.json` while
  the app was quit.
- Created a dedicated scratch vault at `~/Documents/obsidian/uob-test-vault` and
  registered it, so tests never touch a real vault.
