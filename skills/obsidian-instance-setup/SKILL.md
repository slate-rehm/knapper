---
name: obsidian-instance-setup
description: Connect knapper to a live Obsidian desktop app: obsidian_doctor diagnosis, obsidian_launch with remote debugging, CLI enablement, vault registry, argv corruption, and the Electron single-instance lock. Use before plugin dev or UI automation when transports fail.
---

# Obsidian instance setup

Unified Obsidian MCP uses **two complementary transports**:

1. **Obsidian CLI** — global `"cli": true` in `obsidian.json` (Settings → General → Advanced → Command line interface). No app restart required. ~100+ commands via live `__completions`. Cannot run headless. When disabled, every CLI call prints `Command line interface is not enabled.` on stdout (exit 0).
2. **Playwright over CDP** — requires cold start with `--remote-debugging-port`. Supplies real input, waiting, ARIA snapshots, and telemetry streams.

Both can be active at once. Run **`obsidian_doctor`** first — it maps problems to fixes.

## Quick start sequence

```text
obsidian_doctor
# apply each suggested fixedBy tool or manual step
obsidian_launch
obsidian_status
```

## Four precondition states (do not lump together)

| Code                   | Meaning                         | Typical fix                                                   |
| ---------------------- | ------------------------------- | ------------------------------------------------------------- |
| `OBSIDIAN_NOT_RUNNING` | No running instance             | `obsidian_launch`                                             |
| `CLI_DISABLED`         | CLI toggle off                  | `obsidian_setup_cli` or Settings UI                           |
| `CDP_PORT_CLOSED`      | Nothing listening on CDP URL    | Quit Obsidian fully, `obsidian_launch` with debug port        |
| `ARGV_CORRUPTION`      | Bad tokens in `user-flags.conf` | Fix single-dash flags (e.g. `-disable-gpu` → `--disable-gpu`) |

Errors include **remediation** text and often a **`fixedBy`** tool name — follow them literally.

### `CDP_PORT_CLOSED` and the single-instance lock

Electron allows one instance. If Obsidian is already running **without** the debug flag, starting again with `--remote-debugging-port` **silently does nothing**.

**Fix:** fully quit Obsidian (all windows), then cold start with the port. `obsidian_launch` encodes the right command for your OS.

### `CLI_DISABLED`

The CLI cannot enable itself. Use `obsidian_setup_cli` (writes global `cli: true` in `obsidian.json`) or the Settings toggle.

### `VAULT_NOT_FOUND`

`OBSIDIAN_VAULT` or `vault=` names a vault not in the registry. Open/register the vault in Obsidian, or use `obsidian_setup_vault` for a dev scratch vault.

## Provisioning tools

| Tool                   | Purpose                                             |
| ---------------------- | --------------------------------------------------- |
| `obsidian_doctor`      | Full diagnosis + remediation                        |
| `obsidian_launch`      | Start Obsidian with CDP port (and optional vault)   |
| `obsidian_setup_cli`   | Enable global CLI flag                              |
| `obsidian_setup_vault` | Prepare dev vault (restrictions, community plugins) |
| `obsidian_link_plugin` | Symlink plugin build dir into vault                 |
| `obsidian_status`      | Cheap health snapshot (not a full doctor)           |

## Configuration (env vars)

Hosts disagree on plugin manifest variables, so configure via environment:

- `OBSIDIAN_CDP_URL` (default `http://127.0.0.1:9222`)
- `OBSIDIAN_BIN` — path to executable
- `OBSIDIAN_VAULT` — default vault name for CLI

See repository README for the full table (`KNAP_*` toolsets, telemetry, timeouts). Add `vault`, `devtools`, or `authoring` via `KNAP_TOOLSETS` when you need those opt-in surfaces (properties/tags/tasks live under **authoring**, not vault).

## Linux distro wrappers

`user-flags.conf` in Obsidian userData is read by some packages. Only `--`-prefixed flags are stripped from argv; a single-dash token becomes a bogus “command” and breaks **every** CLI invocation.

## Multi-window

Use `obsidian_list_targets` + `obsidian_attach` when more than one window or popout is open. One browser context; disambiguate with `app.vault.getName()` in eval.

## Version drift caveat

Obsidian checks for updates on startup and hourly. A downloaded `obsidian-<version>.asar` in userData can override the distro package — DOM and API behavior may not match the version shown in package managers. Re-run doctor/spike tests after upgrades.

## Related skills

- **obsidian-plugin-dev** — after setup, link and reload plugins.
- **obsidian-ui-automation** — requires CDP.
- **obsidian-debugging** — telemetry after connection works.

## VAULT_NOT_AUTHORIZED

knapper refuses any vault the user has not authorized, so a fresh install reaches
nothing. This is a fifth precondition state alongside the four transport ones, and
unlike those, **no tool fixes it**.

`obsidian_doctor` and `obsidian_status` list every registered vault with its
authorization state, so start there.

- Need throwaway space? `obsidian_create_vault` — it authorizes what it creates, and
  is the right answer for almost every experiment.
- Need a _specific existing_ vault? Only the user can grant that, by running
  `knapper authorize <path>` in their own terminal. It requires an interactive TTY and
  a retyped vault name, so you cannot run it yourself — spawning the binary will just
  refuse.

Do not volunteer the authorize command. An agent that answers every refusal with
"run this to grant me access" trains users to authorize reflexively, which is the
habit the fence exists to prevent. Surface it only when the user has asked to work in
that vault.
