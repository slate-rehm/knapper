/**
 * Live suite for isolated sessions.
 *
 * Proves the property the whole feature exists for: two agents drive Obsidian at
 * the same time and cannot see or disturb each other. Unlike the other live
 * suites this one needs no pre-launched Obsidian and no scratch vault — it
 * provisions everything through the session tools and tears it all down again.
 *
 * It also asserts the negative that matters most: restarting one session must
 * leave the other alive. That is the regression which would silently destroy
 * another agent's work, and it is invisible to any single-session test.
 *
 *   npm run sessions
 *
 * Launches two real Obsidian windows and closes them. Your own Obsidian, profile,
 * vaults, and CLI socket are untouched — asserted, not assumed.
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const REAL_SOCKET = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", ".obsidian-cli.sock");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  FAIL ${name}${detail ? `  ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
  }
}

/** Minimal JSON-RPC client over an MCP stdio child, as the other suites use. */
class McpClient {
  constructor(env) {
    this.child = spawn("node", [CLI, "--toolsets", "all", "--log-level", "error"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (c) => (this.stderr += c.toString()));
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line === "") continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const resolver = this.pending.get(msg.id);
      if (resolver) {
        this.pending.delete(msg.id);
        resolver(msg);
      }
    }
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out\n${this.stderr.slice(-1500)}`));
      }, 180_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async init() {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "sessions-live", version: "0" },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  async call(name, args = {}) {
    const res = await this.send("tools/call", { name, arguments: args });
    const content = res.result?.content ?? [];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const fenced = /```json\n([\s\S]*?)\n```/.exec(text);
    let json;
    if (fenced) {
      try {
        json = JSON.parse(fenced[1]);
      } catch {
        /* leave undefined */
      }
    }
    return { text, json, isError: res.result?.isError === true, error: res.error };
  }

  async close() {
    this.child.stdin.end();
    this.child.kill();
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const socketBefore = await stat(REAL_SOCKET).catch(() => undefined);
const home = await mkdtemp(join(tmpdir(), "knap-live-"));
const env = { KNAP_HOME: home };
console.log(`KNAP_HOME=${home}\n`);

let a;
let b;
const control = new McpClient(env);

try {
  await control.init();

  // Before spending two Obsidian launches: prove the tool refuses to take over a
  // directory that already holds notes. Seeding used to stamp its `created` marker
  // on whatever it was handed, and that marker IS the delete authority — so a user
  // vault passed here became reapable, and automatic cleanup later deleted it.
  console.log("a vault with notes in it is not a scratch vault");
  const realVault = join(home, "MyRealNotes");
  await mkdir(join(realVault, ".obsidian"), { recursive: true });
  await writeFile(join(realVault, "Important.md"), "# my life's work\n", "utf8");
  const hijack = await control.call("obsidian_create_session", {
    label: "hijack",
    vaultPath: realVault,
  });
  check("refuses a non-empty directory as a session vault", hijack.isError === true, {
    text: hijack.text.slice(0, 300),
  });
  check(
    "wrote no marker into it, so nothing can ever reap it",
    !(await exists(join(realVault, ".knapper-managed"))),
  );
  check(
    "left the notes alone",
    (await readFile(join(realVault, "Important.md"), "utf8")).includes("life's work"),
  );

  console.log("provisioning two sessions");
  const createA = await control.call("obsidian_create_session", { label: "alpha" });
  check("create session A", createA.json?.session !== undefined, createA.text.slice(0, 400));
  const createB = await control.call("obsidian_create_session", { label: "beta" });
  check("create session B", createB.json?.session !== undefined, createB.text.slice(0, 400));

  const keyA = createA.json?.session;
  const keyB = createB.json?.session;
  if (keyA === undefined || keyB === undefined)
    throw new Error("session creation failed; aborting");

  check("sessions got distinct keys", keyA !== keyB, { keyA, keyB });
  check("sessions got distinct CDP ports", createA.json.cdpUrl !== createB.json.cdpUrl, {
    a: createA.json.cdpUrl,
    b: createB.json.cdpUrl,
  });
  check("sessions got distinct vaults", createA.json.vault !== createB.json.vault, {
    a: createA.json.vault,
    b: createB.json.vault,
  });
  check(
    "each bound its own CLI socket",
    (await exists(createA.json.cliSocket)) && (await exists(createB.json.cliSocket)),
    { a: createA.json.cliSocket, b: createB.json.cliSocket },
  );

  // The user's own socket must be byte-identical: same inode, same mtime. A new
  // inode here would mean a session stole the socket their Obsidian is serving on.
  const socketAfter = await stat(REAL_SOCKET).catch(() => undefined);
  check(
    "your own CLI socket was not touched",
    socketBefore?.ino === socketAfter?.ino && socketBefore?.mtimeMs === socketAfter?.mtimeMs,
    { before: socketBefore?.ino, after: socketAfter?.ino },
  );

  console.log("\nbinding one server per session");
  a = new McpClient({ ...env, KNAP_SESSION: keyA });
  b = new McpClient({ ...env, KNAP_SESSION: keyB });
  await a.init();
  await b.init();

  const statusA = await a.call("obsidian_status");
  const statusB = await b.call("obsidian_status");
  check(
    "A's server targets A's vault",
    statusA.text.includes(createA.json.vault),
    statusA.text.slice(0, 300),
  );
  check(
    "B's server targets B's vault",
    statusB.text.includes(createB.json.vault),
    statusB.text.slice(0, 300),
  );

  console.log("\nCLI transport routes per session");
  const evalA = await a.call("obsidian_eval", { code: "app.vault.getName()" });
  const evalB = await b.call("obsidian_eval", { code: "app.vault.getName()" });
  check(
    "A evaluates in A's vault",
    evalA.text.includes(createA.json.vault),
    evalA.text.slice(0, 200),
  );
  check(
    "B evaluates in B's vault",
    evalB.text.includes(createB.json.vault),
    evalB.text.slice(0, 200),
  );
  check(
    "A and B are genuinely different instances",
    !evalA.text.includes(createB.json.vault) && !evalB.text.includes(createA.json.vault),
  );

  console.log("\nvault isolation");
  const noteA = await a.call("obsidian_create", { path: "only-in-a.md", content: "alpha" });
  check("A creates a note", !noteA.isError, noteA.text.slice(0, 200));
  const filesB = await b.call("obsidian_files");
  check("B cannot see A's note", !filesB.text.includes("only-in-a"), filesB.text.slice(0, 300));

  console.log("\nlisting");
  const list = await control.call("obsidian_list_sessions");
  check(
    "both sessions are listed live",
    (list.json ?? []).filter((s) => s.state === "live").length === 2,
    list.text.slice(0, 400),
  );

  console.log("\nrestart is scoped — the whole point");
  const pidBefore = createB.json.pid;
  const restartA = await a.call("obsidian_restart_session");
  check("A restarts", !restartA.isError, restartA.text.slice(0, 300));
  const listAfter = await control.call("obsidian_list_sessions");
  const bAfter = (listAfter.json ?? []).find((s) => s.session === keyB);
  check("B survived A's restart, same pid", bAfter?.pid === pidBefore && bAfter?.state === "live", {
    before: pidBefore,
    after: bAfter?.pid,
    state: bAfter?.state,
  });
  const evalBAfter = await b.call("obsidian_eval", { code: "app.vault.getName()" });
  check(
    "B still answers on both transports",
    evalBAfter.text.includes(createB.json.vault),
    evalBAfter.text.slice(0, 200),
  );
  const evalAAfter = await a.call("obsidian_eval", { code: "app.vault.getName()" });
  check(
    "A answers again after its restart",
    evalAAfter.text.includes(createA.json.vault),
    evalAAfter.text.slice(0, 200),
  );

  console.log("\nteardown");
  const closeA = await control.call("obsidian_close_session", { session: keyA, deleteVault: true });
  check("close A", !closeA.isError, closeA.text.slice(0, 300));
  const closeB = await control.call("obsidian_close_session", { session: keyB, deleteVault: true });
  check("close B", !closeB.isError, closeB.text.slice(0, 300));

  const remaining = await readdir(join(home, "sessions")).catch(() => []);
  check("no session directories are left behind", remaining.length === 0, { remaining });

  const listEnd = await control.call("obsidian_list_sessions");
  check(
    "no sessions remain registered",
    listEnd.text.includes("No knapper sessions"),
    listEnd.text.slice(0, 200),
  );
} finally {
  await a?.close();
  await b?.close();
  await control.close();
  await rm(home, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  ${f.name}`);
  process.exit(1);
}
