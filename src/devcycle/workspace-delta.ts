/**
 * Before/after workspace sampling, shared by the tools that answer "did that
 * actually do anything?" rather than "did the call succeed?".
 *
 * `obsidian_exercise_command` and `obsidian_exercise_hotkey` both need the same
 * evidence — what the active file and leaf count were on either side of an action —
 * and the two would drift apart if each kept its own copy.
 */

import type { CapabilityRouter } from "../connection/router.js";
import { rendererEval } from "./eval.js";

export interface WorkspaceSnapshot {
  activeFile: string | null;
  openLeaves: number;
  /** Counts all open leaf types, including views registered by plugins. */
  viewTypes: Record<string, number>;
  /** Present when a modal is open; the command palette is the common case. */
  modal: string | null;
}

export const emptySnapshot = (): WorkspaceSnapshot => ({
  activeFile: null,
  openLeaves: 0,
  viewTypes: {},
  modal: null,
});

/**
 * Sample the workspace. Never throws: a snapshot failing must not turn into the
 * reported outcome of the action being measured.
 */
export async function workspaceSnapshot(
  router: CapabilityRouter,
  vault?: string,
): Promise<WorkspaceSnapshot> {
  try {
    return await rendererEval<WorkspaceSnapshot>(
      router,
      `(() => {
        const leaf = app.workspace.activeLeaf;
        const file = leaf?.view?.file?.path ?? null;
        const modalEl = document.querySelector(".modal-container .modal, .prompt");
        const modal = modalEl ? (modalEl.className || "modal") : null;
        const viewTypes = {};
        app.workspace.iterateAllLeaves((workspaceLeaf) => {
          const type = workspaceLeaf.view?.getViewType?.() ?? "unknown";
          viewTypes[type] = (viewTypes[type] ?? 0) + 1;
        });
        return {
          activeFile: file,
          openLeaves: app.workspace.getLeavesOfType("markdown").length,
          viewTypes,
          modal,
        };
      })()`,
      vault,
    );
  } catch {
    return emptySnapshot();
  }
}

export interface WorkspaceDelta {
  activeFile: { before: string | null; after: string | null };
  openLeaves: { before: number; after: number };
  viewTypes: { before: Record<string, number>; after: Record<string, number> };
  modal: { before: string | null; after: string | null };
}

export function workspaceDelta(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): WorkspaceDelta {
  return {
    activeFile: { before: before.activeFile, after: after.activeFile },
    openLeaves: { before: before.openLeaves, after: after.openLeaves },
    viewTypes: { before: before.viewTypes, after: after.viewTypes },
    modal: { before: before.modal, after: after.modal },
  };
}

/** True when anything observable moved. The "did it fire?" signal. */
export function deltaChanged(delta: WorkspaceDelta): boolean {
  const viewTypeKeys = new Set([
    ...Object.keys(delta.viewTypes.before),
    ...Object.keys(delta.viewTypes.after),
  ]);
  const sameViewTypes = [...viewTypeKeys].every(
    (key) => delta.viewTypes.before[key] === delta.viewTypes.after[key],
  );
  return (
    delta.activeFile.before !== delta.activeFile.after ||
    delta.openLeaves.before !== delta.openLeaves.after ||
    !sameViewTypes ||
    delta.modal.before !== delta.modal.after
  );
}

export function formatWorkspaceDelta(delta: WorkspaceDelta): string[] {
  return [
    "Workspace delta:",
    `  activeFile: ${String(delta.activeFile.before)} → ${String(delta.activeFile.after)}`,
    `  markdown leaves: ${delta.openLeaves.before} → ${delta.openLeaves.after}`,
    `  view types: ${JSON.stringify(delta.viewTypes.before)} → ${JSON.stringify(delta.viewTypes.after)}`,
    `  modal: ${delta.modal.before ?? "(none)"} → ${delta.modal.after ?? "(none)"}`,
  ];
}
