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

Live suites need Obsidian cold-started with `--remote-debugging-port=9222` and the
`uob-test-vault` scratch vault. **Never point these at a real vault** — they create,
rename, and delete notes. They authorize that vault for knapper themselves
(`scripts/authorize-test-vault.mjs`), writing the marker directly rather than going
through `knapper authorize`, which requires a TTY a test runner does not have.

```bash
npm run acceptance  # 23 checks over the critical seams
npm run e2e         # 79 checks: vault round-trips, UI, telemetry, dev cycle, errors
```

```bash
npm run fence      # 14 live checks: refusals against a real unauthorized vault
npm run bg-input   # 6 live checks: input with Obsidian unfocused, emulation reverted
```

`npm run check && npm run typecheck && npm test && npm run acceptance` is the
minimum before proposing a change. Run `npm run e2e` for anything touching the
router, a tool handler, or the CLI argv grammar.

`npm run fence` needs one authorized and one unauthorized vault open at once — the
situation no mock reproduces. `npm run bg-input` is only meaningful when Obsidian is
**not** the foreground window; run it from a terminal without clicking into Obsidian
first, or it proves nothing.

## Conventions that matter

**Comments explain constraints, not narration.** The valuable comments here record
things the code cannot show: why `noDefaults: true` is mandatory on
`connectOverCDP` (it flips the user's theme and forces focus emulation _permanently_
— `src/browser/focus.ts` re-enables emulation per input dispatch and reverts it,
which is how background input works), why pages are re-enumerated per call (handles
go stale), why `rename` takes `name=` while `move` takes `to=`. Match that register.

**The vault fence is not optional plumbing.** `src/connection/fence.ts` resolves the
target vault for every call, and both transports fail closed: `buildArgs` throws
rather than emit a CLI command with no `vault=` token, and `PlaywrightSession.page()`
refuses rather than fall back to another window. A new code path that reaches
Obsidian must go through `router.cliCommand` / `router.evaluate` / `session.page()`,
which fence for you. If you add a fallback that catches and retries, call
`rethrowIfRefused` first — `obsidian_search` used to swallow a refusal and retry the
read unscoped.

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
- Only one Obsidian instance and one CDP endpoint exist. Two agents running live
  suites at once produce garbage for both — serialize live verification.
- Use mermaid flowcharts to explain architecture in plans.
- Build the big shapes first, then refine. Be specific and precise.
