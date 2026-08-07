/** Explicit agent and workspace lifecycle for stateless MCP clients. */

import { z } from "zod";
import { join } from "node:path";
import type { ServerContext } from "../server.js";
import { closeAgent, openAgent, requireAgent } from "../agent/store.js";
import {
  createWorkspaceRecord,
  listWorkspaces,
  readWorkspace,
  removeWorkspaceRecord,
  requireWorkspace,
  type WorkspaceRecord,
} from "../workspace/store.js";
import {
  createSession,
  quarantineSession,
  releaseSession,
  restartSession,
  sessionDiagnostics,
  sessionState,
  stopSession,
  waitSession,
} from "../session/registry.js";
import { readDescriptor } from "../session/descriptor.js";
import { UobError } from "../util/errors.js";
import { sessionPaths, trashDir } from "../config.js";

function agentSummary(record: Awaited<ReturnType<typeof requireAgent>>): Record<string, unknown> {
  return {
    agentHandle: record.handle,
    label: record.label,
    purpose: record.purpose,
    cwd: record.cwd,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    expiresAt: record.expiresAt,
    observedClients: record.observedClients,
  };
}

async function workspaceSummary(handle: string): Promise<Record<string, unknown>> {
  const record = await readWorkspace(handle);
  if (record === undefined) {
    throw new UobError("SESSION_NOT_FOUND", `Workspace ${handle} does not exist.`, {
      remediation: "Create a workspace with obsidian_workspace_create.",
      fixedBy: "obsidian_workspace_create",
    });
  }
  const descriptor =
    record.sessionKey !== undefined ? await readDescriptor(record.sessionKey) : undefined;
  const processState = descriptor !== undefined ? await sessionState(descriptor) : undefined;
  const expired =
    !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now();
  return {
    workspaceHandle: record.handle,
    agentHandle: record.agentHandle,
    kind: record.kind,
    label: record.label,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    expiresAt: record.expiresAt,
    expired,
    active: processState === "live" && descriptor?.readiness.phase === "ready",
    processState,
    phase: descriptor?.readiness.phase,
    profile: {
      kind: record.kind === "isolated" ? "private" : "default",
      sessionId: record.sessionKey ?? null,
      userDataDir: descriptor?.instance.userDataDir ?? null,
    },
    visualIdentity: descriptor?.visualIdentity ?? null,
    vault: descriptor?.vault?.name,
    plugin: descriptor?.plugin?.id,
  };
}

