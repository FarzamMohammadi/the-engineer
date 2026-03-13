import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";

import type { CommunicationAdapter } from "../../adapters/communication.js";
import type { GitHostingAdapter } from "../../adapters/git-hosting.js";
import type { TriggerAdapter } from "../../adapters/trigger.js";
import { parseGitHubUrl, toExternalRef } from "../../plugins/github-shared/index.js";
import type { TriggerEvent } from "../../schemas/adapters.js";
import type { DaemonConfig } from "../../schemas/config.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import type {
  Event,
  EventPayloads,
  TaskChildrenAllDonePayload,
  TaskFeedbackReceivedPayload,
  TaskStateChangedPayload,
} from "../../schemas/events.js";
import type { ActionPipeline } from "../action-pipeline/index.js";
import type { EventBus, PublishInput } from "../event-bus/index.js";
import type { ExecuteTaskResult, Orchestrator } from "../orchestrator/index.js";
import type { PeopleDirectory } from "../people-directory/index.js";
import type { Registry } from "../registry/index.js";
import type { SafetyLayer } from "../safety-layer/index.js";
import type { SessionMemory } from "../session-memory/index.js";
import type { TaskEngine } from "../task-engine/index.js";
import type { WorkspaceManager } from "../workspace-manager/index.js";
import { type QueryHandlerDeps, handleQuery } from "./query-handler.js";

// ── Clock ───────────────────────────────────────────────────────────────────

/** Minimal clock interface for injectable time control. */
export interface Clock {
  now(): number;
}

/** Production clock that delegates to Date.now(). */
export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

/** All dependencies injected into the Daemon. */
export interface DaemonDependencies {
  eventBus: EventBus;
  registry: Registry;
  taskEngine: TaskEngine;
  safetyLayer: SafetyLayer;
  actionPipeline: ActionPipeline;
  orchestrator: Orchestrator;
  sessionMemory: SessionMemory;
  workspaceManager: WorkspaceManager;
  peopleDirectory: PeopleDirectory;
  clock: Clock;
  logger: Logger;
  engineerHome: string;
}

/** Observable Daemon state (for testing and debugging). */
export interface DaemonState {
  running: boolean;
  shuttingDown: boolean;
  startedAt: string | null;
  maxConcurrent: number;
  activeTaskIds: string[];
  pendingPreemption: PendingPreemption | null;
  tasksCompleted: number;
  seenKeyCount: number;
  triggerFailures: Record<string, number>;
}

interface PendingPreemption {
  targetTaskId: string;
  replacementTaskId: string;
  requestedAt: number;
  retried: boolean;
}

/** The Daemon public API. */
export interface Daemon {
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
  getState(): DaemonState;
}

// ── Pure Functions (exported for testing + Biome complexity) ─────────────────

/** Whether a task in the given state consumes a working slot. */
export function isSlotConsuming(state: string, subState: string | null): boolean {
  return state === "active" && (subState === "working" || subState === "integrating");
}

/** Whether a higher-priority task should preempt a lower-priority one. */
export function shouldPreempt(
  currentPriority: number,
  candidatePriority: number,
  threshold: number,
): boolean {
  return candidatePriority - currentPriority >= threshold;
}

/**
 * Compute the aged priority for a queued task.
 * Returns the new priority or null if no change needed.
 */
export function computeAgedPriority(
  basePriority: number,
  elapsedMs: number,
  config: {
    aging_threshold_ms: number;
    aging_interval_ms: number;
    aging_increment: number;
    aging_cap: number;
  },
): number | null {
  if (elapsedMs < config.aging_threshold_ms) {
    return null;
  }

  const periods =
    Math.floor((elapsedMs - config.aging_threshold_ms) / config.aging_interval_ms) + 1;
  const aged = Math.min(basePriority + periods * config.aging_increment, config.aging_cap);

  return aged > basePriority ? aged : null;
}

/**
 * Derive aggregate review state from per-reviewer statuses.
 * changes_requested dominates over approved. Returns null if no actionable reviews.
 */
export function deriveAggregateReviewState(reviewStatus: {
  changes_requested: boolean;
  approved: boolean;
  reviewers: Array<{ state: string }>;
}): "changes_requested" | "approved" | "comment" | null {
  if (reviewStatus.changes_requested) {
    return "changes_requested";
  }
  if (reviewStatus.approved) {
    return "approved";
  }
  // A reviewer submitted a review with comments (not approve/reject)
  if (reviewStatus.reviewers.some((r) => r.state === "commented")) {
    return "comment";
  }
  return null;
}

