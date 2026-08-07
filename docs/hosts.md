# Host support

knapper ships two separable things, and hosts install them by different mechanisms:

1. **The MCP server** — the tools. Configure it as an ordinary stdio MCP server.
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
| **Claude Code**          | `.claude-plugin/marketplace.json` → `.claude-plugin/plugin.json` | `skills/`, `commands/`, `agents/` | `claude plugin marketplace add bearfire-dev/knapper` then `claude plugin install knapper@knapper`            |
| **Cursor**               | `.cursor-plugin/plugin.json`, `rules/*.mdc`, `.mcp.json`         | `skills/`, `rules/`               | MCP: `.mcp.json` at project root or **Settings → MCP**. Bundle: clone into `~/.cursor/plugins/local/knapper` |
| **Codex**                | `.codex-plugin/plugin.json`                                      | `skills/`, `commands/`, `agents/` | `codex plugin marketplace add bearfire-dev/knapper` then `codex plugin add knapper@knapper`                  |
| **OpenCode**             | `opencode.json`                                                  | `.agents/skills/`                 | Add the local MCP configuration below. Install skills with `npx skills add bearfire-dev/knapper`             |
| **skills.sh**            | `skills/*/SKILL.md`                                              | `skills/` only                    | `npx skills add bearfire-dev/knapper`                                                                        |
| **Any MCP client**       | —                                                                | n/a (server only)                 | `command: "knapper"`, or `npx -y github:bearfire-dev/knapper`                                                |
| **`.agents` convention** | `.agents/plugins/marketplace.json`                               | `skills/`, `commands/`, `agents/` | Host-dependent                                                                                               |

## OpenCode MCP configuration

OpenCode uses a command array and an `environment` object. This configuration uses
the installed `knapper` binary:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "knapper": {
      "type": "local",
      "command": ["knapper"],
      "enabled": true,
      "environment": {
        "KNAP_TOOLSETS": "core,workspace,telemetry,plugin-dev",
        "KNAP_SCREENSHOT_DIR": "/absolute/path/to/knapper-output"
      }
    }
  }
}
```

Both environment variables are optional. `KNAP_TOOLSETS` selects the startup
surface. `KNAP_SCREENSHOT_DIR` must name the screenshot output root.

Use this command array to track the default branch:

```json
"command": ["npx", "-y", "github:bearfire-dev/knapper"]
```

The `knap` binary remains a compatibility alias. New configurations must use
`knapper`.

## Known limits

- **Cursor cannot install plugins from an arbitrary Git repo.** Its marketplace is curated,
  so the bundle has to come from `npx skills add` or a manual clone into
  `~/.cursor/plugins/local/knapper` followed by a window reload. The MCP server itself
  installs normally.
- **Config variables do not unify.** Cursor plugin `variables` and Claude Code `userConfig`
  are different dialects, so knapper reads every setting from a plain environment variable
  instead of being expressed three ways. Set them in each client's MCP `env` block. See
  [configuration.md](configuration.md).
- **Enabled `browser_*` tools remain visible when Obsidian is offline.** Calls that need CDP return an
  actionable error with `obsidian_launch` as the fixing tool. Cold-start Obsidian with the debug
  port, then retry the same call. You do not need to reconnect only to refresh the tool list.

## Verifying a host

The bundle is loaded correctly when the host can see all four skills. A quick check that does
not require Obsidian:

```bash
npx -y github:bearfire-dev/knapper --help    # server starts
npm run smoke                              # degraded-mode MCP contract, including browser tools
```

Then, in the host, confirm `obsidian-instance-setup` and `obsidian-plugin-dev` appear as
skills and that `obsidian_doctor` is callable.
