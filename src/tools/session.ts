/**
 * Session tools: isolated Obsidian instances for concurrent agents.
 *
 * Each session is a private Obsidian — its own profile, CLI socket, CDP port, and
 * scratch vault — so two agents in different worktrees (or the same branch) never
 * contend. The server is bound to at most one session, via `KNAP_SESSION` in its
 * environment; the agent harness carries the key, and this server keeps no state
 * that outlives a restart.
 *
 * These are annotated as mutating rather than read-only on purpose: `registry.bind`
 * takes the exclusive lock for anything without `readOnlyHint`, and launching a
 * process while another tool drives the UI is exactly the interleaving that lock
 * exists to prevent.
 */

import { z } from "zod";
import type { ServerContext } from "../server.js";
import { cliSocketPathFor } from "../config.js";
import { UobError } from "../util/errors.js";
import { closeSession, createSession, listSessions, restartSession } from "../session/registry.js";
import { assertSessionKey } from "../session/key.js";
import { reapStaleSessions } from "../session/reap.js";
import type { SessionDescriptor } from "../session/descriptor.js";

/** Compact view of a descriptor for tool output. */
function summarize(descriptor: SessionDescriptor): Record<string, unknown> {
  return {
    session: descriptor.key,
    cdpUrl: descriptor.instance.cdpUrl,
    vault: descriptor.vault?.name,
    vaultPath: descriptor.vault?.path,
    plugin: descriptor.plugin?.id,
    pid: descriptor.instance.pid,
    userDataDir: descriptor.instance.userDataDir,
    outputDir: descriptor.instance.outputDir,
    cliSocket: cliSocketPathFor(descriptor.instance.runtimeDir),
  };
}

