# Obsidian DOM hooks

Stable CSS selectors for `browser_*` tools when snapshot refs are unavailable or you need to scope `obsidian_snapshot`. Verified against Obsidian **1.12.7** on the `uob-test-vault` scratch vault (2026-07-25).

**Tier legend**

| Tier         | Meaning                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| **Stable**   | Core layout classes; themes and plugins rely on them — unlikely to break.        |
| **State**    | Present on `body` only while a condition holds (modal open, dock visible, etc.). |
| **Volatile** | Avoid for automation (called out below).                                         |

## Stable layout

| Selector                             | Role                                                             | Verified                                                |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------- |
| `.workspace-leaf`                    | One pane in the workspace split                                  | Yes (9 nodes)                                           |
| `.workspace-leaf.mod-active`         | Currently focused pane                                           | Yes (1 node)                                            |
| `.workspace-leaf-content[data-type]` | Pane kind; see `data-type` values below                          | Yes                                                     |
| `.view-content`                      | Scrollable content area inside a leaf                            | Yes                                                     |
| `.nav-file-title[data-path]`         | Visible file row in the explorer (`data-path` is vault-relative) | Yes (only **visible** rows exist — tree is virtualized) |
| `.cm-content`                        | CodeMirror 6 typing surface in source mode                       | Yes                                                     |
| `.markdown-preview-view`             | Reading view container                                           | Yes                                                     |
| `.modal-container`                   | Modal shell (settings, dialogs)                                  | When a modal is open                                    |
| `.prompt-input`                      | Command palette filter input                                     | When palette is open                                    |
| `.suggestion-item.is-selected`       | Highlighted palette suggestion                                   | When palette is open                                    |
| `.notice`                            | Toast notice text                                                | When a notice is showing                                |
| `.notice-container`                  | Notice host on `document.body` (outside `.workspace`)            | When a notice is showing                                |
| `.status-bar-item`                   | Status bar entries                                               | Yes                                                     |
| `.setting-item`                      | Row in settings tabs                                             | When settings is open                                   |
| `.tree-item-self`                    | Generic tree row chrome (explorer, outline)                      | Yes                                                     |
| `.menu-item`                         | Context / menu entries                                           | When a menu is open                                     |

### `data-type` on `.workspace-leaf-content`

Observed on a typical layout:

| `data-type`     | Pane                                                     |
| --------------- | -------------------------------------------------------- |
| `markdown`      | Note editor (`data-mode="source"` or `preview` when set) |
| `file-explorer` | File tree                                                |
| `search`        | Search view                                              |
| `graph`         | Graph view                                               |
| `outline`       | Outline                                                  |
| `canvas`        | Canvas                                                   |
| `bases`         | Bases (new core plugin)                                  |
| `undefined`     | Empty / chrome-only leaves (common on New tab)           |

Prefer `[data-type="markdown"]` plus `.mod-active` to target the editor leaf.

## Body state classes

Use for cheap assertions with `obsidian_snapshot` or a narrowly scoped `obsidian_eval` probe.

| Class                                        | Meaning                    | Verified on Linux test session                                                                                              |
| -------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `.theme-dark` / `.theme-light`               | Color scheme               | `theme-dark` yes                                                                                                            |
| `.mod-linux` / `.mod-macos` / `.mod-windows` | Platform                   | `mod-linux` yes                                                                                                             |
| `.is-focused`                                | App has focus              | Absent while unfocused, but present _during_ knapper input, which emulates page focus per dispatch (`src/browser/focus.ts`) |
| `.is-mobile`                                 | Mobile layout              | No (desktop)                                                                                                                |
| `.is-popout-window`                          | Detached window            | No on main window                                                                                                           |
| `.is-left-sidedock-open`                     | Left ribbon / dock visible | Not on body in probe (layout uses other classes)                                                                            |

Additional stable `body` classes seen in the wild: `obsidian-app`, `is-frameless`, `show-ribbon`, `show-view-header`, `styled-scrollbars`.

## Volatile (do not depend on)

- `.bases-*` and `.canvas-*` internal nodes — active development.
- `.cm-hmd-*` and other CodeMirror syntax decoration classes — churn with editor updates.
- Deep graph/canvas SVG internals — use vision (`browser_mouse_*`) or app APIs instead.

## Virtualized file tree

Off-screen files **do not** have `.nav-file-title` nodes. To enumerate paths, use `obsidian_search`, vault tools, or `obsidian_eval` with `app.vault.getFiles()`. Use the explorer DOM only to click **visible** rows (after scrolling or filtering).

## Notices

`new Notice(...)` renders under `.notice-container` on `document.body`, not inside `.workspace`. Query at document level, e.g. `.notice` or `.notice-container .notice`.

## `obsidian_snapshot` scopes

| Scope         | Selector used                                |
| ------------- | -------------------------------------------- |
| `active-leaf` | `.workspace-leaf.mod-active`                 |
| `workspace`   | `.workspace`                                 |
| `modal`       | `.modal-container, .prompt`                  |
| `settings`    | `.vertical-tab-content, .modal.mod-settings` |
| `selector`    | Your CSS string                              |

Refs in scoped snapshots use the same `target` parameter as full `browser_snapshot` (e.g. `e64`).
