import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type Event,
  type EventPayloads,
  EventTypes,
  HealthStuckDetectedPayloadSchema,
  HealthTriggerFailurePayloadSchema,
  PreemptionRequestedPayloadSchema,
  ReviewPollCompletedPayloadSchema,
  SystemCleanupCompletedPayloadSchema,
  type TaskChildrenAllDonePayload,
  TaskChildrenAllDonePayloadSchema,
  type TaskFeedbackReceivedPayload,
  TaskFeedbackReceivedPayloadSchema,
  TriggerNewEventPayloadSchema,
} from "../../schemas/events.js";
import { SubStates, TaskStates } from "../../schemas/task.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import { type ExecuteTaskResult, Outcomes } from "../orchestrator/index.js";
import { DaemonAlreadyRunningError } from "./errors.js";
import { createDaemonHealthMonitor } from "./health-monitor.js";
import { createNotificationRouter } from "./notification-router.js";
import { createPreemptionManager } from "./preemption-manager.js";
import { type QueryHandlerDeps, handleQuery } from "./query-handler.js";
import { createReviewHandler } from "./review-handler.js";
import { createTaskScheduler } from "./task-scheduler.js";
import { createTriggerPoller } from "./trigger-poller.js";
import type { DaemonContext } from "./types.js";

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
  {
    type: "system.cleanup_completed",
    description: "Emitted after data lifecycle cleanup completes",
    payloadSchema: SystemCleanupCompletedPayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
];

