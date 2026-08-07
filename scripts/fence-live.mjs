/**
 * Live verification of the vault fence against a running Obsidian.
 *
 * The unit tests prove the fence's logic; this proves it is actually wired into
 * every path that reaches the app. It launches a private disposable workspace. If
 * that private registry has no second unauthorized window, the cross-window checks
 * skip instead of opening a user vault.
 *
 * Non-destructive by design: it reads, refuses, and never writes a note.
 *
 *   node scripts/fence-live.mjs
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDisposableWorkspace, createLiveHome, removeLiveHome } from "./lib/live-harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let AUTHORIZED;
let UNAUTHORIZED;
const CONTROL_TOOLS = new Set([
  "obsidian_agent_open",
  "obsidian_agent_close",
  "obsidian_workspace_claim_default",
  "obsidian_workspace_stop",
  "obsidian_workspace_release",
]);
let agentHandle;
let workspaceHandle;

class McpClient {
  #child;
  #buffer = "";
  #pending = new Map();
  #nextId = 1;

  constructor(args = [], env = process.env) {
    this.#child = spawn("node", [join(root, "dist", "cli.js"), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
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
    const input =
      workspaceHandle !== undefined && !CONTROL_TOOLS.has(name)
        ? { ...args, workspaceHandle }
        : args;
    const res = await this.send("tools/call", { name, arguments: input });
    if (res.error) throw new Error(`${name}: ${res.error.message}`);
    const text = (res.result?.content ?? []).map((c) => c.text ?? "").join("\n");
    return {
      text,
      isError: res.result?.isError === true,
      json: res.result?.structuredContent,
      raw: res,
    };
  }

  close() {
    this.#child.stdin.end();
    this.#child.kill();
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

const liveHome = await createLiveHome("knapper-fence-");
const client = new McpClient(["--toolsets", "all"], liveHome.env);
try {
  await client.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fence-live", version: "1" },
  });
  const isolated = await createDisposableWorkspace(client, root, {
    home: liveHome.home,
    agentLabel: "fence-live",
    label: "fence-authorized-scratch",
  });
  agentHandle = isolated.agentHandle;
  workspaceHandle = isolated.workspaceHandle;
  AUTHORIZED = isolated.session.vault?.name;
  assert(typeof AUTHORIZED === "string", "isolated workspace has no vault identity");

  // Seed a second private-profile vault while Obsidian is stopped. It receives the
  // same conspicuous session identity plugin, but no Knapper authorization record.
  // This creates the unsafe upstream-current-page condition without opening or
  // registering any user vault.
  const unauthorizedVaultId = randomBytes(8).toString("hex");
  const trustedIdentity = await client.call("obsidian_eval", {
    vault: AUTHORIZED,
    code: `localStorage.setItem(${JSON.stringify(`enable-plugin-${unauthorizedVaultId}`)}, "true")`,
  });
  assert(!trustedIdentity.isError, `identity trust seed failed: ${trustedIdentity.text}`);
  const stoppedForSeed = await client.call("obsidian_workspace_stop", { workspaceHandle });
  assert(!stoppedForSeed.isError, `workspace stop failed: ${stoppedForSeed.text}`);
  UNAUTHORIZED = `${AUTHORIZED}-unauthorized`;
  const unauthorizedPath = join(dirname(isolated.vaultPath), UNAUTHORIZED);
  await mkdir(join(unauthorizedPath, ".obsidian"), { recursive: true, mode: 0o700 });
  const { SESSION_IDENTITY_PLUGIN_ID, seedSessionIdentityPlugin } = await import(
    join(root, "dist", "session", "bootstrap.js")
  );
  await seedSessionIdentityPlugin(unauthorizedPath, isolated.session.key);
  await Promise.all([
    writeFile(
      join(unauthorizedPath, ".obsidian", "app.json"),
      JSON.stringify({ communityPluginEnabled: true }),
      "utf8",
    ),
    writeFile(
      join(unauthorizedPath, ".obsidian", "community-plugins.json"),
      `${JSON.stringify([SESSION_IDENTITY_PLUGIN_ID], null, 2)}\n`,
      "utf8",
    ),
    writeFile(join(unauthorizedPath, "private-sentinel.md"), "unauthorized private fixture\n"),
  ]);
  const registryPath = join(isolated.session.instance.userDataDir, "obsidian.json");
  const privateRegistry = JSON.parse(await readFile(registryPath, "utf8"));
  privateRegistry.vaults ??= {};
  privateRegistry.vaults[unauthorizedVaultId] = {
    path: unauthorizedPath,
    ts: Date.now(),
    open: true,
  };
  await writeFile(registryPath, `${JSON.stringify(privateRegistry, null, 2)}\n`, "utf8");
  const restartedAfterSeed = await client.call("obsidian_workspace_restart", { workspaceHandle });
  assert(!restartedAfterSeed.isError, `workspace restart failed: ${restartedAfterSeed.text}`);

  console.log("Preconditions");
  await check("the authorized vault reports as authorized", async () => {
    const { json } = await client.call("obsidian_status");
    const v = (json?.vaults ?? []).find((x) => x.name === AUTHORIZED);
    assert(v, `${AUTHORIZED} is not registered with Obsidian`);
    assert(v.authorized, `${AUTHORIZED} is not authorized; run: knapper authorize ${AUTHORIZED}`);
  });

  await check("the unauthorized vault reports as unauthorized", async () => {
    const { json } = await client.call("obsidian_status");
    const hidden = (json?.vaults ?? []).filter((entry) => entry.authorized === false);
    assert(hidden.length > 0, `no unauthorized vault is open; expected ${UNAUTHORIZED}`);
    assert(
      hidden.every((entry) => entry.name === undefined),
      "status leaked an unauthorized name",
    );
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
    assert(
      r.text.includes(AUTHORIZED),
      `evaluated against the wrong vault: ${r.text.slice(0, 200)}`,
    );
  });

  await check("obsidian_files lists the authorized vault", async () => {
    const r = await client.call("obsidian_files", { vault: AUTHORIZED });
    assert(!r.isError, `expected success, got: ${r.text.slice(0, 200)}`);
  });

  console.log("\nWindow targeting");
  await check("obsidian_list_targets hides note names of unauthorized windows", async () => {
    const { json } = await client.call("obsidian_list_targets");
    const targets = Array.isArray(json) ? json : (json?.result ?? []);
    const bad = targets.find((target) => target.authorized === false);
    assert(bad, `no window open for ${UNAUTHORIZED}; open it to test this`);
    assert(bad.title === undefined, `leaked the window title: ${bad.title}`);
    assert(bad.vaultName === undefined, `leaked the vault name: ${bad.vaultName}`);
    assert(bad.url === undefined, `leaked the target URL: ${bad.url}`);
  });

  await check("obsidian_attach refuses to pin to an unauthorized window", async () => {
    const { json } = await client.call("obsidian_list_targets");
    const targets = Array.isArray(json) ? json : (json?.result ?? []);
    const bad = targets.find((target) => target.authorized === false);
    assert(bad, `no window open for ${UNAUTHORIZED}`);
    assertFenced(
      await client.call("obsidian_attach", { targetId: bad.targetId }),
      "obsidian_attach",
    );
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
      /VAULT_NOT_AUTHORIZED|not (?:been )?authorized/i.test(r.text),
      `wrong reason: ${r.text.slice(0, 200)}`,
    );
  });

  await check("obsidian_setup_vault refuses to configure an unauthorized vault", async () => {
    const r = await client.call("obsidian_setup_vault", { vault: UNAUTHORIZED });
    assert(r.isError, "expected a refusal");
    assert(
      /VAULT_NOT_AUTHORIZED|not (?:been )?authorized/i.test(r.text),
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
} finally {
  if (workspaceHandle !== undefined) {
    await client.call("obsidian_workspace_stop", { workspaceHandle }).catch(() => undefined);
    await client.call("obsidian_workspace_release", { workspaceHandle }).catch(() => undefined);
    workspaceHandle = undefined;
  }
  if (agentHandle !== undefined) {
    await client.call("obsidian_agent_close", { agentHandle }).catch(() => undefined);
    agentHandle = undefined;
  }
  client.close();
  await removeLiveHome(liveHome.home).catch(() => undefined);
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
