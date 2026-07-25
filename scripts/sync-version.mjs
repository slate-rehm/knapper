/**
 * Keep every published manifest's version in step with package.json.
 *
 * The same version string is declared in six places across five files, because
 * each distribution channel (npm, the MCP registry, and the Cursor / Claude Code /
 * Codex plugin hosts) insists on its own manifest dialect. A release that bumps
 * package.json alone ships plugin manifests that claim the previous version, which
 * is invisible locally and only shows up as a wrong version in someone's client.
 *
 *   node scripts/sync-version.mjs          # rewrite manifests from package.json
 *   node scripts/sync-version.mjs --check  # fail if any manifest has drifted (CI)
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

/**
 * Every version field we own, as a path into the parsed JSON. Add to this list
 * rather than hand-editing a manifest, or the next release drifts again.
 */
const TARGETS = [
  { file: "server.json", paths: [["version"], ["packages", 0, "version"]] },
  { file: ".cursor-plugin/plugin.json", paths: [["version"]] },
  { file: ".claude-plugin/plugin.json", paths: [["version"]] },
  { file: ".codex-plugin/plugin.json", paths: [["version"]] },
];

function getIn(obj, path) {
  return path.reduce((acc, key) => (acc === undefined || acc === null ? undefined : acc[key]), obj);
}

function setIn(obj, path, value) {
  const last = path[path.length - 1];
  const parent = path.slice(0, -1).reduce((acc, key) => acc?.[key], obj);
  if (parent === undefined) throw new Error(`cannot resolve path ${path.join(".")}`);
  parent[last] = value;
}

const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`package.json has a malformed version: ${JSON.stringify(version)}`);
  process.exit(1);
}

let drifted = 0;
let rewrote = 0;

for (const { file, paths } of TARGETS) {
  const abs = join(root, file);
  let raw;
  try {
    raw = await readFile(abs, "utf8");
  } catch {
    console.error(`missing manifest: ${file}`);
    drifted++;
    continue;
  }

  const json = JSON.parse(raw);
  let changed = false;

  for (const path of paths) {
    const current = getIn(json, path);
    if (current === version) continue;
    const where = `${file}#${path.join(".")}`;
    if (check) {
      console.error(`  drift: ${where} is ${JSON.stringify(current)}, expected ${version}`);
      drifted++;
    } else {
      setIn(json, path, version);
      console.log(`  set ${where} -> ${version}`);
      changed = true;
    }
  }

  if (changed) {
    // Preserve the trailing newline convention the formatter enforces.
    await writeFile(abs, `${JSON.stringify(json, null, 2)}\n`);
    rewrote++;
  }
}

if (check) {
  if (drifted > 0) {
    console.error(
      `\n${drifted} manifest version(s) out of sync with package.json (${version}).\n` +
        `Run: node scripts/sync-version.mjs`,
    );
    process.exit(1);
  }
  console.log(`all manifests agree on version ${version}`);
} else {
  console.log(rewrote === 0 ? `already in sync at ${version}` : `synced ${rewrote} manifest(s)`);
}
