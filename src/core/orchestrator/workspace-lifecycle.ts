import type { CommunicationAdapter } from "../../adapters/communication.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import type { Phase } from "../../schemas/orchestrator.js";
import { Phases } from "../../schemas/orchestrator.js";
import type { OrchestratorContext } from "./types.js";

// ── AndonCord (Toyota Production System) ────────────────────────────────────

/** Emergency halt mechanism — any subsystem can "pull the cord" to stop the pipeline. */
export interface AndonCord {
  /** Pull the cord with a reason. Pipeline halts between phases. */
  pull(reason: string): void;
  /** Check if the cord has been pulled. */
  isPulled(): boolean;
  /** Get the reason the cord was pulled, or null if not pulled. */
  getReason(): string | null;
  /** Reset the cord (after the issue is addressed). */
  reset(): void;
}

/** Create an AndonCord instance. */
export function createAndonCord(): AndonCord {
  let pulled = false;
  let reason: string | null = null;
  return {
    pull(r) {
      pulled = true;
      reason = r;
    },
    isPulled() {
      return pulled;
    },
    getReason() {
      return reason;
    },
    reset() {
      pulled = false;
      reason = null;
    },
  };
}

// ── Sterile Cockpit (Aviation) ──────────────────────────────────────────────

/** Phases where non-critical notifications should be suppressed. */
const CRITICAL_PHASES: Set<Phase> = new Set([Phases.execution, Phases.self_review]);

/** Check if a phase is critical (execution, self_review). */
export function isCriticalPhase(phase: Phase): boolean {
  return CRITICAL_PHASES.has(phase);
}

// ── WorkspaceLifecycle Interface ────────────────────────────────────────────

/** Workspace setup, session management, and milestone notifications. */
export interface WorkspaceLifecycle {
  /** Set up workspace for a task dispatch (create or re-register). */
  setupWorkspace(dispatch: Dispatch): void;
  /** Create or resume a session for a dispatch. */
  createSession(dispatch: Dispatch): { id: string; [key: string]: unknown };
  /** Send a milestone notification via PeopleDirectory + comm plugins (D152). */
  notifyMilestone(dispatch: Dispatch, message: string): void;
  /** Post a comment on the source GitHub issue/PR. */
  commentOnSourceIssue(dispatch: Dispatch, message: string): void;
  /** Extract repository identifier from task. */
  getTaskRepo(dispatch: Dispatch): string;
  /** Emergency halt mechanism. */
  andonCord: AndonCord;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create a WorkspaceLifecycle bound to the given OrchestratorContext. */
export function createWorkspaceLifecycle(ctx: OrchestratorContext): WorkspaceLifecycle {
  const andonCord = createAndonCord();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: workspace setup has inherent branching (new/rework/resume/child)
  function setupWorkspace(dispatch: Dispatch): void {
    const taskId = dispatch.task.id;

    if (!dispatch.resume_from) {
      const repo = dispatch.task.repo;
      const cloneUrl = dispatch.task.clone_url;
      if (repo && cloneUrl) {
        // Rework dispatch: workspace already exists (preserved during review_pending)
        const existingWorktree = ctx.workspaceManager.getWorktreePath(taskId);
        if (existingWorktree && dispatch.task.workspace) {
          ctx.workspaceManager.registerExistingWorkspace(taskId, dispatch.task.workspace);
        } else {
          // Child tasks branch from parent's branch
          let parentBranch: string | undefined;
          if (dispatch.task.parent_id) {
            const parentTask = ctx.taskEngine.getTask(dispatch.task.parent_id);
            parentBranch = parentTask?.workspace?.branch ?? undefined;
          }
          const record = ctx.workspaceManager.createWorkspace(
            taskId,
            repo,
            dispatch.task.title,
            undefined,
            parentBranch,
            cloneUrl,
          );
          ctx.taskEngine.updateTaskField(taskId, "workspace", {
            repo,
            branch: record.branch,
            worktree_path: record.worktreePath,
          });
        }
      }
    } else if (dispatch.task.workspace) {
      ctx.workspaceManager.registerExistingWorkspace(taskId, dispatch.task.workspace);
    }
  }

  function createSession(dispatch: Dispatch): { id: string; [key: string]: unknown } {
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

  function notifyMilestone(dispatch: Dispatch, message: string): void {
    try {
      const owner = ctx.peopleDirectory.getOwner();
      if (!owner || owner.contacts.length === 0) {
        return;
      }

      const commPlugins = ctx.registry.getPluginsByType<CommunicationAdapter>(
        AdapterTypes.communication,
      );
      if (commPlugins.length === 0) {
        return;
      }

      const taskId = dispatch.task.id;

      for (const contact of owner.contacts) {
        const plugin = commPlugins.find(
          (p) => p.manifest.id === `${contact.channel}-comm` || p.manifest.id === contact.channel,
        );
        if (!plugin) {
          continue;
        }

        const target = {
          user_id: contact.handle,
          channel: contact.channel,
        };

        const formatted = {
          content: plugin.formatMessage(message, "milestone"),
          metadata: { task_id: taskId, type: "milestone" as const },
        };

        plugin.sendMessage(target, formatted).catch(() => {
          // Silent — notification failure must never block the pipeline
        });
      }
    } catch {
      // Silent — notification failure must never block the pipeline
    }
  }

  function commentOnSourceIssue(dispatch: Dispatch, message: string): void {
    try {
      const externalRef = dispatch.task.external_ref;
      if (
        !externalRef ||
        (externalRef.type !== "github_issue" && externalRef.type !== "github_pr")
      ) {
        return;
      }

      const commPlugins = ctx.registry.getPluginsByType<CommunicationAdapter>(
        AdapterTypes.communication,
      );
      const plugin = commPlugins.find((p) => p.hasCapability("issue_management"));
      if (!plugin) {
        return;
      }

      plugin.commentOnIssue(externalRef.repo, externalRef.number, message).catch(() => {
        // Silent — issue comment failure must never block the pipeline
      });
    } catch {
      // Silent — notification failure must never block the pipeline
    }
  }

  function getTaskRepo(dispatch: Dispatch): string {
    return dispatch.task.workspace?.repo ?? dispatch.task.external_ref?.repo ?? "";
  }

  return {
    setupWorkspace,
    createSession,
    notifyMilestone,
    commentOnSourceIssue,
    getTaskRepo,
    andonCord,
  };
}
