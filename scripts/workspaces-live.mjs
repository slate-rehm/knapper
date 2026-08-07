/**
 * Live isolation and lifecycle suite for explicit workspace handles.
 *
 * This suite creates only Knapper-owned scratch vaults. It snapshots the user's
 * Obsidian vault registry before launch and requires byte-for-byte equality after
 * create, reconnect, restart, release, and destroy operations.
 *
 *   npm run workspaces
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { quarantineSession, stopSession } from "../dist/session/registry.js";
import { obsidianConfigPath } from "../dist/config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const TEST_ROOT = await mkdtemp(join(tmpdir(), "knapper-workspaces-"));
const CONTROL_TOOLS = new Set([
  "obsidian_agent_open",
  "obsidian_agent_status",
  "obsidian_agent_close",
  "obsidian_workspace_create",
  "obsidian_workspace_claim_default",
  "obsidian_workspace_list",
  "obsidian_workspace_status",
  "obsidian_workspace_stop",
  "obsidian_workspace_restart",
  "obsidian_workspace_release",
  "obsidian_workspace_destroy",
  "obsidian_toolsets",
  "obsidian_tool_catalog",
]);

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
    this.child.stderr.on("data", (chunk) => (this.stderr += chunk.toString()));
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolver = this.pending.get(message.id);
      if (resolver !== undefined) {
        this.pending.delete(message.id);
        resolver(message);
      }
    }
  }

  send(method, params) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out\n${this.stderr.slice(-1500)}`));
      }, 180_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolvePromise(message);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async init() {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "workspaces-live", version: "1" },
    });
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
  }

  async call(name, args = {}) {
    const input =
      this.workspaceHandle !== undefined && !CONTROL_TOOLS.has(name)
        ? { ...args, workspaceHandle: this.workspaceHandle }
        : args;
    const response = await this.send("tools/call", { name, arguments: input });
    if (response.error !== undefined) {
      throw new Error(`${name}: ${response.error.message ?? JSON.stringify(response.error)}`);
    }
    const content = response.result?.content ?? [];
    return {
      text: content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n"),
      json: response.result?.structuredContent,
      isError: response.result?.isError === true,
      error: response.error,
    };
  }

  async close() {
    this.child.stdin.end();
    await Promise.race([
      new Promise((resolvePromise) => this.child.once("exit", resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 10_000).unref()),
    ]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
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

async function registryBytes() {
  try {
    return await readFile(obsidianConfigPath());
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function workspaceInternals(home, workspaceHandle) {
  const workspace = JSON.parse(
    await readFile(join(home, "workspaces", `${workspaceHandle}.json`), "utf8"),
  );
  const descriptor = JSON.parse(
    await readFile(join(home, "sessions", workspace.sessionKey, "session.json"), "utf8"),
  );
  return { workspace, descriptor };
}

const home = await mkdtemp(join(TEST_ROOT, "w-"));
const env = { KNAP_HOME: home };
const registryBefore = await registryBytes();
const protectedVault = join(TEST_ROOT, "user-owned-vault");
await mkdir(join(protectedVault, ".obsidian"), { recursive: true });
await writeFile(join(protectedVault, "Important.md"), "protected test content\n", "utf8");

let client = new McpClient(env);
let agentA;
let agentB;
let workspaceA;
let workspaceB;
let retainedWorkspace;

try {
  await client.init();

  const openA = await client.call("obsidian_agent_open", {
    label: "workspace-live-a",
    purpose: "isolation and lifecycle validation",
    cwd: ROOT,
  });
  const openB = await client.call("obsidian_agent_open", {
    label: "workspace-live-b",
    purpose: "cross-workspace routing validation",
    cwd: ROOT,
  });
  agentA = openA.json?.agentHandle;
  agentB = openB.json?.agentHandle;
  check(
    "two explicit agent handles open",
    typeof agentA === "string" && typeof agentB === "string",
  );

  const createA = await client.call("obsidian_workspace_create", {
    agentHandle: agentA,
    label: "alpha",
  });
  const createB = await client.call("obsidian_workspace_create", {
    agentHandle: agentB,
    label: "beta",
  });
  workspaceA = createA.json?.workspaceHandle;
  workspaceB = createB.json?.workspaceHandle;
  check(
    "two isolated workspaces start",
    typeof workspaceA === "string" && typeof workspaceB === "string" && workspaceA !== workspaceB,
    { createA: createA.text, createB: createB.text },
  );
  if (typeof workspaceA !== "string" || typeof workspaceB !== "string") {
    throw new Error("workspace creation failed; remaining isolation checks cannot run");
  }

  const internalA = await workspaceInternals(home, workspaceA);
  const internalB = await workspaceInternals(home, workspaceB);
  check(
    "workspace creation uses a Knapper-owned vault",
    resolve(internalA.descriptor.vault.path).startsWith(resolve(home)),
    internalA.descriptor.vault.path,
  );
  check(
    "scratch vaults use distinct exact workspace roots",
    internalA.descriptor.vault.path !== internalB.descriptor.vault.path &&
      internalA.descriptor.vault.path.startsWith(home) &&
      internalB.descriptor.vault.path.startsWith(home),
  );
  check(
    "no in-vault management marker grants deletion",
    !(await exists(join(internalA.descriptor.vault.path, ".knapper-managed"))) &&
      !(await exists(join(protectedVault, ".knapper-managed"))),
  );
  check(
    "the caller-owned vault remains unchanged",
    (await readFile(join(protectedVault, "Important.md"), "utf8")) === "protected test content\n",
  );

  client.workspaceHandle = workspaceA;
  const createNoteA = await client.call("obsidian_create", {
    path: "alpha-only.txt",
    content: "alpha",
  });
  check("workspace A accepts a vault mutation", !createNoteA.isError, createNoteA.text);

  client.workspaceHandle = workspaceB;
  const filesB = await client.call("obsidian_files");
  check(
    "workspace B cannot see workspace A's note",
    !filesB.text.includes("alpha-only"),
    filesB.text,
  );

  const evalB = await client.call("obsidian_eval", { code: "app.vault.getName()" });
  client.workspaceHandle = workspaceA;
  const evalA = await client.call("obsidian_eval", { code: "app.vault.getName()" });
  check(
    "workspace handles route to different live apps",
    evalA.text.includes(internalA.descriptor.vault.name) &&
      evalB.text.includes(internalB.descriptor.vault.name),
    { a: evalA.text, b: evalB.text },
  );

  await client.close();
  check(
    "isolated Obsidian processes survive MCP teardown",
    await exists(join(internalA.descriptor.instance.userDataDir, "DevToolsActivePort")),
  );

  client = new McpClient(env);
  await client.init();
  const listed = await client.call("obsidian_workspace_list");
  const listedHandles = new Set(
    (listed.json?.workspaces ?? []).map((item) => item.workspaceHandle),
  );
  check(
    "a new MCP process discovers both durable workspaces",
    listedHandles.has(workspaceA) && listedHandles.has(workspaceB),
    listed.json,
  );

  const restartA = await client.call("obsidian_workspace_restart", { workspaceHandle: workspaceA });
  check("workspace A restarts through its explicit handle", !restartA.isError, restartA.text);
  client.workspaceHandle = workspaceB;
  const bAfterRestart = await client.call("obsidian_eval", { code: "app.vault.getName()" });
  check(
    "restarting A leaves B reachable and correctly routed",
    bAfterRestart.text.includes(internalB.descriptor.vault.name),
    bAfterRestart.text,
  );

  const retained = await client.call("obsidian_workspace_create", {
    agentHandle: agentA,
    label: "retained",
  });
  retainedWorkspace = retained.json?.workspaceHandle;
  check("a retained workspace is created", typeof retainedWorkspace === "string", retained.text);
  if (typeof retainedWorkspace !== "string") {
    throw new Error("retained workspace creation failed; release checks cannot run");
  }
  const retainedInternal = await workspaceInternals(home, retainedWorkspace);
  client.workspaceHandle = retainedWorkspace;
  await client.call("obsidian_log_mark", { label: "retained-telemetry" });
  await client.call("obsidian_workspace_stop", { workspaceHandle: retainedWorkspace });
  const released = await client.call("obsidian_workspace_release", {
    workspaceHandle: retainedWorkspace,
  });
  check("release removes the handle without deleting the scratch vault", !released.isError);
  check(
    "released scratch vault remains on disk",
    await exists(retainedInternal.descriptor.vault.path),
  );
  check(
    "release archives workspace telemetry beside the retained vault",
    typeof released.json?.telemetryArchive === "string" &&
      resolve(released.json.telemetryArchive).startsWith(
        resolve(retainedInternal.descriptor.instance.userDataDir, ".."),
      ) &&
      (await readFile(released.json.telemetryArchive, "utf8")).includes("retained-telemetry"),
    released.json,
  );

  client.workspaceHandle = workspaceA;
  await client.call("obsidian_log_mark", { label: "destroy-a-telemetry" });
  client.workspaceHandle = workspaceB;
  await client.call("obsidian_log_mark", { label: "destroy-b-telemetry" });

  await client.call("obsidian_workspace_stop", { workspaceHandle: workspaceA });
  await client.call("obsidian_workspace_stop", { workspaceHandle: workspaceB });

  const destroyedA = await client.call("obsidian_workspace_destroy", {
    workspaceHandle: workspaceA,
  });
  const destroyedB = await client.call("obsidian_workspace_destroy", {
    workspaceHandle: workspaceB,
  });
  for (const [label, result] of [
    ["A", destroyedA],
    ["B", destroyedB],
  ]) {
    check(`destroy ${label} succeeds`, !result.isError, result.text);
    check(
      `destroy ${label} quarantines inside KNAP_HOME`,
      typeof result.json?.quarantinedPath === "string" &&
        resolve(result.json.quarantinedPath).startsWith(resolve(join(home, "trash"))) &&
        (await exists(result.json.quarantinedPath)),
      result.json,
    );
    check(
      `destroy ${label} moves telemetry into the quarantine`,
      typeof result.json?.telemetryArchive === "string" &&
        resolve(result.json.telemetryArchive).startsWith(resolve(result.json.quarantinedPath)) &&
        (await exists(result.json.telemetryArchive)),
      result.json,
    );
  }

  const registryAfter = await registryBytes();
  check(
    "the user's Obsidian vault registry is byte-for-byte unchanged",
    registryBefore === undefined
      ? registryAfter === undefined
      : registryAfter !== undefined && registryBefore.equals(registryAfter),
  );
  check(
    "the user-owned vault is still present after all cleanup",
    (await readFile(join(protectedVault, "Important.md"), "utf8")) === "protected test content\n",
  );

  await client.call("obsidian_agent_close", { agentHandle: agentB });
  const closeAWithRetained = await client.call("obsidian_agent_close", { agentHandle: agentA });
  check("released workspaces do not block agent close", !closeAWithRetained.isError);
  const workspaceRecords = await readdir(join(home, "workspaces")).catch(() => []);
  check(
    "no workspace records remain",
    workspaceRecords.filter((name) => name.endsWith(".json")).length === 0,
  );
} finally {
  await client.close().catch(() => undefined);
  const internalKeys = await readdir(join(home, "sessions")).catch(() => []);
  let cleanupSafe = true;
  for (const key of internalKeys) {
    const cleanupEnv = { ...process.env, KNAP_HOME: home };
    const stopped = await stopSession(key, { env: cleanupEnv }).catch(() => undefined);
    if (stopped?.state === "quitFailed") {
      cleanupSafe = false;
      console.error(`Preserving ${home}: Obsidian for ${key} did not stop.`);
      continue;
    }
    await quarantineSession(key, { env: cleanupEnv }).catch(() => undefined);
  }
  if (cleanupSafe) await rm(TEST_ROOT, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const failure of failures) console.log(`  ${failure.name}`);
  process.exit(1);
}
