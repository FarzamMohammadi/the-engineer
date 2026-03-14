import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";

import type { DaemonConfig } from "../../schemas/config.js";
import {
  type Event,
  type EventPayloads,
  EventTypes,
  HealthStuckDetectedPayloadSchema,
  HealthTriggerFailurePayloadSchema,
  PreemptionRequestedPayloadSchema,
  ReviewPollCompletedPayloadSchema,
  type TaskChildrenAllDonePayload,
  TaskChildrenAllDonePayloadSchema,
  type TaskFeedbackReceivedPayload,
  TaskFeedbackReceivedPayloadSchema,
  TriggerNewEventPayloadSchema,
} from "../../schemas/events.js";
import { SubStates, TaskStates } from "../../schemas/task.js";
import type { ActionPipeline } from "../action-pipeline/index.js";
import type { EventBus } from "../event-bus/index.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { ISafetyLayer } from "../interfaces/safety-layer.interface.js";
import type { ISessionMemory } from "../interfaces/session-memory.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { ExecuteTaskResult, Orchestrator } from "../orchestrator/index.js";
import type { PeopleDirectory } from "../people-directory/index.js";
import type { Registry } from "../registry/index.js";
import type { WorkspaceManager } from "../workspace-manager/index.js";
import { createDaemonHealthMonitor } from "./health-monitor.js";
import { createNotificationRouter } from "./notification-router.js";
import { createPreemptionManager } from "./preemption-manager.js";
import { type QueryHandlerDeps, handleQuery } from "./query-handler.js";
import { createReviewHandler } from "./review-handler.js";
import { createTaskScheduler } from "./task-scheduler.js";
import { createTriggerPoller } from "./trigger-poller.js";

// ── Event Declarations ──────────────────────────────────────────────────────

