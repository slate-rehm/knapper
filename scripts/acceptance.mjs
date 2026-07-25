/**
 * End-to-end acceptance run against a live Obsidian.
 *
 * Drives the built server over real MCP stdio exactly as a client would, so this
 * exercises tool registration, schema validation, the capability router, and the
 * transports together — things unit tests with mocked CDP cannot cover.
 *
 * Prerequisites: Obsidian launched with --remote-debugging-port=9222, the CLI
 * toggle enabled, and the uob-test-vault scratch vault present.
 *
 *   node scripts/acceptance.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VAULT = "uob-test-vault";

class McpClient {
  #child;
  #buffer = "";
  #pending = new Map();
  #nextId = 1;

  constructor(args = []) {
    this.#child = spawn("node", [join(root, "dist", "cli.js"), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.#child.stderr.on("data", (chunk) => {
      if (process.env.VERBOSE) process.stderr.write(chunk);
    });
  }

  #onData(chunk) {
    this.#buffer += chunk.toString();
    let index;
    while ((index = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolver = this.#pending.get(message.id);
      if (resolver) {
        this.#pending.delete(message.id);
        resolver(message);
      }
    }
  }

  send(method, params) {
    const id = this.#nextId++;
    const promise = new Promise((resolve, reject) => {
      this.#pending.set(id, resolve);
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
      }, 90_000);
    });
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  notify(method, params) {
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize() {
    const res = await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "acceptance", version: "1" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  async call(name, args = {}) {
    const res = await this.send("tools/call", { name, arguments: args });
    if (res.error) throw new Error(`${name}: ${res.error.message}`);
    const content = res.result?.content ?? [];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const images = content.filter((c) => c.type === "image");
    return { text, images, isError: res.result?.isError === true };
  }

  close() {
    this.#child.stdin.end();
  }
}

let passed = 0;
let failed = 0;
const failures = [];

async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try {
    const detail = await fn();
    passed++;
    console.log(`PASS${detail ? ` (${detail})` : ""}`);
  } catch (e) {
    failed++;
    failures.push(`${label}: ${e.message}`);
    console.log(`FAIL — ${e.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const client = new McpClient(["--toolsets", "all", "--vault", VAULT]);

console.log("\n=== Unified Obsidian MCP — acceptance run ===\n");

const init = await client.initialize();
console.log(`server: ${init.result.serverInfo.name} v${init.result.serverInfo.version}\n`);

// ------------------------------------------------------------------ surface
console.log("Tool surface");
const listed = await client.send("tools/list");
const tools = listed.result.tools;
const names = new Set(tools.map((t) => t.name));

await check("all toolsets register a large surface", () => {
  assert(tools.length > 80, `only ${tools.length} tools`);
  return `${tools.length} tools`;
});

await check("every tool has a non-trivial description", () => {
  const bad = tools.filter((t) => !t.description || t.description.length < 40);
  assert(bad.length === 0, `thin descriptions: ${bad.map((t) => t.name).join(", ")}`);
});

await check("destructive browser tools are withheld", () => {
  const banned = ["browser_close", "browser_navigate", "browser_resize", "browser_run_code_unsafe"];
  const leaked = banned.filter((n) => names.has(n));
  assert(leaked.length === 0, `exposed: ${leaked.join(", ")}`);
});

await check("no duplicate tool names", () => {
  assert(names.size === tools.length, "duplicates present");
});

// -------------------------------------------------------------- preconditions
console.log("\nPreconditions");
await check("obsidian_doctor reports a healthy instance", async () => {
  const { text, isError } = await client.call("obsidian_doctor");
  assert(!isError, "doctor returned an error");
  // Read the structured verdict rather than pattern-matching prose, which also
  // matches the field name itself when corruption is absent.
  const corruption = /"argvCorruption":\s*(null|\{)/.exec(text);
  assert(corruption, "doctor did not report an argvCorruption verdict");
  assert(corruption[1] === "null", "argv corruption detected in user-flags.conf");
  return text.split("\n")[0]?.slice(0, 60);
});

await check("obsidian_status shows both transports live", async () => {
  const { text } = await client.call("obsidian_status");
  assert(/CLI transport: enabled/.test(text), "CLI transport not enabled");
  assert(/CDP transport: attached/.test(text), "CDP transport not attached");
});

await check("obsidian_list_targets finds the main window", async () => {
  const { text } = await client.call("obsidian_list_targets");
  assert(/\[main\]/.test(text), "no main window classified");
});

// ------------------------------------------------------------------- CLI path
console.log("\nObsidian CLI transport");
await check("obsidian_eval reaches the app object", async () => {
  const { text } = await client.call("obsidian_eval", { code: "app.vault.getName()" });
  assert(text.includes(VAULT), `got: ${text.slice(0, 80)}`);
  return text.trim().slice(0, 40);
});

await check("obsidian_commands introspects the live command table", async () => {
  const { text } = await client.call("obsidian_commands", {});
  assert(text.length > 100, "suspiciously small command list");
});

await check("obsidian_search does real content search, not path matching", async () => {
  const { text } = await client.call("obsidian_search", { query: "xylophone-marmalade" });
  assert(/Alpha/.test(text), `expected Notes/Alpha.md, got: ${text.slice(0, 120)}`);
  // The phrase appears only in the body, never in a filename, so a path-substring
  // implementation would find nothing here.
});

await check("obsidian_read returns note content", async () => {
  const { text } = await client.call("obsidian_read", { path: "Notes/Beta.md" });
  assert(/An open task/.test(text), `unexpected content: ${text.slice(0, 120)}`);
});

// ---------------------------------------------------------------- browser path
console.log("\nBrowser automation over CDP");
await check("browser_snapshot returns real Obsidian UI", async () => {
  const { text } = await client.call("browser_snapshot");
  assert(text.length > 200, "snapshot too small");
  assert(/ref=e\d+/.test(text), "no refs in snapshot");
  return `${text.length} chars`;
});

await check("obsidian_snapshot scopes to the active leaf", async () => {
  const { text } = await client.call("obsidian_snapshot", { scope: "active-leaf" });
  assert(text.length > 20, "scoped snapshot empty");
  return `${text.length} chars`;
});

await check("browser_take_screenshot returns image data", async () => {
  const { images } = await client.call("browser_take_screenshot");
  assert(images.length > 0, "no image content returned");
  return `${images[0].mimeType}`;
});

// ------------------------------------------------------------------ telemetry
console.log("\nTelemetry");
let cursorAfterMark;
await check("obsidian_logs returns a cursor", async () => {
  const { text } = await client.call("obsidian_logs", { limit: 5 });
  const match = /"cursor":\s*(\d+)/.exec(text);
  assert(match, "no cursor in response");
  cursorAfterMark = Number(match[1]);
  return `cursor=${cursorAfterMark}`;
});

await check("obsidian_log_mark inserts a marker", async () => {
  const { isError } = await client.call("obsidian_log_mark", { label: "acceptance" });
  assert(!isError, "mark failed");
});

await check("cursor tailing returns only new records", async () => {
  const before = await client.call("obsidian_logs", { limit: 1 });
  const cursor = Number(/"cursor":\s*(\d+)/.exec(before.text)?.[1]);
  // Generate exactly one new console record.
  await client.call("obsidian_eval", { code: 'console.log("acceptance-probe"), 1' });
  await new Promise((r) => setTimeout(r, 1200));
  const after = await client.call("obsidian_logs", { since: cursor });
  const matched = Number(/"matched":\s*(\d+)/.exec(after.text)?.[1] ?? -1);
  assert(matched >= 0, "no matched count returned");
  assert(matched < 50, `tailing returned ${matched} records, looks like a full replay`);
  return `${matched} new`;
});

await check("obsidian_telemetry_status reports capture armed", async () => {
  const { text } = await client.call("obsidian_telemetry_status");
  assert(/armed/i.test(text), "no armed state reported");
});

// ------------------------------------------------------------------ dev cycle
console.log("\nPlugin dev cycle");
await check("obsidian_plugin_list sees the scratch plugin", async () => {
  const { text } = await client.call("obsidian_plugin_list");
  assert(/uob-scratch/.test(text), "scratch plugin not installed/enabled");
});

await check("obsidian_dev_cycle reloads and reports", async () => {
  const { text, isError } = await client.call("obsidian_dev_cycle", { pluginId: "uob-scratch" });
  assert(!isError, `dev cycle errored: ${text.slice(0, 200)}`);
  return text.split("\n")[0]?.slice(0, 60);
});

await check("telemetry attributes a deliberate plugin throw", async () => {
  const before = await client.call("obsidian_logs", { limit: 1 });
  const cursor = Number(/"cursor":\s*(\d+)/.exec(before.text)?.[1]);
  await client.call("obsidian_exercise_command", { commandId: "uob-scratch:throw-on-purpose" });
  await new Promise((r) => setTimeout(r, 1500));
  const after = await client.call("obsidian_logs", { since: cursor, plugin: "uob-scratch" });
  assert(/uob-scratch/.test(after.text), "throw not attributed to uob-scratch");
  return "attributed";
});

// -------------------------------------------------------------- error contract
console.log("\nError contract");
await check("a bad vault name yields an actionable error", async () => {
  const { text, isError } = await client.call("obsidian_cli", {
    command: "vault",
    vault: "definitely-not-a-real-vault",
  });
  assert(isError, "expected an error result");
  assert(/vault/i.test(text), "error does not mention the vault");
});

await check("an in-page throw is reported as an eval failure, not a transport error", async () => {
  const { text, isError } = await client.call("obsidian_eval", {
    code: 'throw new Error("intentional-acceptance-throw")',
  });
  assert(isError, "expected an error result");
  assert(/intentional-acceptance-throw/.test(text), `lost the message: ${text.slice(0, 150)}`);
});

client.close();

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