async function restoreWorkspaceBinding(
  ctx: ServerContext,
  previousHandle: string | undefined,
): Promise<void> {
  try {
    if (previousHandle !== undefined) {
      const previous = await readWorkspace(previousHandle);
      if (previous?.kind === "isolated" && previous.sessionKey !== undefined) {
        const descriptor = await readDescriptor(previous.sessionKey);
        if (descriptor !== undefined) {
          ctx.selectTelemetry(previous.handle);
          await ctx.bindSession(descriptor, previous.handle);
          ctx.currentWorkspaceHandle = previous.handle;
          return;
        }
      } else if (previous?.kind === "default") {
        ctx.selectTelemetry("default");
        await ctx.bindDefaultWorkspace();
        ctx.currentWorkspaceHandle = previous.handle;
        return;
      }
    }
  } catch (error) {
    ctx.logger.warn("could not restore the previous workspace after a binding failure", {
      workspaceHandle: previousHandle,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  ctx.currentWorkspaceHandle = undefined;
  ctx.selectTelemetry("default");
  await ctx.bindDefaultWorkspace().catch(() => undefined);
}

async function archiveWorkspaceTelemetry(
  ctx: ServerContext,
  workspaceHandle: string,
  destinationRoot: string,
): Promise<{ telemetryArchive?: string; telemetryArchiveError?: string }> {
  try {
    const telemetryArchive = await ctx.archiveTelemetry(workspaceHandle, destinationRoot);
    return telemetryArchive === undefined ? {} : { telemetryArchive };
  } catch (error) {
    return {
      telemetryArchiveError: error instanceof Error ? error.message : String(error),
    };
  }
}

function telemetryArchiveText(result: {
  telemetryArchive?: string;
  telemetryArchiveError?: string;
}): string {
  if (result.telemetryArchive !== undefined) {
    return ` Telemetry archived at ${result.telemetryArchive}.`;
  }
  if (result.telemetryArchiveError !== undefined) {
    return ` Telemetry archive warning: ${result.telemetryArchiveError}`;
  }
  return " No workspace telemetry file needed archiving.";
}

async function workspaceForCleanup(handle: string): Promise<WorkspaceRecord> {
  const record = await readWorkspace(handle);
  if (record === undefined) {
    throw new UobError("SESSION_NOT_FOUND", `Workspace ${handle} does not exist.`, {
      remediation: "Create a workspace with obsidian_workspace_create.",
      fixedBy: "obsidian_workspace_create",
    });
  }
  return record;
}

export function registerWorkspaceTools(ctx: ServerContext): void {
  const { registry, config, logger } = ctx;

  registry.add({
    name: "obsidian_agent_open",
    toolset: "workspace",
    alwaysEnabled: true,
    workspaceIndependent: true,
    profileIndependent: true,
    annotations: { readOnlyHint: false },
    description:
      "Create an explicit, durable agent handle for attribution. The handle is not an authentication credential.",
    inputSchema: {
      label: z.string().min(1).describe("Short name for the agent or task."),
      purpose: z.string().optional().describe("What this agent will do."),
      cwd: z.string().optional().describe("Working directory used for attribution."),
    },
    handler: async (args) => {
      const record = await openAgent({
        label: args.label as string,
        ...(typeof args.purpose === "string" ? { purpose: args.purpose } : {}),
        ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
      });
      return {
        text: `Opened agent ${record.handle}.`,
        json: agentSummary(record),
      };
    },
  });

  registry.add({
    name: "obsidian_agent_status",
    toolset: "workspace",
    alwaysEnabled: true,
    workspaceIndependent: true,
    profileIndependent: true,
    description: "Inspect one explicit agent handle and its current workspace count.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      agentHandle: z.string().describe("Agent handle returned by obsidian_agent_open."),
    },
    handler: async (args) => {
      const record = await requireAgent(args.agentHandle as string);
      const workspaces = (await listWorkspaces()).filter(
        (workspace) => workspace.agentHandle === record.handle,
      );
      return {
        text: `Agent ${record.handle} owns ${workspaces.length} workspace(s).`,
        json: { ...agentSummary(record), workspaceCount: workspaces.length },
      };
    },
  });

  registry.add({
    name: "obsidian_agent_close",
    toolset: "workspace",
    alwaysEnabled: true,
    workspaceIndependent: true,
    profileIndependent: true,
    annotations: { readOnlyHint: false, destructiveHint: true },
    description:
      "Close an agent handle after all of its workspaces have been released or destroyed.",
    inputSchema: { agentHandle: z.string().describe("Agent handle to close.") },
    handler: async (args) => {
      const handle = args.agentHandle as string;
      const workspaces = (await listWorkspaces()).filter(
        (workspace) => workspace.agentHandle === handle,
      );
      if (workspaces.length > 0) {
        throw new UobError("INVALID_ARGUMENT", "The agent still owns workspaces.", {
          remediation: "Release or destroy each workspace, then close the agent handle.",
          details: {
            workspaceHandles: workspaces.map((workspace) => workspace.handle),
          },
        });
      }
      await closeAgent(handle);
      return {
        text: `Closed agent ${handle}.`,
        json: { agentHandle: handle, closed: true },
      };
    },
  });

  registry.add({
    name: "obsidian_workspace_create",
    toolset: "workspace",
    alwaysEnabled: true,
    workspaceIndependent: true,
    profileIndependent: true,
    capability: "launch",
    annotations: { readOnlyHint: false },
    description:
      "Create and activate an isolated Obsidian workspace with a Knapper-owned scratch vault.",
    inputSchema: {
      agentHandle: z.string().describe("Agent handle that will own the workspace."),
      label: z.string().optional().describe("Short label for this isolated workspace."),
      pluginSourceDir: z
        .string()
        .optional()
        .describe("Absolute loadable plugin directory with manifest.json and main.js."),
      pluginId: z.string().optional().describe("Expected plugin ID from manifest.json."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum startup wait in milliseconds."),
    },
    handler: async (args) => {
      const agentHandle = args.agentHandle as string;
      await requireAgent(agentHandle);
      const previousHandle = ctx.currentWorkspaceHandle;
      let descriptor;
      let workspace: WorkspaceRecord | undefined;
      try {
        descriptor = await createSession({
          agentHandle,
          obsidianBin: config.obsidianBin,
          logger: logger.child("workspace"),
          ...(typeof args.label === "string" ? { label: args.label } : {}),
          ...(typeof args.pluginSourceDir === "string"
            ? { pluginSourceDir: args.pluginSourceDir }
            : {}),
          ...(typeof args.pluginId === "string" ? { pluginId: args.pluginId } : {}),
          ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
        });
        if (descriptor.readiness.phase === "starting") {
          descriptor = await waitSession(descriptor.key, {
            timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000,
          });
        }
        workspace = await createWorkspaceRecord({
          agentHandle,
          kind: "isolated",
          sessionKey: descriptor.key,
          ...(typeof args.label === "string" ? { label: args.label } : {}),
        });
        await ctx.workspaceLeases.acquire(workspace.handle, "obsidian_workspace_create");
        ctx.selectTelemetry(workspace.handle);
        await ctx.bindSession(descriptor, workspace.handle);
        ctx.currentWorkspaceHandle = workspace.handle;
      } catch (error) {
        if (workspace !== undefined) {
          await ctx.workspaceLeases.release(workspace.handle).catch(() => undefined);
          await removeWorkspaceRecord(workspace.handle).catch(() => undefined);
        }
        if (descriptor !== undefined) {
          const stop = await stopSession(descriptor.key, {
            timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : 15_000,
          }).catch(() => undefined);
          if (stop !== undefined && stop.state !== "quitFailed") {
            await quarantineSession(descriptor.key).catch(() => undefined);
          }
        }
        await restoreWorkspaceBinding(ctx, previousHandle);
        throw error;
      }
      return {
        text: `Created and activated isolated workspace ${workspace.handle}.`,
        json: {
          ...(await workspaceSummary(workspace.handle)),
          diagnostics: await sessionDiagnostics(descriptor),
        },
      };
    },
  });

  registry.add({
    name: "obsidian_workspace_claim_default",
    toolset: "workspace",
    alwaysEnabled: true,
    workspaceIndependent: true,
    profileIndependent: true,
    annotations: { readOnlyHint: false },
    description:
      "Create and activate a workspace handle for the user's default Obsidian profile. Vault authorization still applies.",
    inputSchema: {
      agentHandle: z.string().describe("Agent handle that will own the workspace."),
      label: z.string().optional().describe("Short label for this default-profile claim."),
    },
    handler: async (args) => {
      await requireAgent(args.agentHandle as string);
      const previousHandle = ctx.currentWorkspaceHandle;
      let workspace: WorkspaceRecord | undefined;
      try {
        workspace = await createWorkspaceRecord({
          agentHandle: args.agentHandle as string,
          kind: "default",
          ...(typeof args.label === "string" ? { label: args.label } : {}),
        });
        await ctx.workspaceLeases.acquire(workspace.handle, "obsidian_workspace_claim_default");
        ctx.selectTelemetry("default");
        await ctx.bindDefaultWorkspace();
        ctx.currentWorkspaceHandle = workspace.handle;
      } catch (error) {
        if (workspace !== undefined) {
          await ctx.workspaceLeases.release(workspace.handle).catch(() => undefined);
          await removeWorkspaceRecord(workspace.handle).catch(() => undefined);
        }
        await restoreWorkspaceBinding(ctx, previousHandle);
        throw error;
      }
      return {
        text: `Claimed the default profile as workspace ${workspace.handle}.`,
        json: await workspaceSummary(workspace.handle),
      };
    },
  });

  registry.add({
    name: "obsidian_workspace_list",
    toolset: "workspace",
    alwaysEnabled: true,
    workspaceIndependent: true,
    profileIndependent: true,
    annotations: { readOnlyHint: true },
    description: "List durable workspace handles, optionally for one agent.",
    inputSchema: {
      agentHandle: z
        .string()
        .optional()
        .describe("Return only workspaces owned by this agent handle."),
    },
    handler: async (args) => {
      const records = (await listWorkspaces()).filter(
        (record) => args.agentHandle === undefined || record.agentHandle === args.agentHandle,
      );
      const workspaces = await Promise.all(
        records.map((record) => workspaceSummary(record.handle)),
      );
      return {
        text: `${workspaces.length} workspace(s).`,
        json: { count: workspaces.length, workspaces },
      };
    },
  });

  registry.add({
    name: "obsidian_workspace_status",
    toolset: "workspace",
    alwaysEnabled: true,
    workspaceIndependent: true,
    profileIndependent: true,
    annotations: { readOnlyHint: true },
    description: "Inspect one workspace handle without activating its Obsidian window.",
    inputSchema: {
      workspaceHandle: z.string().describe("Workspace handle to inspect without activating it."),
    },
    handler: async (args) => {
      const summary = await workspaceSummary(args.workspaceHandle as string);
      return {
        text: [
          `Workspace: ${summary.workspaceHandle}`,
          `Kind: ${summary.kind}`,
          `Process: ${summary.processState ?? "not applicable"}`,
          `Phase: ${summary.phase ?? "not applicable"}`,
          `Active: ${summary.active ? "yes" : "no"}`,
          `Expired: ${summary.expired ? "yes" : "no"}`,
          ...(summary.vault !== undefined ? [`Vault: ${summary.vault}`] : []),
          ...(summary.plugin !== undefined ? [`Plugin: ${summary.plugin}`] : []),
          `Lease expires: ${summary.expiresAt}`,
        ].join("\n"),
        json: summary,
      };
    },
  });

  registry.add({
    name: "obsidian_workspace_restart",
    toolset: "workspace",
    alwaysEnabled: true,
    requiresWorkspaceLease: true,
    workspaceIndependent: true,
    profileIndependent: true,
    capability: "launch",
    annotations: { readOnlyHint: false, destructiveHint: true },
    description: "Cold-restart one isolated workspace and activate it.",
    inputSchema: {
      workspaceHandle: z.string().describe("Isolated workspace handle to restart."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum restart wait in milliseconds."),
    },
    handler: async (args) => {
      const workspace = await requireWorkspace(args.workspaceHandle as string);
      if (workspace.kind !== "isolated" || workspace.sessionKey === undefined) {
        throw new UobError(
          "INVALID_ARGUMENT",
          "The default-profile workspace cannot be restarted here.",
          {
            remediation: "Use obsidian_launch with this workspace handle.",
          },
        );
      }
      const result = await restartSession(workspace.sessionKey, {
        ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
        logger: logger.child("workspace"),
      });
      ctx.selectTelemetry(workspace.handle);
      await ctx.bindSession(result.descriptor, workspace.handle);
      ctx.currentWorkspaceHandle = workspace.handle;
      return {
        text: `Restarted workspace ${workspace.handle}.`,
        json: {
          ...(await workspaceSummary(workspace.handle)),
          quit: result.quit,
        },
      };
    },
  });

  registry.add({
    name: "obsidian_workspace_stop",
    toolset: "workspace",
    alwaysEnabled: true,
    requiresWorkspaceLease: true,
    workspaceIndependent: true,
    profileIndependent: true,
    annotations: { readOnlyHint: false, destructiveHint: true },
    description: "Stop one isolated workspace without removing its files or records.",
    inputSchema: {
      workspaceHandle: z.string().describe("Isolated workspace handle to stop."),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum stop wait in milliseconds."),
    },
    handler: async (args) => {
      const workspace = await requireWorkspace(args.workspaceHandle as string);
      if (workspace.kind !== "isolated" || workspace.sessionKey === undefined) {
        throw new UobError("INVALID_ARGUMENT", "Knapper cannot stop a default-profile workspace.", {
          remediation: "Release the default-profile workspace handle instead.",
        });
      }
      const result = await stopSession(
        workspace.sessionKey,
        typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {},
      );
      if (result.state !== "quitFailed" && ctx.currentWorkspaceHandle === workspace.handle) {
        ctx.currentWorkspaceHandle = undefined;
        ctx.selectTelemetry("default");
        await ctx.bindDefaultWorkspace();
      }
      return {
        text:
          result.state === "quitFailed"
            ? `Workspace ${workspace.handle} did not stop. Knapper preserved its files and records.`
            : result.state === "notRunning"
              ? `Workspace ${workspace.handle} was already stopped.`
              : `Stopped workspace ${workspace.handle}.`,
        json: {
          workspaceHandle: workspace.handle,
          stopped: result.state !== "quitFailed",
          ...result,
        },
        ...(result.state === "quitFailed" ? { isError: true } : {}),
      };
    },
  });

  registry.add({
    name: "obsidian_workspace_release",
    toolset: "workspace",
    alwaysEnabled: true,
    requiresWorkspaceLease: true,
    workspaceIndependent: true,
    profileIndependent: true,
    annotations: { readOnlyHint: false, destructiveHint: true },
    description: "Release a workspace handle. An isolated scratch vault is retained on disk.",
    inputSchema: {
      workspaceHandle: z
        .string()
        .describe("Workspace handle to release while retaining its vault."),
    },
    handler: async (args) => {
      const workspace = await workspaceForCleanup(args.workspaceHandle as string);
      let closeResult: unknown;
      if (workspace.sessionKey !== undefined) {
        try {
          closeResult = await releaseSession(workspace.sessionKey);
        } catch (error) {
          if (!(error instanceof UobError) || error.code !== "SESSION_NOT_FOUND") throw error;
          closeResult = { alreadyAbsent: true };
        }
      }
      await removeWorkspaceRecord(workspace.handle);
      await ctx.workspaceLeases.release(workspace.handle);
      ctx.selectTelemetry("default");
      if (ctx.currentWorkspaceHandle === workspace.handle) {
        ctx.currentWorkspaceHandle = undefined;
        await ctx.bindDefaultWorkspace();
      }
      const telemetry =
        workspace.sessionKey !== undefined
          ? await archiveWorkspaceTelemetry(
              ctx,
              workspace.handle,
              sessionPaths(workspace.sessionKey).root,
            )
          : {};
      return {
        text: `Released workspace ${workspace.handle}. Its vault was not deleted.${
          workspace.sessionKey !== undefined ? telemetryArchiveText(telemetry) : ""
        }`,
        json: {
          workspaceHandle: workspace.handle,
          released: true,
          closeResult,
          ...telemetry,
        },
      };
    },
  });

  registry.add({
    name: "obsidian_workspace_destroy",
    toolset: "workspace",
    alwaysEnabled: true,
    requiresWorkspaceLease: true,
    workspaceIndependent: true,
    profileIndependent: true,
    description:
      "Move a stopped isolated workspace's verified scratch root to recoverable Knapper trash.",
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      workspaceHandle: z.string().describe("Isolated workspace handle to quarantine and destroy."),
    },
    handler: async (args) => {
      const workspace = await workspaceForCleanup(args.workspaceHandle as string);
      if (workspace.kind !== "isolated" || workspace.sessionKey === undefined) {
        throw new UobError(
          "INVALID_ARGUMENT",
          "Knapper cannot destroy a default-profile workspace.",
          {
            remediation: "Release the workspace handle instead.",
            fixedBy: "obsidian_workspace_release",
          },
        );
      }
      let result;
      try {
        result = await quarantineSession(workspace.sessionKey);
      } catch (error) {
        if (!(error instanceof UobError) || error.code !== "SESSION_NOT_FOUND") throw error;
        result = {
          key: workspace.sessionKey,
          quit: false,
          unlinkedPlugin: false,
          vaultRemoved: false,
          vaultDeleted: false,
          rootDeleted: false,
          notes: ["The private session was already absent."],
        };
      }
      await removeWorkspaceRecord(workspace.handle);
      await ctx.workspaceLeases.release(workspace.handle);
      ctx.selectTelemetry("default");
      if (ctx.currentWorkspaceHandle === workspace.handle) {
        ctx.currentWorkspaceHandle = undefined;
        await ctx.bindDefaultWorkspace();
      }
      let telemetryRoot = result.quarantinedPath;
      if (telemetryRoot === undefined) {
        telemetryRoot = join(trashDir(), `orphaned-${workspace.handle}-${Date.now()}`);
      }
      const telemetry = await archiveWorkspaceTelemetry(ctx, workspace.handle, telemetryRoot);
      const disposition =
        result.quarantinedPath !== undefined
          ? `Quarantined workspace ${workspace.handle} at ${result.quarantinedPath}.`
          : `Removed stale workspace ${workspace.handle}; its private session was already absent.`;
      return {
        text: `${disposition}${telemetryArchiveText(telemetry)}`,
        json: {
          workspaceHandle: workspace.handle,
          destroyed: true,
          ...result,
          ...telemetry,
        },
      };
    },
  });
}
