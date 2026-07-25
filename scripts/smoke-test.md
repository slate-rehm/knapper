# Manual smoke test

The automated suites cover most of this — run them first:

| Command                              | Covers                                                           | Needs live Obsidian |
| ------------------------------------ | ---------------------------------------------------------------- | ------------------- |
| `vp exec vitest run`                 | Discovery, routing, config, errors, schema conversion, telemetry | no                  |
| `node scripts/acceptance.mjs`        | 23 end-to-end checks over real MCP stdio                         | yes                 |
| `node scripts/spike-gates.mjs`       | Input reliability and transport coexistence                      | yes                 |
| `node scripts/spike-multiwindow.mjs` | Popout classification, single-context assumption                 | yes                 |

This document is the manual pass for the things a script should not do on its own:
cold-start behavior, first-run provisioning, and anything that rearranges the user's
windows.

Use the scratch vault (`uob-test-vault`) throughout. Never point a smoke test at a
real vault — several steps toggle restricted mode and rewrite plugin `data.json`.

## 0. Deliberately broken starting state

The point of this pass is that the server _diagnoses and repairs_ a broken install,
so start by breaking one. With Obsidian fully quit:

1. Put a single-dash token in the launch flags: add `-disable-gpu` to
   `~/.config/obsidian/user-flags.conf` (Linux).
2. Remove the `"cli": true` key from `~/.config/obsidian/obsidian.json`.
3. Confirm the damage: `obsidian vault` should fail with
   `Command "-disable-gpu" not found.`

## 1. Diagnose before repairing

Start Obsidian normally (no debug flag) and run `obsidian_doctor`.

Expected: three distinct problems, each with its own remediation — argv corruption,
CLI disabled, and CDP port closed. A single generic "cannot connect" is a
**failure**; distinguishing these is the whole point of the four-state probe.

## 2. Repair the argv corruption

Fix `user-flags.conf` to use `--disable-gpu`, then re-run `obsidian_doctor`.

Expected: the argv problem clears and the other two remain.

## 3. Enable the CLI

Run `obsidian_setup_cli`.

- With Obsidian running and a debug port attached, it should use the renderer
  `ipcRenderer` bootstrap.
- With Obsidian quit, it should edit `obsidian.json` directly.
- With Obsidian running but **no** debug port, it should refuse to edit the file and
  explain why — a live instance holds the config in memory and overwrites the file on
  exit, so the edit would be silently lost.

Verify `obsidian vault` now returns real output.

## 4. Cold-start with the debug port

Run `obsidian_launch`.

Expected: it detects the already-running instance and either fully quits it first or
refuses with a clear explanation. It must **not** silently spawn a second process
that becomes a CLI client while the debug flag is dropped — that is the single most
common cause of "CDP attach times out."

After it completes, `obsidian_doctor` should be clean and `obsidian_status` should
report both transports live.

## 5. Confirm the user's Obsidian was left alone

This matters because we attach to a daily-driver application.

- Theme unchanged (`noDefaults` should prevent Playwright's emulated media from
  flipping light/dark).
- The window does not behave as permanently focused.
- No windows were opened, closed, or resized that you did not ask for.

## 6. Link and exercise a scratch plugin

1. `obsidian_link_plugin` pointing at a plugin build directory.
2. `obsidian_setup_vault` to turn off restricted mode and enable it.
3. `obsidian_plugin_list` — the plugin appears and is enabled.
4. `obsidian_dev_cycle { pluginId }` — reloads and reports cleanly.
5. Trigger a deliberate error, then `obsidian_logs` — the error is captured and
   **attributed to the right plugin id**.
6. `obsidian_logs { since: <cursor> }` — returns only what is new, not a replay.

## 7. Real input

1. `browser_snapshot`, then `browser_click` a ref from it. Confirm the UI actually
   responded rather than the call merely succeeding.
2. Open the command palette with a real keypress and run a command by typing.
3. `obsidian_command` for the same action — prefer this in real workflows; the
   keyboard path is being tested here, not recommended.

## 8. Popout window

Tear a note out into its own window, then `obsidian_list_targets`.

Expected: the popout is listed as `popout` even though its URL is `about:blank`.
`obsidian_attach` to it, run `obsidian_eval` there, and confirm it targets that
window. Then clear the pin.

## 9. Two vaults open

Open a second vault so two main windows exist.

Expected: both share the identical URL `app://obsidian.md/index.html`, so
`obsidian_status` must distinguish them by vault name. `--vault` (or the `vault`
argument) must route to the right one. Getting the wrong window here is a silent,
destructive class of bug — writes land in the wrong vault.

## 10. Degraded modes

- **CDP down, CLI up:** quit and restart Obsidian without the debug flag. Obsidian
  tools keep working; `browser_*` calls fail with an actionable message pointing at
  `obsidian_launch`. Registration must not hang or throw.
- **CLI down, CDP up:** turn the `cli` setting off. `obsidian_eval` should fall back
  to Playwright rather than failing.
- **Obsidian not running:** every tool explains that and points at `obsidian_launch`.

## 11. Toolset gating

`--toolsets core` should register only the core tools; `--toolsets all` should
register everything (~107). An unknown name should warn on stderr and fall back to
the defaults rather than failing to start.

## 12. Shutdown

Close the client. The server process must exit — the attached CDP websocket keeps
the event loop alive, so a lingering process per session is a leak. Verify with
`pgrep -af 'knapper|dist/cli.js'`.

## Known caveat

Obsidian checks for updates on startup and hourly. A downloaded
`obsidian-<version>.asar` in userData takes precedence over the distro package, so
DOM and API assumptions can drift out from under the installed version. If selectors
start failing inexplicably, check the running version against
`docs/verified-environment.md` and re-run `scripts/spike-gates.mjs`.
