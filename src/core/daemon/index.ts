import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PluginHealthStates } from "../../schemas/adapters.js";
import {
  CommRetryExhaustedPayloadSchema,
  CommRetrySucceededPayloadSchema,
  CommSendFailedPayloadSchema,
  type Event,
  type EventPayloads,
  EventTypes,
  GitBranchDeletedPayloadSchema,
  HealthStuckDetectedPayloadSchema,
  HealthTriggerFailurePayloadSchema,
  PreemptionCompletedPayloadSchema,
  PreemptionRequestedPayloadSchema,
  ReviewPollCompletedPayloadSchema,
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
import { createCostLimitQueue } from "./cost-limit-queue.js";
import { DaemonAlreadyRunningError } from "./errors.js";
import { createDaemonHealthMonitor } from "./health-monitor.js";
import { type PendingPreemption, createPreemptionManager } from "./preemption-manager.js";
import { type QueryHandlerDeps, handleQuery } from "./query-handler.js";
import { createResponsePoller } from "./response-poller.js";
import { createReviewHandler } from "./review-handler.js";
import { createTaskScheduler, isSlotConsuming } from "./task-scheduler.js";
import { createTriggerPoller } from "./trigger-poller.js";
import type { DaemonContext } from "./types.js";
import { createUnblockResolver } from "./unblock-resolver.js";

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
    subscribers: ["daemon"],
  },
  {
    type: "health.stuck_detected",
    description: "Emitted when a task is detected as stuck (no progress)",
    payloadSchema: HealthStuckDetectedPayloadSchema,
    publishers: ["daemon"],
    subscribers: ["daemon"],
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
    type: "preemption.completed",
    description:
      "Emitted when a preemption cycle completes (cooperative yield or forced transition)",
    payloadSchema: PreemptionCompletedPayloadSchema,
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
    type: "comm.send_failed",
    description: "Emitted when a notification could not be delivered to any channel for a person",
    payloadSchema: CommSendFailedPayloadSchema,
    publishers: ["notification-router"],
    subscribers: [],
  },
  {
    type: "comm.retry_succeeded",
    description: "Emitted when a previously failed notification is successfully delivered on retry",
    payloadSchema: CommRetrySucceededPayloadSchema,
    publishers: ["notification-router"],
    subscribers: [],
  },
  {
    type: "comm.retry_exhausted",
    description:
      "Emitted when notification retries are abandoned (max attempts, max age, or task terminal)",
    payloadSchema: CommRetryExhaustedPayloadSchema,
    publishers: ["notification-router"],
    subscribers: [],
  },
  {
    type: "git.branch_deleted",
    description: "Emitted when the daemon deletes a task branch from the remote after merge",
    payloadSchema: GitBranchDeletedPayloadSchema,
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
  slotUtilization: { active: number; max: number };
}

/** The Daemon public API. */
export interface Daemon {
  start(): Promise<void>;
  stop(): Promise<void>;
  tick(): Promise<void>;
  getState(): DaemonState;
}

// ── Pure Function Re-exports ──────────────────────────────────────────────────
// Each function lives in its subsystem file — re-exported here for backward compatibility.

