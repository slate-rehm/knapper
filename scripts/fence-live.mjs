/**
 * Live verification of the vault fence against a running Obsidian.
 *
 * The unit tests prove the fence's logic; this proves it is actually wired into
 * every path that reaches the app. It needs at least one authorized vault and one
 * unauthorized vault open at the same time, which is the situation that matters and
 * the one no mock reproduces.
 *
 * Non-destructive by design: it reads, refuses, and never writes a note. Safe to
 * run against a machine with real vaults open — that is the point.
 *
 *   AUTHORIZED=agent-vault UNAUTHORIZED=content node scripts/fence-live.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const AUTHORIZED = process.env.AUTHORIZED ?? "agent-vault";
const UNAUTHORIZED = process.env.UNAUTHORIZED ?? "content";

class McpClient {
  #child;
  #buffer = "";
  #pending = new Map();
  #nextId = 1;

  constructor(args = []) {
    this.#child = spawn("node", [join(root, "dist", "cli.js"), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.on("data", (c) => this.#onData(c));
    this.#child.stderr.on("data", (c) => {
      if (process.env.VERBOSE) process.stderr.write(c);
    });
  }

  #onData(chunk) {
    this.#buffer += chunk.toString();
    let i;
    while ((i = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, i).trim();
      this.#buffer = this.#buffer.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = this.#pending.get(msg.id);
      if (p) {
        this.#pending.delete(msg.id);
        p(msg);
      }
    }
  }

  send(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 45_000);
      this.#pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async call(name, args = {}) {
    const res = await this.send("tools/call", { name, arguments: args });
    const text = (res.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    return { text, isError: res.result?.isError === true, json: extractJson(text), raw: res };
  }

  close() {
    this.#child.stdin.end();
    this.#child.kill();
  }
}

/** The registry renders a tool's structured payload as a fenced json block. */
function extractJson(text) {
  const m = /```json\n([\s\S]*?)\n```/.exec(text);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]);
  } catch {
    return undefined;
  }
}

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${e.message}`);
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** A refusal must be the fence's, not an incidental failure that looks like one. */
function assertFenced(result, what) {
  assert(result.isError, `${what}: expected a refusal, got success — ${result.text.slice(0, 200)}`);
  assert(
    /VAULT_NOT_AUTHORIZED|not been authorized|not authorized/i.test(result.text),
    `${what}: refused for the wrong reason — ${result.text.slice(0, 300)}`,
  );
}

console.log("\n\x1b[1m=== knapper vault fence — live ===\x1b[0m");
console.log(`authorized:   ${AUTHORIZED}`);
console.log(`unauthorized: ${UNAUTHORIZED}\n`);

const client = new McpClient(["--toolsets", "all"]);
await client.send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "fence-live", version: "1" },
});

console.log("Preconditions");
await check("the authorized vault reports as authorized", async () => {
  const { json } = await client.call("obsidian_status");
  const v = (json?.vaults ?? []).find((x) => x.name === AUTHORIZED);
  assert(v, `${AUTHORIZED} is not registered with Obsidian`);
  assert(v.authorized, `${AUTHORIZED} is not authorized; run: knapper authorize ${AUTHORIZED}`);
});

await check("the unauthorized vault reports as unauthorized", async () => {
  const { json } = await client.call("obsidian_status");
  const v = (json?.vaults ?? []).find((x) => x.name === UNAUTHORIZED);
  assert(v, `${UNAUTHORIZED} is not registered`);
  assert(!v.authorized, `${UNAUTHORIZED} IS authorized — pick a different UNAUTHORIZED vault`);
});

console.log("\nReads are fenced");
await check("obsidian_files refuses on an unauthorized vault", async () =>
  assertFenced(await client.call("obsidian_files", { vault: UNAUTHORIZED }), "obsidian_files"),
);

await check("obsidian_search refuses on an unauthorized vault", async () =>
  assertFenced(
    await client.call("obsidian_search", { query: "the", vault: UNAUTHORIZED }),
    "obsidian_search",
  ),
);

await check("obsidian_eval refuses on an unauthorized vault", async () =>
  assertFenced(
    await client.call("obsidian_eval", { code: "app.vault.getName()", vault: UNAUTHORIZED }),
    "obsidian_eval",
  ),
);

await check("obsidian_read refuses on an unauthorized vault", async () =>
  assertFenced(
    await client.call("obsidian_read", { path: "README.md", vault: UNAUTHORIZED }),
    "obsidian_read",
  ),
);

console.log("\nWrites are fenced");
await check("obsidian_create refuses on an unauthorized vault", async () =>
  assertFenced(
    await client.call("obsidian_create", {
      path: "knapper-fence-probe.md",
      content: "should never exist",
      vault: UNAUTHORIZED,
    }),
    "obsidian_create",
  ),
);

await check("obsidian_delete refuses on an unauthorized vault", async () =>
  assertFenced(
    await client.call("obsidian_delete", { path: "README.md", vault: UNAUTHORIZED }),
    "obsidian_delete",
  ),
);

await check("obsidian_cli refuses a raw command on an unauthorized vault", async () =>
  assertFenced(
    await client.call("obsidian_cli", { command: "vault", vault: UNAUTHORIZED }),
    "obsidian_cli",
  ),
);

console.log("\nThe authorized vault still works");
await check("obsidian_eval reaches the authorized vault", async () => {
  const r = await client.call("obsidian_eval", {
    code: "app.vault.getName()",
    vault: AUTHORIZED,
  });
  assert(!r.isError, `expected success, got: ${r.text.slice(0, 200)}`);
  assert(r.text.includes(AUTHORIZED), `evaluated against the wrong vault: ${r.text.slice(0, 200)}`);
});

await check("obsidian_files lists the authorized vault", async () => {
  const r = await client.call("obsidian_files", { vault: AUTHORIZED });
  assert(!r.isError, `expected success, got: ${r.text.slice(0, 200)}`);
});

console.log("\nWindow targeting");
await check("obsidian_list_targets hides note names of unauthorized windows", async () => {
  const { json } = await client.call("obsidian_list_targets");
  const bad = (json ?? []).find((t) => t.vaultName === UNAUTHORIZED);
  assert(bad, `no window open for ${UNAUTHORIZED}; open it to test this`);
  assert(bad.authorized === false, "unauthorized window was marked authorized");
  assert(bad.noteName === null, `leaked the open note name: ${bad.noteName}`);
});

await check("obsidian_attach refuses to pin to an unauthorized window", async () => {
  const { json } = await client.call("obsidian_list_targets");
  const bad = (json ?? []).find((t) => t.vaultName === UNAUTHORIZED);
  assert(bad, `no window open for ${UNAUTHORIZED}`);
  assertFenced(await client.call("obsidian_attach", { targetId: bad.id }), "obsidian_attach");
});

console.log("\nProvisioning is fenced");
// These two write into `<vault>/.obsidian` on disk rather than through the CLI, so
// they used to resolve their target from the vault *registry* — and being
// registered is not consent. Both would happily install a dev symlink or flip
// community-plugin settings inside a vault the user never authorized.
await check("obsidian_link_plugin refuses to symlink into an unauthorized vault", async () => {
  const r = await client.call("obsidian_link_plugin", {
    vault: UNAUTHORIZED,
    sourceDir: root,
    pluginId: "uob-fence-probe",
  });
  assert(r.isError, "expected a refusal");
  assert(
    /VAULT_NOT_AUTHORIZED|not authorized/i.test(r.text),
    `wrong reason: ${r.text.slice(0, 200)}`,
  );
});

await check("obsidian_setup_vault refuses to configure an unauthorized vault", async () => {
  const r = await client.call("obsidian_setup_vault", { vault: UNAUTHORIZED });
  assert(r.isError, "expected a refusal");
  assert(
    /VAULT_NOT_AUTHORIZED|not authorized/i.test(r.text),
    `wrong reason: ${r.text.slice(0, 200)}`,
  );
});

console.log("\nDeletion provenance");
await check("obsidian_remove_vault refuses a vault it did not create", async () => {
  const r = await client.call("obsidian_remove_vault", { vault: UNAUTHORIZED });
  assert(r.isError, "expected a refusal");
  assert(
    /VAULT_NOT_MANAGED|did not create|not authorized/i.test(r.text),
    `wrong reason: ${r.text.slice(0, 200)}`,
  );
});

client.close();

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