export function registerSessionTools(ctx: ServerContext): void {
  const { registry, config, logger } = ctx;

  /** The session this server is bound to, if any. */
  const currentKey = (): string | undefined => config.sessionId;

  /** Resolve a tool's `session` argument, defaulting to this server's own. */
  const targetKey = (raw: unknown): string => {
    if (typeof raw === "string" && raw !== "") return assertSessionKey(raw);
    const own = currentKey();
    if (own !== undefined) return own;
    throw new UobError(
      "INVALID_ARGUMENT",
      "No session given and this server is not bound to one.",
      {
        remediation:
          "Pass `session` explicitly, or set KNAP_SESSION in this server's environment to bind it. " +
          "obsidian_list_sessions shows the available keys.",
        fixedBy: "obsidian_list_sessions",
      },
    );
  };

  registry.add({
    name: "obsidian_create_session",
    toolset: "session",
    capability: "launch",
    description:
      "Create an isolated Obsidian instance with its own profile, CLI socket, debug port, and " +
      "scratch vault, and return a session key. Use this before plugin work whenever other agents " +
      "may be driving Obsidian, so your actions cannot collide with theirs. The returned key goes " +
      "in this server's KNAP_SESSION environment variable; reconnect for the rest of the tools to " +
      "target the new instance. Linux only.",
    inputSchema: {
      label: z
        .string()
        .optional()
        .describe(
          "Short human-readable name, used as the key prefix and shown by obsidian_list_sessions. " +
            "Defaults to the current directory name. Truncated to 12 characters.",
        ),
      vaultPath: z
        .string()
        .optional()
        .describe(
          "Absolute path for the scratch vault. Defaults to a directory inside the session, which " +
            "obsidian_close_session may delete. Must be empty or non-existent.",
        ),
      adoptVault: z
        .string()
        .optional()
        .describe(
          "Absolute path to a vault already authorized with `knapper authorize`, to use instead of " +
            "a scratch one. knapper will never delete it and closing the session leaves it alone.",
        ),
      pluginSourceDir: z
        .string()
        .optional()
        .describe(
          "Absolute path to a plugin project root to symlink into the session vault before first " +
            "launch. The plugin id is read from its manifest.json.",
        ),
      pluginId: z
        .string()
        .optional()
        .describe("Plugin id, when it should not be read from manifest.json."),
      cdpPort: z
        .number()
        .optional()
        .describe(
          "Explicit debug port. Omit to let the kernel allocate a free one, which is race-free " +
            "when several sessions are created at once.",
        ),
      timeoutMs: z
        .number()
        .optional()
        .describe("How long to wait for Obsidian to start (default 45000)."),
    },
    handler: async (args) => {
      // Opportunistic cleanup: this is where nearly all reaping happens in
      // practice, and it needs no daemon. Failure here must never block creating a
      // session, so it is deliberately swallowed.
      //
      // `keep` matters even though this server is about to create a *different*
      // session: a server already bound to one would otherwise be the thing that
      // collects it, and the reaper cannot tell "its Obsidian crashed a while ago"
      // from "abandoned" — only the caller knows it is still in use.
      const reaped = await reapStaleSessions({
        logger: logger.child("reap"),
        deleteVaults: true,
        ...(currentKey() !== undefined ? { keep: currentKey() as string } : {}),
      })
        .then((r) => r.reaped)
        .catch(() => [] as string[]);

      const descriptor = await createSession({
        obsidianBin: config.obsidianBin,
        logger: logger.child("session"),
        ...(typeof args.label === "string" ? { label: args.label } : {}),
        ...(typeof args.vaultPath === "string" ? { vaultPath: args.vaultPath } : {}),
        ...(typeof args.adoptVault === "string" ? { adoptVault: args.adoptVault } : {}),
        ...(typeof args.pluginSourceDir === "string"
          ? { pluginSourceDir: args.pluginSourceDir }
          : {}),
        ...(typeof args.pluginId === "string" ? { pluginId: args.pluginId } : {}),
        ...(typeof args.cdpPort === "number" ? { cdpPort: args.cdpPort } : {}),
        ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
      });

      const live = (await listSessions({ env: process.env })).filter((s) => s.state === "live");
      const lines = [
        `Session ${descriptor.key} is ready.`,
        `Vault "${descriptor.vault?.name}" at ${descriptor.vault?.path}`,
        `CDP ${descriptor.instance.cdpUrl}, pid ${descriptor.instance.pid ?? "unknown"}`,
        descriptor.plugin !== undefined
          ? `Plugin ${descriptor.plugin.id} linked from ${descriptor.plugin.sourceDir}`
          : "No plugin linked.",
        "",
        "To target it, add this to knapper's MCP server config and reconnect:",
        `  "env": { "KNAP_SESSION": "${descriptor.key}" }`,
      ];
      // Each session is a whole Electron app, so the cost of forgetting to close
      // one is measured in gigabytes rather than file handles.
      if (live.length > 2) {
        lines.push(
          "",
          `Note: ${live.length} sessions are live. Each is a separate Obsidian process — close the ` +
            "ones you are done with using obsidian_close_session.",
        );
      }
      if (reaped.length > 0) {
        lines.push("", `Reaped ${reaped.length} abandoned session(s): ${reaped.join(", ")}`);
      }

      return { text: lines.join("\n"), json: { ...summarize(descriptor), reaped } };
    },
  });

  registry.add({
    name: "obsidian_list_sessions",
    toolset: "session",
    description:
      "List knapper sessions on this machine with their vault, debug port, process state, and " +
      "which one this server is bound to. `live` means the Obsidian process is running; " +
      "`orphaned` means it is gone but the session was recently active; `stale` means it is " +
      "abandoned and safe to close.",
    annotations: { readOnlyHint: true },
    inputSchema: {},
    handler: async () => {
      const sessions = await listSessions(
        currentKey() !== undefined ? { currentKey: currentKey() as string } : {},
      );
      if (sessions.length === 0) {
        return "No knapper sessions exist. Create one with obsidian_create_session.";
      }

      const lines = sessions.map((s) => {
        const d = s.descriptor;
        const marks = [s.state, s.isCurrent ? "current" : undefined].filter(Boolean).join(", ");
        return (
          `${d.key} [${marks}]\n` +
          `  vault ${d.vault?.name ?? "(none)"} · ${d.instance.cdpUrl} · pid ${d.instance.pid ?? "?"}\n` +
          `  from ${d.origin.cwd}${d.origin.branch !== undefined ? ` (${d.origin.branch})` : ""}` +
          `${d.plugin !== undefined ? ` · plugin ${d.plugin.id}` : ""}`
        );
      });

      return {
        text: lines.join("\n"),
        json: sessions.map((s) => ({
          ...summarize(s.descriptor),
          state: s.state,
          cliIsolation: s.cliIsolation,
          isCurrent: s.isCurrent,
          origin: s.descriptor.origin,
          heartbeatAt: s.descriptor.heartbeatAt,
        })),
      };
    },
  });

  registry.add({
    name: "obsidian_restart_session",
    toolset: "session",
    capability: "launch",
    description:
      "Cold-restart one session's Obsidian, leaving every other session untouched. Use this to " +
      "recover a wedged instance or to pick up changes that only apply at startup. The debug port " +
      "changes, so the session must be re-read afterwards.",
    // Kills a process. Nothing is deleted, but an unsaved editor state is lost.
    annotations: { destructiveHint: true },
    inputSchema: {
      session: z
        .string()
        .optional()
        .describe("Session key to restart. Defaults to the session this server is bound to."),
      timeoutMs: z
        .number()
        .optional()
        .describe("How long to wait for the old process to exit and the new one to start."),
    },
    handler: async (args) => {
      const key = targetKey(args.session);
      const { descriptor, quit } = await restartSession(key, {
        logger: logger.child("session"),
        ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
      });

      // Only meaningful when this server owns the session: with port 0 the new
      // instance is on a different port, and the router would otherwise keep
      // probing the old one.
      if (key === currentKey()) await ctx.router.retarget(descriptor.instance.cdpUrl);

      return {
        text:
          `Restarted session ${key}${quit ? "" : " (nothing was running)"}.\n` +
          `Now on ${descriptor.instance.cdpUrl}, pid ${descriptor.instance.pid ?? "unknown"}.`,
        json: summarize(descriptor),
      };
    },
  });

  registry.add({
    name: "obsidian_close_session",
    toolset: "session",
    capability: "launch",
    description:
      "Quit a session's Obsidian, remove its plugin symlink, and delete its profile. Pass " +
      "deleteVault=true to delete the scratch vault too — a vault authorized with `knapper " +
      "authorize` is never deleted regardless. Only this session's instance is stopped.",
    annotations: { destructiveHint: true },
    inputSchema: {
      session: z
        .string()
        .optional()
        .describe("Session key to close. Defaults to the session this server is bound to."),
      deleteVault: z
        .boolean()
        .optional()
        .describe(
          "Also delete the session's scratch vault directory and its notes. Only applies to a " +
            "vault knapper created; an adopted one is always left alone.",
        ),
      keepInstance: z
        .boolean()
        .optional()
        .describe("Leave Obsidian running and only drop the session record."),
      timeoutMs: z.number().optional().describe("How long to wait for Obsidian to exit."),
    },
    handler: async (args) => {
      const key = targetKey(args.session);
      const result = await closeSession(key, {
        ...(args.deleteVault === true ? { deleteVault: true } : {}),
        ...(args.keepInstance === true ? { keepInstance: true } : {}),
        ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
      });

      const lines = [
        `Closed session ${key}.`,
        result.quit ? "Obsidian quit." : "Obsidian was not running.",
        result.unlinkedPlugin ? "Plugin symlink removed." : undefined,
        result.vaultDeleted
          ? "Scratch vault deleted."
          : result.vaultRemoved
            ? "Vault unregistered, files kept."
            : "Vault left on disk.",
        ...result.notes,
        key === currentKey()
          ? "This server was bound to that session — unset KNAP_SESSION or create a new one."
          : undefined,
      ].filter((l): l is string => l !== undefined);

      return { text: lines.join("\n"), json: result };
    },
  });
}
