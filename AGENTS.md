# Contributing agent guide

Read this before changing anything in this repository.

## What this is

`knapper` is an MCP server that drives a **live Obsidian desktop app**
for plugin development. It is not a vault-file library: almost every tool acts on a
running application, so "it compiles" is a weak signal here and the live suites are
the real gate.

Two transports reach Obsidian, and a capability router picks per call:

| Layer                   | Reaches Obsidian by                           | Needed for                                            |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------- |
| **Obsidian CLI**        | `obsidian` binary, `key=value` argv grammar   | ~100 native commands, plugin reload, vault-scoped ops |
| **Playwright over CDP** | `connectOverCDP` to `--remote-debugging-port` | Real input, ARIA snapshots, console/network capture   |

## Layout

```
src/
  capabilities.ts        capability -> layer preference table
  config.ts              env + flag resolution (single source for settings)
  connection/
    router.ts            picks a layer per capability, explains why none work
    cdp/                 Playwright session, target discovery
    cli/exec.ts          CLI exec + output classification
    supervisor.ts        health probe with exponential backoff
  tools/                 one module per toolset; registry.ts is the choke point
  browser/proxy.ts       proxies @playwright/mcp, filters destructive tools
  telemetry/             console/error/network ring buffer, plugin attribution
  devcycle/              composites (dev_cycle, exercise, reset_state)
  session/               internal isolated-instance descriptors, launch, and cleanup
  agent/, workspace/     durable public handles and leases
scripts/                 acceptance, e2e, ci-smoke, version sync

skills/                  plugin skills (obsidian-debugging, -instance-setup,
                         -plugin-dev, -ui-automation), shipped to installers
commands/                plugin slash commands (obsidian-dev, obsidian-doctor)
rules/                   plugin rules (obsidian-plugin.mdc)
agents/                  plugin subagents
```

This repo is packaged as a **plugin**, so `skills/`, `commands/`, `rules/`, and
`agents/` sit at the top level rather than under a dot-directory — that is the
plugin convention, not a mistake. `.agents/skills` and `.claude/skills` are symlinks
to `skills/` so the skills also load while working inside this repo.

### Plugin manifests

Four manifests describe the same plugin and **must be updated together**:

- `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`
  — identical content, one per harness.
- `.claude-plugin/marketplace.json` (Claude marketplace schema) and
  `.agents/plugins/marketplace.json` (`.agents` plugin schema) — **different schemas
  by design**, so they cannot be merged; keep name, description, and version aligned
  by hand.

## Commands

```bash
npm run check      # oxfmt + oxlint (pinned vite-plus; no global install needed)
npm run typecheck  # tsc --noEmit
npm test           # vitest unit tests
npm run build      # tsc -> dist/
npm run smoke      # degraded-mode MCP check, no Obsidian required
```

Live suites create a temporary `KNAP_HOME`, a private Obsidian profile, a scratch
vault, and a dynamic CDP port. They must never use the default profile or a caller
vault. The harness proves that each selected vault is disposable before it writes
notes.

```bash
npm run acceptance  # 23 checks over the critical seams
npm run e2e         # 79 checks: vault round-trips, UI, telemetry, dev cycle, errors
```

```bash
npm run fence      # live checks for authorized and unauthorized private windows
npm run bg-input   # 6 live checks: background input without desktop focus theft
npm run workspaces # isolated instances, reconnect, scoped restart, quarantine
```

Each live suite provisions its own workspace and tears it down. Run `npm run
workspaces` for anything that changes `src/session/`, `launch.ts`, workspace
leases, or process-scoping predicates.

`npm run check && npm run typecheck && npm test && npm run acceptance` is the
minimum before proposing a change. Run `npm run e2e` for anything touching the
router, a tool handler, or the CLI argv grammar.

`npm run fence` creates separate authorized and unauthorized private windows when
the platform supports them. `npm run bg-input` is only meaningful when Obsidian is
not the foreground window. Run it without clicking the private Obsidian window.

## Conventions that matter

**Comments explain constraints, not narration.** The valuable comments here record
things the code cannot show: why `noDefaults: true` is mandatory on
`connectOverCDP` (it flips the user's theme and forces focus emulation _permanently_
— `src/browser/focus.ts` re-enables emulation per input dispatch and reverts it,
which is how background input works), why pages are re-enumerated per call (handles
go stale), why `rename` takes `name=` while `move` takes `to=`. Match that register.

**Sessions isolate; two flags do it, and they are inseparable.** `--user-data-dir`
gives an instance its own Electron singleton lock, which is what lets a second
Obsidian exist. `XDG_RUNTIME_DIR` decides where it binds its CLI socket. Ship the
first without the second and the newest instance silently steals the shared socket
(`unlink` then `listen`), so every agent's CLI commands land in the wrong app with no
error anywhere — `launchObsidian` refuses that configuration rather than produce it.
Overriding `XDG_RUNTIME_DIR` also breaks Wayland, which resolves a relative
`WAYLAND_DISPLAY` against it; `childEnv` re-pins it to an absolute path, and without
that Obsidian spins forever with no window and nothing in any log. Process detection,
quitting, and `DevToolsActivePort` are all scoped by profile — `matchesScope` is
`isObsidianCmdline(...) && dirMatches(...)`, an AND, because Obsidian's own helper
processes carry `--user-data-dir` without carrying the marker.

