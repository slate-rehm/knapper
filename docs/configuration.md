# Configuration

Every setting for **knapper**. Precedence is CLI flag → environment
variable → default, resolved in one place (`src/config.ts`); tools never read the
environment directly.

Cursor plugin `variables` and Claude Code `userConfig` do not unify across hosts —
set these in each client's MCP server `env` block, or in your shell profile.

## Connection

| Variable                 | Flag             | Default                 | Description                                                          |
| ------------------------ | ---------------- | ----------------------- | -------------------------------------------------------------------- |
| `OBSIDIAN_CDP_URL`       | `--cdp-url`      | `http://127.0.0.1:9222` | CDP endpoint Playwright attaches to                                  |
| `OBSIDIAN_BIN`           | `--obsidian-bin` | Platform default        | Path to the Obsidian executable                                      |
| `OBSIDIAN_VAULT`         | `--vault`, `-v`  | (active vault)          | Pins CLI-scoped tools to one vault                                   |
| `OBSIDIAN_TARGET_MATCH`  | `--target-match` | (unset)                 | Case-insensitive substring; only attach to matching window title/URL |
| `KNAP_CLI_TIMEOUT_MS`    | —                | `15000`                 | Timeout per Obsidian CLI invocation                                  |
| `KNAP_COMMAND_TRANSPORT` | —                | `auto`                  | Renderer command route: `auto`, `cli`, or `playwright`               |
| `KNAP_RECONNECT_MS`      | —                | `2000`                  | Base backoff between CDP reconnect attempts                          |
| `KNAP_SESSION`           | `--session`      | (unset)                 | Bind this server to an isolated session (see below)                  |
| `KNAP_HOME`              | —                | `~/.knapper_mcp`        | Root for session profiles, scratch vaults, and screenshots           |

`KNAP_SESSION` binds the server to one isolated Obsidian instance: its own profile,
CLI socket, debug port, and scratch vault. Create one with `obsidian_create_session`,
then put the returned key in this server's `env` block and reconnect. Everything else
— `cdpUrl`, `vault`, `outputDir` — is then read from the session descriptor, though an
explicit flag or env var still wins so a session's instance can be debugged by hand.
Without it the server drives the installation's own Obsidian exactly as before.

Sessions are what let several agents drive Obsidian at once. Set `KNAP_SESSION` when
another agent might be working in the same repo or on the same machine; leave it unset
for solo work against your own app. `knapper sessions` lists them and
`knapper sessions:reap` collects abandoned ones (reporting first; `--yes` to delete).

Session isolation is Linux-only. Obsidian derives its CLI socket from
`XDG_RUNTIME_DIR`, which only the Linux branch of its path formula reads; on macOS it
is keyed on the home directory and on Windows on the username, neither of which takes
input from the environment. `obsidian_doctor` reports the resulting `CLI isolation`
level so a degraded setup is visible rather than silent.

`OBSIDIAN_TARGET_MATCH` matters when several Obsidian windows are open and you want
automation pinned to one — for example a scratch vault while your real vault stays
untouched.

## Tools and output

| Variable                 | Flag           | Default                                       | Description                                          |
| ------------------------ | -------------- | --------------------------------------------- | ---------------------------------------------------- |
| `KNAP_TOOLSETS`          | `--toolsets`   | `core,session,ui,telemetry,plugin-dev,editor` | Comma-separated toolsets, or `all`                   |
| `KNAP_SCREENSHOT_DIR`    | `--output-dir` | `./.knapper`                                  | Screenshots and snapshot artifacts, relative to cwd  |
| `KNAP_TELEMETRY_BUFFER`  | —              | `2000`                                        | Max retained telemetry events (ring buffer)          |
| `KNAP_TELEMETRY_NETWORK` | —              | `false`                                       | Also capture failed network requests                 |
| `KNAP_MAX_CONCURRENCY`   | —              | `4`                                           | Concurrent read-only tool calls; mutations serialize |
| `KNAP_LOG_LEVEL`         | `--log-level`  | `info`                                        | `debug`, `info`, `warn`, `error`, `silent` — stderr  |

`KNAP_MAX_CONCURRENCY` only raises the ceiling for tools marked `readOnlyHint`.

`KNAP_TOOLSETS` sets the startup surface. Use `obsidian_toolsets` to change the surface at
runtime. Knapper sends `notifications/tools/list_changed` after each effective change.
Anything that mutates takes an exclusive lock regardless, so real input and UI
mutations never interleave.

`KNAP_TELEMETRY_NETWORK` is off by default because failed requests share the one
ring buffer with console output, and Obsidian's renderer is chatty enough that
they crowd out the plugin errors most sessions are after. Turn it on when you are
debugging a plugin that fetches, then read the results with
`obsidian_logs source=network`. `obsidian_telemetry_status` reports whether it is
armed. Accepted truthy values: `1`, `true`, `yes`, `on`.

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
    "knapper": {
      "command": "knap",
      "env": {
        "OBSIDIAN_VAULT": "uob-test-vault",
        "OBSIDIAN_TARGET_MATCH": "uob-test-vault",
        "KNAP_TOOLSETS": "core,ui,telemetry,plugin-dev,vault"
      }
    }
  }
}
```

Swap `"command": "knap"` for `"command": "npx", "args": ["-y", "github:slate-rehm/knapper"]`
if you installed from the default branch rather than a release tarball.
