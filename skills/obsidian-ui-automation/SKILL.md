---
name: obsidian-ui-automation
description: Drive the live Obsidian desktop UI with unified-obsidian-mcp browser tools (Playwright over CDP). Use for clicking controls, forms, modals, and verifying layout when obsidian_command or obsidian_eval are insufficient. Teaches snapshot-first refs, target vs element, virtualization hazards, and notice placement.
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

## Related skills

- **obsidian-plugin-dev** — reload and verify after UI changes.
- **obsidian-debugging** — correlate UI steps with `obsidian_logs` cursors.
- **obsidian-instance-setup** — CDP launch and doctor fixes.