// ── Types ───────────────────────────────────────────────────────────────────

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
export function createDaemon(ctx: DaemonContext): Daemon {
  const {
    config,
    eventBus,
    registry,
    taskEngine,
    clock,
    observer,
    engineerHome,
    dataLifecycleManager,
  } = ctx;

  // ── Facade State ──────────────────────────────────────────────────────
  let running = false;
  let shuttingDown = false;
  let startedAt: string | null = null;
  let tickInterval: ReturnType<typeof setInterval> | null = null;
  const signalHandlers: { signal: string; handler: () => void }[] = [];

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

    // Clean up triggerPoller base priority when task leaves the scheduling queue
    if (
      result.outcome === Outcomes.completed ||
      result.outcome === Outcomes.error ||
      result.outcome === Outcomes.review_pending ||
      result.outcome === Outcomes.decomposed
    ) {
      triggerPoller.removeBasePriority(taskId);
    }

    // Clear pending preemption on preempted outcome
    if (result.outcome === Outcomes.preempted) {
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
      observer.warn("Parent task not found for children_all_done", {
        parentTaskId: payload.parent_task_id,
      });
      return;
    }

    if (parent.state !== TaskStates.active || parent.sub_state !== SubStates.supervising) {
      observer.warn("Parent not in supervising state for children_all_done", {
        parentTaskId: payload.parent_task_id,
        state: parent.state,
        subState: parent.sub_state,
      });
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
      observer.error("Failed to transition parent to integrating", {
        parentTaskId: parent.id,
        reason: transition.reason,
      });
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
      observer.error("Parent task disappeared after update", { parentTaskId: parent.id });
      return;
    }
    scheduler.dispatchTask(updatedParent);

    observer.info("Parent task resumed for integration after all children completed", {
      parentTaskId: parent.id,
      allSucceeded: payload.all_succeeded,
      failedIds: payload.failed_ids,
    });
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
        throw new DaemonAlreadyRunningError(existingPid);
      }
      observer.warn("Removing stale PID file", { pid: existingPid });
      unlinkSync(pidPath);
    }

    writeFileSync(pidPath, String(process.pid));
    observer.info("PID file written", { pid: process.pid, path: pidPath });
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
        safetyLayer: ctx.safetyLayer,
        registry,
        observer,
      };
      handleQuery(payload, queryDeps).catch((err) => {
        observer.error("Query handler error", { err });
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

    observer.debug("Event subscriptions registered", { count: 5 });
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
        observer.warn("Recovering orphaned active task", {
          taskId: task.id,
          subState: task.sub_state,
        });
        taskEngine.requestTransition(task.id, TaskStates.queued, null, "crash_recovery", "daemon");
      }
    }

    const orphanCount = activeTasks.filter((t) => isSlotConsuming(t.state, t.sub_state)).length;
    observer.debug("Crash recovery scan complete", {
      activeTasks: activeTasks.length,
      orphansRecovered: orphanCount,
    });

    // Initialize base priorities for queued tasks (aging)
    const queuedTasks = taskEngine.getTasksByState(TaskStates.queued);
    scheduler.initializeBasePriorities(queuedTasks);

    // Copy trigger poller's base priorities (drain all pending from startup)
    const triggerBasePriorities = triggerPoller.drainNewBasePriorities();
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

    // Sync only newly added base priorities from trigger poller to scheduler
    const newBasePriorities = triggerPoller.drainNewBasePriorities();
    for (const [taskId, priority] of newBasePriorities) {
      scheduler.trackBasePriority(taskId, priority);
    }

    // Step 3: Evaluate preemption
    preemption.evaluate(now);

    // Step 4+5: Schedule + priority aging (shared query avoids redundant DB fetch)
    const queuedTasks = taskEngine.getQueuedByPriority();
    scheduler.scheduleNext(queuedTasks);
    scheduler.applyPriorityAging(now, queuedTasks);

    // Step 6: Stuck detection + blocked escalation + review reminders
    healthMonitor.checkStuckTasks(now);
    healthMonitor.checkBlockedEscalation(now);

    // Query review_pending tasks once, pass to all consumers (avoids 3 redundant DB queries/tick)
    const reviewPendingTasks = taskEngine.getTasksByState(TaskStates.review_pending);
    healthMonitor.checkReviewPendingReminders(now, reviewPendingTasks);

    // Step 7+8: Check merges and feedback (shared PR status cache avoids duplicate API calls)
    reviewHandler.clearTickCache();
    await reviewHandler.checkMerges(reviewPendingTasks);
    await reviewHandler.checkFeedback(reviewPendingTasks);

    // Step 9: Cleanup expired seen keys
    triggerPoller.cleanupExpiredKeys(now);
  }

  // ── Start (P1) ────────────────────────────────────────────────────────

  async function start(): Promise<void> {
    if (running) {
      throw new DaemonAlreadyRunningError();
    }

    observer.info("Daemon starting (Protocol P1)");

    // Pre-running initialization — if any step fails, undo everything in reverse
    // order so start() is atomic (either fully initialized or fully rolled back).
    try {
      // Single instance check + PID file
      checkAndWritePidFile();

      // Start Registry health check loop
      registry.startHealthCheckLoop();

      // Start data lifecycle manager
      dataLifecycleManager?.start();

      // Rebuild state from Task Engine (crash recovery)
      rebuildStateFromTaskEngine();

      // Register Event Bus subscriptions
      registerSubscriptions();
    } catch (error) {
      // Reverse-order cleanup — each is idempotent/safe if the step never ran
      unregisterSubscriptions();
      dataLifecycleManager?.stop();
      registry.stopHealthCheckLoop();
      removePidFile();
      throw error;
    }

    // Set running state
    running = true;
    startedAt = new Date(clock.now()).toISOString();

    // Start tick interval
    tickInterval = setInterval(() => {
      tick().catch((error: unknown) => {
        observer.error("Tick loop error", { err: sanitizeErrorMessage(error) });
      });
    }, config.tick_interval_ms);

    // Signal handling (tracked for cleanup in stop())
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const handler = () => {
        stop().catch((error: unknown) => {
          observer.error(`Error during ${signal} shutdown`, { err: sanitizeErrorMessage(error) });
        });
      };
      signalHandlers.push({ signal, handler });
      process.on(signal, handler);
    }

    observer.info("Daemon started — entering main loop", { startedAt });
  }

  // ── Stop (P15) ────────────────────────────────────────────────────────

  async function stop(): Promise<void> {
    if (!running || shuttingDown) {
      return;
    }

    shuttingDown = true;
    observer.info("Daemon shutting down (Protocol P15)");

    // Stop tick interval
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = null;
    }

    // Flush pending cost tracker snapshot before shutdown
    ctx.safetyLayer.flushCostSnapshot();

    // Stop data lifecycle manager
    dataLifecycleManager?.stop();

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
    const uptimeMs = startedAt ? clock.now() - new Date(startedAt).getTime() : 0;
    running = false;
    observer.info("Daemon stopped", { uptimeMs });
  }

  async function drainActiveDispatches(): Promise<void> {
    const dispatches = scheduler.getActiveDispatches();
    const total = dispatches.size;
    let drained = 0;
    let transitioned = 0;

    for (const [taskId, promise] of dispatches) {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error("shutdown_timeout")),
              config.shutdown_timeout_ms,
            );
          }),
        ]);
        drained++;
      } catch {
        observer.warn("Shutdown timeout waiting for task", { taskId });
      } finally {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
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
        transitioned++;
      }
    }
    dispatches.clear();

    if (total > 0) {
      observer.info("Active dispatches drained", { total, drained, transitioned });
    }
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
