# Host support

knapper ships two separable things, and hosts install them by different mechanisms:

1. **The MCP server** — the tools. Configured per host as an ordinary stdio MCP server.
2. **The plugin bundle** — 4 skills, 2 slash commands, 1 subagent, 1 rules file. Installed
   through each host's plugin/marketplace system, or standalone via `npx skills add`.

## The bundle is discovered by folder, not declared by manifest

This is the part that is easy to get wrong when editing manifests. The three plugin manifests
(`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`)
**deliberately omit** `skills`, `commands`, and `agents` fields. Every host discovers those
from conventional **root-level directories**:

```
skills/<name>/SKILL.md     4 skills, each with YAML frontmatter (name + trigger description)
commands/<name>.md         2 slash commands
agents/<name>.md           1 subagent
rules/<name>.mdc           1 Cursor-format rules file
```

Adding a fifth skill therefore means creating `skills/<name>/SKILL.md` and nothing else. Do
not add a `skills` array to a manifest to "register" it — no host reads one here, and the
three manifests are kept byte-identical apart from their directory.

The marketplace manifests point at the repo root (`"source": "./"`). Hosts resolve a plugin's
`source` relative to the **marketplace file's root**, which is this repository, so anything
else (`".."`, `"../.."`) points outside the repo and fails to resolve.

## Matrix

| Host                     | Reads                                                            | Discovers bundle from             | Install                                                                                                      |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Claude Code**          | `.claude-plugin/marketplace.json` → `.claude-plugin/plugin.json` | `skills/`, `commands/`, `agents/` | `claude plugin marketplace add slate-rehm/knapper` then `claude plugin install knapper@knapper`              |
| **Cursor**               | `.cursor-plugin/plugin.json`, `rules/*.mdc`, `.mcp.json`         | `skills/`, `rules/`               | MCP: `.mcp.json` at project root or **Settings → MCP**. Bundle: clone into `~/.cursor/plugins/local/knapper` |
| **Codex**                | `.codex-plugin/plugin.json`                                      | `skills/`, `commands/`, `agents/` | `codex plugin marketplace add slate-rehm/knapper` then `codex plugin add knapper@knapper`                    |
| **skills.sh**            | `skills/*/SKILL.md`                                              | `skills/` only                    | `npx skills add slate-rehm/knapper`                                                                          |
| **Any MCP client**       | —                                                                | n/a (server only)                 | `command: "knap"`, or `npx -y github:slate-rehm/knapper`                                                     |
| **`.agents` convention** | `.agents/plugins/marketplace.json`                               | `skills/`, `commands/`, `agents/` | Host-dependent                                                                                               |

## Known limits

- **Cursor cannot install plugins from an arbitrary Git repo.** Its marketplace is curated,
  so the bundle has to come from `npx skills add` or a manual clone into
  `~/.cursor/plugins/local/knapper` followed by a window reload. The MCP server itself
  installs normally.
- **Config variables do not unify.** Cursor plugin `variables` and Claude Code `userConfig`
  are different dialects, so knapper reads every setting from a plain environment variable
  instead of being expressed three ways. Set them in each client's MCP `env` block. See
  [configuration.md](configuration.md).
- **`browser_*` tools only appear when Obsidian is reachable.** Most of the `ui` toolset is
  proxied from `@playwright/mcp`, which can only be enumerated over a live CDP connection. If
  knapper starts before Obsidian, the client caches a short tool list — start Obsidian (or run
  `obsidian_launch`), then reconnect the MCP server.

## Verifying a host

The bundle is loaded correctly when the host can see all four skills. A quick check that does
not require Obsidian:

```bash
npx -y github:slate-rehm/knapper --help    # server starts
npm run smoke                              # degraded-mode MCP contract, 80 tools
```

Then, in the host, confirm `obsidian-instance-setup` and `obsidian-plugin-dev` appear as
skills and that `obsidian_doctor` is callable.
