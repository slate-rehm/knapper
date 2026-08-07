# Security

## What this server is

knapper drives a **live Obsidian desktop application**. It executes arbitrary JavaScript in
the renderer, dispatches real mouse and keyboard input, reads and writes vault files, and
starts and stops the Obsidian process. Running it is closer to granting desktop automation
access than to installing a note-reading integration.

Because of that, knapper cannot touch a vault until you have said so. See **The vault
fence** below; it is the first thing to understand about running this server.

## Trust model

```
User → MCP client → knapper → [vault fence] → { Obsidian CLI | CDP } → Obsidian
```

There are two boundaries, and they protect against different things.

**The MCP client decides which tools may run.** knapper does not authenticate callers. It
trusts that the client only forwards requests the user has approved, and relies on the
client's permission system to prompt on the tools that need it. Every tool carries MCP
annotations — `readOnlyHint`, `destructiveHint`, `openWorldHint` — so a client can distinguish
a vault read from arbitrary code execution. Register knapper only with clients you trust.

**The vault fence decides what those tools may touch.** This one is enforced inside knapper
and does not depend on the client behaving well. A client that approves everything, or an
agent that has talked its way past a prompt, still cannot reach a vault you have not
authorized.

## The vault fence

Every path that reads or writes vault content resolves a target vault first. It refuses an
unauthorized target. Knapper stores grants in
`KNAP_HOME/vault-authorizations.json`, outside the vault. Each grant binds the canonical path,
device, inode, and directory birth time. The registry uses locked atomic writes with mode
`0600`.

| Grant     | Written by                                                    | Knapper may       |
| --------- | ------------------------------------------------------------- | ----------------- |
| `created` | `obsidian_create_vault`                                       | read and write it |
| `adopted` | `knapper authorize <path>` — run by you, in your own terminal | read and write it |

Legacy `.knapper-managed` files are inert. They do not grant access or deletion rights.
Knapper never uses a vault authorization as permission to delete the vault directory.

No MCP tool can grant access. `knapper authorize` refuses without an interactive TTY and makes
you retype the vault name, so it cannot be completed from inside an automation run — an agent
can spawn the binary but cannot answer the prompt. Withdraw with `knapper revoke <path>`, which
takes effect immediately, without restarting the server.

```
knapper authorizations              # what knapper may touch
knapper authorize ~/vaults/scratch  # grant (interactive)
knapper revoke ~/vaults/scratch     # withdraw
```

What the fence covers, and why each one is separate:

- **Both transports.** The Obsidian CLI never emits a command without a `vault=` token — an
  unscoped command silently targets whichever vault you last focused. The CDP session resolves
  a window by asking the renderer for `app.vault.getName()` and refuses when none matches; it
  no longer falls back to "first main window".
- **The `@playwright/mcp` proxy.** Real input is re-pointed at the authorized window before
  every call, and refused if that cannot be confirmed. `browser_tabs` is restricted to `list`
  so nothing can retarget the proxy behind the fence's back.
- **Telemetry.** Console and error capture is armed only on authorized windows, since log
  lines quote note titles and file contents.
- **`obsidian_reset_state`.** The one path that writes vault files directly on disk re-checks
  the vault directory it got from the renderer before writing.
- **Window listings.** Diagnostics return only an opaque target identifier for an unauthorized
  window. They omit vault names, paths, note titles, URLs, and workspace content.

Refusals raise `VAULT_NOT_AUTHORIZED`, kept distinct from `VAULT_NOT_MANAGED` (which is about
deletion provenance) so the two never blur together.

**Authorizing is not a small grant.** It lets any agent driving knapper read every note in that
vault into its context, modify or delete notes, and run arbitrary JavaScript against it. Use
`obsidian_create_vault` for throwaway work; authorize a real vault only when you mean it.

Two transports reach Obsidian and both are local:

- **Obsidian CLI** — spawns the `obsidian` binary via `execFile`. Requires the global
  `"cli": true` flag in `obsidian.json`.
- **Chrome DevTools Protocol** — attaches to `--remote-debugging-port` on loopback. Requires
  Obsidian to have been deliberately cold-started with that flag.

Neither is enabled by default in a stock Obsidian install. The user has to opt in to both.

## The MCP transport is a network listener when you ask for one

The default `stdio` transport has no listener and is what MCP clients use.

`--transport http` binds a TCP listener on loopback only. The default endpoint is
`127.0.0.1:9223/mcp`. Knapper refuses every non-loopback bind because this transport has no
authentication. Host and origin validation also restrict requests to loopback names.

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

### `obsidian_remove_vault` — `destructiveHint`

Unregisters an authorized Knapper-created vault. It never deletes the directory. It rejects
user-adopted vaults. Isolated workspace cleanup uses `obsidian_workspace_destroy`, which first
stops the private instance, verifies the exact Knapper-owned root, and moves that root to
recoverable trash under `KNAP_HOME`.

### Withheld browser tools

knapper proxies `@playwright/mcp` through an **allowlist**, not a blocklist
(`src/browser/allowlist.ts`). Tools that would damage or hijack the user's real window are
withheld even when upstream advertises them: `browser_close`, `browser_navigate` and its
back/forward variants, `browser_resize`, `browser_file_upload`, `browser_pdf_save`,
`browser_run_code_unsafe`, and the storage-state pair. Navigating or closing the window here
means navigating or closing _the user's actual Obsidian_.

## What it writes to disk

knapper is not a read-only bridge. It writes, outside the vault as well as inside it:

| Path                                       | Written by                                                             | Why                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `<userData>/obsidian.json`                 | `obsidian_setup_cli`, `obsidian_create_vault`, `obsidian_remove_vault` | Flips the global `cli` flag; registers and unregisters vaults          |
| `<KNAP_HOME>/vault-authorizations.json`    | `obsidian_create_vault`, `knapper authorize`, `knapper revoke`         | External path and filesystem-identity grants, mode `0600`              |
| `<KNAP_HOME>/trash/`                       | `obsidian_workspace_destroy`                                           | Recoverable quarantine for verified private workspace roots            |
| `<vault>/.obsidian/plugins/<id>`           | `obsidian_link_plugin`                                                 | Creates or replaces a **symlink**. Refuses to clobber a real directory |
| `<vault>/.obsidian/plugins/<id>/data.json` | `obsidian_reset_state`                                                 | Overwrites plugin settings with `{}`; returns the previous contents    |
| `./.knapper/`                              | screenshot and snapshot tools                                          | Output artifacts, under `KNAP_SCREENSHOT_DIR`                          |
| The vault itself                           | the `vault` and `authoring` toolsets                                   | Note CRUD, frontmatter, daily notes                                    |

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

Open a [security advisory](https://github.com/bearfire-dev/knapper/security/advisories/new) on
the repository, or a regular issue if the problem is not sensitive. There is no formal SLA on
this project — it is maintained on a best-effort basis.
