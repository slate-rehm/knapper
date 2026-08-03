---
name: obsidian-ui-automation
description: Drive the live Obsidian desktop UI with knapper browser tools (Playwright over CDP). Use for clicking controls, forms, modals, and verifying layout when obsidian_command or obsidian_eval are insufficient. Teaches snapshot-first refs, target vs element, virtualization hazards, and notice placement.
---

# Obsidian UI automation (snapshot-first)

UI tools require **CDP**: Obsidian must have been **cold-started** with `--remote-debugging-port` (see **obsidian-instance-setup**). CLI-only sessions cannot click or snapshot.

## Tool split

| Need                           | Use                                                         |
| ------------------------------ | ----------------------------------------------------------- |
| Command palette actions        | `obsidian_command` or `obsidian_exercise_command`           |
| Vault files, plugin state      | `obsidian_eval` (`app.vault`, `app.plugins`, …)             |
| Clicks, typing, ARIA tree      | `browser_*` tools (proxied from `@playwright/mcp`)          |
| Smaller Obsidian-specific tree | Prefer **`obsidian_snapshot`** (scope: leaf/modal/settings) |

**Default rule:** prefer `obsidian_command` over clicking through menus — fewer flaky steps and stable ids.

## Ref workflow (critical)

1. Call **`browser_snapshot`** (optionally scoped) to get an accessibility tree with `[ref=eN]` on interactable nodes.
2. Pass that ref to click/type tools as **`target`** — not `ref`. Older docs that say `ref` are outdated.
3. **`target`** also accepts a **raw CSS selector** when refs are missing or stale.
4. **`element`** is optional human-readable text for the client’s approval UI and error messages — it does **not** select anything.

Example flow:

```text
browser_snapshot()
browser_click(target="e5", element="New note")
```

If you get `STALE_REF`, take a fresh snapshot and pick a new ref.

## Real input vs DOM click

Verified on Obsidian 1.12.x: Playwright **locator clicks** deliver real `mousedown → mouseup → click` over CDP. Use normal `browser_click` / `browser_type` / `browser_press_key`.

Avoid relying on bare `element.click()` from evaluate for drag handles or gutters — it skips pointer events.

## Hazard: virtualized file tree

The sidebar file tree is **virtualized**. Off-screen `.nav-file-title` nodes **do not exist** in the DOM.

**Do not** scrape the tree with CSS to list files.

**Do** enumerate via the app API:

```javascript
// obsidian_eval
app.vault.getMarkdownFiles().map((f) => f.path);
```

To open a file: `obsidian_open`, CLI `open`, or a command — not “scroll until the row exists” unless you are explicitly testing scrolling.

## Hazard: notices live outside `.workspace`

Toasts render in a **per-window** `.notice-container` on `document.body`, not inside `.workspace`.

After actions that should show a notice:

- Snapshot at body level, or
- Query `.notice` / `.notice-container`, or
- Use `obsidian_eval` to read plugin notice APIs if you control the plugin.

## Stable selectors

For assertions and scoped snapshots, prefer the **stable tier** documented in [references/dom-hooks.md](references/dom-hooks.md).

Avoid `.bases-*`, `.canvas-*` internals, and `.cm-hmd-*` (CodeMirror markdown mode classes drift).

## Window selection

Obsidian exposes **one** Playwright browser context; every window is a **page**. With multiple vaults or popouts:

1. `obsidian_list_targets` — classify main vs popout vs webview.
2. `obsidian_attach` with `targetId` to pin subsequent browser calls.
3. Disambiguate vault with `obsidian_eval` → `app.vault.getName()` on that page.

Popouts often report `about:blank` as URL — use title + eval, not URL alone.

## Screenshots

Two different captures — do not conflate them:

| Tool                      | What it captures                                                     |
| ------------------------- | -------------------------------------------------------------------- |
| `browser_take_screenshot` | Playwright **web contents** (page pixels)                            |
| `obsidian_screenshot`     | Electron **`capturePage()`** of the **OS window** (devtools toolset) |

