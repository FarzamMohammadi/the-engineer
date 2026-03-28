import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExternalRef } from "../../schemas/task.js";
import { TaskStates } from "../../schemas/task.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IWorkspaceManager } from "../interfaces/workspace-manager.interface.js";
import type { IObserver } from "../observer/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type UnblockInput =
  | { by: "external_ref"; ref: ExternalRef; source: string; content?: string }
  | { by: "task_id"; taskId: string; source: string; content?: string };

export interface UnblockResult {
  unblocked: boolean;
  taskId: string | null;
  reason: string | null;
}

export interface UnblockResolver {
  tryUnblock(input: UnblockInput): UnblockResult;
}

export interface UnblockResolverContext {
  taskEngine: ITaskEngine;
  workspaceManager: IWorkspaceManager;
  observer: IObserver;
}

// ── Pure Function ────────────────────────────────────────────────────────────

/**
 * Technology-agnostic comparison of two ExternalRef values by repo + number.
 * Intentionally ignores `type` — on platforms where issue and PR numbers share
 * the same sequence, a response on any entity with the same repo + number
 * should unblock the matching task.
 *
 * Deliberate divergence from `findByExternalRef()` (TaskEngine) which IS
 * type-aware (type + repo + number) for dedup: an issue and a PR with the
 * same number are different entities for task creation purposes.
 */
export function externalRefsMatch(a: ExternalRef, b: ExternalRef): boolean {
  return a.repo === b.repo && a.id === b.id;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createUnblockResolver(ctx: UnblockResolverContext): UnblockResolver {
  const { taskEngine, workspaceManager, observer } = ctx;

  function tryUnblock(input: UnblockInput): UnblockResult {
    if (input.by === "external_ref") {
      return tryUnblockByExternalRef(input.ref, input.source, input.content);
    }
    return tryUnblockByTaskId(input.taskId, input.source, input.content);
  }

  function tryUnblockByExternalRef(
    ref: ExternalRef,
    source: string,
    content?: string,
  ): UnblockResult {
    const blockedTasks = taskEngine.getTasksByState(TaskStates.blocked);
    const match = blockedTasks.find(
      (t) => t.external_ref !== null && externalRefsMatch(t.external_ref, ref),
    );

    if (!match) {
      return { unblocked: false, taskId: null, reason: "no_match" };
    }

    return transitionAndClear(match.id, source, content);
  }

  function tryUnblockByTaskId(taskId: string, source: string, content?: string): UnblockResult {
    const task = taskEngine.getTask(taskId);
    if (!task || task.state !== TaskStates.blocked) {
      return { unblocked: false, taskId, reason: "not_blocked" };
    }

    return transitionAndClear(taskId, source, content);
  }

  /** Shared transition logic: write response first, then transition, then clear blocked. */
  function transitionAndClear(taskId: string, source: string, content?: string): UnblockResult {
    // Write response file FIRST — before state change. If the write fails,
    // writeResponseToWorktree logs the error internally (try/catch), so we
    // still proceed with the transition to avoid leaving the task stuck.
    if (content) {
      writeResponseToWorktree(taskId, source, content);
    }

    const result = taskEngine.requestTransition(
      taskId,
      TaskStates.queued,
      null,
      `${source}_response_received`,
      "daemon",
    );

    if (!result.success) {
      observer.warn("Failed to unblock task", {
        taskId,
        source,
        reason: result.reason,
      });
      return { unblocked: false, taskId, reason: result.reason ?? "transition_failed" };
    }

    // Clear blocked details but preserve contacted history
    const task = taskEngine.getTask(taskId);
    const contacted = task?.blocked?.contacted ?? [];
    if (contacted.length > 0) {
      taskEngine.updateTaskField(taskId, "blocked", {
        reason: "",
        efforts_made: [],
        contacted,
        needed: "",
        waiting_for: "",
      });
    } else {
      taskEngine.updateTaskField(taskId, "blocked", null);
    }

    observer.info("Task unblocked", { taskId, source });
    return { unblocked: true, taskId, reason: null };
  }

  /** Write response content to {thoughtsDir}/requirements/responses/{source}.txt */
  function writeResponseToWorktree(taskId: string, source: string, content: string): void {
    const worktreePath = workspaceManager.getWorktreePath(taskId);
    if (!worktreePath) {
      observer.debug("No worktree for task — skipping response file write", { taskId });
      return;
    }

    // Use thoughtsDir from workspace record (includes date prefix, e.g., "thoughts/2026-03-23-issue-42")
    const record = workspaceManager.getWorkspaceRecord(taskId);
    const thoughtsDir = record?.thoughtsDir;
    if (!thoughtsDir) {
      observer.debug("No thoughtsDir for task — skipping response file write", { taskId });
      return;
    }

    const responsesDir = path.join(worktreePath, thoughtsDir, "requirements", "responses");
    try {
      mkdirSync(responsesDir, { recursive: true });
      const filename = `response-${String(Date.now())}-${source}.txt`;
      const finalPath = path.join(responsesDir, filename);
      const tempPath = `${finalPath}.tmp`;
      writeFileSync(tempPath, content, "utf-8");
      renameSync(tempPath, finalPath);
      observer.debug("Response file written", { taskId, source, filename, dir: responsesDir });
    } catch (err) {
      observer.warn("Failed to write response file", {
        taskId,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { tryUnblock };
}
