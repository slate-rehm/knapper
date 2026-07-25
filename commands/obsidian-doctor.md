# Obsidian connection doctor

Diagnose why knapper cannot talk to Obsidian and fix each layer explicitly.

## Run

1. Call **`obsidian_doctor`** and read the structured JSON problems list.
2. For each problem, run the suggested **`fixedBy`** tool or follow **remediation** text:
   - `OBSIDIAN_NOT_RUNNING` → `obsidian_launch`
   - `CLI_DISABLED` → `obsidian_setup_cli`
   - `CDP_PORT_CLOSED` → quit Obsidian completely, then `obsidian_launch` (single-instance lock)
   - `ARGV_CORRUPTION` → edit `user-flags.conf` to use `--` prefixes
   - `VAULT_NOT_FOUND` → fix `OBSIDIAN_VAULT` or register the vault in Obsidian
3. Call **`obsidian_status`** to confirm transports and toolsets.
4. If CDP is still missing, verify nothing else holds port `9222` and that `OBSIDIAN_CDP_URL` matches your launch flags.

## Reference

Use skill **obsidian-instance-setup** for transport tradeoffs and multi-window attach (`obsidian_list_targets`, `obsidian_attach`).
