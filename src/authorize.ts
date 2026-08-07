/**
 * `knapper authorize` — the out-of-band grant.
 *
 * This is the only way a vault of real notes becomes reachable by knapper, and it
 * lives here rather than behind an MCP tool on purpose. A tool an agent can call is
 * a tool an agent will call the moment it hits a wall, which turns consent into a
 * formality. The grant has to come from the person, in their own terminal.
 *
 * Two things enforce that:
 *
 *  - An interactive TTY is required. A background agent's shell is not one, so the
 *    handshake cannot be completed from inside an automation run even though the
 *    agent can technically spawn the binary.
 *  - The vault name must be retyped. It makes the target explicit rather than
 *    something scrolled past, which matters most when several vaults have similar
 *    names.
 *
 * `revoke` deliberately has neither requirement. Withdrawing access can only ever
 * reduce what knapper may touch, so gating it would protect nothing and would make
 * the safe direction the inconvenient one.
 */

import { createInterface } from "node:readline/promises";
import { stat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { obsidianConfigPath } from "./config.js";
import { recoverVaultTransaction } from "./connection/vault-transaction.js";
import {
  forbiddenRoot,
  markerGrant,
  readGlobalConfig,
  readManagedMarker,
  removeManagedMarker,
  vaultAuthorizationRegistryPath,
  writeManagedMarker,
  type VaultEntry,
} from "./connection/vaults.js";

export interface AuthorizeIo {
  out: (line: string) => void;
  err: (line: string) => void;
  isTty: boolean;
  prompt: (question: string) => Promise<string>;
}

/** Default IO, wired to the real terminal. */
export function terminalIo(): AuthorizeIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    isTty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompt: async (question) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
  };
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return input;
}

interface ResolvedTarget {
  path: string;
  name: string;
  /** Present when Obsidian already knows this directory as a vault. */
  registered?: VaultEntry;
}

/**
 * Accept either a path or a registered vault name.
 *
 * Names are convenient but ambiguous; paths are unambiguous but tedious. Taking
 * both and always *reporting* the resolved absolute path keeps the confirmation
 * honest either way.
 */
async function resolveTarget(input: string, configPath: string): Promise<ResolvedTarget> {
  const vaults = (await readGlobalConfig(configPath))?.vaults ?? [];
  const expanded = expandHome(input);
  const looksLikePath =
    isAbsolute(expanded) || expanded.startsWith("./") || expanded.startsWith("../");

  if (!looksLikePath) {
    const match = vaults.find((v) => v.name.toLowerCase() === input.toLowerCase());
    if (match) return { path: resolve(match.path), name: match.name, registered: match };
  }

  const path = resolve(expanded);
  const registered = vaults.find((v) => v.path !== "" && resolve(v.path) === path);
  return {
    path,
    name: registered?.name ?? basename(path),
    ...(registered !== undefined ? { registered } : {}),
  };
}

