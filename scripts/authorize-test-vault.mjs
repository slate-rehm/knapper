/**
 * Authorize the scratch vault for the live suites.
 *
 * The suites run as the user from a checkout, so they write an external
 * authorization record directly rather than going through `knapper authorize`.
 * That command requires an
 * interactive TTY on purpose, and a test runner does not have one. Bypassing the
 * prompt is legitimate here precisely because a human is invoking the suite; it is
 * not a hole in the fence, which is enforced inside the server.
 *
 * The grant is `adopted`, not `created`. Authorization never permits directory
 * deletion. No ownership or authorization file is written inside the vault.
 */

import { stat } from "node:fs/promises";
import { writeManagedMarker, readManagedMarker } from "../dist/connection/vaults.js";

/** Returns a short status string, or throws when the vault is missing. */
export async function authorizeTestVault(dir) {
  if (typeof dir !== "string" || dir.length === 0) {
    throw new Error("Pass an explicit vault directory to authorizeTestVault.");
  }
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
  const dir = process.argv[2];
  const status = await authorizeTestVault(dir);
  process.stdout.write(`${dir}: ${status}\n`);
}