export const EVENTS: EventDeclaration[] = [
  {
    type: "trigger.new_event",
    description: "Emitted when a trigger adapter detects a new assignable event",
    payloadSchema: TriggerNewEventPayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
  {
    type: "health.trigger_failure",
    description: "Emitted when a trigger adapter fails consecutively",
    payloadSchema: HealthTriggerFailurePayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
  {
    type: "health.stuck_detected",
    description: "Emitted when a task is detected as stuck (no progress)",
    payloadSchema: HealthStuckDetectedPayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
  {
    type: "task.children_all_done",
    description: "Emitted when all child tasks of a parent have completed",
    payloadSchema: TaskChildrenAllDonePayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
  {
    type: "preemption.requested",
    description: "Emitted when a higher-priority task preempts a running task",
    payloadSchema: PreemptionRequestedPayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
  {
    type: "task.feedback_received",
    description: "Emitted when PR review feedback is processed",
    payloadSchema: TaskFeedbackReceivedPayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
  {
    type: "review.poll_completed",
    description: "Emitted after polling PR review status",
    payloadSchema: ReviewPollCompletedPayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
];

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
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
  actionPipeline: ActionPipeline;
  orchestrator: Orchestrator;
  sessionMemory: ISessionMemory;
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
  return (
    state === TaskStates.active &&
    (subState === SubStates.working || subState === SubStates.integrating)
  );
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
    workspaceManager,
    clock,
    logger,
    engineerHome,
  } = deps;

  // ── Facade State ──────────────────────────────────────────────────────
  let running = false;
  let shuttingDown = false;
  let startedAt: string | null = null;
  let tickInterval: ReturnType<typeof setInterval> | null = null;
  const signalHandlers: { signal: string; handler: () => void }[] = [];

  // ── DaemonContext (shared across subsystems) ──────────────────────────
  const ctx = {
    config,
    eventBus,
    registry,
    taskEngine,
    safetyLayer: deps.safetyLayer,
    orchestrator,
    sessionMemory: deps.sessionMemory,
    workspaceManager,
    peopleDirectory: deps.peopleDirectory,
    clock,
    logger,
    engineerHome,
  };

  // ── Create Subsystems ─────────────────────────────────────────────────
  const notifications = createNotificationRouter(ctx);

  const scheduler = createTaskScheduler(ctx, notifications, {
    onTaskCompleted: (taskId, result) => handleTaskCompletion(taskId, result),
    onTaskError: (taskId, error) => handleTaskError(taskId, error),
  });

  const preemption = createPreemptionManager(
    ctx,
    () => scheduler.getActiveTaskIds(),
    (taskId) => scheduler.removeActiveDispatch(taskId),
  );

  const triggerPoller = createTriggerPoller(ctx);

  const reviewHandler = createReviewHandler(ctx, notifications, {
    onTaskMergeComplete: (taskId) => scheduler.checkAndEmitChildrenAllDone(taskId),
  });

  const healthMonitor = createDaemonHealthMonitor(ctx, notifications, () =>
    scheduler.getActiveTaskIds(),
  );

  // ── Cross-Subsystem Coordination ──────────────────────────────────────

  function handleTaskCompletion(taskId: string, result: ExecuteTaskResult): void {
    scheduler.handleTaskCompletion(taskId, result);

    // Clear pending preemption on preempted outcome
    if (result.outcome === "preempted") {
      preemption.clearPending();
    }
  }

  function handleTaskError(taskId: string, error: unknown): void {
    scheduler.handleTaskError(taskId, error);
  }

  // ── Children All Done Handler ─────────────────────────────────────────

  function handleChildrenAllDone(payload: TaskChildrenAllDonePayload): void {
    const parent = taskEngine.getTask(payload.parent_task_id);
    if (!parent) {
      logger.warn(
        { parentTaskId: payload.parent_task_id },
        "Parent task not found for children_all_done",
      );
      return;
    }

    if (parent.state !== TaskStates.active || parent.sub_state !== SubStates.supervising) {
      logger.warn(
        { parentTaskId: payload.parent_task_id, state: parent.state, subState: parent.sub_state },
        "Parent not in supervising state for children_all_done",
      );
      return;
    }

    const transition = taskEngine.requestTransition(
      parent.id,
      TaskStates.active,
      SubStates.integrating,
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
      test_status: (child.state === TaskStates.completed ? "passing" : "failing") as
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
    scheduler.dispatchTask(updatedParent);

    logger.info(
      {
        parentTaskId: parent.id,
        allSucceeded: payload.all_succeeded,
        failedIds: payload.failed_ids,
      },
      "Parent task resumed for integration after all children completed",
    );
  }

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
    eventBus.subscribe("daemon:cost", EventTypes["cost.limit_reached"], (event: Event) => {
      const payload = event.payload as EventPayloads["cost.limit_reached"];
      if (payload.task_id) {
        healthMonitor.addCostLimitTask(payload.task_id);
      }
    });

    eventBus.subscribe("daemon:comm", EventTypes["comm.message_received"], (event: Event) => {
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

    eventBus.subscribe("daemon:state-sync", EventTypes["task.state_changed"], (event: Event) => {
      const payload = event.payload as EventPayloads["task.state_changed"];
      notifications.syncStateToCommPlugin(payload);
    });

    eventBus.subscribe(
      "daemon:children-done",
      EventTypes["task.children_all_done"],
      (event: Event) => {
        const payload = event.payload as TaskChildrenAllDonePayload;
        handleChildrenAllDone(payload);
      },
    );

    eventBus.subscribe("daemon:feedback", EventTypes["task.feedback_received"], (event: Event) => {
      const payload = event.payload as TaskFeedbackReceivedPayload;
      reviewHandler.handleFeedbackEvent(payload);
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
    const activeTasks = taskEngine.getTasksByState(TaskStates.active);
    for (const task of activeTasks) {
      if (isSlotConsuming(task.state, task.sub_state)) {
        logger.warn(
          { taskId: task.id, subState: task.sub_state },
          "Recovering orphaned active task",
        );
        taskEngine.requestTransition(task.id, TaskStates.queued, null, "crash_recovery", "daemon");
      }
    }

    // Initialize base priorities for queued tasks (aging)
    const queuedTasks = taskEngine.getTasksByState(TaskStates.queued);
    scheduler.initializeBasePriorities(queuedTasks);

    // Copy trigger poller's base priorities
    const triggerBasePriorities = triggerPoller.getBasePriorities();
    for (const [taskId, priority] of triggerBasePriorities) {
      scheduler.trackBasePriority(taskId, priority);
    }
  }

  // ── Tick Loop ─────────────────────────────────────────────────────────

  async function tick(): Promise<void> {
    if (shuttingDown) {
      return;
    }

    const now = clock.now();

    // Step 1: Process event-driven flags
    healthMonitor.processCostLimits();

    // Step 2: Poll triggers
    await triggerPoller.poll(now);

    // Sync new base priorities from trigger poller to scheduler
    const triggerBasePriorities = triggerPoller.getBasePriorities();
    for (const [taskId, priority] of triggerBasePriorities) {
      scheduler.trackBasePriority(taskId, priority);
    }

    // Step 3: Evaluate preemption
    preemption.evaluate(now);

    // Step 4: Schedule
    scheduler.scheduleNext();

    // Step 5: Priority aging
    scheduler.applyPriorityAging(now);

    // Step 6: Stuck detection + blocked escalation + review reminders
    healthMonitor.checkStuckTasks(now);
    healthMonitor.checkBlockedEscalation(now);
    healthMonitor.checkReviewPendingReminders(now);

    // Step 7: Check if review-pending PRs have been merged
    await reviewHandler.checkMerges();

    // Step 8: Check for PR review feedback on review-pending tasks
    await reviewHandler.checkFeedback();

    // Step 9: Cleanup expired seen keys
    triggerPoller.cleanupExpiredKeys(now);
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
    for (const [taskId, promise] of scheduler.getActiveDispatches()) {
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
      if (task && task.state === TaskStates.active) {
        taskEngine.requestTransition(
          taskId,
          TaskStates.queued,
          null,
          "graceful_shutdown",
          "daemon",
        );
      }
    }
    scheduler.getActiveDispatches().clear();
  }

  // ── State Inspector ───────────────────────────────────────────────────

  function getState(): DaemonState {
    return {
      running,
      shuttingDown,
      startedAt,
      maxConcurrent: config.max_concurrent,
      activeTaskIds: scheduler.getActiveTaskIds(),
      pendingPreemption: preemption.getPending(),
      tasksCompleted: scheduler.getTasksCompleted(),
      seenKeyCount: triggerPoller.getSeenKeyCount(),
      triggerFailures: triggerPoller.getTriggerFailures(),
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

// ── Barrel Exports ──────────────────────────────────────────────────────────

export type { TriggerPoller } from "./trigger-poller.js";
export type { TaskScheduler } from "./task-scheduler.js";
export type { PreemptionManager } from "./preemption-manager.js";
export type { NotificationRouter } from "./notification-router.js";
export type { ReviewHandler } from "./review-handler.js";
export type { DaemonHealthMonitor } from "./health-monitor.js";
