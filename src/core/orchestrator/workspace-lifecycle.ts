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

    if (!dispatch.resume_from) {
      const repo = dispatch.task.repo;
      const cloneUrl = dispatch.task.clone_url;
      if (repo && cloneUrl) {
        // Rework dispatch: workspace already exists (preserved during review_pending).
        // Check task.workspace (DB-persisted) — not getWorktreePath() which is in-memory
        // and empty after daemon restart.
        if (dispatch.task.workspace) {
          ctx.observer.debug("Workspace setup: re-registering existing workspace (rework)", {
            taskId,
            repo,
          });
          ctx.workspaceManager.registerExistingWorkspace(taskId, dispatch.task.workspace);
        } else {
          const thoughtsId = dispatch.task.thoughts_id ?? undefined;
          const record = ctx.workspaceManager.createWorkspace(taskId, repo, {
            title: dispatch.task.title,
            cloneUrl,
            thoughtsId,
          });
          ctx.taskEngine.updateTaskField(taskId, "workspace", {
            repo,
            branch: record.branch,
            worktree_path: record.worktreePath,
            thoughts_dir: record.thoughtsDir,
          });
        }
      } else {
        ctx.observer.debug("Workspace setup: no repo/cloneUrl — skipping workspace creation", {
          taskId,
        });
      }
    } else if (dispatch.task.workspace) {
      ctx.observer.debug("Workspace setup: re-registering workspace for resume", { taskId });
      ctx.workspaceManager.registerExistingWorkspace(taskId, dispatch.task.workspace);
    }
  }

  function createSession(dispatch: Dispatch): Session {
    if (dispatch.resume_from) {
      return ctx.sessionMemory.createSession({
        taskId: dispatch.task.id,
        previousSessionId: dispatch.resume_from.session_id,
        resumedFromCheckpoint: dispatch.resume_from.id,
      });
    }
    return ctx.sessionMemory.createSession({
      taskId: dispatch.task.id,
    });
  }

  return { setupWorkspace, createSession };
}