export { isSlotConsuming } from "./task-scheduler.js";
export { shouldPreempt } from "./preemption-manager.js";
export { deriveAggregateReviewState } from "./review-handler.js";
export { evaluateTaskStuckness } from "./health-monitor.js";

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Daemon instance (Decision #124: factory function, not class).
 *
 * The Daemon is the always-running heartbeat — polls triggers, creates tasks,
 * dispatches to the Orchestrator, manages preemption/health, handles
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
  let tickCount = 0;

  /** Cooldown map for health event notifications — prevents flooding owner. */
  const healthNotifyCooldowns = new Map<string, number>();
  const HEALTH_NOTIFY_COOLDOWN_MS = 300_000; // 5 minutes

  /** Memory warning threshold in bytes (2 GB). */
  const MEMORY_WARNING_BYTES = 2 * 1024 * 1024 * 1024;
  /** Memory critical threshold in bytes (4 GB). */
  const MEMORY_CRITICAL_BYTES = 4 * 1024 * 1024 * 1024;
  /** Log RSS every N ticks. */
  const MEMORY_LOG_INTERVAL = 10;
  // Note: Signal handling is the CLI's responsibility (src/cli/commands/start.ts).
  // When using the daemon programmatically, the caller must call daemon.stop() on shutdown signals.

  // ── Create Subsystems ─────────────────────────────────────────────────
  const notifications = ctx.notifications;

  const scheduler = createTaskScheduler(ctx, notifications, {
    onTaskCompleted: (taskId, result) => handleTaskCompletion(taskId, result),
    onTaskError: (taskId, error) => handleTaskError(taskId, error),
  });

  const preemption = createPreemptionManager(
    ctx,
    () => scheduler.getActiveTaskIds(),
    (taskId) => scheduler.removeActiveDispatch(taskId),
  );

  const unblockResolver = createUnblockResolver({
    taskEngine: ctx.taskEngine,
    workspaceManager: ctx.workspaceManager,
    observer: ctx.observer,
  });

  const triggerPoller = createTriggerPoller(ctx);
  const responsePoller = createResponsePoller(ctx, unblockResolver);

  const reviewHandler = createReviewHandler(ctx, notifications, {
    onTaskCompletionFinalized: (taskId) => scheduler.checkAndEmitChildrenAllDone(taskId),
  });

  const healthMonitor = createDaemonHealthMonitor(ctx, notifications, () =>
    scheduler.getActiveTaskIds(),
  );

  const costLimitQueue = createCostLimitQueue(taskEngine, notifications, observer);

  // ── Cross-Subsystem Coordination ──────────────────────────────────────

  function handleTaskCompletion(taskId: string, result: ExecuteTaskResult): void {
    scheduler.handleTaskCompletion(taskId, result);

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

    // Populate child_summaries on parent before any dispatch
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

    // Slot overrun check: if all slots are full, transition parent to queued
    // for normal scheduling instead of bypassing the slot check.
    const availableSlots = config.max_concurrent - scheduler.getActiveTaskIds().length;
    if (availableSlots <= 0) {
      const requeue = taskEngine.requestTransition(
        parent.id,
        TaskStates.queued,
        null,
        "slot_unavailable_after_children_done",
        "daemon",
      );
      if (requeue.success) {
        observer.info("Parent task queued (slot unavailable after children done)", {
          parentTaskId: parent.id,
        });
      } else {
        observer.error("Failed to requeue parent after slot overrun", {
          parentTaskId: parent.id,
          reason: requeue.reason,
        });
      }
      return;
    }

    // Slots available — transition to active.integrating and dispatch
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
        costLimitQueue.add(payload.task_id);
      }
    });

    eventBus.subscribe("daemon:comm", EventTypes["comm.message_received"], (event: Event) => {
      const payload = event.payload as EventPayloads["comm.message_received"];
      // Skip task-directed responses — those are handled by the ResponsePoller for unblocking.
      // Only general queries (no task_id) go to the QueryHandler.
      if (payload.task_id) {
        return;
      }
      const queryDeps: QueryHandlerDeps = {
        taskEngine,
        safetyLayer: ctx.safetyLayer,
        notifications,
      };
      try {
        handleQuery(payload, queryDeps);
      } catch (err) {
        observer.error("Query handler error", { err });
      }
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

    // ── Health event → owner notification (with cooldown dedup) ──────────

    function shouldNotifyHealth(key: string, now: number): boolean {
      const last = healthNotifyCooldowns.get(key) ?? 0;
      if (now - last < HEALTH_NOTIFY_COOLDOWN_MS) {
        return false;
      }
      healthNotifyCooldowns.set(key, now);
      return true;
    }

    eventBus.subscribe(
      "daemon:health-trigger",
      EventTypes["health.trigger_failure"],
      (event: Event) => {
        const p = event.payload as EventPayloads["health.trigger_failure"];
        if (!shouldNotifyHealth(`trigger:${p.trigger_id}`, clock.now())) {
          return;
        }
        notifications.notify({
          kind: "alert",
          taskId: null,
          message: `Trigger adapter "${p.trigger_id}" has failed ${String(p.consecutive_failures)} consecutive times (threshold: ${String(p.threshold)}). Last error: ${p.last_error}. Check your configuration.`,
        });
      },
    );

    eventBus.subscribe(
      "daemon:health-stuck",
      EventTypes["health.stuck_detected"],
      (event: Event) => {
        const p = event.payload as EventPayloads["health.stuck_detected"];
        if (!shouldNotifyHealth(`stuck:${p.task_id}`, clock.now())) {
          return;
        }
        const title = taskEngine.getTask(p.task_id)?.title ?? p.task_id;
        notifications.notify({
          kind: "alert",
          taskId: p.task_id,
          message: `Task "${title}" appears stuck (${p.condition}). Elapsed: ${String(Math.floor(p.elapsed_ms / 60_000))}m. Threshold: ${String(Math.floor(p.threshold_ms / 60_000))}m.`,
        });
      },
    );

    eventBus.subscribe(
      "daemon:health-plugin-failed",
      EventTypes["health.plugin_failed"],
      (event: Event) => {
        const p = event.payload as EventPayloads["health.plugin_failed"];
        if (!shouldNotifyHealth(`plugin:${p.plugin_id}`, clock.now())) {
          return;
        }
        notifications.notify({
          kind: "alert",
          taskId: null,
          message: `Plugin "${p.plugin_id}" (${p.plugin_type}) has failed ${String(p.consecutive_failures)} consecutive times (threshold: ${String(p.threshold)}). Error: ${p.error}`,
        });
      },
    );

    eventBus.subscribe(
      "daemon:health-plugin-unhealthy",
      EventTypes["health.plugin_unhealthy"],
      (event: Event) => {
        const p = event.payload as EventPayloads["health.plugin_unhealthy"];
        if (!shouldNotifyHealth(`plugin-unhealthy:${p.plugin_id}`, clock.now())) {
          return;
        }
        notifications.notify({
          kind: "alert",
          taskId: null,
          message: `Plugin "${p.plugin_id}" (${p.plugin_type}) is unhealthy after ${String(p.consecutive_failures)} consecutive failures. Error: ${p.error}`,
        });
      },
    );

    observer.debug("Event subscriptions registered", { count: 9 });
  }

  function unregisterSubscriptions(): void {
    eventBus.unsubscribe("daemon:cost");
    eventBus.unsubscribe("daemon:comm");
    eventBus.unsubscribe("daemon:state-sync");
    eventBus.unsubscribe("daemon:children-done");
    eventBus.unsubscribe("daemon:feedback");
    eventBus.unsubscribe("daemon:health-trigger");
    eventBus.unsubscribe("daemon:health-stuck");
    eventBus.unsubscribe("daemon:health-plugin-failed");
    eventBus.unsubscribe("daemon:health-plugin-unhealthy");
  }

  // ── Startup: Protocol P1 ──────────────────────────────────────────────

  function rebuildStateFromTaskEngine(): void {
    // Crash recovery: transition orphaned active tasks → queued
    const activeTasks = taskEngine.getTasksByState(TaskStates.active);
    let recovered = 0;
    let failed = 0;

    for (const task of activeTasks) {
      if (isSlotConsuming(task.state, task.sub_state)) {
        observer.warn("Recovering orphaned active task", {
          taskId: task.id,
          subState: task.sub_state,
        });
        const result = taskEngine.requestTransition(
          task.id,
          TaskStates.queued,
          null,
          "crash_recovery",
          "daemon",
        );
        if (result.success) {
          recovered++;
        } else {
          failed++;
          observer.error("Crash recovery transition failed", {
            taskId: task.id,
            reason: result.reason,
          });
        }
      }
    }

    observer.info("Crash recovery scan complete", {
      activeTasks: activeTasks.length,
      orphansRecovered: recovered,
      recoveryFailures: failed,
    });
  }

  // ── Tick Loop ─────────────────────────────────────────────────────────

  async function tick(): Promise<void> {
    if (shuttingDown) {
      return;
    }

    const now = clock.now();

    // Step 1: Process event-driven flags
    costLimitQueue.process();

    // Step 2: Poll triggers
    await triggerPoller.poll(now);

    // Step 2b: Poll for communication responses (GitHub comments, dashboard, etc.)
    await responsePoller.poll(now);

    // Step 2c: Process pending notification retries
    notifications.processRetries?.(now);

    // Step 3+4: Preemption + schedule (single DB query for both)
    const queuedTasks = taskEngine.getQueuedByPriority();
    preemption.evaluate(now, queuedTasks);
    scheduler.scheduleNext(queuedTasks);

    // Step 6: Stuck detection + blocked escalation + review reminders
    healthMonitor.checkStuckTasks(now);
    healthMonitor.checkBlockedEscalation(now);

    // Query review_pending tasks once, pass to all consumers (avoids 3 redundant DB queries/tick)
    const reviewPendingTasks = taskEngine.getTasksByState(TaskStates.review_pending);
    healthMonitor.checkReviewPendingReminders(now, reviewPendingTasks);

    // Step 7+8+8b: Check merges, feedback, and CI for approved tasks
    reviewHandler.clearTickCache();
    await reviewHandler.checkMerges(reviewPendingTasks);
    await reviewHandler.checkFeedback(reviewPendingTasks);
    await reviewHandler.checkApprovedCI();

    // Step 9: Cleanup expired seen keys and stale health cooldowns
    triggerPoller.cleanupExpiredKeys(now);
    for (const [key, ts] of healthNotifyCooldowns) {
      if (now - ts > HEALTH_NOTIFY_COOLDOWN_MS * 2) {
        healthNotifyCooldowns.delete(key);
      }
    }

    // Step 10: Memory instrumentation
    tickCount++;
    if (tickCount % MEMORY_LOG_INTERVAL === 0) {
      const rss = process.memoryUsage().rss;
      const rssMb = (rss / (1024 * 1024)).toFixed(1);
      observer.debug("Memory usage", { rss_bytes: rss, rss_mb: rssMb, tick: tickCount });

      if (rss > MEMORY_CRITICAL_BYTES) {
        observer.error("Memory critical — RSS exceeds 4 GB", { rss_bytes: rss, rss_mb: rssMb });
        eventBus.publish({
          type: "system.health_changed",
          source: "daemon",
          task_id: null,
          payload: {
            component: "daemon",
            status: PluginHealthStates.unhealthy,
            message: `RSS ${rssMb} MB exceeds critical threshold`,
          },
        });
      } else if (rss > MEMORY_WARNING_BYTES) {
        observer.warn("Memory warning — RSS exceeds 2 GB", { rss_bytes: rss, rss_mb: rssMb });
      }
    }
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

    // Signal orchestrator to yield between phases
    ctx.orchestrator.requestShutdown();

    // Drain active dispatches with shutdown timeout
    await scheduler.drainForShutdown(config.shutdown_timeout_ms);

    // Shutdown plugins (reverse init order)
    await registry.shutdownAll();
    registry.stopHealthCheckLoop();

    // Unsubscribe from Event Bus
    unregisterSubscriptions();

    // Remove PID file
    removePidFile();

    // Final state
    const uptimeMs = startedAt ? clock.now() - new Date(startedAt).getTime() : 0;
    running = false;
    observer.info("Daemon stopped", { uptimeMs });
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
      slotUtilization: {
        active: scheduler.getActiveTaskIds().length,
        max: config.max_concurrent,
      },
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
