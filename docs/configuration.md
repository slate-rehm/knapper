# Configuration

Environment variables and CLI flags for **unified-obsidian-mcp**. CLI flags override env vars, which override defaults (`src/config.ts`).

Cursor plugin `variables` and Claude Code `userConfig` do not unify across hosts — set these in each client’s MCP server `env` block or your shell profile.

## Environment variables

| Variable               | Default                         | Description                                                  |
| ---------------------- | ------------------------------- | ------------------------------------------------------------ |
| `OBSIDIAN_CDP_URL`     | `http://127.0.0.1:9222`         | CDP HTTP endpoint for Playwright attach                      |
| `OBSIDIAN_BIN`         | Platform default                | Path to Obsidian executable                                  |
| `OBSIDIAN_VAULT`       | (unset)                         | Default vault name for CLI-scoped tools                      |
| `UOB_TOOLSETS`         | `core,ui,telemetry,plugin-dev`  | Comma-separated toolsets or `all`                            |
| `UOB_LOG_LEVEL`        | `info`                          | Server log level on stderr: `debug`, `info`, `warn`, `error` |
| `UOB_TELEMETRY_BUFFER` | `2000`                          | Max retained telemetry events                                |
| `UOB_RECONNECT_MS`     | `2000`                          | Backoff between CDP reconnect attempts                       |
| `UOB_SCREENSHOT_DIR`   | `./.unified-obsidian-mcp` (cwd) | Screenshots and snapshot artifacts                           |
| `UOB_CLI_TIMEOUT_MS`   | `15000`                         | Timeout per Obsidian CLI invocation (ms)                     |

## CLI flags (mirror env)

| Flag             | Env equivalent       |
| ---------------- | -------------------- |
| `--cdp-url`      | `OBSIDIAN_CDP_URL`   |
| `--obsidian-bin` | `OBSIDIAN_BIN`       |
| `--vault`, `-v`  | `OBSIDIAN_VAULT`     |
| `--toolsets`     | `UOB_TOOLSETS`       |
| `--log-level`    | `UOB_LOG_LEVEL`      |
| `--output-dir`   | `UOB_SCREENSHOT_DIR` |

`UOB_TELEMETRY_BUFFER`, `UOB_RECONNECT_MS`, and `UOB_CLI_TIMEOUT_MS` are **environment-only** (no CLI flag yet).

## Toolsets

See README for descriptions. Default: `core`, `ui`, `telemetry`, `plugin-dev`. Add `vault` for note/file CRUD; `authoring` for properties/tags/tasks/themes/daily notes; `devtools` for DOM/CSS/CDP and OS-window screenshots.

## Example MCP `env` block

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "unified-obsidian-mcp@latest"],
      "env": {
        "OBSIDIAN_VAULT": "uob-test-vault",
        "OBSIDIAN_CDP_URL": "http://127.0.0.1:9222"
      }
    }
  }
}
```
