/**
 * Degraded-mode smoke test for CI, where Obsidian cannot run.
 *
 * A desktop app is not available on a CI runner, so the live suites cannot run
 * there. What we can still assert — and what actually breaks in practice — is the
 * degraded-mode contract: with nothing to attach to, the server must still start,
 * register its tool surface, answer a status call with a diagnosis instead of a
 * stack trace, and exit when the client goes away.
 *
 * That last point is a regression guard: an attached CDP websocket previously kept
 * the event loop alive and the process lingered after every session.
 *
 *   node scripts/ci-smoke.mjs [path/to/cli.js]
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = process.argv[2] ?? join(root, "dist", "cli.js");

/** A port nothing can be listening on, so attach must fail fast. */
const DEAD_CDP = "http://127.0.0.1:1";
/**
 * Without a live Obsidian the proxied @playwright/mcp tools cannot be enumerated,
 * so only the natively implemented surface registers. Assert a floor rather than
 * an exact count so this does not become a brittle tripwire on every tool added.
 */
const MIN_TOOLS = 60;

let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

const child = spawn("node", [entry, "--toolsets", "all", "--cdp-url", DEAD_CDP], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, OBSIDIAN_BIN: "/nonexistent/obsidian" },
});

let stderr = "";
child.stderr.on("data", (c) => {
  stderr += c.toString();
});

const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === "") continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    // Clear the guard on settle. An outstanding timer keeps the Node event loop
    // alive, which would otherwise stall this script for the full timeout after
    // its last successful call.
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
    }, 30_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return promise;
}

console.log(`\nDegraded-mode smoke test: ${entry}\n`);

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ci-smoke", version: "1" },
  });
  check("initialize handshake succeeds", init.result?.serverInfo?.name !== undefined);
  check(
    "server reports a name and version",
    typeof init.result?.serverInfo?.version === "string",
    `${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`,
  );

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const listed = await send("tools/list");
  const tools = listed.result?.tools ?? [];
  check(
    "tool surface registers without Obsidian",
    tools.length >= MIN_TOOLS,
    `${tools.length} tools`,
  );

  const names = new Set(tools.map((t) => t.name));
  for (const required of ["obsidian_status", "obsidian_doctor", "obsidian_eval", "obsidian_logs"]) {
    check(`${required} is registered`, names.has(required));
  }
  check("no duplicate tool names", names.size === tools.length);
  check(
    "every tool carries a description",
    tools.every((t) => typeof t.description === "string" && t.description.length > 0),
  );

  const status = await send("tools/call", { name: "obsidian_status", arguments: {} });
  const statusText = (status.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  check("obsidian_status answers instead of crashing", statusText.length > 0);
  check(
    "status diagnoses the missing instance",
    /not running|no|unavailable|disabled/i.test(statusText),
    statusText.split("\n")[0]?.slice(0, 60),
  );

  // A tool that genuinely needs the app must fail as a clean, actionable MCP
  // error rather than a transport-level crash.
  const evaluated = await send("tools/call", {
    name: "obsidian_eval",
    arguments: { code: "1+1" },
  });
  const evalText = (evaluated.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  check("a call needing the app fails cleanly", evaluated.result?.isError === true);
  check("the failure explains how to fix it", evalText.length > 20, evalText.slice(0, 70));
} catch (e) {
  check(`smoke sequence completed`, false, e.message);
}

// Closing stdin is how an MCP client signals shutdown.
child.stdin.end();
const exited = await Promise.race([
  new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0))),
  // unref so a prompt exit is not held up by this watchdog.
  new Promise((resolve) => setTimeout(() => resolve("timeout"), 10_000).unref()),
]);
check("process exits when the client closes stdin", exited !== "timeout", `exit=${exited}`);
if (exited === "timeout") child.kill("SIGKILL");

if (failed > 0) {
  console.log(`\n${failed} check(s) failed.`);
  if (stderr.trim()) console.log(`\nserver stderr:\n${stderr.slice(-2000)}`);
  process.exit(1);
}
console.log("\nAll degraded-mode checks passed.");
