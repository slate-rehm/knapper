---
name: obsidian-instance-setup
description: Connect Knapper to a live Obsidian app with explicit agent and workspace handles. Use for doctor diagnosis, isolated scratch workspaces, default-profile claims, launch, CLI enablement, registry safety, or concurrent agents.
---

# Obsidian instance setup

Use an isolated workspace for plugin development and experiments. Claim the default
profile only when the user explicitly wants an existing vault.

## Select the target first

1. Call `obsidian_agent_open` with a short label and purpose.
2. Save the returned `agentHandle`.
3. Call `obsidian_workspace_create` with that handle.
4. Include `pluginSourceDir` and `pluginId` when you test a plugin.
5. Save the returned `workspaceHandle`.
6. Pass `workspaceHandle` to every operational tool.

Example:

```text
obsidian_agent_open label=my-plugin purpose="test the current build"
obsidian_workspace_create agentHandle=<agentHandle> label=my-plugin \
  pluginSourceDir=/abs/path/to/dist pluginId=my-plugin
obsidian_plugin_health workspaceHandle=<workspaceHandle> pluginId=my-plugin
```

The workspace handle is durable across MCP reconnects. It selects one exact
Obsidian instance. It is not an authentication credential.

## Concurrent agents

Each agent must use a different isolated workspace. Knapper gives each workspace a
private profile, CLI socket, CDP port, and scratch vault. Calls route from the
explicit workspace handle, not from MCP transport state or `clientInfo`.

Use these lifecycle tools:

```text
obsidian_workspace_list agentHandle=<agentHandle>
obsidian_workspace_status workspaceHandle=<workspaceHandle>
obsidian_workspace_restart workspaceHandle=<workspaceHandle>
obsidian_workspace_release workspaceHandle=<workspaceHandle>
obsidian_workspace_destroy workspaceHandle=<workspaceHandle>
obsidian_agent_close agentHandle=<agentHandle>
```

`release` stops the app and retains the scratch vault. `destroy` moves a verified
isolated root to recoverable Knapper trash. It does not hard-delete the root.
Release or destroy all workspaces before you close the agent handle.

## Default profile

Call `obsidian_workspace_claim_default` only for a user-approved default-profile
task. Then pass that workspace handle to `obsidian_doctor`.

| State                  | Meaning                                  | Action                                    |
| ---------------------- | ---------------------------------------- | ----------------------------------------- |
| `OBSIDIAN_NOT_RUNNING` | Obsidian is stopped                      | Call `obsidian_launch`                    |
| `CLI_DISABLED`         | Native CLI is disabled                   | Call `obsidian_setup_cli`                 |
| `CDP_PORT_CLOSED`      | Browser automation cannot attach         | Cold-start with `obsidian_launch`         |
| `ARGV_CORRUPTION`      | A wrapper passed a bad single-dash token | Correct `user-flags.conf`                 |
| `DEFAULT_PROFILE_BUSY` | Another MCP process owns the profile     | Create an isolated workspace              |
| `VAULT_NOT_AUTHORIZED` | The user did not grant vault access      | Stop unless the user requested that vault |

The Obsidian CLI prints some failures to stdout with exit code 0. Trust the typed
Knapper result, not the process exit code.

## Vault safety

An isolated workspace always creates Knapper-owned scratch space. It cannot accept
or adopt an existing vault path. Knapper stores ownership outside the vault. It
checks the exact layout, real path, symlink state, device, and inode before cleanup.

An Obsidian registry entry does not authorize access. Legacy `.knapper-managed`
files are inert. Only the user can authorize an existing vault from an interactive
terminal. Authorization never permits vault-directory deletion.

Do not suggest authorization unless the user asked to work in that exact vault.
Never redirect an existing-vault request into scratch space without telling the
user.

## Tool surface

The default surface includes `core`, `workspace`, `telemetry`, and `plugin-dev`.
Toolsets are static for the server process. Use `obsidian_toolsets` to inspect the
active set and `obsidian_tool_catalog` to discover optional tools. Restart Knapper
with `KNAP_TOOLSETS` to add `ui`, `editor`, `vault`, `devtools`, or `authoring`.

## Platform limits

Isolated workspaces are verified on Linux. Linux uses a private `XDG_RUNTIME_DIR`
for each CLI socket. macOS isolation is unverified. Windows cannot isolate the
Obsidian CLI socket, so Knapper refuses isolated workspace creation.

## Related skills

- Use **obsidian-plugin-dev** after the workspace is ready.
- Use **obsidian-ui-automation** when the `ui` toolset is enabled.
- Use **obsidian-debugging** for console and network telemetry.