/** Check if an active task is stuck based on journal entry staleness. */
export function evaluateTaskStuckness(
  activeElapsedMs: number,
  latestEntryTimestamp: number | null,
  nowMs: number,
  stuckThresholdMs: number,
  maxActiveDurationMs: number,
): {
  stuck: boolean;
  condition: "no_journal_entries" | "no_state_transition";
  elapsedMs: number;
} | null {
  if (activeElapsedMs > maxActiveDurationMs) {
    return { stuck: true, condition: "no_state_transition", elapsedMs: activeElapsedMs };
  }

  if (activeElapsedMs > stuckThresholdMs) {
    if (latestEntryTimestamp === null) {
      return { stuck: true, condition: "no_journal_entries", elapsedMs: activeElapsedMs };
    }
    const staleness = nowMs - latestEntryTimestamp;
    if (staleness > stuckThresholdMs) {
      return { stuck: true, condition: "no_journal_entries", elapsedMs: staleness };
    }
  }

  return null;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Daemon instance (Decision #124: factory function, not class).
 *
 * The Daemon is the always-running heartbeat — polls triggers, creates tasks,
 * dispatches to the Orchestrator, manages preemption/aging/health, handles
 * signals, and coordinates graceful startup (P1) and shutdown (P15).
 */
export function createDaemon(config: DaemonConfig, deps: DaemonDependencies): Daemon {
  const {
    eventBus,
    registry,
    taskEngine,
    orchestrator,
    sessionMemory,
    workspaceManager,
    clock,
    logger,
    engineerHome,
  } = deps;

  // ── Internal State ──────────────────────────────────────────────────────
  let running = false;
  let shuttingDown = false;
  let startedAt: string | null = null;
  let tickInterval: ReturnType<typeof setInterval> | null = null;
  let tasksCompleted = 0;
  const signalHandlers: { signal: string; handler: () => void }[] = [];

  const activeDispatches = new Map<string, Promise<ExecuteTaskResult>>();
  const triggerLastPoll = new Map<string, number>();
  const triggerFailures = new Map<string, number>();
  const seenTriggerKeys = new Map<string, number>();
  const basePriorities = new Map<string, number>();
  let pendingPreemption: PendingPreemption | null = null;
  const costLimitTasks: string[] = [];

  // Blocked escalation: tracks which stage each task has reached + last action time
  const blockedEscalationState = new Map<
    string,
    { lastStageIndex: number; lastActionAt: number }
  >();

  // Review pending reminders: tracks when last reminder was sent per task
  const reviewReminderTimes = new Map<string, number>();

  // Review feedback dedup: tracks last processed aggregate review state per task
  const processedReviewStates = new Map<string, string>();

  // ── PID File ───────────────────────────────────────────────────────────

  function pidFilePath(): string {
    return join(engineerHome, "run", "engineer.pid");
  }

  function checkAndWritePidFile(): void {
    const runDir = join(engineerHome, "run");
    mkdirSync(runDir, { recursive: true });
    const pidPath = pidFilePath();

    if (existsSync(pidPath)) {
      const existingPid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      if (isProcessAlive(existingPid)) {
        throw new Error(`Another Daemon instance is already running (PID: ${String(existingPid)})`);
      }
      logger.warn({ pid: existingPid }, "Removing stale PID file");
      unlinkSync(pidPath);
    }

    writeFileSync(pidPath, String(process.pid));
    logger.info({ pid: process.pid, path: pidPath }, "PID file written");
  }

  function removePidFile(): void {
    try {
      unlinkSync(pidFilePath());
    } catch {
      // Idempotent — file may already be removed
    }
  }

  // ── Event Bus Subscriptions ───────────────────────────────────────────

  function registerSubscriptions(): void {
    eventBus.subscribe("daemon:cost", "cost.limit_reached", (event: Event) => {
      const payload = event.payload as EventPayloads["cost.limit_reached"];
      if (payload.task_id) {
        costLimitTasks.push(payload.task_id);
      }
    });

    eventBus.subscribe("daemon:comm", "comm.message_received", (event: Event) => {
      const payload = event.payload as EventPayloads["comm.message_received"];
      const queryDeps: QueryHandlerDeps = {
        taskEngine,
        safetyLayer: deps.safetyLayer,
        registry,
        logger,
      };
      handleQuery(payload, queryDeps).catch((err) => {
        logger.error({ err }, "Query handler error");
      });
    });

    // Subscribe to task state changes — sync to communication plugins
    eventBus.subscribe("daemon:state-sync", "task.state_changed", (event: Event) => {
      const payload = event.payload as TaskStateChangedPayload;
      syncStateToCommPlugin(payload);
    });

    // Subscribe to children_all_done — resume parent task integration
    eventBus.subscribe("daemon:children-done", "task.children_all_done", (event: Event) => {
      const payload = event.payload as TaskChildrenAllDonePayload;
      handleChildrenAllDone(payload);
    });

    // Subscribe to PR review feedback — handle approval, rework, or demo→code transition
    eventBus.subscribe("daemon:feedback", "task.feedback_received", (event: Event) => {
      const payload = event.payload as TaskFeedbackReceivedPayload;
      handleFeedbackEvent(payload);
    });
  }

  function unregisterSubscriptions(): void {
    eventBus.unsubscribe("daemon:cost");
    eventBus.unsubscribe("daemon:comm");
    eventBus.unsubscribe("daemon:state-sync");
    eventBus.unsubscribe("daemon:children-done");
    eventBus.unsubscribe("daemon:feedback");
  }

  // ── Startup: Protocol P1 ──────────────────────────────────────────────

  function rebuildStateFromTaskEngine(): void {
    // Crash recovery: transition orphaned active tasks → queued
    const activeTasks = taskEngine.getTasksByState("active");
    for (const task of activeTasks) {
      if (isSlotConsuming(task.state, task.sub_state)) {
        logger.warn(
          { taskId: task.id, subState: task.sub_state },
          "Recovering orphaned active task",
        );
        taskEngine.requestTransition(task.id, "queued", null, "crash_recovery", "daemon");
      }
    }

    // Initialize base priorities for queued tasks (aging).
    // Note: after restart, task.priority may already be aged. This means
    // basePriority captures the current (potentially aged) value, not the
    // original. This is safe because aging is capped at aging_cap and
    // computeAgedPriority checks against basePriority, so the worst case
    // is slightly faster convergence to cap — never exceeds it.
    const queuedTasks = taskEngine.getTasksByState("queued");
    for (const task of queuedTasks) {
      basePriorities.set(task.id, task.priority);
    }
  }

  // ── Trigger Polling ───────────────────────────────────────────────────

  async function pollTriggers(now: number): Promise<void> {
    const triggers = registry.getPluginsByType<TriggerAdapter>("trigger");

    for (const trigger of triggers) {
      await pollSingleTrigger(trigger, now);
    }
  }

  async function pollSingleTrigger(trigger: TriggerAdapter, now: number): Promise<void> {
    const pluginId = trigger.manifest.id;
    const lastPoll = triggerLastPoll.get(pluginId) ?? 0;

    if (now - lastPoll < config.trigger_poll_interval_ms) {
      return;
    }

    try {
      const events = await trigger.poll();
      triggerLastPoll.set(pluginId, now);
      triggerFailures.set(pluginId, 0);

      for (const event of events) {
        processNewTriggerEvent(event, now);
      }
    } catch (error) {
      const failures = (triggerFailures.get(pluginId) ?? 0) + 1;
      triggerFailures.set(pluginId, failures);
      logger.warn({ pluginId, failures, error }, "Trigger poll failed");

      if (failures >= config.plugins.consecutive_failures_threshold) {
        emitHealthTriggerFailure(pluginId, failures, error);
      }
    }
  }

  function processNewTriggerEvent(event: TriggerEvent, now: number): void {
    const expiry = seenTriggerKeys.get(event.idempotency_key);
    if (expiry !== undefined && expiry > now) {
      return; // Already seen and not expired
    }

    // Mark seen with TTL
    seenTriggerKeys.set(event.idempotency_key, now + config.seen_keys_ttl_ms);

    // Emit trigger.new_event
    eventBus.publish({
      type: "trigger.new_event",
      source: "daemon",
      task_id: null,
      payload: {
        idempotency_key: event.idempotency_key,
        source: event.source,
        event_type: event.event_type,
        external_ref: event.external_ref,
        title: event.title,
        body: event.body,
        repo: event.repo,
        clone_url: event.clone_url,
        metadata: event.metadata,
      },
    } satisfies PublishInput<"trigger.new_event">);

    // Create task: intake → queued
    const parsed = parseGitHubUrl(event.external_ref);
    const externalRef = parsed
      ? toExternalRef(parsed.owner, parsed.repo, parsed.number, parsed.type)
      : null;

    const task = taskEngine.createTask({
      title: event.title,
      repo: event.repo,
      source: event.source,
      description: event.body ?? "",
      external_ref: externalRef,
      clone_url: event.clone_url,
    });

    taskEngine.requestTransition(task.id, "queued", null, "new_trigger_event", "daemon");
    basePriorities.set(task.id, task.priority);
    logger.info({ taskId: task.id, title: event.title }, "Task created from trigger event");
  }

  // ── State Sync ──────────────────────────────────────────────────────

  function syncStateToCommPlugin(payload: TaskStateChangedPayload): void {
    const commPlugins = registry.getPluginsByType("communication");
    for (const plugin of commPlugins) {
      const comm = plugin as CommunicationAdapter;
      if (!comm.hasCapability("sync")) {
        continue;
      }
      const task = taskEngine.getTask(payload.task_id);
      const externalRef = task?.external_ref
        ? `https://github.com/${task.external_ref.repo}/issues/${String(task.external_ref.number)}`
        : null;

      comm
        .syncTaskState(payload.task_id, payload.from_state, payload.to_state, {
          task_title: task?.title ?? "",
          external_ref: externalRef,
          sub_state: payload.to_sub,
          reason: payload.reason,
        })
        .catch((err) => {
          logger.error(
            { err, pluginId: comm.manifest.id, taskId: payload.task_id },
            "Failed to sync task state to comm plugin",
          );
        });
    }
  }

  // ── Children All Done ───────────────────────────────────────────────

  function handleChildrenAllDone(payload: TaskChildrenAllDonePayload): void {
    const parent = taskEngine.getTask(payload.parent_task_id);
    if (!parent) {
      logger.warn(
        { parentTaskId: payload.parent_task_id },
        "Parent task not found for children_all_done",
      );
      return;
    }

    if (parent.state !== "active" || parent.sub_state !== "supervising") {
      logger.warn(
        { parentTaskId: payload.parent_task_id, state: parent.state, subState: parent.sub_state },
        "Parent not in supervising state for children_all_done",
      );
      return;
    }

    const transition = taskEngine.requestTransition(
      parent.id,
      "active",
      "integrating",
      "children_all_done",
      "daemon",
    );

    if (!transition.success) {
      logger.error(
        { parentTaskId: parent.id, reason: transition.reason },
        "Failed to transition parent to integrating",
      );
      return;
    }

    // Populate child_summaries on parent before re-dispatch
    const children = taskEngine.getChildren(parent.id);
    const summaries = children.map((child) => ({
      child_id: child.id,
      child_title: child.title,
      summary: child.description,
      key_outputs: [] as Array<{ type: "file"; path: string; description: string }>,
      patterns_introduced: [] as string[],
      gotchas: [] as string[],
      decisions_made: child.decisions.map((d) => d.what),
      pr_number: child.review?.pr_number ?? null,
      branch: child.workspace?.branch ?? "",
      test_status: (child.state === "completed" ? "passing" : "failing") as
        | "passing"
        | "failing"
        | "no_tests",
    }));
    taskEngine.updateTaskField(parent.id, "child_summaries", summaries);

    // Re-fetch parent with updated child_summaries for dispatch
    const updatedParent = taskEngine.getTask(parent.id);
    if (!updatedParent) {
      logger.error({ parentTaskId: parent.id }, "Parent task disappeared after update");
      return;
    }
    dispatchTask(updatedParent);

    logger.info(
      {
        parentTaskId: parent.id,
        allSucceeded: payload.all_succeeded,
        failedIds: payload.failed_ids,
      },
      "Parent task resumed for integration after all children completed",
    );
  }

  // ── Child Completion Detection ─────────────────────────────────────────

  /**
   * After a child task reaches a terminal state, check if all siblings are done.
   * If so, emit task.children_all_done so the Daemon can resume the parent.
   */
  function checkAndEmitChildrenAllDone(childTaskId: string): void {
    const child = taskEngine.getTask(childTaskId);
    if (!child?.parent_id) {
      return;
    }

    const siblings = taskEngine.getChildren(child.parent_id);
    const allTerminal = siblings.every((s) => s.state === "completed" || s.state === "failed");

    if (!allTerminal) {
      return;
    }

    const failedIds = siblings.filter((s) => s.state === "failed").map((s) => s.id);

    eventBus.publish({
      type: "task.children_all_done",
      source: "daemon",
      task_id: child.parent_id,
      payload: {
        parent_task_id: child.parent_id,
        child_ids: siblings.map((s) => s.id),
        all_succeeded: failedIds.length === 0,
        failed_ids: failedIds,
      },
    } satisfies PublishInput<"task.children_all_done">);

    logger.info(
      { parentTaskId: child.parent_id, allSucceeded: failedIds.length === 0, failedIds },
      "All children completed — emitting children_all_done",
    );
  }

  // ── Preemption ────────────────────────────────────────────────────────

  function evaluatePreemption(now: number): void {
    if (pendingPreemption) {
      checkPreemptionTimeout(now);
      return;
    }

    if (activeDispatches.size === 0) {
      return;
    }

    const queuedTasks = taskEngine.getQueuedByPriority();
    if (queuedTasks.length === 0) {
      return;
    }

    findAndInitiatePreemption(queuedTasks, now);
  }

  function findAndInitiatePreemption(
    queuedTasks: ReturnType<TaskEngine["getQueuedByPriority"]>,
    now: number,
  ): void {
    const candidate = queuedTasks[0];
    if (!candidate) {
      return;
    }

    for (const activeTaskId of activeDispatches.keys()) {
      const activeTask = taskEngine.getTask(activeTaskId);
      if (!activeTask) {
        continue;
      }

      if (shouldPreempt(activeTask.priority, candidate.priority, config.preemption_threshold)) {
        initiatePreemption(
          activeTaskId,
          candidate.id,
          candidate.priority - activeTask.priority,
          now,
        );
        break; // One preemption per tick
      }
    }
  }

  function initiatePreemption(
    targetTaskId: string,
    replacementTaskId: string,
    priorityDelta: number,
    now: number,
  ): void {
    pendingPreemption = {
      targetTaskId,
      replacementTaskId,
      requestedAt: now,
      retried: false,
    };

    eventBus.publish({
      type: "preemption.requested",
      source: "daemon",
      task_id: targetTaskId,
      payload: {
        target_task_id: targetTaskId,
        preempting_task_id: replacementTaskId,
        reason: "priority_delta_exceeded",
        priority_delta: priorityDelta,
      },
    } satisfies PublishInput<"preemption.requested">);

    logger.info({ targetTaskId, replacementTaskId }, "Preemption requested");
  }

  function checkPreemptionTimeout(now: number): void {
    if (!pendingPreemption) {
      return;
    }

    const elapsed = now - pendingPreemption.requestedAt;
    if (elapsed <= config.preemption_timeout_ms) {
      return;
    }

    if (pendingPreemption.retried) {
      // Second timeout: force-transition
      logger.error(
        { targetTaskId: pendingPreemption.targetTaskId },
        "Preemption double timeout — force-transitioning task to queued",
      );
      taskEngine.requestTransition(
        pendingPreemption.targetTaskId,
        "queued",
        null,
        "preemption_timeout",
        "daemon",
      );
      activeDispatches.delete(pendingPreemption.targetTaskId);
      pendingPreemption = null;
    } else {
      // First timeout: re-request
      logger.warn(
        { targetTaskId: pendingPreemption.targetTaskId },
        "Preemption timeout — re-requesting",
      );
      pendingPreemption.retried = true;
      pendingPreemption.requestedAt = now;

      eventBus.publish({
        type: "preemption.requested",
        source: "daemon",
        task_id: pendingPreemption.targetTaskId,
        payload: {
          target_task_id: pendingPreemption.targetTaskId,
          preempting_task_id: pendingPreemption.replacementTaskId,
          reason: "preemption_timeout_retry",
          priority_delta: 0,
        },
      } satisfies PublishInput<"preemption.requested">);
    }
  }

  // ── Scheduling ────────────────────────────────────────────────────────

  function getAvailableSlots(): number {
    return config.max_concurrent - activeDispatches.size;
  }

  /**
   * Check if a queued child task is eligible for scheduling.
   * Top-level tasks (no parent) are always eligible.
   * Child tasks require their parent to be in active.supervising.
   * If cascade_policy is pause_siblings, only one child runs at a time.
   */
  function isTaskEligible(task: { id: string; parent_id: string | null }): boolean {
    if (!task.parent_id) {
      return true;
    }

    const parent = taskEngine.getTask(task.parent_id);
    if (!parent) {
      return true; // Orphaned child — allow scheduling
    }

    // Parent must be in supervising state for children to run
    if (parent.state !== "active" || parent.sub_state !== "supervising") {
      return false;
    }

    // With pause_siblings policy, only one child can be active at a time
    if (parent.cascade_policy === "pause_siblings") {
      const siblings = taskEngine.getChildren(task.parent_id);
      const activeSibling = siblings.find((s) => s.id !== task.id && s.state === "active");
      if (activeSibling) {
        return false;
      }
    }

    return true;
  }

  function scheduleNext(): void {
    const available = getAvailableSlots();
    if (available <= 0) {
      return;
    }

    const queuedTasks = taskEngine.getQueuedByPriority();
    const eligible = queuedTasks.filter(isTaskEligible);

    const toSchedule = eligible.slice(0, available);
    for (const candidate of toSchedule) {
      dispatchTask(candidate);
    }
  }

  function dispatchTask(candidate: ReturnType<TaskEngine["getQueuedByPriority"]>[number]): void {
    // Build dispatch package
    const checkpoint = sessionMemory.getLatestCheckpoint(candidate.id);
    const repoKnowledge = candidate.workspace
      ? sessionMemory.getKnowledge("repo", candidate.workspace.repo)
      : [];
    const userKnowledge = sessionMemory.getKnowledge("user");

    const dispatch: Dispatch = {
      task: candidate,
      resume_from: checkpoint,
      knowledge: { repo: repoKnowledge, user: userKnowledge },
    };

    // Transition to active.working
    const transition = taskEngine.requestTransition(
      candidate.id,
      "active",
      "working",
      checkpoint ? "resumed_from_checkpoint" : "scheduled",
      "daemon",
    );

    if (!transition.success) {
      logger.warn(
        { taskId: candidate.id, reason: transition.reason },
        "Failed to transition task to active.working",
      );
      return;
    }

    logger.info(
      { taskId: candidate.id, title: candidate.title },
      "Dispatching task to Orchestrator",
    );

    // Fire-and-forget dispatch
    const promise = orchestrator.executeTask(dispatch);
    activeDispatches.set(candidate.id, promise);

    promise.then(
      (result) => handleTaskCompletion(candidate.id, result),
      (error) => handleTaskError(candidate.id, error),
    );
  }

  function handleTaskCompletion(taskId: string, result: ExecuteTaskResult): void {
    activeDispatches.delete(taskId);
    tasksCompleted++;

    // Fetch task title before transition (needed for notifications)
    const task = taskEngine.getTask(taskId);
    const taskTitle = task?.title ?? taskId;

    if (result.outcome === "completed") {
      taskEngine.requestTransition(taskId, "completed", null, "pipeline_completed", "daemon");
      // Check if this child's completion means all siblings are done
      checkAndEmitChildrenAllDone(taskId);
      // Workspace cleanup (D153): preserve branch, remove worktree
      try {
        workspaceManager.cleanupWorkspace(taskId, true);
      } catch {
        logger.warn({ taskId }, "Workspace cleanup failed after completion");
      }
      // Notify completion — personal channels + GitHub issue comment
      sendCompletionNotification(taskId, taskTitle);
      commentOnTaskIssue(taskId, "Task completed successfully.");
      logger.info({ taskId }, "Task completed");
    } else if (result.outcome === "review_pending") {
      taskEngine.requestTransition(taskId, "review_pending", "demo", "pr_created", "daemon");
      // Notify about PR review needed — personal channels + GitHub issue comment
      sendReviewPendingNotification(taskId, taskTitle);
      commentOnTaskIssue(taskId, "Pull request created — awaiting review.");
      logger.info({ taskId }, "Task awaiting PR review");
      // Do NOT cleanup workspace — task is still in progress
    } else if (result.outcome === "decomposed") {
      // Parent is already in active.supervising (set by Orchestrator).
      // Children are already queued. Daemon will schedule them on next tick.
      // Don't cleanup workspace — parent needs it for integration later.
      logger.info(
        { taskId, childCount: result.childTaskIds.length },
        "Task decomposed — children queued for scheduling",
      );
    } else if (result.outcome === "preempted") {
      taskEngine.requestTransition(taskId, "queued", null, "preempted", "daemon");
      logger.info({ taskId, lastPhase: result.lastPhase }, "Task preempted — returned to queue");
      pendingPreemption = null;
    } else if (result.outcome === "error") {
      logger.error({ taskId, phase: result.phase, reason: result.reason }, "Task error");
      taskEngine.requestTransition(taskId, "blocked", null, result.reason, "daemon");
      // Check if this child's failure means all siblings are terminal
      checkAndEmitChildrenAllDone(taskId);
      // Notify error — personal channels + GitHub issue comment
      sendTaskErrorNotification(taskId, taskTitle, result.reason);
      commentOnTaskIssue(taskId, `Task encountered an error: ${result.reason}`);
      // Don't cleanup workspace on error — task might be resumed
    }
  }

  function handleTaskError(taskId: string, error: unknown): void {
    activeDispatches.delete(taskId);
    logger.error({ taskId, error }, "Orchestrator crash during task execution");

    emitStuckDetected(taskId, "orchestrator_crash", 0);
    taskEngine.requestTransition(taskId, "queued", null, "crash_recovery", "daemon");
  }

  // ── Priority Aging ────────────────────────────────────────────────────

  function applyPriorityAging(now: number): void {
    const queuedTasks = taskEngine.getTasksByState("queued");
    for (const task of queuedTasks) {
      const base = basePriorities.get(task.id) ?? task.priority;
      const elapsed = now - Date.parse(task.created_at);
      const newPriority = computeAgedPriority(base, elapsed, config);

      if (newPriority !== null && newPriority > task.priority) {
        taskEngine.updateTaskField(task.id, "priority", newPriority);
        logger.debug(
          { taskId: task.id, from: task.priority, to: newPriority },
          "Task priority aged",
        );
      }
    }
  }

  // ── Stuck Detection ───────────────────────────────────────────────────

  function checkStuckTasks(now: number): void {
    for (const taskId of activeDispatches.keys()) {
      checkSingleTaskStuck(taskId, now);
    }

    checkBlockedEscalation(now);
    checkReviewPendingReminders(now);
  }

  function checkSingleTaskStuck(taskId: string, now: number): void {
    const task = taskEngine.getTask(taskId);
    if (!task?.started_at) {
      return;
    }

    const activeElapsed = now - Date.parse(task.started_at);
    const entries =
      activeElapsed > config.stuck_threshold_ms ? sessionMemory.queryJournal(taskId) : [];
    const latestTimestamp =
      entries.length > 0
        ? entries.map((e) => Date.parse(e.timestamp)).reduce((a, b) => Math.max(a, b), 0)
        : null;

    const result = evaluateTaskStuckness(
      activeElapsed,
      latestTimestamp,
      now,
      config.stuck_threshold_ms,
      config.max_active_duration_ms,
    );

    if (result) {
      emitStuckDetected(taskId, result.condition, result.elapsedMs);
    }
  }

  function emitStuckDetected(
    taskId: string,
    condition: "no_journal_entries" | "no_state_transition" | "orchestrator_crash",
    elapsedMs: number,
  ): void {
    eventBus.publish({
      type: "health.stuck_detected",
      source: "daemon",
      task_id: taskId,
      payload: {
        task_id: taskId,
        condition,
        threshold_ms:
          condition === "no_state_transition"
            ? config.max_active_duration_ms
            : config.stuck_threshold_ms,
        elapsed_ms: elapsedMs,
        last_activity: null,
      },
    } satisfies PublishInput<"health.stuck_detected">);
    logger.warn({ taskId, condition, elapsedMs }, "Stuck task detected");
  }

  // ── Blocked Timeout Escalation ──────────────────────────────────────

  function checkBlockedEscalation(now: number): void {
    const blockedTasks = taskEngine.getTasksByState("blocked");
    const timeoutPolicy = deps.safetyLayer.getTimeoutPolicy();
    const stages = timeoutPolicy.blocked.stages;

    // Clean up escalation state for tasks no longer blocked
    for (const taskId of blockedEscalationState.keys()) {
      if (!blockedTasks.some((t) => t.id === taskId)) {
        blockedEscalationState.delete(taskId);
      }
    }

    for (const task of blockedTasks) {
      if (!task.last_transition_at) {
        continue;
      }
      const elapsedMs = now - Date.parse(task.last_transition_at);
      processBlockedStages(task.id, task.title, elapsedMs, stages, now);
    }
  }

  function processBlockedStages(
    taskId: string,
    taskTitle: string,
    elapsedMs: number,
    stages: Array<{
      name: string;
      after_ms: number;
      action: string;
      repeat: boolean | null;
      repeat_interval_ms: number | null;
    }>,
    now: number,
  ): void {
    const state = blockedEscalationState.get(taskId) ?? { lastStageIndex: -1, lastActionAt: 0 };

    for (let i = 0; i < stages.length; i++) {
      const stage = stages[i];
      if (!stage || elapsedMs < stage.after_ms) {
        continue;
      }

      if (!shouldFireStage(i, stage, state, now)) {
        continue;
      }

      executeBlockedStageAction(taskId, taskTitle, stage);
      blockedEscalationState.set(taskId, { lastStageIndex: i, lastActionAt: now });
    }
  }

  /** Check if a stage should fire given the current escalation state. */
  function shouldFireStage(
    stageIndex: number,
    stage: { repeat: boolean | null; repeat_interval_ms: number | null },
    state: { lastStageIndex: number; lastActionAt: number },
    now: number,
  ): boolean {
    if (stageIndex > state.lastStageIndex) {
      return true; // New stage not yet reached
    }
    // Already processed — only re-fire if repeatable and interval elapsed
    if (stage.repeat && stage.repeat_interval_ms) {
      return now - state.lastActionAt >= stage.repeat_interval_ms;
    }
    return false;
  }

  function executeBlockedStageAction(
    taskId: string,
    taskTitle: string,
    stage: { name: string; action: string },
  ): void {
    if (stage.action === "send_reminder") {
      sendBlockedReminder(taskId, taskTitle);
      logger.info({ taskId, stage: stage.name }, "Blocked task reminder sent");
    } else if (stage.action === "evaluate_self_unblock") {
      orchestrator.attemptSelfUnblock(taskId).then(
        (resolved) => {
          if (resolved) {
            taskEngine.requestTransition(taskId, "active", "working", "self_unblocked", "daemon");
            blockedEscalationState.delete(taskId);
            logger.info({ taskId }, "Task self-unblocked");
          } else {
            logger.info({ taskId }, "Self-unblock check failed — continuing escalation");
          }
        },
        (err) => {
          logger.error({ taskId, err }, "Self-unblock check error");
        },
      );
    } else if (stage.action === "escalation_alert") {
      taskEngine.requestTransition(taskId, "failed", null, "blocked_timeout_escalation", "daemon");
      sendEscalationAlert(taskId, taskTitle);
      blockedEscalationState.delete(taskId);
      logger.warn({ taskId, stage: stage.name }, "Blocked task escalated to failed");
    }
  }

  function sendBlockedReminder(taskId: string, taskTitle: string): void {
    const owner = deps.peopleDirectory.getOwner();
    if (!owner) {
      return;
    }
    const commPlugins = registry.getPluginsByType<CommunicationAdapter>("communication");
    const content = `Task "${taskTitle}" is still blocked and waiting for attention.`;

    for (const comm of commPlugins) {
      if (!comm.hasCapability("send")) {
        continue;
      }
      const formatted = comm.formatMessage(content, "notification");
      comm
        .sendMessage(
          { user_id: owner.id, channel: null },
          { content: formatted, metadata: { task_id: taskId, type: "notification" } },
        )
        .catch((err) => {
          logger.error({ err, taskId }, "Failed to send blocked reminder");
        });
    }
  }

  function sendEscalationAlert(taskId: string, taskTitle: string): void {
    const owner = deps.peopleDirectory.getOwner();
    const reviewers = deps.peopleDirectory.getReviewers();
    const recipients = [...(owner ? [owner] : []), ...reviewers];
    const commPlugins = registry.getPluginsByType<CommunicationAdapter>("communication");
    const content = `ALERT: Task "${taskTitle}" has been blocked too long and was transitioned to failed. Please investigate.`;

    for (const person of recipients) {
      for (const comm of commPlugins) {
        if (!comm.hasCapability("send")) {
          continue;
        }
        const formatted = comm.formatMessage(content, "alert");
        comm
          .sendMessage(
            { user_id: person.id, channel: null },
            { content: formatted, metadata: { task_id: taskId, type: "alert" } },
          )
          .catch((err) => {
            logger.error({ err, taskId }, "Failed to send escalation alert");
          });
      }
    }
  }

  // ── Review Pending Reminders ──────────────────────────────────────────

  function checkReviewPendingReminders(now: number): void {
    const reviewPendingTasks = taskEngine.getTasksByState("review_pending");
    const timeoutPolicy = deps.safetyLayer.getTimeoutPolicy();
    const reviewConfig = timeoutPolicy.review_pending;

    cleanupStaleReminderTimes(reviewPendingTasks);

    for (const task of reviewPendingTasks) {
      evaluateReviewReminder(task, reviewConfig, now);
    }
  }

  // ── Review Pending Merge Detection ───────────────────────────────────

  function completeTaskOnMerge(task: {
    id: string;
    title: string;
    sub_state: string | null;
    review: { pr_number: number | null } | null;
  }): void {
    if (task.sub_state === "demo") {
      taskEngine.requestTransition(task.id, "review_pending", "code", "pr_merged", "daemon");
    }
    taskEngine.requestTransition(task.id, "completed", null, "pr_merged", "daemon");
    try {
      workspaceManager.cleanupWorkspace(task.id, true);
    } catch {
      logger.warn({ taskId: task.id }, "Workspace cleanup failed after PR merge");
    }
    sendCompletionNotification(task.id, task.title);
    commentOnTaskIssue(task.id, "PR merged — task completed.");
    logger.info(
      { taskId: task.id, prNumber: task.review?.pr_number },
      "PR merged — task completed",
    );
  }

  async function checkSingleTaskMerge(
    task: ReturnType<typeof taskEngine.getTasksByState>[number],
    hosting: GitHostingAdapter,
  ): Promise<void> {
    if (!(task.review?.pr_number && task.repo)) {
      return;
    }
    try {
      const status = await hosting.getPRStatus(task.repo, task.review.pr_number);
      if (status.state === "merged") {
        completeTaskOnMerge(task);
      }
    } catch (err) {
      logger.warn({ taskId: task.id, err }, "Failed to check PR status");
    }
  }

  async function checkReviewPendingMerges(): Promise<void> {
    const reviewTasks = taskEngine.getTasksByState("review_pending");
    if (reviewTasks.length === 0) {
      return;
    }

    const hostingPlugins = registry.getPluginsByType<GitHostingAdapter>("git_hosting");
    const hosting = hostingPlugins[0];
    if (!hosting) {
      return;
    }

    for (const task of reviewTasks) {
      await checkSingleTaskMerge(task, hosting);
    }
  }

  // ── Review Feedback Detection ─────────────────────────────────────────

  async function checkReviewPendingFeedback(): Promise<void> {
    const reviewTasks = taskEngine.getTasksByState("review_pending");
    if (reviewTasks.length === 0) {
      return;
    }

    // Prune stale dedup entries for tasks no longer in review_pending
    const reviewTaskIds = new Set(reviewTasks.map((t) => t.id));
    for (const key of processedReviewStates.keys()) {
      if (!reviewTaskIds.has(key)) {
        processedReviewStates.delete(key);
      }
    }

    const hostingPlugins = registry.getPluginsByType<GitHostingAdapter>("git_hosting");
    const hosting = hostingPlugins[0];
    if (!hosting) {
      return;
    }

    for (const task of reviewTasks) {
      await checkSingleTaskReviewFeedback(task, hosting);
    }
  }

  /** Fetch conversation-level PR comments (non-critical, returns [] on failure). */
  async function fetchPRCommentStrings(
    hosting: GitHostingAdapter,
    repo: string,
    prNumber: number,
  ): Promise<string[]> {
    try {
      const comments = await hosting.getPRComments(repo, prNumber);
      return comments
        .filter((c) => c.body.trim().length > 0)
        .map((c) => `@${c.author}: ${c.body.trim()}`);
    } catch {
      return []; // Non-critical — proceed with review data only
    }
  }

  type AggregateState = "changes_requested" | "approved" | "comment";
  type ReviewStatusLike = {
    changes_requested: boolean;
    approved: boolean;
    reviewers: Array<{ state: string; username?: string }>;
    comments?: string[];
  };

  /** Resolve aggregate state from review + conversation comments. */
  function resolveAggregateState(
    reviewStatus: ReviewStatusLike,
    prComments: string[],
  ): AggregateState | null {
    const state = deriveAggregateReviewState(reviewStatus);
    if (state) {
      return state;
    }
    return prComments.length > 0 ? "comment" : null;
  }

  /** Emit a feedback event for a task, with dedup check. Returns true if emitted. */
  function emitFeedbackIfNew(
    taskId: string,
    prNumber: number,
    aggregateState: AggregateState,
    allComments: string[],
    reviewStatus: ReviewStatusLike,
    isDraft: boolean,
  ): boolean {
    const dedupKey = `${aggregateState}:${String(allComments.length)}`;
    if (processedReviewStates.get(taskId) === dedupKey) {
      return false;
    }
    processedReviewStates.set(taskId, dedupKey);

    const stage = isDraft ? "demo" : "code";
    const primaryReviewer =
      reviewStatus.reviewers.find((r) => r.state === aggregateState) ?? reviewStatus.reviewers[0];

    eventBus.publish({
      type: "task.feedback_received",
      source: "daemon",
      task_id: taskId,
      payload: {
        task_id: taskId,
        stage,
        feedback_type: (aggregateState === "approved" ? "approved" : aggregateState) as
          | "approved"
          | "changes_requested"
          | "comment",
        reviewer: primaryReviewer?.username ?? "unknown",
        content: allComments.length > 0 ? allComments.join("\n") : null,
        pr_number: prNumber,
      },
    } satisfies PublishInput<"task.feedback_received">);
    return true;
  }

  async function checkSingleTaskReviewFeedback(
    task: ReturnType<typeof taskEngine.getTasksByState>[number],
    hosting: GitHostingAdapter,
  ): Promise<void> {
    if (!(task.review?.pr_number && task.repo)) {
      return;
    }

    try {
      const reviewStatus = await hosting.getReviewStatus(task.repo, task.review.pr_number);
      const prStatus = await hosting.getPRStatus(task.repo, task.review.pr_number);
      const prComments = await fetchPRCommentStrings(hosting, task.repo, task.review.pr_number);
      const allComments = [...(reviewStatus.comments ?? []), ...prComments];

      const aggregateState = resolveAggregateState(reviewStatus, prComments);
      if (!aggregateState) {
        return;
      }

      const emitted = emitFeedbackIfNew(
        task.id,
        task.review.pr_number,
        aggregateState,
        allComments,
        reviewStatus,
        prStatus.draft,
      );
      if (emitted) {
        logger.info(
          { taskId: task.id, aggregateState, prNumber: task.review.pr_number },
          "Review feedback detected",
        );
      }
    } catch (err) {
      logger.warn({ taskId: task.id, err }, "Failed to check PR review feedback");
    }
  }

  // ── Feedback Event Handler ──────────────────────────────────────────

  function handleFeedbackEvent(payload: TaskFeedbackReceivedPayload): void {
    const task = taskEngine.getTask(payload.task_id);
    if (!task) {
      return;
    }

    // Guard: only handle feedback for tasks in review_pending state
    if (task.state !== "review_pending") {
      logger.debug(
        { taskId: payload.task_id, state: task.state },
        "Ignoring feedback for non-review_pending task",
      );
      return;
    }

    // Store feedback round on the task
    storeFeedbackRound(payload);

    if (payload.feedback_type === "approved") {
      handleReviewApproval(task, payload);
    } else {
      handleFeedbackRework(task, payload);
    }
  }

  function storeFeedbackRound(payload: TaskFeedbackReceivedPayload): void {
    const task = taskEngine.getTask(payload.task_id);
    if (!task) {
      return;
    }
    const currentReview = task.review ?? {
      pr_number: payload.pr_number,
      pr_state: payload.stage === "demo" ? "draft" : "ready",
      demo_artifacts: [],
      feedback_rounds: [],
    };
    const comments = payload.content
      ? payload.content.split("\n").filter((line) => line.trim().length > 0)
      : [];
    const newRound = {
      stage: payload.stage,
      comments,
      applied: payload.feedback_type === "approved",
    };
    taskEngine.updateTaskField(payload.task_id, "review", {
      ...currentReview,
      feedback_rounds: [...currentReview.feedback_rounds, newRound],
    });
  }

  function handleReviewApproval(
    task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
    payload: TaskFeedbackReceivedPayload,
  ): void {
    if (payload.stage === "demo") {
      handleDemoApproval(task, payload);
    } else {
      handleCodeApproval(task, payload);
    }
  }

  function handleDemoApproval(
    task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
    payload: TaskFeedbackReceivedPayload,
  ): void {
    // Mark PR as ready (not draft) and transition demo → code
    const hosting = registry.getPluginsByType<GitHostingAdapter>("git_hosting")[0];
    if (hosting && task.repo && task.review?.pr_number) {
      hosting
        .updatePR(task.repo, task.review.pr_number, {
          title: null,
          body: null,
          draft: false,
          labels_add: null,
          labels_remove: null,
        })
        .then(() => {
          const currentReview = task.review ?? {
            pr_number: payload.pr_number,
            pr_state: "draft" as const,
            demo_artifacts: [],
            feedback_rounds: [],
          };
          taskEngine.updateTaskField(payload.task_id, "review", {
            ...currentReview,
            pr_state: "ready",
          });
          taskEngine.requestTransition(
            payload.task_id,
            "review_pending",
            "code",
            "demo_approved",
            "daemon",
          );
          commentOnTaskIssue(payload.task_id, "Demo approved — PR marked ready for code review.");
          logger.info(
            { taskId: payload.task_id },
            "Demo approved — PR marked ready for code review",
          );
        })
        .catch((err) => {
          logger.error(
            { err, taskId: payload.task_id },
            "Failed to mark PR ready after demo approval",
          );
        });
    }
  }

  function handleCodeApproval(
    task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
    payload: TaskFeedbackReceivedPayload,
  ): void {
    try {
      const repo = task.repo;
      const prNumber = task.review?.pr_number;
      const autoMergeAllowed = repo ? deps.safetyLayer.checkAutoMergeAllowed(repo) : false;

      if (autoMergeAllowed && prNumber && repo) {
        // Auto-merge: attempt squash merge directly
        const hosting = registry.getPluginsByType<GitHostingAdapter>("git_hosting")[0];
        if (hosting) {
          hosting
            .mergePR(repo, prNumber, "squash")
            .then((result) => {
              if (result.success) {
                taskEngine.updateTaskField(payload.task_id, "review", {
                  ...(task.review ?? {
                    pr_number: prNumber,
                    pr_state: "ready" as const,
                    demo_artifacts: [],
                    feedback_rounds: [],
                  }),
                  pr_state: "merged",
                });
                commentOnTaskIssue(
                  payload.task_id,
                  `Code approved — PR #${String(prNumber)} auto-merged.`,
                );
              }
              // Complete the task regardless of merge outcome
              taskEngine.requestTransition(
                payload.task_id,
                "completed",
                null,
                "code_approved_merged",
                "daemon",
              );
            })
            .catch(() => {
              // Merge failed — still complete, human merges manually
              taskEngine.requestTransition(
                payload.task_id,
                "completed",
                null,
                "code_approved",
                "daemon",
              );
              commentOnTaskIssue(
                payload.task_id,
                "Code approved — auto-merge failed, please merge manually.",
              );
            });
        }
      } else {
        // No auto-merge — complete, let human merge
        taskEngine.requestTransition(payload.task_id, "completed", null, "code_approved", "daemon");
        commentOnTaskIssue(payload.task_id, "Code review approved — ready to merge.");
      }
      logger.info({ taskId: payload.task_id, autoMergeAllowed }, "Code approved — task completing");
    } catch (err) {
      logger.error({ err, taskId: payload.task_id }, "Failed to handle code approval");
    }
  }

  function handleFeedbackRework(
    _task: NonNullable<ReturnType<typeof taskEngine.getTask>>,
    payload: TaskFeedbackReceivedPayload,
  ): void {
    try {
      taskEngine.requestTransition(
        payload.task_id,
        "queued",
        null,
        `feedback_rework:${payload.feedback_type}`,
        "daemon",
      );
      commentOnTaskIssue(
        payload.task_id,
        `Reviewer feedback received (${payload.feedback_type}) — reworking.`,
      );
      logger.info(
        { taskId: payload.task_id, feedbackType: payload.feedback_type },
        "Task re-queued after review feedback",
      );
    } catch (err) {
      logger.error({ err, taskId: payload.task_id }, "Failed to re-queue task after feedback");
    }
  }

  function cleanupStaleReminderTimes(activeTasks: Array<{ id: string }>): void {
    for (const taskId of reviewReminderTimes.keys()) {
      if (!activeTasks.some((t) => t.id === taskId)) {
        reviewReminderTimes.delete(taskId);
      }
    }
  }

  function evaluateReviewReminder(
    task: { id: string; title: string; last_transition_at: string },
    reviewConfig: { reminder_after_ms: number; repeat_interval_ms: number },
    now: number,
  ): void {
    if (!task.last_transition_at) {
      return;
    }

    const elapsedMs = now - Date.parse(task.last_transition_at);
    if (elapsedMs < reviewConfig.reminder_after_ms) {
      return;
    }

    const lastReminder = reviewReminderTimes.get(task.id) ?? 0;
    if (now - lastReminder < reviewConfig.repeat_interval_ms) {
      return;
    }

    sendReviewReminder(task.id, task.title, elapsedMs);
    reviewReminderTimes.set(task.id, now);
  }

  function sendReviewReminder(taskId: string, taskTitle: string, elapsedMs: number): void {
    const reviewers = deps.peopleDirectory.getReviewers();
    const commPlugins = registry.getPluginsByType<CommunicationAdapter>("communication");
    const hours = Math.floor(elapsedMs / 3_600_000);
    const content = `Review reminder: Task "${taskTitle}" has been pending review for ${String(hours)}h.`;

    for (const reviewer of reviewers) {
      for (const comm of commPlugins) {
        if (!comm.hasCapability("send")) {
          continue;
        }
        const formatted = comm.formatMessage(content, "notification");
        comm
          .sendMessage(
            { user_id: reviewer.id, channel: null },
            { content: formatted, metadata: { task_id: taskId, type: "notification" } },
          )
          .catch((err) => {
            logger.error({ err, taskId }, "Failed to send review reminder");
          });
      }
    }

    logger.info({ taskId, hours }, "Review pending reminder sent");
  }

  // ── Task Milestone Notifications ──────────────────────────────────────

  function sendCompletionNotification(taskId: string, taskTitle: string): void {
    const owner = deps.peopleDirectory.getOwner();
    if (!owner) {
      return;
    }
    const commPlugins = registry.getPluginsByType<CommunicationAdapter>("communication");
    const content = `Task "${taskTitle}" completed successfully.`;

    for (const comm of commPlugins) {
      if (!comm.hasCapability("send")) {
        continue;
      }
      const formatted = comm.formatMessage(content, "milestone");
      comm
        .sendMessage(
          { user_id: owner.id, channel: null },
          { content: formatted, metadata: { task_id: taskId, type: "milestone" } },
        )
        .catch((err) => {
          logger.error({ err, taskId }, "Failed to send completion notification");
        });
    }
  }

  function sendReviewPendingNotification(taskId: string, taskTitle: string): void {
    const owner = deps.peopleDirectory.getOwner();
    if (!owner) {
      return;
    }
    const commPlugins = registry.getPluginsByType<CommunicationAdapter>("communication");
    const content = `Task "${taskTitle}" — PR created, awaiting review.`;

    for (const comm of commPlugins) {
      if (!comm.hasCapability("send")) {
        continue;
      }
      const formatted = comm.formatMessage(content, "milestone");
      comm
        .sendMessage(
          { user_id: owner.id, channel: null },
          { content: formatted, metadata: { task_id: taskId, type: "milestone" } },
        )
        .catch((err) => {
          logger.error({ err, taskId }, "Failed to send review pending notification");
        });
    }
  }

  function sendTaskErrorNotification(taskId: string, taskTitle: string, reason: string): void {
    const owner = deps.peopleDirectory.getOwner();
    if (!owner) {
      return;
    }
    const commPlugins = registry.getPluginsByType<CommunicationAdapter>("communication");
    const content = `Task "${taskTitle}" encountered an error: ${reason}. Status: blocked.`;

    for (const comm of commPlugins) {
      if (!comm.hasCapability("send")) {
        continue;
      }
      const formatted = comm.formatMessage(content, "alert");
      comm
        .sendMessage(
          { user_id: owner.id, channel: null },
          { content: formatted, metadata: { task_id: taskId, type: "alert" } },
        )
        .catch((err) => {
          logger.error({ err, taskId }, "Failed to send task error notification");
        });
    }
  }

  function sendCostLimitNotification(taskId: string, taskTitle: string): void {
    const owner = deps.peopleDirectory.getOwner();
    if (!owner) {
      return;
    }
    const commPlugins = registry.getPluginsByType<CommunicationAdapter>("communication");
    const content = `Task "${taskTitle}" blocked — cost limit reached.`;

    for (const comm of commPlugins) {
      if (!comm.hasCapability("send")) {
        continue;
      }
      const formatted = comm.formatMessage(content, "alert");
      comm
        .sendMessage(
          { user_id: owner.id, channel: null },
          { content: formatted, metadata: { task_id: taskId, type: "alert" } },
        )
        .catch((err) => {
          logger.error({ err, taskId }, "Failed to send cost limit notification");
        });
    }
  }

  function commentOnTaskIssue(taskId: string, message: string): void {
    const task = taskEngine.getTask(taskId);
    if (!task?.external_ref) {
      return;
    }
    const { type, repo, number } = task.external_ref;
    if (type !== "github_issue" && type !== "github_pr") {
      return;
    }

    const commPlugins = registry.getPluginsByType<CommunicationAdapter>("communication");
    const plugin = commPlugins.find((p) => p.hasCapability("issue_management"));
    if (!plugin) {
      return;
    }

    plugin.commentOnIssue(repo, number, message).catch((err) => {
      logger.error({ err, taskId }, "Failed to comment on task issue");
    });
  }

  // ── Health Events ─────────────────────────────────────────────────────

  function emitHealthTriggerFailure(pluginId: string, failures: number, error: unknown): void {
    eventBus.publish({
      type: "health.trigger_failure",
      source: "daemon",
      task_id: null,
      payload: {
        trigger_id: pluginId,
        consecutive_failures: failures,
        threshold: config.plugins.consecutive_failures_threshold,
        last_error: error instanceof Error ? error.message : String(error),
        last_success: null,
      },
    } satisfies PublishInput<"health.trigger_failure">);
  }

  // ── Seen Key Cleanup ──────────────────────────────────────────────────

  function cleanupSeenKeys(now: number): void {
    for (const [key, expiry] of seenTriggerKeys) {
      if (expiry <= now) {
        seenTriggerKeys.delete(key);
      }
    }
  }

  // ── Cost Limit Processing ─────────────────────────────────────────────

  function processCostLimits(): void {
    if (costLimitTasks.length === 0) {
      return;
    }

    // Drain and clear in one pass (FIFO order)
    const pending = costLimitTasks.splice(0);
    for (const taskId of pending) {
      const task = taskEngine.getTask(taskId);
      if (task && task.state === "active") {
        logger.warn({ taskId }, "Task blocked due to cost limit");
        taskEngine.requestTransition(taskId, "blocked", null, "cost_limit_reached", "daemon");
        // Notify cost limit — personal channels + GitHub issue comment
        sendCostLimitNotification(taskId, task.title);
        commentOnTaskIssue(taskId, "Task blocked \u2014 cost limit reached.");
      }
    }
  }

  // ── Tick Loop ─────────────────────────────────────────────────────────

  async function tick(): Promise<void> {
    if (shuttingDown) {
      return;
    }

    const now = clock.now();

    // Step 1: Process event-driven flags
    processCostLimits();

    // Step 2: Poll triggers
    await pollTriggers(now);

    // Step 3: Evaluate preemption
    evaluatePreemption(now);

    // Step 4: Schedule
    scheduleNext();

    // Step 5: Priority aging
    applyPriorityAging(now);

    // Step 6: Stuck detection
    checkStuckTasks(now);

    // Step 7: Check if review-pending PRs have been merged
    await checkReviewPendingMerges();

    // Step 8: Check for PR review feedback on review-pending tasks
    await checkReviewPendingFeedback();

    // Step 9: Cleanup expired seen keys
    cleanupSeenKeys(now);
  }

  // ── Start (P1) ────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (running) {
      throw new Error("Daemon is already running");
    }

    logger.info("Daemon starting (Protocol P1)");

    // Single instance check + PID file
    checkAndWritePidFile();

    // Start Registry health check loop
    registry.startHealthCheckLoop();

    // Rebuild state from Task Engine (crash recovery)
    rebuildStateFromTaskEngine();

    // Register Event Bus subscriptions
    registerSubscriptions();

    // Set running state
    running = true;
    startedAt = new Date(clock.now()).toISOString();

    // Start tick interval
    tickInterval = setInterval(() => {
      tick().catch((error: unknown) => {
        logger.error({ error }, "Tick loop error");
      });
    }, config.tick_interval_ms);

    // Signal handling (tracked for cleanup in stop())
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const handler = () => {
        stop().catch((error: unknown) => {
          logger.error({ error }, `Error during ${signal} shutdown`);
        });
      };
      signalHandlers.push({ signal, handler });
      process.on(signal, handler);
    }

    logger.info({ startedAt }, "Daemon started — entering main loop");
  }

  // ── Stop (P15) ────────────────────────────────────────────────────────

  async function stop(): Promise<void> {
    if (!running || shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("Daemon shutting down (Protocol P15)");

    // Stop tick interval
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }

    // Drain active dispatches with shutdown timeout
    await drainActiveDispatches();

    // Shutdown plugins (reverse init order)
    await registry.shutdownAll();
    registry.stopHealthCheckLoop();

    // Unsubscribe from Event Bus
    unregisterSubscriptions();

    // Remove signal handlers
    for (const { signal, handler } of signalHandlers) {
      process.removeListener(signal, handler);
    }
    signalHandlers.length = 0;

    // Remove PID file
    removePidFile();

    // Final state
    running = false;
    logger.info("Daemon stopped");
  }

  async function drainActiveDispatches(): Promise<void> {
    for (const [taskId, promise] of activeDispatches) {
      try {
        await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("shutdown_timeout")), config.shutdown_timeout_ms);
          }),
        ]);
      } catch {
        logger.warn({ taskId }, "Shutdown timeout waiting for task");
      }

      // Transition active tasks to queued
      const task = taskEngine.getTask(taskId);
      if (task && task.state === "active") {
        taskEngine.requestTransition(taskId, "queued", null, "graceful_shutdown", "daemon");
      }
    }
    activeDispatches.clear();
  }

  // ── State Inspector ───────────────────────────────────────────────────

  function getState(): DaemonState {
    const failures: Record<string, number> = {};
    for (const [id, count] of triggerFailures) {
      failures[id] = count;
    }
    return {
      running,
      shuttingDown,
      startedAt,
      maxConcurrent: config.max_concurrent,
      activeTaskIds: [...activeDispatches.keys()],
      pendingPreemption,
      tasksCompleted,
      seenKeyCount: seenTriggerKeys.size,
      triggerFailures: failures,
    };
  }

  // ── Public API ────────────────────────────────────────────────────────

  return { start, stop, tick, getState };
}

// ── Process Liveness Check ──────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
