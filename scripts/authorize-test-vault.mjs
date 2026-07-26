/**
 * Authorize the scratch vault for the live suites.
 *
 * The suites run as the user from a checkout, so they write the marker directly
 * rather than going through `knapper authorize` — that command requires an
 * interactive TTY on purpose, and a test runner does not have one. Bypassing the
 * prompt is legitimate here precisely because a human is invoking the suite; it is
 * not a hole in the fence, which is enforced inside the server.
 *
 * The marker is written as `adopted`, not `created`. `uob-test-vault` is a vault
 * someone made by hand, and tagging it `created` would make it deletable by
 * obsidian_remove_vault — a bad thing to arrange in a script that runs often.
 */

import { join } from "node:path";
import { stat } from "node:fs/promises";
import { writeManagedMarker, readManagedMarker } from "../dist/connection/vaults.js";

export const TEST_VAULT = "uob-test-vault";
export const TEST_VAULT_DIR = join(process.env.HOME, "Documents", "obsidian", TEST_VAULT);

/** Returns a short status string, or throws when the vault is missing. */
export async function authorizeTestVault(dir = TEST_VAULT_DIR) {
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(
      `Scratch vault not found at ${dir}.\n` +
        "The live suites need it. Create it in Obsidian, or point them elsewhere.",
    );
  }

  const existing = await readManagedMarker(dir);
  if (existing) return `already authorized (${existing.grant ?? "created"})`;

  await writeManagedMarker(dir, new Date(), "adopted");
  return "authorized";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const status = await authorizeTestVault();
  process.stdout.write(`${TEST_VAULT}: ${status}\n`);
}
