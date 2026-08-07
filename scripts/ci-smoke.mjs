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
import { rm } from "node:fs/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = process.argv[2] ?? join(root, "dist", "cli.js");
const knapHome = join(root, ".knapper-ci-smoke");
await rm(knapHome, { recursive: true, force: true });

/** A port nothing can be listening on, so attach must fail fast. */
const DEAD_CDP = "http://127.0.0.1:1";
const CONTROL_TOOL_COUNT = 17;
const ALL_TOOLSETS = [
  "core",
  "workspace",
  "ui",
  "telemetry",
  "plugin-dev",
  "editor",
  "vault",
  "devtools",
  "authoring",
];

let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

const child = spawn("node", [entry, "--cdp-url", DEAD_CDP], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, OBSIDIAN_BIN: "/nonexistent/obsidian", KNAP_HOME: knapHome },
});

let stderr = "";
child.stderr.on("data", (c) => {
  stderr += c.toString();
});

const pending = new Map();
const notifications = [];
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
    if (typeof message.method === "string" && message.id === undefined) {
      notifications.push(message.method);
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
  const controlTools = listed.result?.tools ?? [];
  check(
    "startup surface contains only control tools",
    controlTools.length === CONTROL_TOOL_COUNT,
    `${controlTools.length} tools`,
  );

  const controlNames = new Set(controlTools.map((tool) => tool.name));
  for (const required of [
    "obsidian_status",
    "obsidian_doctor",
    "obsidian_capabilities",
    "obsidian_toolsets",
    "obsidian_agent_open",
    "obsidian_workspace_claim_default",
    "obsidian_tool_catalog",
    "obsidian_toolsets_update",
  ]) {
    check(`${required} is registered`, controlNames.has(required));
  }
  check("operational tools start disabled", !controlNames.has("obsidian_eval"));

  const enabledAll = await send("tools/call", {
    name: "obsidian_toolsets_update",
    arguments: { enable: ALL_TOOLSETS },
  });
  check("all operational toolsets enable at runtime", enabledAll.result?.isError !== true);
  const expanded = await send("tools/list");
  const tools = expanded.result?.tools ?? [];
  const names = new Set(tools.map((tool) => tool.name));
  check("runtime surface expands without reconnect", tools.length > 80, `${tools.length} tools`);
  for (const required of ["browser_snapshot", "browser_click", "browser_take_screenshot"]) {
    check(`${required} is registered without Obsidian`, names.has(required));
  }
  check("no duplicate tool names", names.size === tools.length);
  check(
    "every tool carries a description",
    tools.every((t) => typeof t.description === "string" && t.description.length > 0),
  );
  check(
    "every tool declares whether it is read-only",
    tools.every((t) => typeof t.annotations?.readOnlyHint === "boolean"),
  );

  check("legacy session tools are absent", !names.has("obsidian_isolate"));

  const openedAgent = await send("tools/call", {
    name: "obsidian_agent_open",
    arguments: { label: "ci-smoke" },
  });
  const agentHandle = openedAgent.result?.structuredContent?.agentHandle;
  check("agent handle opens", typeof agentHandle === "string", String(agentHandle));
  const claimed = await send("tools/call", {
    name: "obsidian_workspace_claim_default",
    arguments: { agentHandle, label: "offline-default" },
  });
  const workspaceHandle = claimed.result?.structuredContent?.workspaceHandle;
  check(
    "default workspace handle opens",
    typeof workspaceHandle === "string",
    String(workspaceHandle),
  );

  const status = await send("tools/call", {
    name: "obsidian_status",
    arguments: { workspaceHandle },
  });
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

  const doctor = await send("tools/call", {
    name: "obsidian_doctor",
    arguments: { workspaceHandle },
  });
  const doctorText = (doctor.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  check("obsidian_doctor answers while offline", doctor.result?.isError !== true);
  check(
    "offline doctor reports the unavailable automation transport",
    /not running|stopped|CDP reachable: no/i.test(doctorText),
  );

  // A tool that genuinely needs the app must fail as a clean, actionable MCP
  // error rather than a transport-level crash.
  const evaluated = await send("tools/call", {
    name: "obsidian_eval",
    arguments: { workspaceHandle, code: "1+1" },
  });
  const evalText = (evaluated.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  check("a call needing the app fails cleanly", evaluated.result?.isError === true);
  check("the failure explains how to fix it", evalText.length > 20, evalText.slice(0, 70));

  const clicked = await send("tools/call", {
    name: "browser_click",
    arguments: { workspaceHandle, target: ".workspace" },
  });
  const clickText = (clicked.result?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  check("browser calls fail cleanly without CDP", clicked.result?.isError === true);
  check("browser failure points to obsidian_launch", /obsidian_launch|cold-start/i.test(clickText));

  const listChangesBeforeInspection = notifications.filter(
    (method) => method === "notifications/tools/list_changed",
  ).length;
  const toolsets = await send("tools/call", {
    name: "obsidian_toolsets",
    arguments: {},
  });
  check(
    "toolset report is structured and read-only",
    Array.isArray(toolsets.result?.structuredContent?.enabled) &&
      Array.isArray(toolsets.result?.structuredContent?.disabled),
  );
  const afterToolsets = await send("tools/list");
  const afterNames = new Set((afterToolsets.result?.tools ?? []).map((tool) => tool.name));
  check("toolset inspection leaves tools/list unchanged", afterNames.size === names.size);
  check("toolset control remains available", afterNames.has("obsidian_toolsets"));
  check(
    "toolset inspection emits no list_changed notification",
    notifications.filter((method) => method === "notifications/tools/list_changed").length ===
      listChangesBeforeInspection,
  );
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
await rm(knapHome, { recursive: true, force: true });

if (failed > 0) {
  console.log(`\n${failed} check(s) failed.`);
  if (stderr.trim()) console.log(`\nserver stderr:\n${stderr.slice(-2000)}`);
  process.exit(1);
}
console.log("\nAll degraded-mode checks passed.");
