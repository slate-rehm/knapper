# Configuration

Knapper reads CLI flags first, then environment variables, then defaults. Tool
calls select an Obsidian target with a required `workspaceHandle`. Transport state
does not select a workspace.

## Connection and process settings

| Environment variable     | CLI flag         | Default                 | Purpose                                      |
| ------------------------ | ---------------- | ----------------------- | -------------------------------------------- |
| `OBSIDIAN_CDP_URL`       | `--cdp-url`      | `http://127.0.0.1:9222` | Default-profile CDP endpoint                 |
| `OBSIDIAN_BIN`           | `--obsidian-bin` | OS default              | Obsidian executable                          |
| `OBSIDIAN_VAULT`         | `--vault`, `-v`  | unset                   | Default authorized vault name                |
| `OBSIDIAN_TARGET_MATCH`  | `--target-match` | unset                   | Additional default-window match              |
| `KNAP_HOME`              | none             | `~/.knapper_mcp`        | Durable handles, telemetry, audit, and trash |
| `KNAP_IDLE_TIMEOUT_MS`   | none             | `86400000`              | Workspace lease and cleanup timeout          |
| `KNAP_COMMAND_TRANSPORT` | none             | `auto`                  | `auto`, `cli`, or `playwright`               |
| `KNAP_CLI_TIMEOUT_MS`    | none             | `15000`                 | Obsidian CLI timeout in milliseconds         |

Do not set an internal profile, runtime directory, or instance descriptor. Use
`obsidian_workspace_create` and pass its workspace handle on each tool call.

Agent and workspace handles use 192 bits of random data. Both records have a
24-hour idle lease. Each successful operational call renews both leases. Handles
provide attribution and routing. They do not provide authentication.

One live Knapper process holds an exclusive lease for each workspace. Another
process receives `WORKSPACE_BUSY` when it uses that workspace. The lease expires
after `KNAP_IDLE_TIMEOUT_MS` when the process has no active calls. Knapper reclaims
the lease immediately after it proves process death or PID reuse.

An isolated workspace always creates an exact scratch layout under `KNAP_HOME`.
It cannot adopt a caller path. Knapper verifies the private-session identity before
it routes tools. The result returns `visualIdentity.state` and
`visualIdentity.warnings`. A workspace does not become ready when the required
banner, title, icon, or desktop class is missing.

Call `obsidian_workspace_stop` before `obsidian_workspace_destroy`. The destroy tool
refuses an active workspace. It checks path, symlink, device, and inode ownership.
It then moves the root into `KNAP_HOME/trash`. It does not hard-delete the root.

`obsidian_workspace_release` removes the stopped handle and retains the scratch
vault. A default-profile workspace can only be released.

## Tool surface

| Environment variable   | CLI flag       | Default      | Purpose                            |
| ---------------------- | -------------- | ------------ | ---------------------------------- |
| `KNAP_TOOLSETS`        | `--toolsets`   | empty        | Comma-separated toolsets or `all`  |
| `KNAP_MAX_CONCURRENCY` | none           | `4`          | Maximum concurrent read-only calls |
| `KNAP_SCREENSHOT_DIR`  | `--output-dir` | `./.knapper` | Default-profile artifact root      |

An empty toolset value starts only the 17 control tools. These tools remain visible
when you disable their toolsets:

- `obsidian_agent_open`, `obsidian_agent_status`, and `obsidian_agent_close`
- `obsidian_workspace_create`, `obsidian_workspace_claim_default`, and `obsidian_workspace_list`
- `obsidian_workspace_status`, `obsidian_workspace_stop`, and `obsidian_workspace_restart`
- `obsidian_workspace_release` and `obsidian_workspace_destroy`
- `obsidian_status`, `obsidian_doctor`, and `obsidian_capabilities`
- `obsidian_toolsets`, `obsidian_tool_catalog`, and `obsidian_toolsets_update`

`obsidian_toolsets` reports the enabled set. `obsidian_tool_catalog` searches all
tool definitions with cursor pagination. `obsidian_toolsets_update` accepts
`enable`, `disable`, and `dryRun`.
An effective update sends `notifications/tools/list_changed` to the MCP client.

