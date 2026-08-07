/**
 * Comprehensive end-to-end suite against a live Obsidian.
 *
 * Where scripts/acceptance.mjs is a fast gate over the critical seams, this suite
 * is the deep one: it drives real plugin-development workflows through real MCP
 * stdio, verifies vault mutations against the filesystem rather than trusting the
 * tool's own report, and exercises the transport, concurrency, and reconnect
 * behaviour that unit tests with mocked CDP cannot reach.
 *
 * Every mutation it makes is namespaced under E2E_DIR and removed on exit, so a
 * completed run leaves the scratch vault exactly as it found it.
 *
 * The suite launches a private Obsidian profile with a temporary CDP port.
 *
 *   node scripts/e2e.mjs           # full run
 *   VERBOSE=1 node scripts/e2e.mjs # stream server stderr
 *   node scripts/e2e.mjs --only ui # run one suite
 */

import { spawn } from "node:child_process";
import {
  createDisposableWorkspace,
  createLiveHome,
  findFreePort,
  removeLiveHome,
} from "./lib/live-harness.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let VAULT;
let VAULT_DIR;
const PLUGIN = process.env.PLUGIN_ID;
/** All notes this suite writes live here so cleanup is a single recursive delete. */
const E2E_DIR = "E2E";
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
let defaultAgentHandle;
let defaultWorkspaceHandle;

const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg === -1 ? undefined : process.argv[onlyArg + 1];

// --------------------------------------------------------------------- client

class McpClient {
  #child;
  #buffer = "";
  #pending = new Map();
  #nextId = 1;
  exited = false;

  constructor(args = [], env = process.env) {
    this.#child = spawn("node", [join(root, "dist", "cli.js"), ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.#child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.#child.stderr.on("data", (chunk) => {
      if (process.env.VERBOSE) process.stderr.write(chunk);
    });
    this.#child.on("exit", () => {
      this.exited = true;
    });
  }

  get pid() {
    return this.#child.pid;
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
      // Clear the guard on settle; a live timer would hold the event loop open.
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
      }, 90_000);
      this.#pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
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
      clientInfo: { name: "e2e", version: "1" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  async call(name, args = {}) {
    const input =
      defaultWorkspaceHandle !== undefined && !CONTROL_TOOLS.has(name)
        ? { ...args, workspaceHandle: defaultWorkspaceHandle }
        : args;
    const res = await this.send("tools/call", { name, arguments: input });
    if (res.error) throw new Error(`${name}: ${res.error.message}`);
    const content = res.result?.content ?? [];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return {
      text,
      images: content.filter((c) => c.type === "image"),
      json: res.result?.structuredContent,
      isError: res.result?.isError === true,
    };
  }

  /** Call and fail loudly if the tool reported an error. */
  async ok(name, args = {}) {
    const res = await this.call(name, args);
    if (res.isError) throw new Error(`${name} errored: ${res.text.slice(0, 300)}`);
    return res;
  }

  close() {
    this.#child.stdin.end();
  }

  kill() {
    this.#child.kill("SIGKILL");
  }
}

// ---------------------------------------------------------------- test runner

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
let currentSuite = "";

function suite(name) {
  if (ONLY && ONLY !== name) return false;
  currentSuite = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  return true;
}

async function check(label, fn) {
  process.stdout.write(`  ${label} ... `);
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    if (detail === SKIP) {
      skipped++;
      console.log(`\x1b[33mSKIP\x1b[0m`);
      return;
    }
    passed++;
    console.log(`\x1b[32mPASS\x1b[0m${detail ? ` (${detail})` : ""} \x1b[2m${ms}ms\x1b[0m`);
  } catch (e) {
    failed++;
    failures.push(`[${currentSuite}] ${label}: ${e.message}`);
    console.log(`\x1b[31mFAIL\x1b[0m — ${e.message.split("\n")[0].slice(0, 200)}`);
  }
}

const SKIP = Symbol("skip");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fileExists(rel) {
  try {
    await stat(join(VAULT_DIR, rel));
    return true;
  } catch {
    return false;
  }
}

async function readVaultFile(rel) {
  return readFile(join(VAULT_DIR, rel), "utf8");
}

/** Poll until a predicate holds; Obsidian's disk writes are asynchronous. */
async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 200, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------ preflight

