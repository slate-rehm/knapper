# DOM hooks and selectors (Obsidian desktop)

Quick reference for CSS targeting with `browser_*` `target` selectors and `obsidian_snapshot`
scopes. Verified against Obsidian **1.12.7**.

This is a condensed subset. The canonical version — with per-selector verification notes,
the full `data-type` table, and body-class observations — is `docs/dom-hooks.md` in the
[knapper repo](https://github.com/bearfire-dev/knapper/blob/master/docs/dom-hooks.md). Keep the
two in agreement; do not add a selector here that is not there.

## Stable (prefer these)

| Selector                             | Use                                |
| ------------------------------------ | ---------------------------------- |
| `.workspace-leaf`                    | Leaf panes                         |
| `.workspace-leaf.mod-active`         | Currently focused pane             |
| `.workspace-leaf-content[data-type]` | View kind (`markdown`, `empty`, …) |
| `.view-content`                      | Inner view region                  |
| `.nav-file-title[data-path]`         | Visible file row (path attribute)  |
| `.cm-content`                        | Editor surface                     |
| `.markdown-preview-view`             | Reading view                       |
| `.modal-container`                   | Modals                             |
| `.prompt-input`                      | Command palette / prompts          |
| `.suggestion-item.is-selected`       | Highlighted suggestion             |
| `.notice`                            | Toast content                      |
| `.notice-container`                  | Toast host (on `document.body`)    |
| `.status-bar-item`                   | Status bar controls                |
| `.setting-item`                      | Settings rows                      |
| `.tree-item-self`                    | Generic tree rows                  |
| `.menu-item`                         | Menu entries                       |

Common `data-type` values: `markdown`, `file-explorer`, `search`, `graph`, `outline`,
`canvas`, `bases`. Prefer `[data-type="markdown"]` plus `.mod-active` to hit the editor leaf.

## Body-level state (cheap assertions)

- Theme: `.theme-dark` / `.theme-light`
- Focus: `.is-focused`
- Layout: `.is-mobile`, `.is-popout-window`, `.is-left-sidedock-open`
- OS chrome: `.mod-linux`, `.mod-macos`, `.mod-windows`

## Avoid for automation

- `.bases-*` — Bases plugin internals change often
- `.canvas-*` — Canvas internals
- `.cm-hmd-*` — CodeMirror markdown-mode classes
- Deep graph/canvas SVG internals — use `browser_mouse_*` or app APIs instead

## Virtualization reminder

`.nav-file-title` only exists for **visible** rows. List paths with `app.vault.getFiles()` via
`obsidian_eval`, not DOM walks. Use the explorer DOM only to click rows already on screen.

## Notices

`.notice-container` is attached to `document.body`, outside `.workspace`. Query at document
level when waiting for toasts.

## `obsidian_snapshot` scopes

Obsidian's full accessibility tree is large, so prefer a scoped snapshot over
`browser_snapshot` when you already know which region you care about.

| Scope         | Selector used                                |
| ------------- | -------------------------------------------- |
| `active-leaf` | `.workspace-leaf.mod-active`                 |
| `workspace`   | `.workspace`                                 |
| `modal`       | `.modal-container, .prompt`                  |
| `settings`    | `.vertical-tab-content, .modal.mod-settings` |
| `selector`    | Your own CSS string                          |

Refs from a scoped snapshot work exactly like full-snapshot refs — pass them as `target`.
