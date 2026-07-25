# Obsidian plugin dev cycle

Run a full **build → link → reload → verify** loop against the live Obsidian app using knapper.

## Prerequisites

1. Call `obsidian_doctor` and apply every remediation until CLI and CDP are healthy.
2. Call `obsidian_launch` if Obsidian is not running with `--remote-debugging-port`.

## Steps

1. **Build** the plugin on disk (`npm run build` or your bundler) in the plugin repository.
2. If not already linked: `obsidian_link_plugin` with the dev vault name and absolute `sourceDir`.
3. Run `obsidian_dev_cycle` with the plugin id (folder name under `.obsidian/plugins/`).
   - Optionally pass `openPath` to open a smoke note after reload.
4. Read the returned logs (errors since the internal mark). If something failed, call `obsidian_logs` with the returned cursor as `since` for more detail.
5. For command-centric features, run `obsidian_exercise_command` with the palette id from `obsidian_plugin_commands`.

## When to escalate

- Connection errors → run the **obsidian-doctor** command.
- UI-only bugs → use skills **obsidian-ui-automation** (`browser_snapshot` first).
- Persistent settings issues → `obsidian_reset_state` on a dev vault only.
