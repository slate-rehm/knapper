/**
 * Live verification that real input reaches Obsidian while it is NOT focused.
 *
 * Run this from a terminal without clicking into Obsidian first. That is the whole
 * test: before scoped focus emulation, every one of these checks failed unless
 * Obsidian was the foreground window.
 *
 * It also asserts the teardown, which matters more than the feature. knapper
 * attaches to a daily-driver app, so emulation left switched on would make the
 * user's window behave as permanently focused for the rest of the session.
 *
 * The suite launches its own private profile and dynamic CDP endpoint.
 *
 *   node scripts/background-input-live.mjs
 */

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createDisposableWorkspace, createLiveHome, removeLiveHome } from "./lib/live-harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let VAULT;
const CONTROL_TOOLS = new Set([
  "obsidian_agent_open",
  "obsidian_agent_close",
  "obsidian_workspace_claim_default",
  "obsidian_workspace_stop",
  "obsidian_workspace_release",
]);
let agentHandle;
let workspaceHandle;
const execFileAsync = promisify(execFile);

const activeDesktopWindow = async () => {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return undefined;
  try {
    const { stdout } = await execFileAsync("hyprctl", ["activewindow", "-j"]);
    const window = JSON.parse(stdout);
    return { address: window.address, class: window.class, title: window.title };
  } catch {
    return undefined;
  }
};

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
      json: res.result?.structuredContent,
      isError: res.result?.isError === true,
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

const evalIn = async (client, code) => {
  const r = await client.call("obsidian_eval", { code, vault: VAULT });
  assert(!r.isError, `eval failed: ${r.text.slice(0, 200)}`);
  return r.text;
};

const closePalette = async (client) => {
  await client.call("browser_press_key", { key: "Escape" });
  await new Promise((r) => setTimeout(r, 300));
};

console.log("\n\x1b[1m=== knapper background input — live ===\x1b[0m");
console.log(`vault: ${VAULT}`);
console.log("Do NOT click into Obsidian while this runs.\n");

const liveHome = await createLiveHome("knapper-bg-input-");
const client = new McpClient(["--toolsets", "all"], liveHome.env);
await client.send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "bg-input-live", version: "1" },
});
const isolated = await createDisposableWorkspace(client, root, {
  home: liveHome.home,
  agentLabel: "bg-input-live",
  label: "background-input-scratch",
});
agentHandle = isolated.agentHandle;
workspaceHandle = isolated.workspaceHandle;
VAULT = isolated.session.vault?.name;
assert(typeof VAULT === "string", "isolated workspace has no vault identity");
const foregroundBefore = await activeDesktopWindow();

console.log("Preconditions");
await check("Obsidian is NOT the focused window (this test is meaningless otherwise)", async () => {
  const focused = await evalIn(client, "document.hasFocus()");
  assert(
    /false/.test(focused),
    "Obsidian currently has focus — click away from it and re-run, or this proves nothing",
  );
});

console.log("\nKeyboard reaches an unfocused window");
await check("Control+p opens the command palette", async () => {
  await closePalette(client);
  const r = await client.call("obsidian_exercise_hotkey", {
    keys: "Control+p",
    vault: VAULT,
    waitMs: 900,
  });
  assert(!r.isError, `hotkey failed: ${r.text.slice(0, 300)}`);
  assert(
    r.json?.verdict === "fired",
    `expected a workspace change, got verdict=${r.json?.verdict}\n${r.text.slice(0, 400)}`,
  );
  const open = await evalIn(
    client,
    "!!document.querySelector('.prompt input, .modal.mod-command-palette')",
  );
  assert(/true/.test(open), "the command palette did not open");
});

await check("typed characters reach the palette input", async () => {
  const r = await client.call("browser_press_sequentially", { text: "graph" });
  assert(!r.isError, `typing failed: ${r.text.slice(0, 200)}`);
  await new Promise((res) => setTimeout(res, 500));
  const value = await evalIn(client, "document.querySelector('.prompt input')?.value ?? ''");
  assert(/graph/.test(value), `palette input did not receive the text: ${value.slice(0, 120)}`);
});

await check("Escape closes the palette again", async () => {
  await closePalette(client);
  const open = await evalIn(
    client,
    "!!document.querySelector('.prompt input, .modal.mod-command-palette')",
  );
  assert(/false/.test(open), "the palette is still open");
});

console.log("\nInput does not steal desktop focus");
await check("the desktop foreground window is unchanged after input", async () => {
  const foregroundAfter = await activeDesktopWindow();
  if (foregroundBefore === undefined || foregroundAfter === undefined) return;
  assert(
    foregroundAfter.address === foregroundBefore.address,
    `desktop focus moved from ${foregroundBefore.class} to ${foregroundAfter.class}`,
  );
});

await check("an unpaired browser_keydown is released during MCP shutdown", async () => {
  const down = await client.call("browser_keydown", { key: "Shift" });
  assert(!down.isError, `keydown failed: ${down.text.slice(0, 200)}`);

  const held = await evalIn(client, "document.hasFocus()");
  assert(/true/.test(held), "emulation should be held open between keydown and keyup");

  // Close the session without the matching keyup; dispose must force-release.
  client.close();
  await new Promise((r) => setTimeout(r, 1200));

  const after = new McpClient(["--toolsets", "all", "--vault", VAULT], liveHome.env);
  try {
    await after.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bg-input-live-2", version: "1" },
    });
    const stopped = await after.call("obsidian_workspace_stop", { workspaceHandle });
    assert(!stopped.isError, `workspace stop failed: ${stopped.text}`);
    const released = await after.call("obsidian_workspace_release", { workspaceHandle });
    assert(!released.isError, `workspace release failed: ${released.text}`);
    workspaceHandle = undefined;
    const closed = await after.call("obsidian_agent_close", { agentHandle });
    assert(!closed.isError, `agent close failed: ${closed.text}`);
  } finally {
    after.close();
    await removeLiveHome(liveHome.home);
  }
  const foregroundAfter = await activeDesktopWindow();
  if (foregroundBefore !== undefined && foregroundAfter !== undefined) {
    assert(
      foregroundAfter.address === foregroundBefore.address,
      `desktop focus moved from ${foregroundBefore.class} to ${foregroundAfter.class}`,
    );
  }
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