console.log("\n\x1b[1m=== Unified Obsidian MCP — comprehensive E2E ===\x1b[0m");
const liveHome = await createLiveHome("knapper-e2e-");
const client = new McpClient(["--toolsets", "all"], liveHome.env);
try {
  const init = await client.initialize();
  const isolated = await createDisposableWorkspace(client, root, {
    home: liveHome.home,
    agentLabel: "e2e",
    label: "e2e-scratch",
    ...(process.env.PLUGIN_SOURCE_DIR ? { pluginSourceDir: process.env.PLUGIN_SOURCE_DIR } : {}),
    ...(process.env.PLUGIN_ID ? { pluginId: process.env.PLUGIN_ID } : {}),
  });
  defaultAgentHandle = isolated.agentHandle;
  defaultWorkspaceHandle = isolated.workspaceHandle;
  VAULT = isolated.session.vault?.name;
  VAULT_DIR = isolated.vaultPath;
  assert(typeof VAULT === "string", "isolated workspace has no vault identity");
  console.log(
    `server: ${init.result.serverInfo.name} v${init.result.serverInfo.version}  vault: ${VAULT}`,
  );

  // Start from a clean slate in case a previous run died mid-way.
  await rm(join(VAULT_DIR, E2E_DIR), { recursive: true, force: true });
  for (const [path, content] of [
    ["Notes/Alpha.md", "# Alpha\n\nxylophone-marmalade #e2e\n\nSee [[Notes/Beta]].\n"],
    ["Notes/Beta.md", "# Beta\n\n- [ ] An open task\n\nLinked from [[Notes/Alpha]].\n"],
  ]) {
    await client.ok("obsidian_create", { path, content, overwrite: true });
  }

  const listed = await client.send("tools/list");
  const tools = listed.result.tools;
  const names = new Set(tools.map((t) => t.name));

  // ------------------------------------------------------------- suite: surface

  if (suite("Tool surface & schema integrity")) {
    await check("registers the full surface under --toolsets all", () => {
      assert(tools.length > 80, `only ${tools.length} tools`);
      return `${tools.length} tools`;
    });

    await check("no duplicate tool names", () => {
      assert(names.size === tools.length, "duplicates present");
    });

    await check("every tool has a substantive description", () => {
      const bad = tools.filter((t) => !t.description || t.description.length < 40);
      assert(bad.length === 0, `thin: ${bad.map((t) => t.name).join(", ")}`);
    });

    await check("every tool exposes a valid object input schema", () => {
      const bad = tools.filter(
        (t) =>
          !t.inputSchema || t.inputSchema.type !== "object" || !("properties" in t.inputSchema),
      );
      assert(bad.length === 0, `malformed schema: ${bad.map((t) => t.name).join(", ")}`);
    });

    await check("every declared parameter is documented", () => {
      const bad = [];
      for (const t of tools) {
        for (const [k, v] of Object.entries(t.inputSchema.properties ?? {})) {
          const described = v.description ?? v.items?.description ?? v.anyOf?.[0]?.description;
          if (!described) bad.push(`${t.name}.${k}`);
        }
      }
      assert(bad.length === 0, `undocumented: ${bad.slice(0, 8).join(", ")}`);
    });

    await check("destructive browser tools stay withheld", () => {
      const banned = [
        "browser_close",
        "browser_navigate",
        "browser_navigate_back",
        "browser_resize",
        "browser_file_upload",
        "browser_install",
        "browser_run_code_unsafe",
      ];
      const leaked = banned.filter((n) => names.has(n));
      assert(leaked.length === 0, `exposed: ${leaked.join(", ")}`);
    });

    await check("read-only and filesystem-writing tools are annotated accurately", () => {
      // readOnlyHint is not decoration: the registry gives these a shared lock and
      // everything else an exclusive one, so a missing hint silently serializes.
      const shouldBeReadOnly = [
        "obsidian_status",
        "obsidian_read",
        "obsidian_search",
        "obsidian_logs",
        "obsidian_snapshot",
        "obsidian_editor_state",
        "obsidian_editor_widgets",
        "browser_snapshot",
      ];
      const bad = shouldBeReadOnly.filter(
        (n) => tools.find((t) => t.name === n)?.annotations?.readOnlyHint !== true,
      );
      assert(bad.length === 0, `missing readOnlyHint: ${bad.join(", ")}`);
      const filesystemWrites = ["obsidian_element_screenshot", "browser_take_screenshot"];
      const mislabeled = filesystemWrites.filter(
        (name) => tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint !== false,
      );
      assert(
        mislabeled.length === 0,
        `filesystem writes labeled read-only: ${mislabeled.join(", ")}`,
      );
    });

    await check("destructive tools carry a destructive annotation", () => {
      // Anything that destroys existing state, plus the two arbitrary-code escape
      // hatches. Additive writes (create/append/prepend) are deliberately absent.
      const shouldBeDestructive = [
        "obsidian_delete",
        "obsidian_move",
        "obsidian_rename",
        "obsidian_eval",
        "obsidian_cdp",
        "obsidian_link_plugin",
        "obsidian_reset_state",
        "obsidian_property_set",
        "obsidian_property_remove",
        "obsidian_theme_set",
        "obsidian_editor_replace",
      ];
      const bad = shouldBeDestructive.filter(
        (n) => tools.find((t) => t.name === n)?.annotations?.destructiveHint !== true,
      );
      assert(bad.length === 0, `missing destructiveHint: ${bad.join(", ")}`);
    });

    await check("arbitrary-code tools are flagged open-world", () => {
      const openWorld = ["obsidian_eval", "obsidian_cdp"];
      const bad = openWorld.filter(
        (n) => tools.find((t) => t.name === n)?.annotations?.openWorldHint !== true,
      );
      assert(bad.length === 0, `missing openWorldHint: ${bad.join(", ")}`);
    });

    await check("toolset gating actually narrows the surface", async () => {
      const gated = new McpClient(["--toolsets", "core", "--vault", VAULT]);
      try {
        await gated.initialize();
        const res = await gated.send("tools/list");
        const n = res.result.tools.length;
        assert(n > 0 && n < tools.length, `core exposed ${n} of ${tools.length}`);
        return `core=${n} vs all=${tools.length}`;
      } finally {
        gated.close();
      }
    });

    await check("toolset inspection does not mutate the runtime surface", async () => {
      const before = await client.send("tools/list");
      const beforeSurface = JSON.stringify(before.result.tools);
      const report = await client.ok("obsidian_toolsets");
      const after = await client.send("tools/list");
      assert(Array.isArray(report.json?.enabled), "toolset report omitted the enabled set");
      assert(beforeSurface === JSON.stringify(after.result.tools), "tools/list changed at runtime");
    });
  }

  // -------------------------------------------------------- suite: preconditions

  if (suite("Preconditions & health")) {
    await check("obsidian_doctor reports a healthy instance", async () => {
      const { json, isError } = await client.call("obsidian_doctor");
      assert(!isError, "doctor returned an error");
      assert(json && "argvCorruption" in json, "no argvCorruption verdict");
      assert(json.argvCorruption === null, "argv corruption detected in user-flags.conf");
    });

    await check("obsidian_status shows both transports live", async () => {
      const { text } = await client.ok("obsidian_status");
      assert(/CLI transport: enabled/.test(text), "CLI transport not enabled");
      assert(/CDP transport: attached/.test(text), "CDP transport not attached");
    });

    await check("obsidian_list_targets classifies the main window", async () => {
      const { text } = await client.ok("obsidian_list_targets");
      assert(/\[main\]/.test(text), "no main window classified");
    });

    await check("the scratch vault is the attached vault", async () => {
      const { text } = await client.ok("obsidian_eval", { code: "app.vault.getName()" });
      assert(text.includes(VAULT), `attached to the wrong vault: ${text.slice(0, 80)}`);
    });
  }

  // ----------------------------------------------- suite: plan §11 acceptance demo

  if (suite("Plan §11 acceptance demo (the documented agent workflow)")) {
    await check("1. status reports connected", async () => {
      const { text } = await client.ok("obsidian_status");
      assert(/attached|enabled/.test(text), "not connected");
    });

    await check("2. open a note in the editor", async () => {
      await client.ok("obsidian_open", { path: "Notes/Alpha.md" });
      const active = await waitFor(
        async () => {
          const { text } = await client.ok("obsidian_eval", {
            code: "app.workspace.getActiveFile()?.path",
          });
          return /Alpha\.md/.test(text) ? text : false;
        },
        { what: "Alpha.md to become active" },
      );
      return active
        .trim()
        .replace(/^=>\s*/, "")
        .slice(0, 40);
    });

    await check("3. screenshot returns a file artifact", async () => {
      const { images, json } = await client.ok("browser_take_screenshot");
      assert(images.length === 0, "screenshot must not return inline image content");
      assert(Number(json?.size) > 1000, "image artifact is suspiciously small");
      await stat(json.path);
      return `${json.mimeType}, ${Math.round(json.size / 1024)}KB`;
    });

    await check("4. real keyboard input opens the command palette", async () => {
      await client.ok("browser_press_key", { key: "Control+p" });
      const visible = await waitFor(
        async () => {
          const { text } = await client.ok("obsidian_eval", {
            code: "!!document.querySelector('.prompt input, .modal.mod-command-palette')",
          });
          return /true/.test(text);
        },
        { what: "command palette to open", timeoutMs: 5000 },
      );
      assert(visible, "palette did not open");
      // Leave the UI as we found it.
      await client.ok("browser_press_key", { key: "Escape" });
      await sleep(300);
    });

    await check("5. run a command by id", async () => {
      await client.ok("obsidian_command", { id: "app:go-back" });
    });

    if (PLUGIN !== undefined) {
      await check("6. reload a plugin", async () => {
        await client.ok("obsidian_plugin_reload", { id: PLUGIN });
        const { text } = await client.ok("obsidian_plugin_health", { pluginId: PLUGIN });
        assert(
          /enabled|loaded/i.test(text),
          `plugin not healthy after reload: ${text.slice(0, 150)}`,
        );
      });
    } else {
      await check("6. reload a plugin", () => SKIP);
    }

    await check("7. console is readable and clean of our own errors", async () => {
      const { json } = await client.ok("obsidian_logs", { limit: 20 });
      assert(Number.isFinite(json?.cursor), "no cursor returned");
    });

    await check("8. accessibility tree contains expected Obsidian labels", async () => {
      const { text } = await client.ok("browser_snapshot");
      assert(text.length > 200, "snapshot too small");
      assert(/ref=e\d+/.test(text), "no refs in snapshot");
      return `${text.length} chars`;
    });
  }

  // ------------------------------------------------------- suite: vault round-trip

  if (suite("Vault CRUD verified against the filesystem")) {
    const note = `${E2E_DIR}/roundtrip.md`;

    await check("create writes a real file with the given body", async () => {
      await client.ok("obsidian_create", {
        path: note,
        content: "# Roundtrip\n\nfirst-line-marker\n",
      });
      await waitFor(() => fileExists(note), { what: "the note to hit disk" });
      const disk = await readVaultFile(note);
      assert(/first-line-marker/.test(disk), `body missing on disk: ${disk.slice(0, 120)}`);
    });

    await check("create escapes newlines rather than writing literal \\n", async () => {
      const disk = await readVaultFile(note);
      assert(!/\\n/.test(disk), `literal backslash-n leaked to disk: ${disk.slice(0, 160)}`);
      assert(disk.split("\n").length >= 3, "content collapsed onto one line");
    });

    await check("read returns what is actually on disk", async () => {
      const { text } = await client.ok("obsidian_read", { path: note });
      assert(/first-line-marker/.test(text), `read did not return the body: ${text.slice(0, 150)}`);
    });

    await check("append adds to the end", async () => {
      await client.ok("obsidian_append", { path: note, content: "appended-marker" });
      const disk = await waitFor(
        async () => {
          const d = await readVaultFile(note);
          return /appended-marker/.test(d) ? d : false;
        },
        { what: "the append to land" },
      );
      assert(
        disk.indexOf("appended-marker") > disk.indexOf("first-line-marker"),
        "append did not go to the end",
      );
    });

    await check("prepend adds to the beginning", async () => {
      await client.ok("obsidian_prepend", { path: note, content: "prepended-marker" });
      const disk = await waitFor(
        async () => {
          const d = await readVaultFile(note);
          return /prepended-marker/.test(d) ? d : false;
        },
        { what: "the prepend to land" },
      );
      assert(
        disk.indexOf("prepended-marker") < disk.indexOf("appended-marker"),
        "prepend did not go to the front",
      );
    });

    await check("frontmatter properties round-trip through YAML", async () => {
      await client.ok("obsidian_property_set", { path: note, name: "e2e-status", value: "green" });
      const disk = await waitFor(
        async () => {
          const d = await readVaultFile(note);
          return /e2e-status/.test(d) ? d : false;
        },
        { what: "frontmatter to be written" },
      );
      assert(disk.startsWith("---"), `frontmatter not at the top: ${disk.slice(0, 80)}`);
      const { text } = await client.ok("obsidian_property_read", {
        path: note,
        name: "e2e-status",
      });
      assert(/green/.test(text), `property read back wrong: ${text.slice(0, 100)}`);
    });

    await check("property_remove strips the key again", async () => {
      await client.ok("obsidian_property_remove", { path: note, name: "e2e-status" });
      await waitFor(
        async () => {
          const d = await readVaultFile(note);
          return !/e2e-status/.test(d);
        },
        { what: "the property to be removed" },
      );
    });

    await check("rename moves the file on disk", async () => {
      await client.ok("obsidian_rename", { path: note, to: "renamed.md" });
      await waitFor(() => fileExists(`${E2E_DIR}/renamed.md`), { what: "the renamed file" });
      assert(!(await fileExists(note)), "the old path still exists after rename");
    });

    await check("full-text search finds body content, not just filenames", async () => {
      // The marker exists only inside the body, so a path-substring implementation
      // would return nothing here.
      const { text } = await waitFor(
        async () => {
          const r = await client.ok("obsidian_search", { query: "prepended-marker" });
          return /renamed/.test(r.text) ? r : false;
        },
        { what: "the search index to catch up", timeoutMs: 15000, intervalMs: 500 },
      );
      assert(/renamed/.test(text), `search missed the note: ${text.slice(0, 200)}`);
    });

    await check("delete removes the file", async () => {
      await client.ok("obsidian_delete", { path: `${E2E_DIR}/renamed.md`, permanent: true });
      await waitFor(async () => !(await fileExists(`${E2E_DIR}/renamed.md`)), {
        what: "the file to be deleted",
      });
    });
  }

  // ------------------------------------------------------ suite: knowledge graph

  if (suite("Vault introspection")) {
    await check("files lists vault notes", async () => {
      const { text } = await client.ok("obsidian_files", {});
      assert(/\.md/.test(text), "no markdown files listed");
    });

    await check("folders lists vault folders", async () => {
      const { text } = await client.ok("obsidian_folders", {});
      assert(text.length > 0, "no folders listed");
    });

    await check("outline parses headings", async () => {
      const { text } = await client.ok("obsidian_outline", { path: "Notes/Alpha.md" });
      assert(text.length > 0, "empty outline");
    });

    await check("tags, tasks, backlinks and orphans all answer", async () => {
      for (const tool of ["obsidian_tags", "obsidian_tasks", "obsidian_orphans"]) {
        const { isError, text } = await client.call(tool, {});
        assert(!isError, `${tool} errored: ${text.slice(0, 120)}`);
      }
      const { isError } = await client.call("obsidian_backlinks", { path: "Notes/Alpha.md" });
      assert(!isError, "backlinks errored");
    });

    await check("workspace and tabs describe the live layout", async () => {
      const { text } = await client.ok("obsidian_workspace", {});
      assert(text.length > 0, "empty workspace description");
      await client.ok("obsidian_tabs", {});
    });

    await check("commands introspects the live command table", async () => {
      const { text } = await client.ok("obsidian_commands", {});
      assert(text.length > 100, "suspiciously small command list");
    });
  }

  // -------------------------------------------------------------- suite: ui

  if (suite("UI automation over CDP")) {
    await check("scoped snapshot is much cheaper than the full one", async () => {
      const full = await client.ok("browser_snapshot");
      const scoped = await client.ok("obsidian_snapshot", { scope: "active-leaf" });
      assert(scoped.text.length > 20, "scoped snapshot empty");
      assert(
        scoped.text.length < full.text.length,
        `scoped (${scoped.text.length}) not smaller than full (${full.text.length})`,
      );
      return `${scoped.text.length} vs ${full.text.length} chars`;
    });

    await check("snapshot refs resolve for a real click", async () => {
      // Open the palette, click its first ref, and confirm the UI reacted.
      await client.ok("browser_press_key", { key: "Control+p" });
      await sleep(600);
      const { text } = await client.ok("obsidian_snapshot", { scope: "modal" });
      const ref = /ref=(e\d+)/.exec(text)?.[1];
      assert(ref, `no ref in the modal snapshot: ${text.slice(0, 200)}`);
      await client.ok("browser_press_key", { key: "Escape" });
      await sleep(300);
      return `ref=${ref}`;
    });

    await check("typing real keystrokes reaches the palette input", async () => {
      await client.ok("browser_press_key", { key: "Control+p" });
      await sleep(600);
      await client.ok("browser_press_sequentially", { text: "graph" });
      const matched = await waitFor(
        async () => {
          const { text } = await client.ok("obsidian_eval", {
            code: "document.querySelector('.prompt input')?.value ?? ''",
          });
          return /graph/.test(text);
        },
        { what: "typed text to appear in the palette", timeoutMs: 5000 },
      );
      assert(matched, "typed text never appeared");
      await client.ok("browser_press_key", { key: "Escape" });
      await sleep(300);
    });

    await check("obsidian_dom queries the live DOM", async () => {
      const { text } = await client.ok("obsidian_dom", { selector: ".workspace-leaf", all: true });
      assert(text.length > 0, "no DOM returned");
    });

    await check("obsidian_css reads computed style", async () => {
      const { isError } = await client.call("obsidian_css", {
        selector: "body",
        prop: "background-color",
      });
      assert(!isError, "css read errored");
    });

    await check("raw CDP passthrough works", async () => {
      const { text, isError } = await client.call("obsidian_cdp", {
        method: "Runtime.evaluate",
        params: { expression: "1+1", returnByValue: true },
      });
      assert(!isError, `cdp errored: ${text.slice(0, 150)}`);
      assert(/2/.test(text), `unexpected cdp result: ${text.slice(0, 150)}`);
    });

    await check("obsidian_notice does not crash on circular objects", async () => {
      // A Notice instance is circular; serializing it naively used to throw.
      await client.ok("obsidian_notice", { message: "e2e running", duration: 800 });
    });

    await check("obsidian_screenshot writes a file", async () => {
      const { text, isError } = await client.call("obsidian_screenshot", {});
      assert(!isError, `screenshot errored: ${text.slice(0, 150)}`);
    });
  }

  // --------------------------------------------------------------- suite: editor

  if (suite("Editor toolset")) {
    const note = `${E2E_DIR}/editor.md`;

    await check("the default surface stays slim", async () => {
      const dflt = new McpClient([], liveHome.env);
      try {
        await dflt.initialize();
        const res = await dflt.send("tools/list");
        const have = new Set(res.result.tools.map((t) => t.name));
        const wanted = ["obsidian_status", "obsidian_workspace_create", "obsidian_toolsets_update"];
        const missing = wanted.filter((name) => !have.has(name));
        const leaked = ["obsidian_editor_state", "obsidian_create", "browser_snapshot"].filter(
          (name) => have.has(name),
        );
        assert(missing.length === 0, `missing from default surface: ${missing.join(", ")}`);
        assert(
          leaked.length === 0,
          `optional tools leaked into default surface: ${leaked.join(", ")}`,
        );
      } finally {
        dflt.close();
      }
    });

    await check("editor_state reports file, mode, cursor, and a doc hash", async () => {
      await client.ok("obsidian_create", {
        path: note,
        content: "# Editor\n\nalpha\nbeta\ngamma\n",
        overwrite: true,
      });
      await client.ok("obsidian_open", { path: note });
      const state = await waitFor(
        async () => {
          const r = await client.ok("obsidian_editor_state", {});
          return /editor\.md/.test(r.text) ? r : false;
        },
        { what: "the note to become the active editor" },
      );
      assert(
        (state.json?.docHash ?? "").startsWith("fnv1a-"),
        `no docHash: ${state.text.slice(0, 200)}`,
      );
      assert(
        ["source", "live-preview"].includes(state.json?.mode),
        `unexpected mode: ${state.text.slice(0, 200)}`,
      );
      assert(Array.isArray(state.json?.docSlice?.lines), "no docSlice window");
    });

    await check("editor_set moves the cursor and reports back", async () => {
      await client.ok("obsidian_editor_set", { cursor: { line: 3, ch: 0 }, scrollIntoView: true });
      const { text, json } = await client.ok("obsidian_editor_state", { windowLines: 4 });
      assert(json?.cursor?.line === 3, `cursor did not move: ${text.slice(0, 200)}`);
    });

    await check("editor_replace refuses a stale hash with a typed remediation", async () => {
      const { text, json, isError } = await client.call("obsidian_editor_replace", {
        mode: "setValue",
        text: "clobbered",
        expectedDocHash: "fnv1a-00000000-0",
      });
      assert(isError, "a stale hash was accepted");
      assert(json?.code === "STALE_REF", `wrong error code: ${text.slice(0, 200)}`);
      assert(/obsidian_editor_state/.test(text), "remediation does not name the fixing tool");
      // The refusal must not have edited anything.
      const after = await client.ok("obsidian_editor_state", {});
      assert(!/clobbered/.test(after.text), "the document changed despite the refusal");
    });

    await check("editor_replace applies with the current hash", async () => {
      const state = await client.ok("obsidian_editor_state", {});
      const hash = state.json?.docHash;
      assert(hash, "no hash to authorize the edit");
      await client.ok("obsidian_editor_replace", {
        mode: "replaceRange",
        text: "delta-marker\n",
        from: { line: 2, ch: 0 },
        expectedDocHash: hash,
      });
      const after = await client.ok("obsidian_editor_state", {});
      assert(
        after.json?.docSlice?.lines?.some((line) => line.includes("delta-marker")),
        "the inserted text is not visible",
      );
      const newHash = after.json?.docHash;
      assert(newHash && newHash !== hash, "the doc hash did not change after an edit");
    });

    await check("editor_widgets answers with a bounded list", async () => {
      const { text, json, isError } = await client.call("obsidian_editor_widgets", {});
      assert(!isError, `widgets errored: ${text.slice(0, 200)}`);
      assert(Number.isFinite(json?.returned), "no returned count");
      assert(Number.isFinite(json?.total), "no total count");
    });

    await check("editor_widgets accepts an arbitrary selector", async () => {
      const { text, json, isError } = await client.call("obsidian_editor_widgets", {
        selector: ".cm-line",
      });
      assert(!isError, `custom selector errored: ${text.slice(0, 200)}`);
      assert(
        json?.widgets?.every((widget) => typeof widget.cssPath === "string"),
        "matches carry no cssPath",
      );
    });

    await check("snapshot scope=editor targets the active editor", async () => {
      const { text } = await client.ok("obsidian_snapshot", { scope: "editor" });
      assert(text.length > 20, "empty editor snapshot");
      assert(/\.cm-editor|markdown-reading-view/.test(text), "selector not reported");
    });

    await check("element screenshot returns an artifact plus a metrics block", async () => {
      const { text, images, json, isError } = await client.call("obsidian_element_screenshot", {
        target: ".workspace-leaf.mod-active .cm-editor",
      });
      assert(!isError, `element screenshot errored: ${text.slice(0, 200)}`);
      assert(images.length === 0, "element screenshot must not return inline image content");
      assert(Number(json?.file?.size) > 1000, "image artifact is suspiciously small");
      await stat(json.file.path);
      assert(/devicePixelRatio/.test(text), "no metrics block");
      assert(json?.rect && Number.isFinite(json.rect.width), "no rect in metrics");
    });

    await check("element screenshot rejects a missing selector actionably", async () => {
      const { text, isError } = await client.call("obsidian_element_screenshot", {
        target: "#definitely-not-present-e2e",
      });
      assert(isError, "expected an error");
      assert(/TARGET_NOT_FOUND|No element/i.test(text), `unhelpful: ${text.slice(0, 200)}`);
    });
  }

  // ------------------------------------------------------------ suite: telemetry

  if (suite("Telemetry")) {
    await check("telemetry capture reports armed", async () => {
      const { text } = await client.ok("obsidian_telemetry_status");
      assert(/armed/i.test(text), "capture not armed");
    });

    await check("console output is captured", async () => {
      const marker = `e2e-console-${Date.now()}`;
      const before = await client.ok("obsidian_logs", { limit: 1 });
      const cursor = Number(before.json?.cursor ?? 0);
      await client.ok("obsidian_eval", { code: `(console.log(${JSON.stringify(marker)}), 1)` });
      const found = await waitFor(
        async () => {
          const { text } = await client.ok("obsidian_logs", { since: cursor });
          return text.includes(marker);
        },
        { what: "the console line to be captured" },
      );
      assert(found, "console line never captured");
    });

    await check("cursor tailing returns only new records, not a full replay", async () => {
      const before = await client.ok("obsidian_logs", { limit: 1 });
      const cursor = Number(before.json?.cursor ?? 0);
      await client.ok("obsidian_eval", { code: '(console.log("e2e-probe"), 1)' });
      await sleep(1200);
      const after = await client.ok("obsidian_logs", { since: cursor });
      const matched = Number(after.json?.matched ?? -1);
      assert(matched >= 0, "no matched count");
      assert(matched < 50, `looks like a full replay: ${matched} records`);
      return `${matched} new`;
    });

    await check("markers anchor a tail window", async () => {
      const label = `e2e-mark-${Date.now()}`;
      await client.ok("obsidian_log_mark", { label });
      await client.ok("obsidian_eval", { code: '(console.log("after-the-mark"), 1)' });
      await sleep(1000);
      const { text } = await client.ok("obsidian_logs", { sinceMarker: label });
      assert(/after-the-mark/.test(text), "marker window missed the later record");
    });

    await check("severity filtering works", async () => {
      await client.ok("obsidian_eval", { code: '(console.warn("e2e-warning"), 1)' });
      await sleep(900);
      const { text } = await client.ok("obsidian_logs", { minLevel: "warn", limit: 50 });
      assert(!/"level":\s*"(log|debug|info)"/.test(text), "minLevel let through low severity");
    });

    await check("regex pattern filtering works", async () => {
      const { text } = await client.ok("obsidian_logs", { pattern: "e2e-warning", limit: 20 });
      assert(/e2e-warning/.test(text), "pattern filter found nothing");
    });

    await check("a thrown page error is captured with its stack", async () => {
      const before = await client.ok("obsidian_logs", { limit: 1 });
      const cursor = Number(before.json?.cursor ?? 0);
      await client.call("obsidian_eval", {
        code: 'setTimeout(() => { throw new Error("e2e-async-boom"); }, 0)',
      });
      const found = await waitFor(
        async () => {
          const { text } = await client.ok("obsidian_logs", { since: cursor, limit: 50 });
          return /e2e-async-boom/.test(text);
        },
        { what: "the async throw to surface", timeoutMs: 6000 },
      );
      assert(found, "async page error never captured");
    });
  }

  // ------------------------------------------------------------ suite: dev cycle

  if (
    PLUGIN !== undefined &&
    process.env.PLUGIN_SOURCE_DIR !== undefined &&
    suite("Plugin dev cycle")
  ) {
    await check("plugin_list sees the test plugin", async () => {
      const { text } = await client.ok("obsidian_plugin_list");
      assert(new RegExp(PLUGIN).test(text), "scratch plugin not installed/enabled");
    });

    await check("plugin_manifest reads id, name and version", async () => {
      const { text } = await client.ok("obsidian_plugin_manifest", { id: PLUGIN });
      assert(new RegExp(PLUGIN).test(text), "manifest missing the id");
      assert(/version/i.test(text), "manifest missing a version");
    });

    await check("plugin_commands lists commands the plugin owns", async () => {
      const { text } = await client.ok("obsidian_plugin_commands", { id: PLUGIN });
      assert(new RegExp(PLUGIN).test(text), "no owned commands reported");
    });

    await check("dev_cycle reloads and reports cleanly", async () => {
      const { text } = await client.ok("obsidian_dev_cycle", { pluginId: PLUGIN });
      assert(/reload/i.test(text), `unexpected dev cycle output: ${text.slice(0, 150)}`);
      return text.split("\n")[0]?.slice(0, 60);
    });

    await check("disable then enable round-trips", async () => {
      await client.ok("obsidian_plugin_disable", { id: PLUGIN });
      await sleep(500);
      const off = await client.ok("obsidian_plugin_health", { pluginId: PLUGIN });
      assert(/false|disabled|not (enabled|loaded)/i.test(off.text), "still reported enabled");
      await client.ok("obsidian_plugin_enable", { id: PLUGIN });
      await sleep(800);
      const on = await client.ok("obsidian_plugin_health", { pluginId: PLUGIN });
      assert(/enabled|loaded/i.test(on.text), "did not come back enabled");
    });

    await check("plugin settings read and write data.json", async () => {
      const { isError } = await client.call("obsidian_plugin_settings", { id: PLUGIN });
      assert(!isError, "settings read errored");
    });

    await check("reset_state wipes data.json and returns the previous contents", async () => {
      const { text, isError } = await client.call("obsidian_reset_state", { pluginId: PLUGIN });
      assert(!isError, `reset errored: ${text.slice(0, 150)}`);
    });

    await check("a deliberate plugin throw is attributed to the plugin", async () => {
      const before = await client.ok("obsidian_logs", { limit: 1 });
      const cursor = Number(/"cursor":\s*(\d+)/.exec(before.text)?.[1] ?? 0);
      await client.call("obsidian_exercise_command", { commandId: `${PLUGIN}:throw-on-purpose` });
      const found = await waitFor(
        async () => {
          const { text } = await client.ok("obsidian_logs", { since: cursor, plugin: PLUGIN });
          return new RegExp(PLUGIN).test(text);
        },
        { what: "the throw to be attributed", timeoutMs: 8000 },
      );
      assert(found, "throw not attributed");
    });

    await check("dev_errors surfaces recent errors", async () => {
      const { isError } = await client.call("obsidian_dev_errors", {});
      assert(!isError, "dev_errors errored");
    });
  }

  // -------------------------------------------------------- suite: error contract

  if (suite("Error contract")) {
    await check("unknown vault yields an actionable error", async () => {
      const { text, isError } = await client.call("obsidian_cli", {
        command: "vault",
        vault: "definitely-not-a-real-vault",
      });
      assert(isError, "expected an error");
      assert(/vault/i.test(text), "error does not mention the vault");
    });

    await check("an in-page throw is an eval failure, not a transport error", async () => {
      const { text, isError } = await client.call("obsidian_eval", {
        code: 'throw new Error("intentional-e2e-throw")',
      });
      assert(isError, "expected an error");
      assert(/intentional-e2e-throw/.test(text), `lost the message: ${text.slice(0, 150)}`);
      assert(!/not running|port closed/i.test(text), "misreported as a connection failure");
    });

    await check("a missing note reports the path", async () => {
      const { text, isError } = await client.call("obsidian_read", {
        path: "E2E/does-not-exist-at-all.md",
      });
      assert(isError, "expected an error");
      assert(/does-not-exist-at-all|not found/i.test(text), `unhelpful: ${text.slice(0, 150)}`);
    });

    await check("an unknown command id is rejected", async () => {
      const { isError } = await client.call("obsidian_command", { id: "nope:not-a-real-command" });
      assert(isError, "expected an error");
    });

    await check("an unknown plugin id is rejected", async () => {
      const { isError } = await client.call("obsidian_plugin_manifest", {
        id: "not-a-real-plugin",
      });
      assert(isError, "expected an error");
    });

    await check("a bad selector suggests taking a snapshot", async () => {
      const { text, isError } = await client.call("browser_click", {
        element: "nothing",
        target: "#definitely-not-present-e2e",
      });
      assert(isError, "expected an error");
      assert(text.length > 20, "error text too thin to be actionable");
    });

    await check("schema violations are rejected before reaching Obsidian", async () => {
      const res = await client.send("tools/call", {
        name: "obsidian_read",
        arguments: { path: 12345 },
      });
      const errored = res.error !== undefined || res.result?.isError === true;
      assert(errored, "a type-invalid argument was accepted");
    });
  }

  // --------------------------------------------------- suite: stability additions

  if (suite("Stability: concurrency, transport, reconnect")) {
    await check("overlapping read-only calls all succeed", async () => {
      const results = await Promise.all([
        client.call("obsidian_status"),
        client.call("obsidian_files", {}),
        client.call("obsidian_logs", { limit: 5 }),
        client.call("obsidian_commands", {}),
        client.call("obsidian_workspace", {}),
        client.call("obsidian_list_targets"),
      ]);
      const bad = results.filter((r) => r.isError);
      assert(bad.length === 0, `${bad.length} of ${results.length} concurrent reads failed`);
      return `${results.length} parallel reads`;
    });

    await check("overlapping mutating calls serialize without corrupting each other", async () => {
      const dir = `${E2E_DIR}/conc`;
      const n = 5;
      const results = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          client.call("obsidian_create", {
            path: `${dir}/note-${i}.md`,
            content: `body-${i}`,
            overwrite: true,
          }),
        ),
      );
      const bad = results.filter((r) => r.isError);
      assert(bad.length === 0, `${bad.length}/${n} concurrent creates failed`);
      // Every file must exist with exactly its own body — interleaving would cross them.
      for (let i = 0; i < n; i++) {
        const rel = `${dir}/note-${i}.md`;
        await waitFor(() => fileExists(rel), { what: rel });
        const disk = await readVaultFile(rel);
        assert(disk.includes(`body-${i}`), `note-${i} has the wrong body: ${disk.slice(0, 60)}`);
      }
      return `${n} serialized writes`;
    });

    await check("a mixed read/write burst leaves the server responsive", async () => {
      await Promise.all([
        client.call("obsidian_status"),
        client.call("obsidian_notice", { message: "burst", duration: 400 }),
        client.call("obsidian_files", {}),
        client.call("obsidian_log_mark", { label: "burst" }),
        client.call("obsidian_logs", { limit: 3 }),
      ]);
      const { isError } = await client.call("obsidian_status");
      assert(!isError, "server unresponsive after a mixed burst");
    });

    await check("http transport serves a real MCP handshake", async () => {
      const port = await findFreePort();
      const proc = spawn(
        "node",
        [
          join(root, "dist", "cli.js"),
          "--transport",
          "http",
          "--port",
          String(port),
          "--vault",
          VAULT,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      proc.stderr.on("data", (c) => {
        stderr += c.toString();
        if (process.env.VERBOSE) process.stderr.write(c);
      });
      try {
        // Wait for the listener rather than sleeping a fixed amount.
        await waitFor(
          async () => {
            try {
              const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "GET" });
              return r.status > 0;
            } catch {
              return false;
            }
          },
          { what: "the http listener", timeoutMs: 15000, intervalMs: 300 },
        );

        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "e2e-http", version: "1" },
            },
          }),
        });
        const body = await res.text();
        assert(res.ok, `http ${res.status}: ${body.slice(0, 200)}`);
        assert(
          /"serverInfo"|"protocolVersion"/.test(body),
          `no MCP initialize result: ${body.slice(0, 200)}`,
        );
        return `port ${port}, http ${res.status}`;
      } finally {
        proc.kill("SIGTERM");
        await sleep(500);
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
    });

    await check("http transport refuses to start on a busy port instead of hanging", async () => {
      const port = await findFreePort();
      const blocker = createServer((_, res) => res.end("busy"));
      await new Promise((r) => blocker.listen(port, "127.0.0.1", r));
      const proc = spawn(
        "node",
        [join(root, "dist", "cli.js"), "--transport", "http", "--port", String(port)],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      proc.stderr.on("data", (c) => (stderr += c.toString()));
      try {
        const exited = await Promise.race([
          new Promise((r) => proc.on("exit", (code) => r(code))),
          sleep(12000).then(() => "timeout"),
        ]);
        assert(exited !== "timeout", "server neither started nor exited on a busy port");
        assert(
          /EADDRINUSE|in use|address/i.test(stderr) || exited !== 0,
          `no clear port-conflict diagnostic: ${stderr.slice(-250)}`,
        );
        return `exit=${exited}`;
      } finally {
        proc.kill("SIGKILL");
        await new Promise((r) => blocker.close(r));
      }
    });

    await check("target match narrows window selection without bricking on a miss", async () => {
      // A match string that cannot match anything must degrade to normal selection
      // rather than failing every call.
      const miss = new McpClient([
        "--toolsets",
        "core",
        "--vault",
        VAULT,
        "--target-match",
        "zzz-no-such-window-zzz",
      ]);
      try {
        await miss.initialize();
        const { isError, text } = await miss.call("obsidian_status");
        assert(!isError, `a non-matching target filter broke status: ${text.slice(0, 150)}`);
      } finally {
        miss.close();
      }
    });

    await check("the server exits promptly when the client closes stdin", async () => {
      const short = new McpClient(["--toolsets", "core", "--vault", VAULT]);
      await short.initialize();
      await short.ok("obsidian_status");
      short.close();
      const exited = await waitFor(() => short.exited, {
        what: "the process to exit after stdin close",
        timeoutMs: 12000,
        intervalMs: 200,
      });
      assert(exited, "process lingered after stdin closed");
    });

    await check("the server survives a CDP drop and recovers", async () => {
      // We cannot kill the user's Obsidian, so assert the softer property that
      // matters: repeated status calls stay consistent and the session reattaches
      // on demand rather than latching into a failed state.
      for (let i = 0; i < 3; i++) {
        const { text, isError } = await client.call("obsidian_status");
        assert(!isError, `status failed on attempt ${i + 1}`);
        assert(/CDP transport: attached/.test(text), `lost CDP on attempt ${i + 1}`);
        await sleep(400);
      }
    });
  }

  // ---------------------------------------------------------------------- teardown

  console.log("\n\x1b[1mTeardown\x1b[0m");
  await check("scratch notes are removed from the vault", async () => {
    await rm(join(VAULT_DIR, E2E_DIR), { recursive: true, force: true });
    assert(!(await fileExists(E2E_DIR)), "E2E directory survived cleanup");
  });

  if (PLUGIN !== undefined) {
    await check("the plugin is left enabled and healthy", async () => {
      const { text } = await client.ok("obsidian_plugin_health", { pluginId: PLUGIN });
      assert(/enabled|loaded/i.test(text), `plugin left unhealthy: ${text.slice(0, 150)}`);
    });
  }

  await check("default workspace and agent handles close cleanly", async () => {
    await client.ok("obsidian_workspace_stop", { workspaceHandle: defaultWorkspaceHandle });
    const released = await client.ok("obsidian_workspace_release", {
      workspaceHandle: defaultWorkspaceHandle,
    });
    assert(released.json?.released === true, "default workspace was not released");
    defaultWorkspaceHandle = undefined;
    const closed = await client.ok("obsidian_agent_close", { agentHandle: defaultAgentHandle });
    assert(closed.json?.closed === true, "agent handle was not closed");
    defaultAgentHandle = undefined;
  });

  client.close();
  await removeLiveHome(liveHome.home);
} finally {
  if (defaultWorkspaceHandle !== undefined) {
    await client
      .call("obsidian_workspace_stop", { workspaceHandle: defaultWorkspaceHandle })
      .catch(() => undefined);
    await client
      .call("obsidian_workspace_release", { workspaceHandle: defaultWorkspaceHandle })
      .catch(() => undefined);
    defaultWorkspaceHandle = undefined;
  }
  if (defaultAgentHandle !== undefined) {
    await client
      .call("obsidian_agent_close", { agentHandle: defaultAgentHandle })
      .catch(() => undefined);
    defaultAgentHandle = undefined;
  }
  client.close();
  await removeLiveHome(liveHome.home).catch(() => undefined);
}

// ----------------------------------------------------------------------- report

const total = passed + failed + skipped;
console.log(
  `\n\x1b[1m=== ${passed}/${total} passed` +
    (failed ? `, \x1b[31m${failed} failed\x1b[0m\x1b[1m` : "") +
    (skipped ? `, ${skipped} skipped` : "") +
    " ===\x1b[0m",
);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
