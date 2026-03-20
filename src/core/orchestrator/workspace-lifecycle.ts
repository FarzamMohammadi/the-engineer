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
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: workspace setup has inherent branching (new/rework/resume/child)
  function setupWorkspace(dispatch: Dispatch): void {
    const taskId = dispatch.task.id;
    const isResume = !!dispatch.resume_from;
    const isChild = !!dispatch.task.parent_id;

    ctx.observer.info("Setting up workspace", { taskId, isResume, isChild });

    if (!dispatch.resume_from) {
      const repo = dispatch.task.repo;
      const cloneUrl = dispatch.task.clone_url;
      if (repo && cloneUrl) {
        // Rework dispatch: workspace already exists (preserved during review_pending)
        const existingWorktree = ctx.workspaceManager.getWorktreePath(taskId);
        if (existingWorktree && dispatch.task.workspace) {
          ctx.observer.debug("Workspace setup: re-registering existing workspace (rework)", {
            taskId,
            repo,
          });
          ctx.workspaceManager.registerExistingWorkspace(taskId, dispatch.task.workspace);
        } else {
          // Child tasks branch from parent's branch
          let parentBranch: string | undefined;
          if (dispatch.task.parent_id) {
            const parentTask = ctx.taskEngine.getTask(dispatch.task.parent_id);
            parentBranch = parentTask?.workspace?.branch ?? undefined;
            ctx.observer.debug("Workspace setup: child task branching from parent", {
              taskId,
              parentId: dispatch.task.parent_id,
              parentBranch: parentBranch ?? null,
            });
          }
          const record = ctx.workspaceManager.createWorkspace(taskId, repo, {
            title: dispatch.task.title,
            parentBranch,
            cloneUrl,
          });
          ctx.taskEngine.updateTaskField(taskId, "workspace", {
            repo,
            branch: record.branch,
            worktree_path: record.worktreePath,
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
