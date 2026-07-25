# Security

## What this server is

knapper drives a **live Obsidian desktop application**. It executes arbitrary JavaScript in
the renderer, dispatches real mouse and keyboard input, reads and writes vault files, and
starts and stops the Obsidian process. Running it is closer to granting desktop automation
access than to installing a note-reading integration.

Use a scratch vault for agent work. The live suites in this repo create, rename, and delete
notes, which is why they are pointed at a dedicated `uob-test-vault`.

## Trust model

```
User → MCP client → knapper → { Obsidian CLI | Chrome DevTools Protocol } → Obsidian
```

**The MCP client is the trust boundary.** knapper does not authenticate callers. It trusts
that the client only forwards requests the user has approved, and it relies on the client's
permission system to prompt on the tools that need it. Every tool carries MCP annotations —
`readOnlyHint`, `destructiveHint`, `openWorldHint` — so a client can distinguish a vault read
from arbitrary code execution. Register knapper only with clients you trust.

Two transports reach Obsidian and both are local:

- **Obsidian CLI** — spawns the `obsidian` binary via `execFile`. Requires the global
  `"cli": true` flag in `obsidian.json`.
- **Chrome DevTools Protocol** — attaches to `--remote-debugging-port` on loopback. Requires
  Obsidian to have been deliberately cold-started with that flag.

Neither is enabled by default in a stock Obsidian install. The user has to opt in to both.

## The MCP transport is a network listener when you ask for one

The default `stdio` transport has no listener and is what MCP clients use.

`--transport http` **does** bind a TCP listener (default `127.0.0.1:9223`, endpoint `/mcp`).
It has **no authentication of any kind**. Anything that can reach that port can execute
arbitrary JavaScript inside your Obsidian renderer and read or delete your vault.

It binds to loopback unless you override `MCP_HOST`, and it logs a warning when you do. DNS
rebinding protection is on for non-wildcard hosts. Only one session is served at a time. If
you need remote access, put it behind a tunnel or an authenticating reverse proxy — do not
expose the port directly.

## Powerful tools

### `obsidian_eval` — `destructiveHint`, `openWorldHint`

Executes arbitrary JavaScript in Obsidian's renderer with full access to `app.*`, the DOM,
and whatever Electron exposes to that context. There are no restrictions on the code.

**Why it exists:** it is the escape hatch for anything the ~100 purpose-built tools do not
cover, and it is usually the right way to read plugin or vault state.

### `obsidian_cdp` — `destructiveHint`, `openWorldHint`

Raw Chrome DevTools Protocol passthrough. At least as powerful as `obsidian_eval`, since
`Runtime.evaluate` is one of the methods it forwards. Intended for debugging and profiling.
In the `devtools` toolset, which is off by default.

### `browser_evaluate` — `destructiveHint`, `openWorldHint`

The same capability by way of `@playwright/mcp`.

### `obsidian_delete` — `destructiveHint`

Moves files to the system trash. `permanent: true` must be set explicitly to bypass it.

### Withheld browser tools

knapper proxies `@playwright/mcp` through an **allowlist**, not a blocklist
(`src/browser/allowlist.ts`). Tools that would damage or hijack the user's real window are
withheld even when upstream advertises them: `browser_close`, `browser_navigate` and its
back/forward variants, `browser_resize`, `browser_file_upload`, `browser_pdf_save`,
`browser_run_code_unsafe`, and the storage-state pair. Navigating or closing the window here
means navigating or closing _the user's actual Obsidian_.

## What it writes to disk

knapper is not a read-only bridge. It writes, outside the vault as well as inside it:

| Path                                       | Written by                                   | Why                                                                    |
| ------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------- |
| `<userData>/obsidian.json`                 | `obsidian_setup_cli`, `obsidian_setup_vault` | Flips the global `cli` flag; registers a vault                         |
| `<vault>/.obsidian/plugins/<id>`           | `obsidian_link_plugin`                       | Creates or replaces a **symlink**. Refuses to clobber a real directory |
| `<vault>/.obsidian/plugins/<id>/data.json` | `obsidian_reset_state`                       | Overwrites plugin settings with `{}`; returns the previous contents    |
| `./.knapper/`                              | screenshot and snapshot tools                | Output artifacts, under `KNAP_SCREENSHOT_DIR`                          |
| The vault itself                           | the `vault` and `authoring` toolsets         | Note CRUD, frontmatter, daily notes                                    |

## Input handling

- **No shell injection.** Every CLI call goes through `execFile`, which passes arguments
  directly to the process without a shell. `content=foo; rm -rf /` is a literal string.
- **CLI argument escaping** is centralized in `cliValue` (`src/obsidian/helpers.ts`), and
  `obsidian_search` uses Obsidian's native `search` command rather than composing JavaScript.
- **Path handling is delegated** to the Obsidian CLI, which resolves paths within the vault.
  The exceptions are the explicit filesystem writes in the table above.
- **`obsidian_eval` is not sanitized, by design.** Executing the code you pass is the tool.

## Timeouts

A single Obsidian CLI invocation is killed after `KNAP_CLI_TIMEOUT_MS` (default **15000** ms)
so a hung binary cannot block the client indefinitely.

## Logging

Logs go to **stderr only** — a single stray byte on stdout corrupts JSON-RPC framing. At the
default `info` level, note contents are not logged. `--log-level debug` is more verbose and
may include tool arguments; do not use it for a screen recording or a bug report without
reading it first.

## Reporting a vulnerability

Open a [security advisory](https://github.com/slate-rehm/knapper/security/advisories/new) on
the repository, or a regular issue if the problem is not sensitive. There is no formal SLA on
this project — it is maintained on a best-effort basis.