**The vault fence is not optional plumbing.** `src/connection/fence.ts` resolves the
target vault for every call, and both transports fail closed: `buildArgs` throws
rather than emit a CLI command with no `vault=` token, and `PlaywrightSession.page()`
refuses rather than fall back to another window. A new code path that reaches
Obsidian must go through `router.cliCommand` / `router.evaluate` / `session.page()`,
which fence for you.

**A tool that writes into a vault directory bypasses all of that**, because it never
touches a transport. Resolve the path with `router.fence.resolve(name)` — never with
`findVault(readGlobalConfig())`, which only proves a vault is _registered_, and being
registered is not consent. `obsidian_link_plugin` and `obsidian_setup_vault` both had
this: they wrote into `<vault>/.obsidian` of any vault Obsidian happened to know
about, including the user's own. `obsidian_setup_vault` was worse for being fenced
only _by accident_ — a `plugins:restrict` call happened to run first and throw, so
reordering two lines would have reopened it. `fence-live.mjs` now asserts both
refuse. The two remaining `findVault` callers are deliberate: `vaultAutomationState`
is read-only diagnostics that must be able to inspect an unauthorized vault to
explain the refusal, and `obsidian_remove_vault` is guarded by
`removeManagedVault` can only unregister. It never deletes a vault directory.

If you add a fallback that catches and retries, call
`rethrowIfRefused` first — `obsidian_search` used to swallow a refusal and retry the
read unscoped.

**Vault authorization is external and never grants directory deletion.** Store it in
`KNAP_HOME/vault-authorizations.json`. Bind each record to the canonical path,
device, and inode. Legacy `.knapper-managed` files are inert. Use locked atomic
writes with mode `0600`.

**Isolated cleanup can only quarantine an exact scratch root.** Workspace creation
does not accept a caller vault path. Before cleanup, verify the derived layout,
real paths, symlink state, device, inode, and Knapper-created grant. Move the whole
root to `KNAP_HOME/trash`. Never hard-delete it. Never quarantine the default
Obsidian profile. `KNAP_IDLE_TIMEOUT_MS` defaults to 24 hours.

**Errors are a feature.** Use typed `UobError` from `src/util/errors.ts` with a
`remediation` and, where possible, a `fixedBy` naming the tool that fixes it. The
four precondition states — not running, CLI disabled, CDP closed, argv corruption —
must stay distinguishable; collapsing them into "cannot connect" is a regression.

**The CLI lies about success.** Obsidian prints errors to stdout with exit code 0.
`classifyCliOutput` / `classifyEvalOutput` in `connection/cli/exec.ts` own that
translation. Any new CLI surface goes through them.

**Every tool needs annotations.** `readOnlyHint` gates concurrency: the registry
takes an exclusive lock for anything not marked read-only, so a mislabeled mutating
tool will interleave real input against shared UI. Add `destructiveHint` for
anything that deletes or overwrites. Every schema field needs `.describe()`.

**Adding a tool** means: register it in the right `src/tools/*.ts` module with a
toolset and capability, describe every field, add it to the E2E suite, and check
whether the README's representative-tools list should mention it.

**Config lives in `config.ts`.** Do not read `process.env` from a tool.

TypeScript is strict with `noUncheckedIndexedAccess`. Avoid `any`; justify it in a
comment when genuinely unavoidable.

## Branching

Work flows `feature/* → dev → master`. `dev` is the default branch; `master` is
production and only advances by promotion PR. Both are protected and reject direct
pushes, including from admins. There is no registry: a release is a tag on `master`
plus a GitHub Release with the `npm pack` tarball attached, which is what users
install by URL.

The version lives in `package.json` and is mirrored into the three plugin manifests
— run `npm run versions:sync` rather than editing them, and CI fails on drift.

`playwright-core` is pinned to the exact build `@playwright/mcp` depends on, not a
caret range. The spike scripts import it directly, and `connectOverCDP` only behaves
if that import is the same build the proxy uses — a caret range silently installs a
second copy. Bump both together.

## Working style

- Delegate independent workstreams to parallel subagents with **strict file
  ownership**, since they share one working tree. Overlapping edits corrupt each
  other. Follow implementation with an audit subagent that runs `npm run check`.
- Open an agent handle, then create an isolated workspace for live work. Pass its
  `workspaceHandle` to every operational tool.
- One MCP server owns the default profile at a time. On `DEFAULT_PROFILE_BUSY`,
  create an isolated workspace and retry with its handle.
- `npm run bg-input` stays serialized regardless: it depends on Obsidian not being the
  foreground window, which is one global property of the desktop, and it fails open.
- Use mermaid flowcharts to explain architecture in plans.
- Build the big shapes first, then refine. Be specific and precise.