export async function runAuthorize(
  input: string,
  io: AuthorizeIo,
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
  configPath = obsidianConfigPath(),
): Promise<number> {
  await recoverVaultTransaction(configPath, vaultAuthorizationRegistryPath(env), env);
  const target = await resolveTarget(input, configPath);

  const forbidden = forbiddenRoot(target.path);
  if (forbidden !== undefined) {
    io.err(`Refusing to authorize ${forbidden} (${target.path}).`);
    io.err("Point this at a vault directory, not a container for one.");
    return 1;
  }

  let isDirectory = false;
  try {
    isDirectory = (await stat(target.path)).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    io.err(`No directory at ${target.path}.`);
    io.err("Pass the vault's folder, or the name of a vault Obsidian already knows.");
    return 1;
  }

  const existing = await readManagedMarker(target.path, env);
  if (existing) {
    io.out(`"${target.name}" is already authorized (${markerGrant(existing)}).`);
    io.out(`  ${target.path}`);
    return 0;
  }

  // A vault with no .obsidian directory is usually a mistyped path rather than a
  // vault, so say so — but do not refuse: a freshly created vault has none yet.
  let looksLikeVault = false;
  try {
    looksLikeVault = (await stat(resolve(target.path, ".obsidian"))).isDirectory();
  } catch {
    looksLikeVault = false;
  }

  io.out("");
  io.out("Authorize knapper for this vault?");
  io.out("");
  io.out(`  Vault:  ${target.name}`);
  io.out(`  Path:   ${target.path}`);
  io.out(
    `  Status: ${
      target.registered
        ? "registered with Obsidian"
        : "NOT registered with Obsidian (it will not appear in the vault switcher)"
    }`,
  );
  if (!looksLikeVault) {
    io.out("  Note:   no .obsidian directory here — double-check this is the right folder.");
  }
  io.out("");
  io.out("This grants knapper — and any AI agent driving it — permission to:");
  io.out("  • read every note in this vault, including into an agent's context");
  io.out("  • create, edit, rename, move, and delete notes in it");
  io.out("  • run arbitrary JavaScript against this vault in the live app");
  io.out("");
  io.out("It does NOT allow knapper to delete the vault itself.");
  io.out("Withdraw at any time with:  knapper revoke " + JSON.stringify(target.path));
  io.out("");

  if (!io.isTty) {
    io.err("Refusing to authorize without an interactive terminal.");
    io.err("");
    io.err(
      "This confirmation exists so a person grants access, not a script or an agent. Run this " +
        "command yourself in a real terminal.",
    );
    return 1;
  }

  const answer = await io.prompt(`Type the vault name (${target.name}) to confirm: `);
  if (answer !== target.name) {
    io.err(`Cancelled — "${answer}" does not match "${target.name}". Nothing was changed.`);
    return 1;
  }

  const marker = await writeManagedMarker(target.path, now, "adopted", env, configPath);
  io.out("");
  io.out(`Authorized "${target.name}".`);
  io.out(`  Registry: ${vaultAuthorizationRegistryPath(env)}`);
  io.out(`  Granted: ${marker.authorizedAt ?? marker.createdAt}`);
  if (!target.registered) {
    io.out("");
    io.out("This vault is not registered with Obsidian yet. Open it once from the vault switcher,");
    io.out("or knapper will not find a window for it.");
  }
  return 0;
}

export async function runRevoke(
  input: string,
  io: AuthorizeIo,
  env: NodeJS.ProcessEnv = process.env,
  configPath = obsidianConfigPath(),
): Promise<number> {
  await recoverVaultTransaction(configPath, vaultAuthorizationRegistryPath(env), env);
  const target = await resolveTarget(input, configPath);
  const existing = await readManagedMarker(target.path, env);
  const removed = await removeManagedMarker(target.path, env, configPath);
  if (!removed) {
    if (existing !== undefined) {
      io.err(`"${target.name}" is still authorized, but Knapper could not match its record.`);
      io.err(`  ${target.path}`);
      io.err("The vault directory may be missing or moved. Restore it, then revoke again.");
      return 1;
    }
    io.out(`"${target.name}" was not authorized. Nothing to do.`);
    return 0;
  }

  io.out(`Revoked knapper's access to "${target.name}".`);
  io.out(`  ${target.path}`);
  if (existing !== undefined && markerGrant(existing) === "created") {
    io.out("");
    io.out("This was a Knapper-created vault. Its files are still on disk.");
    io.out("Knapper can no longer access it.");
  }
  return 0;
}

export async function runListAuthorizations(
  io: AuthorizeIo,
  env: NodeJS.ProcessEnv = process.env,
  configPath = obsidianConfigPath(),
): Promise<number> {
  await recoverVaultTransaction(configPath, vaultAuthorizationRegistryPath(env), env);
  const vaults = (await readGlobalConfig(configPath))?.vaults ?? [];
  if (vaults.length === 0) {
    io.out("Obsidian has no registered vaults.");
    return 0;
  }

  const rows = await Promise.all(
    vaults.map(async (v) => {
      const marker = v.path === "" ? undefined : await readManagedMarker(v.path, env);
      return { vault: v, grant: marker ? markerGrant(marker) : undefined };
    }),
  );

  const width = Math.max(...rows.map((r) => r.vault.name.length), 5);
  io.out("Vault".padEnd(width) + "  Access");
  io.out("-".repeat(width) + "  " + "-".repeat(40));
  for (const { vault, grant } of rows) {
    const access =
      grant === "created"
        ? "authorized (Knapper-created)"
        : grant === "adopted"
          ? "authorized by you"
          : "not authorized";
    io.out(vault.name.padEnd(width) + "  " + access);
  }

  const authorized = rows.filter((r) => r.grant !== undefined).length;
  io.out("");
  io.out(
    authorized === 0
      ? "No vault is authorized, so every vault-scoped knapper tool will refuse."
      : `${authorized} of ${rows.length} vault(s) authorized.`,
  );
  return 0;
}
