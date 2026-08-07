---
name: obsidian-plugin-dev
description: Build, link, reload, and verify Obsidian plugins against a live desktop app using knapper. Use when developing or testing community plugins, symlinking build output, running obsidian_dev_cycle, reading attributed console errors, or exercising plugin commands and CLI handlers.
---

# Obsidian plugin development loop

Enable `core`, `workspace`, `telemetry`, and `plugin-dev` with
`obsidian_toolsets_update`. To preview the update, first call it with `dryRun: true`.
Then, repeat the call without `dryRun`. The workspace setup below returns a
`workspaceHandle`. Pass this handle to each operational tool.

For plugin work, create an isolated workspace with `pluginSourceDir` and
`pluginId`. If `visualIdentity.state` is `degraded`, read `visualIdentity.warnings`
array. This warning does not disable the private-session routing.

## Mental model

Obsidian plugin work is a tight loop:

1. **Link** your build directory into the vault’s `.obsidian/plugins/<id>` folder.
2. **Build** TypeScript (or your bundler) on the host.
3. **Reload** the plugin in the live app.
4. **Verify** with telemetry (console/errors) and optional UI checks.

The composite tool `obsidian_dev_cycle` runs steps 3–4 in one call after you have built locally.

## One-time workspace setup

For a dedicated development workspace:

1. Call `obsidian_agent_open`.
2. Call `obsidian_workspace_create` with the loadable plugin directory and ID.
3. Check `obsidian_plugin_health` before you modify plugin state.

### `obsidian_link_plugin`

- **vault** — registered vault name (must appear in Obsidian’s vault list).
- **sourceDir** — absolute path to a loadable directory with `manifest.json` and `main.js`.
- **pluginId** — optional; defaults to `manifest.json` → `id`.
- **unlink** — remove the symlink only (refuses to delete a real directory).

After linking, enable the plugin once in Obsidian if it is not already enabled (`obsidian_plugin_enable`).

## The fast path: `obsidian_dev_cycle`

Call after every code change you want to validate:

```text
obsidian_dev_cycle(workspaceHandle=<workspaceHandle>, pluginId="my-plugin", openPath="Notes/Smoke.md", waitMs=1500)
```

What it does:

1. Inserts a telemetry mark (baseline for logs).
2. Reloads the plugin via CLI (`obsidian_plugin_reload` behavior).
3. Optionally opens a note.
4. Waits for the UI to settle.
5. Optionally saves a screenshot under the configured output root.
6. Returns console output since the mark and attributes applicable errors to the plugin.

Screenshot results contain `path`, `mimeType`, `size`, and `inline: false`. They do
not contain inline base64 data.

**Side effects:** reload wipes in-memory plugin state; treat this as intentional during dev.

## Manual loop (when you need finer control)

| Step             | Tool                       | Notes                                    |
| ---------------- | -------------------------- | ---------------------------------------- |
| Build on disk    | (your `npm run build`)     | MCP does not compile for you             |
| Reload           | `obsidian_plugin_reload`   | `id` = plugin folder name                |
| Inspect metadata | `obsidian_plugin_manifest` | Live manifest + enabled state            |
| Settings         | `obsidian_plugin_settings` | Read/write `data.json` in memory         |
| List plugins     | `obsidian_plugin_list`     | `filter=community` during dev            |
| Health check     | `obsidian_plugin_health`   | Enabled, loaded, commands, recent errors |

## Reading failures: `obsidian_logs`

After reload or exercising UI:

1. Call `obsidian_logs` — note the returned **cursor**.
2. Reproduce the bug.
3. Call `obsidian_logs` again with `since=<cursor>` to fetch only new events.

See **obsidian-debugging** for marks, attribution, and network events.

## Exercising commands

Prefer commands over menu automation:

1. `obsidian_plugin_commands` or `obsidian_commands` with a filter — discover ids.
2. `obsidian_exercise_command` — runs a palette command by id, waits, returns workspace delta + new logs.
3. Or `obsidian_command` for a simple CLI-fired execution.

## Plugin CLI handlers (`registerCliHandler`)

Plugins can expose Obsidian CLI commands via `Plugin.prototype.registerCliHandler`:

- Descriptions are **auto-prefixed** with the plugin name in completions.
- **Duplicate command ids throw** at registration time.
- The server **does not hardcode** plugin CLI tables — `obsidian_commands` introspects live `__completions`, so new handlers show up automatically after reload.

To test a handler: find its name in `obsidian_commands`, then run it with `obsidian_cli` (raw CLI) or the documented flags for that command.

## Probe globals and editor checks

Expose a probe function from your plugin during development. Return plain data, not class instances:

```javascript
// in the plugin's onload
window.myPluginProbe = async () => ({ settings: this.settings, widgetCount: this.widgets.length });
```

Run it through `obsidian_eval`:

```text
obsidian_eval workspaceHandle=<workspaceHandle> code=JSON.stringify(await window.myPluginProbe())
```

Keep the call on one line. The Playwright transport awaits the promise for you. Also mirror the result to the console as an overflow channel — a large payload then stays readable through `obsidian_logs`:

```text
obsidian_eval workspaceHandle=<workspaceHandle> code=(async () => { const r = await window.myPluginProbe(); console.log("probe:", JSON.stringify(r)); return JSON.stringify(r); })()
```

For editor-rendering plugins, pair the probe with the editor toolset:

- `obsidian_editor_state` — file, mode, cursor, and a `docHash` of the document.
- `obsidian_editor_widgets selector=[data-my-plugin]` — verify your decorations actually rendered, with rects and document positions.
- `obsidian_editor_replace` — drive hash-guarded text edits to trigger your extension, then re-run the probe.

## Clean slate testing

`obsidian_reset_state` disables the plugin, resets `data.json` to `{}`, re-enables, and returns the previous settings JSON so you can restore them. Destructive — use only on dev vaults.

Do not call `obsidian_create_vault` for an isolated workspace. The tool refuses a
session-bound request. Use the scratch vault from `obsidian_workspace_create`.

## Checklist for a new plugin repo

1. `obsidian_agent_open` — create the attribution handle.
2. `obsidian_workspace_create` — create scratch space and link the loadable build.
3. `obsidian_plugin_health` — confirm present, enabled, and loaded state.
4. `obsidian_plugin_enable` if needed.
5. Iterate: **build → `obsidian_dev_cycle`**.
6. Use `obsidian_exercise_command` for command-centric features.
7. Call `obsidian_workspace_stop` after testing.
8. Call `obsidian_workspace_destroy` to move the scratch root to recoverable trash.
9. Close the agent handle.

## Related skills

- **obsidian-instance-setup** — transports, launch, vault registry.
- **obsidian-ui-automation** — snapshot-first UI when commands are not enough.
- **obsidian-debugging** — cursor tailing and log marks.
