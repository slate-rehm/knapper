/** Remove only Knapper's generated TypeScript output before a build. */

import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist");

if (dirname(output) !== root || basename(output) !== "dist") {
  throw new Error(`Refusing to clean an unexpected build directory: ${output}`);
}

await rm(output, { recursive: true, force: true });
