# DOM hooks and selectors (Obsidian desktop)

Stability tiers for CSS targeting when using `browser_*` tools with `target` selectors or when scoping snapshots.

## Stable (prefer these)

| Selector                             | Use                                |
| ------------------------------------ | ---------------------------------- |
| `.workspace-leaf`                    | Leaf panes                         |
| `.workspace-leaf-content[data-type]` | View kind (`markdown`, `empty`, …) |
| `.view-content`                      | Inner view region                  |
| `.nav-file-title[data-path]`         | Visible file row (path attribute)  |
| `.cm-content`                        | Editor surface                     |
| `.markdown-preview-view`             | Reading view                       |
| `.modal-container`                   | Modals                             |
| `.prompt-input`                      | Command palette / prompts          |
| `.suggestion-item.is-selected`       | Highlighted suggestion             |
| `.notice`                            | Toast content                      |
| `.status-bar-item`                   | Status bar controls                |
| `.setting-item`                      | Settings rows                      |
| `.tree-item-self`                    | Generic tree rows                  |
| `.menu-item`                         | Menu entries                       |

## Body-level state (cheap assertions)

- Theme: `.theme-dark` / `.theme-light`
- Focus: `.is-focused`
- Layout: `.is-mobile`, `.is-popout-window`, `.is-left-sidedock-open`
- OS chrome: `.mod-linux`, `.mod-macos`, `.mod-windows`

## Avoid for automation

- `.bases-*` — Bases plugin internals change often
- `.canvas-*` — Canvas internals
- `.cm-hmd-*` — CodeMirror markdown-mode classes

## Virtualization reminder

`.nav-file-title` only exists for **visible** rows. List paths with `app.vault` via `obsidian_eval`, not DOM walks.

## Notices

`.notice-container` is attached to `document.body`, outside `.workspace`. Include body in snapshot scope when waiting for toasts.

## `obsidian_snapshot` scopes

Obsidian's full accessibility tree is large, so prefer a scoped snapshot over `browser_snapshot`
when you already know which region you care about.

| Scope         | Selector used                                |
| ------------- | -------------------------------------------- |
| `active-leaf` | `.workspace-leaf.mod-active`                 |
| `workspace`   | `.workspace`                                 |
| `modal`       | `.modal-container, .prompt`                  |
| `settings`    | `.vertical-tab-content, .modal.mod-settings` |
| `selector`    | Your own CSS string                          |

Refs from a scoped snapshot work exactly like full-snapshot refs — pass them as `target`.