Enable `core`, `workspace`, `telemetry`, and `plugin-dev` for the full plugin loop.
Add `ui` for browser automation. Add other toolsets only when the task needs them.

## Structured output

Knapper tools publish MCP output schemas. Successful calls return values through
`structuredContent`. Clients do not need to parse the display text.

Screenshot tools return this object:

```json
{
  "path": "/absolute/path/to/output/capture.png",
  "mimeType": "image/png",
  "size": 12345,
  "inline": false
}
```

The requested `path` must be relative to the configured output root. Screenshot
tools do not return inline base64 data. Isolated workspaces use their private
`output/` root.

Doctor returns explicit version information in this shape:

```json
{
  "versions": {
    "running": "1.12.7",
    "downloadedAsar": "1.12.7",
    "installedPackage": "1.12.7",
    "installedPackageSource": "pacman",
    "comparisons": {
      "runningVsDownloaded": "match",
      "runningVsInstalled": "match",
      "downloadedVsInstalled": "match"
    }
  }
}
```

Each comparison is `match`, `different`, or `unavailable`. An unavailable source
produces `unavailable` instead of an inferred result.

The four version source fields can be `null`. `installedPackageSource` identifies
the package manager that supplied `installedPackage`.

## Telemetry and audit

| Environment variable     | Default | Purpose                          |
| ------------------------ | ------- | -------------------------------- |
| `KNAP_LOG_LEVEL`         | `info`  | Server log level                 |
| `KNAP_TELEMETRY_BUFFER`  | `2000`  | In-memory telemetry record limit |
| `KNAP_TELEMETRY_NETWORK` | `false` | Capture failed network requests  |
| `KNAP_RECONNECT_MS`      | `2000`  | Telemetry reconnect delay        |

Knapper writes default-profile telemetry to `KNAP_HOME/telemetry/events.jsonl`.
Each isolated workspace has a separate `<workspaceHandle>.jsonl` file in that
directory. Switching workspaces does not erase records or mix histories. Knapper
writes redacted tool audit events under `KNAP_HOME/audit`. Audit files use mode
`0600` and have 14-day retention.

Release and destroy operations archive an isolated workspace's telemetry file.
They store it in the retained or quarantined root.

`LOG_LEVEL`, `RECONNECT_MS`, and `SCREENSHOT_DIR` are supported aliases. The
`KNAP_` name takes precedence.

## HTTP transport

| Environment variable | CLI flag      | Default     | Purpose                  |
| -------------------- | ------------- | ----------- | ------------------------ |
| `MCP_TRANSPORT`      | `--transport` | `stdio`     | `stdio` or `http`        |
| `MCP_PORT`           | `--port`      | `9223`      | HTTP listen port         |
| `MCP_HOST`           | `--host`      | `127.0.0.1` | Exact loopback bind host |

HTTP serves `/mcp` with the MCP 2026 stateless request model. It does not issue an
`Mcp-Session-Id`. Each request can select a durable workspace handle.

The HTTP server has no authentication. The listener accepts only `127.0.0.1` or
`::1` as the bind host. It rejects `localhost`, wildcard addresses, and LAN
addresses. Requests can use `localhost`, `127.0.0.1`, or `[::1]` in their `Host`
and `Origin` headers. Do not place the server behind a public proxy.

## Vault authorization

The Obsidian vault registry is discovery data, not consent. A user must create an
external authorization from an interactive terminal:

```text
knapper authorize /absolute/path/to/vault
knapper revoke /absolute/path/to/vault
knapper authorizations
```

Knapper stores authorizations in `KNAP_HOME/vault-authorizations.json`. Each record
binds the canonical path to its device and inode. Legacy `.knapper-managed` files
have no effect. Authorization permits vault operations. It never permits directory
deletion.

`obsidian_create_vault` refuses when an isolated workspace is selected. Use the
scratch vault that `obsidian_workspace_create` created for that workspace.
