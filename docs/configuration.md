# Configuration

Every setting for **knapper**. Precedence is CLI flag → environment
variable → default, resolved in one place (`src/config.ts`); tools never read the
environment directly.

Cursor plugin `variables` and Claude Code `userConfig` do not unify across hosts —
set these in each client's MCP server `env` block, or in your shell profile.

## Connection

| Variable                | Flag             | Default                 | Description                                                          |
| ----------------------- | ---------------- | ----------------------- | -------------------------------------------------------------------- |
| `OBSIDIAN_CDP_URL`      | `--cdp-url`      | `http://127.0.0.1:9222` | CDP endpoint Playwright attaches to                                  |
| `OBSIDIAN_BIN`          | `--obsidian-bin` | Platform default        | Path to the Obsidian executable                                      |
| `OBSIDIAN_VAULT`        | `--vault`, `-v`  | (active vault)          | Pins CLI-scoped tools to one vault                                   |
| `OBSIDIAN_TARGET_MATCH` | `--target-match` | (unset)                 | Case-insensitive substring; only attach to matching window title/URL |
| `KNAP_CLI_TIMEOUT_MS`   | —                | `15000`                 | Timeout per Obsidian CLI invocation                                  |
| `KNAP_RECONNECT_MS`     | —                | `2000`                  | Base backoff between CDP reconnect attempts                          |

`OBSIDIAN_TARGET_MATCH` matters when several Obsidian windows are open and you want
automation pinned to one — for example a scratch vault while your real vault stays
untouched.

## Tools and output

| Variable                | Flag           | Default                        | Description                                          |
| ----------------------- | -------------- | ------------------------------ | ---------------------------------------------------- |
| `KNAP_TOOLSETS`         | `--toolsets`   | `core,ui,telemetry,plugin-dev` | Comma-separated toolsets, or `all`                   |
| `KNAP_SCREENSHOT_DIR`   | `--output-dir` | `./.knapper`                   | Screenshots and snapshot artifacts, relative to cwd  |
| `KNAP_TELEMETRY_BUFFER` | —              | `2000`                         | Max retained telemetry events (ring buffer)          |
| `KNAP_MAX_CONCURRENCY`  | —              | `4`                            | Concurrent read-only tool calls; mutations serialize |
| `KNAP_LOG_LEVEL`        | `--log-level`  | `info`                         | `debug`, `info`, `warn`, `error`, `silent` — stderr  |

`KNAP_MAX_CONCURRENCY` only raises the ceiling for tools marked `readOnlyHint`.
Anything that mutates takes an exclusive lock regardless, so real input and UI
mutations never interleave.

## Transport

| Variable        | Flag          | Default     | Description                 |
| --------------- | ------------- | ----------- | --------------------------- |
| `MCP_TRANSPORT` | `--transport` | `stdio`     | `stdio` or `http`           |
| `MCP_PORT`      | `--port`      | `9223`      | Listen port for `http`      |
| `MCP_HOST`      | `--host`      | `127.0.0.1` | Listen interface for `http` |

`stdio` is what MCP clients use and needs no configuration. Use `http` only for
remote or multi-client setups. It binds to loopback unless you override `MCP_HOST`,
which exposes control of your live Obsidian UI — including arbitrary JavaScript
execution — to anything that can reach that port. There is no authentication; put
it behind a tunnel or reverse proxy if you must.

The HTTP endpoint is **`/mcp`** (for example `http://127.0.0.1:9223/mcp`). Clients
must send an `Accept` header that includes both `application/json` and
`text/event-stream`. Only one session is live at a time — a second `initialize`
without first closing the previous session (`DELETE`) returns
`400 Server already initialized`. That matches the reality that concurrent agents
would fight over one Obsidian window.

## Aliases

`LOG_LEVEL`, `RECONNECT_MS`, and `SCREENSHOT_DIR` are accepted as unprefixed
aliases. The `KNAP_`-prefixed name wins when both are set.

## Toolsets

Default: `core`, `ui`, `telemetry`, `plugin-dev`. Opt in to `vault` for note and
file CRUD, `authoring` for properties/tags/tasks/themes/daily notes, and `devtools`
for DOM/CSS/CDP passthrough and OS-window screenshots. See the README for the full
table and the reasoning behind the defaults.

## Example

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "knapper@latest"],
      "env": {
        "OBSIDIAN_VAULT": "uob-test-vault",
        "OBSIDIAN_TARGET_MATCH": "uob-test-vault",
        "KNAP_TOOLSETS": "core,ui,telemetry,plugin-dev,vault"
      }
    }
  }
}
```
