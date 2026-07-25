---
name: obsidian-debugging
description: Debug Obsidian plugins with unified-obsidian-mcp telemetry: cursor-based obsidian_logs tailing, obsidian_log_mark brackets, console and network capture, and error attribution from stack frames. Use after reloads, UI exercises, or mysterious plugin onload failures.
---

# Obsidian debugging with telemetry

Telemetry tools need the MCP server attached to a live Obsidian window (CDP for capture hooks; some reads work with CLI-only but tailing is most useful with CDP active).

## The core primitive: cursor tailing

`obsidian_logs` returns a **cursor** (opaque position in the ring buffer). Pass it back as **`since`** on the next call to receive **only events that arrived after that point**.

This is the reliable answer to: _“What happened because of what I just did?”_

### Pattern

```text
obsidian_log_mark(label="before-reload")   # optional but readable
obsidian_plugin_reload(id="my-plugin")
# … reproduce issue …
obsidian_logs(since=<cursor from mark or prior logs call>)
```

1. Note cursor **before** the action (from `obsidian_log_mark` or a prior `obsidian_logs`).
2. Perform the action (reload, command, UI click).
3. Fetch logs with `since` set to that cursor.

Without `since`, you get the tail of the buffer — fine for orientation, poor for causality.

## Marks: `obsidian_log_mark`

Inserts a labeled divider in the telemetry stream. Returns a cursor you can pass to `obsidian_logs(since=…)`.

Use labels that match your experiment: `after-enable`, `click-settings-tab`, `dev-cycle-start`.

## What you get

Depending on filters, `obsidian_logs` includes:

- **Console** — `log`, `warn`, `error`, …
- **Errors** — uncaught exceptions with stacks
- **Network** — when capture is enabled (useful for plugin fetches)

`obsidian_telemetry_status` reports buffer size, capture state, and high-level counters — call when logs look empty suspiciously.

## Plugin attribution

Stack frames and message heuristics attribute errors to a **plugin id** when possible. After `obsidian_dev_cycle` or `obsidian_plugin_health`, prefer the structured JSON payload’s attribution fields over hand-parsing text.

When attribution is missing:

- Confirm the plugin id matches the folder under `.obsidian/plugins/`.
- Check whether the error originates in Obsidian core or another plugin.

## Clearing noise

`obsidian_logs_clear` wipes the buffer (use on dev vaults when the ring is full of old noise). Follow with a fresh mark before the next experiment.

## Combine with dev tools

| Symptom                       | Next step                                                     |
| ----------------------------- | ------------------------------------------------------------- |
| Reload threw                  | `obsidian_logs(since=…)` right after `obsidian_plugin_reload` |
| Command did nothing           | `obsidian_exercise_command` (includes before/after + logs)    |
| UI wrong but no console error | `browser_snapshot` + screenshot; check DOM hooks skill        |
| Settings not sticking         | `obsidian_plugin_settings` readback vs `obsidian_eval`        |

## CLI vs CDP for debugging

- **CLI** can run `dev:*` style introspection when enabled, but live console streaming is tied to CDP capture.
- Both transports can be active simultaneously (verified) — router picks the right layer per tool.

## Related skills

- **obsidian-plugin-dev** — `obsidian_dev_cycle` embeds marks and log diffing.
- **obsidian-instance-setup** — fix `CDP_PORT_CLOSED` before expecting telemetry.
- **obsidian-ui-automation** — reproduce UI bugs with snapshot-first steps.
