import type { Dispatch } from "../../schemas/ephemeral.js";
import type { Session } from "../../schemas/session-memory.js";
import type { OrchestratorContext } from "./types.js";

// ── WorkspaceLifecycle Interface ────────────────────────────────────────────

/** Workspace setup and session management for task dispatches. */
export interface WorkspaceLifecycle {
  /** Set up workspace for a task dispatch (create or re-register). */
  setupWorkspace(dispatch: Dispatch): void;
  /** Create or resume a session for a dispatch. */
  createSession(dispatch: Dispatch): Session;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create WorkspaceLifecycle bound to the given context. */
export function createWorkspaceLifecycle(ctx: OrchestratorContext): WorkspaceLifecycle {
  function setupWorkspace(dispatch: Dispatch): void {
    const taskId = dispatch.task.id;
    const isResume = !!dispatch.resume_from;

    ctx.observer.info("Setting up workspace", { taskId, isResume });

    // Resume dispatches read workspace state from task.workspace via the DB —
    // no per-dispatch setup needed (WorkspaceManager is stateless).
    if (dispatch.resume_from) {
      return;
    }

    const repo = dispatch.task.repo;
    const cloneUrl = dispatch.task.clone_url;

    if (!(repo && cloneUrl)) {
      ctx.observer.debug("Workspace setup: no repo/cloneUrl — skipping workspace creation", { taskId });
      return;
    }

    // Rework dispatch: workspace already exists (preserved during review_pending).
    // task.workspace is the source of truth — no in-memory re-registration needed.
    if (dispatch.task.workspace) {
      ctx.observer.debug("Workspace setup: re-using existing workspace (rework)", { taskId, repo });
      return;
    }

    const thoughtsId = dispatch.task.thoughts_id ?? undefined;
    ctx.workspaceManager.createWorkspace(taskId, repo, {
      title: dispatch.task.title,
      cloneUrl,
      thoughtsId,
    });
  }

  function createSession(dispatch: Dispatch): Session {
    return ctx.sessionMemory.sessions.create({
      taskId: dispatch.task.id,
    });
  }

  return { setupWorkspace, createSession };
}
