---
name: obsidian-plugin-dev
description: Build, link, reload, and verify Obsidian plugins against a live desktop app using knapper. Use when developing or testing community plugins, symlinking build output, running obsidian_dev_cycle, reading attributed console errors, or exercising plugin commands and CLI handlers.
---

# Obsidian plugin development loop

This skill assumes **knapper** is connected and Obsidian is running. If anything fails with connection errors, switch to the **obsidian-instance-setup** skill first (`obsidian_doctor` → remediation → `obsidian_launch`).

## Mental model

Obsidian plugin work is a tight loop:

1. **Link** your build directory into the vault’s `.obsidian/plugins/<id>` folder.
2. **Build** TypeScript (or your bundler) on the host.
3. **Reload** the plugin in the live app.
4. **Verify** with telemetry (console/errors) and optional UI checks.

The composite tool `obsidian_dev_cycle` runs steps 3–4 in one call after you have built locally.

## One-time vault setup

For a dedicated dev vault:

1. `obsidian_setup_vault` — creates or prepares a scratch vault with community plugins enabled and restrictions off (when you need that).
2. `obsidian_link_plugin` — symlinks your plugin project into the vault.

### `obsidian_link_plugin`

- **vault** — registered vault name (must appear in Obsidian’s vault list).
- **sourceDir** — absolute path to your plugin root (contains `manifest.json`).
- **pluginId** — optional; defaults to `manifest.json` → `id`.
- **unlink** — remove the symlink only (refuses to delete a real directory).

After linking, enable the plugin once in Obsidian if it is not already enabled (`obsidian_plugin_enable`).

## The fast path: `obsidian_dev_cycle`

Call after every code change you want to validate:

```text
obsidian_dev_cycle(pluginId="my-plugin", openPath="Notes/Smoke.md", waitMs=1500)
```

What it does:

1. Inserts a telemetry mark (baseline for logs).
2. Reloads the plugin via CLI (`obsidian_plugin_reload` behavior).
3. Optionally opens a note.
4. Waits for the UI to settle.
5. Captures a screenshot and returns **console output since the mark**, with errors attributed to your plugin when stack frames allow.

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

## Clean slate testing

`obsidian_reset_state` disables the plugin, resets `data.json` to `{}`, re-enables, and returns the previous settings JSON so you can restore them. Destructive — use only on dev vaults.

## Checklist for a new plugin repo

1. `obsidian_doctor` — fix CLI/CDP/argv issues.
2. `obsidian_launch` — cold start with `--remote-debugging-port`.
3. `obsidian_setup_vault` or use an existing dev vault.
4. `obsidian_link_plugin` from your repo root.
5. `obsidian_plugin_enable` if needed.
6. Iterate: **build → `obsidian_dev_cycle`**.
7. Use `obsidian_exercise_command` for command-centric features.

## Related skills

- **obsidian-instance-setup** — transports, launch, vault registry.
- **obsidian-ui-automation** — snapshot-first UI when commands are not enough.
- **obsidian-debugging** — cursor tailing and log marks.
