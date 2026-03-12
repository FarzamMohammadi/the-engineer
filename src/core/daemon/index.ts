import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";

import type { CommunicationAdapter } from "../../adapters/communication.js";
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

    // Subscribe to PR review feedback — transition task back to queued for rework
    eventBus.subscribe("daemon:feedback", "task.feedback_received", (event: Event) => {
      const payload = event.payload as TaskFeedbackReceivedPayload;
      if (payload.feedback_type === "changes_requested" || payload.feedback_type === "comment") {
        try {
          taskEngine.requestTransition(
            payload.task_id,
            "queued",
            null,
            `feedback_rework:${payload.feedback_type}`,
            "daemon",
          );
          logger.info(
            { taskId: payload.task_id, feedbackType: payload.feedback_type },
            "Task re-queued after review feedback",
          );
        } catch (err) {
          logger.error({ err, taskId: payload.task_id }, "Failed to re-queue task after feedback");
        }
      }
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

    // Re-dispatch parent for integration phase
    dispatchTask(parent);

    logger.info(
      {
        parentTaskId: parent.id,
        allSucceeded: payload.all_succeeded,
        failedIds: payload.failed_ids,
      },
      "Parent task resumed for integration after all children completed",
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

    if (result.outcome === "completed") {
      taskEngine.requestTransition(taskId, "completed", null, "pipeline_completed", "daemon");
      // Workspace cleanup (D153): preserve branch, remove worktree
      try {
        workspaceManager.cleanupWorkspace(taskId, true);
      } catch {
        logger.warn({ taskId }, "Workspace cleanup failed after completion");
      }
      logger.info({ taskId }, "Task completed");
    } else if (result.outcome === "preempted") {
      taskEngine.requestTransition(taskId, "queued", null, "preempted", "daemon");
      logger.info({ taskId, lastPhase: result.lastPhase }, "Task preempted — returned to queue");
      pendingPreemption = null;
    } else {
      logger.error({ taskId, phase: result.phase, reason: result.reason }, "Task error");
      taskEngine.requestTransition(taskId, "blocked", null, result.reason, "daemon");
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

    // Step 7: Cleanup expired seen keys
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
