import type { ExternalRef } from "../../schemas/task.js";
import { BlockReasons, TaskStates } from "../../schemas/task.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
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

/**
 * Whether a blocked task is awaiting PR review. Such a task resumes only through PR events (the PR-event
 * poller detects an approval, new feedback, or a CI result and re-enters it), never through a human comment
 * or dashboard reply — so it must not be unblocked here. This is the single authoritative guard, covering
 * every caller including the dashboard/event-bus path the response-poller's own scoping does not see.
 */
function isAwaitingPrReview(task: { blocked: { reason: string } | null }): boolean {
  return task.blocked?.reason === BlockReasons.pr_review_pending;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createUnblockResolver(ctx: UnblockResolverContext): UnblockResolver {
  const { taskEngine, observer } = ctx;

  function tryUnblock(input: UnblockInput): UnblockResult {
    if (input.by === "external_ref") {
      return tryUnblockByExternalRef(input.ref, input.source, input.content);
    }
    return tryUnblockByTaskId(input.taskId, input.source, input.content);
  }

  function tryUnblockByExternalRef(ref: ExternalRef, source: string, content?: string): UnblockResult {
    const blockedTasks = taskEngine.getTasksByState(TaskStates.blocked);
    const match = blockedTasks.find((t) => t.external_ref !== null && externalRefsMatch(t.external_ref, ref));

    if (!match) {
      return { unblocked: false, taskId: null, reason: "no_match" };
    }
    if (isAwaitingPrReview(match)) {
      return ignoreReviewPending(match.id, source);
    }

    return transitionAndClear(match.id, source, content);
  }

  function tryUnblockByTaskId(taskId: string, source: string, content?: string): UnblockResult {
    const task = taskEngine.getTask(taskId);
    if (!task || task.state !== TaskStates.blocked) {
      return { unblocked: false, taskId, reason: "not_blocked" };
    }
    if (isAwaitingPrReview(task)) {
      return ignoreReviewPending(taskId, source);
    }

    return transitionAndClear(taskId, source, content);
  }

  /** A response matched a PR-review-pending task — leave it for the PR-event poller and record why it was not unblocked. */
  function ignoreReviewPending(taskId: string, source: string): UnblockResult {
    observer.debug("Ignoring a response for a PR-review-pending task — it resumes through PR events, not comments", {
      taskId,
      source,
    });
    return { unblocked: false, taskId, reason: "pr_review_pending" };
  }

  /** Shared transition logic: capture the answer first, then transition, then clear blocked. */
  function transitionAndClear(taskId: string, source: string, content?: string): UnblockResult {
    // Capture the owner's answer on the task BEFORE the state change, so it is already in place when
    // the daemon dispatches the now-queued task. The next dispatch reads it as authoritative scope for
    // the requirements re-run, then clears it (see Orchestrator.resolveDispatchStart). Without this the
    // answer is lost and the re-run re-derives scope from scratch — the runaway-PR bug.
    if (content) {
      taskEngine.updateTaskField(taskId, "pending_response", content);
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

    // Clear blocked details — the task is no longer blocked.
    taskEngine.updateTaskField(taskId, "blocked", null);

    observer.info("Task unblocked", { taskId, source });
    return { unblocked: true, taskId, reason: null };
  }

  return { tryUnblock };
}