Use `browser_take_screenshot` for UI proof during automation. Dev-cycle composites may also return images from `obsidian_dev_cycle`.

Blocked browser tools (would harm a daily-driver window): navigate, close, resize, file upload, storage state, etc. — the server filters these.

## Editor testing

The editor toolset reads and edits the active editor through `app.workspace.activeEditor`. Use it instead of raw `obsidian_eval` for cursor, selection, and text work.

1. `obsidian_editor_state` — reports the file, the mode (`source`, `live-preview`, `reading`, `none`), the cursor, the selections, and a `docHash` over the full document. It also returns a window of numbered lines around the cursor. It never errors on a reading view or an empty workspace.
2. `obsidian_editor_set` — moves the cursor or sets selections. Pass `scrollIntoView=true` to center the view.
3. `obsidian_editor_replace` — edits text. It requires `expectedDocHash` from a fresh `obsidian_editor_state` call. A `STALE_REF` refusal means the document changed under you. The user or another agent edits the same live editor, so take a new state and retry.
4. `obsidian_editor_widgets` — lists rendered widgets and decorations inside the editor DOM. Pass a `selector` such as `[data-my-plugin]` to find your plugin's decorations. Each match reports a short `cssPath`, its rect, a document position when the CM6 view is reachable, and a text preview.

Two related capture tools:

- `obsidian_snapshot scope=editor` — scopes the ARIA snapshot to the active editor. It falls back to the reading view when no editor exists.
- `obsidian_element_screenshot target=<selector>` — captures one element as a PNG and pairs it with a metrics block (rect, `devicePixelRatio`, viewport, computed display). Trust the metrics over the pixels when display scaling is in play. It takes a CSS selector only — snapshot refs do not resolve here.

## Related skills

- **obsidian-plugin-dev** — reload and verify after UI changes.
- **obsidian-debugging** — correlate UI steps with `obsidian_logs` cursors.
- **obsidian-instance-setup** — CDP launch and doctor fixes.

## Background input and hotkeys

knapper emulates page focus around every input dispatch, so clicks and keystrokes
land in Obsidian **even when it is not the foreground window**. You do not need to
raise or focus the app first, and knapper deliberately never does — it will not steal
the user's window.

Page focus is not element focus. Emulation makes the document believe it is focused;
it does not choose an `activeElement`. A chord bound to the editor still needs the
editor focused, which is what the `focus` argument is for.

Testing a hotkey binding:

```text
obsidian_hotkeys                                  # discover bindings
obsidian_hotkeys commandId=editor:toggle-bold     # look one up
obsidian_exercise_hotkey keys=Control+p           # press it, and report if it fired
obsidian_exercise_hotkey keys=Control+b focus=.cm-content
```

`obsidian_exercise_hotkey` reports a **verdict**, not just success: it samples the
workspace before and after and tells you whether anything moved. `browser_press_key`
only tells you the keys were delivered, which they almost always are — that is the
difference worth caring about when a binding is broken.

A `no-change` verdict is not proof of failure: a command that toggles a setting or
writes a file changes nothing the workspace sample sees. Check the logs it returns.

**Cannot be triggered this way:** Electron menu accelerators (the app-level `Cmd+Q` /
`Cmd+W` class) never reach the renderer, so no CDP input fires them. Every ordinary
Obsidian command binding does work.

**Prefer `obsidian_command`** to _do_ something. Reach for the hotkey tools when the
binding itself is what you are testing.

## Vault access

Every tool here is fenced to vaults the user has authorized. A `VAULT_NOT_AUTHORIZED`
refusal is not a bug and not something you can work around — no tool grants access.
Report the situation and stop; only mention the `knapper authorize` command if the
user has asked to work in that specific vault. Use `obsidian_create_vault` for
throwaway work, which authorizes what it creates.
