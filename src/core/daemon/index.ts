import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PluginHealthStates } from "../../schemas/adapters.js";
import {
  CommRetryExhaustedPayloadSchema,
  CommRetrySucceededPayloadSchema,
  CommSendFailedPayloadSchema,
  EvaluationCompletedPayloadSchema,
  type Event,
  type EventPayloads,
  EventTypes,
  GitBranchDeletedPayloadSchema,
  HealthStuckDetectedPayloadSchema,
  HealthTriggerFailurePayloadSchema,
  PreemptionCompletedPayloadSchema,
  PreemptionRequestedPayloadSchema,
  ReviewPollCompletedPayloadSchema,
  type TaskFeedbackReceivedPayload,
  TaskFeedbackReceivedPayloadSchema,
  TriggerNewEventPayloadSchema,
} from "../../schemas/events.js";
import { TaskStates } from "../../schemas/task.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import { createEvaluationManager } from "../evaluation/index.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import { type ExecuteTaskResult, Outcomes } from "../orchestrator/index.js";
import { createRetryPolicy } from "../retry-policy/index.js";
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
    type: EventTypes["trigger.new_event"],
    description: "Emitted when a trigger adapter detects a new assignable event",
    payloadSchema: TriggerNewEventPayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
  {
    type: EventTypes["health.trigger_failure"],
    description: "Emitted when a trigger adapter fails consecutively",
    payloadSchema: HealthTriggerFailurePayloadSchema,
    publishers: ["daemon"],
    subscribers: ["daemon"],
  },
  {
    type: EventTypes["health.stuck_detected"],
    description: "Emitted when a task is detected as stuck (no progress)",
    payloadSchema: HealthStuckDetectedPayloadSchema,
    publishers: ["daemon"],
    subscribers: ["daemon"],
  },
  {
    type: EventTypes["preemption.requested"],
    description: "Emitted when a higher-priority task preempts a running task",
    payloadSchema: PreemptionRequestedPayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
  {
    type: EventTypes["preemption.completed"],
    description: "Emitted when a preemption cycle completes (cooperative yield or forced transition)",
    payloadSchema: PreemptionCompletedPayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
  {
    type: EventTypes["task.feedback_received"],
    description: "Emitted when PR review feedback is processed",
    payloadSchema: TaskFeedbackReceivedPayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
  {
    type: EventTypes["review.poll_completed"],
    description: "Emitted after polling PR review status",
    payloadSchema: ReviewPollCompletedPayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
  {
    type: EventTypes["comm.send_failed"],
    description: "Emitted when a notification could not be delivered to any channel for a person",
    payloadSchema: CommSendFailedPayloadSchema,
    publishers: ["notification-router"],
    subscribers: [],
  },
  {
    type: EventTypes["comm.retry_succeeded"],
    description: "Emitted when a previously failed notification is successfully delivered on retry",
    payloadSchema: CommRetrySucceededPayloadSchema,
    publishers: ["notification-router"],
    subscribers: [],
  },
  {
    type: EventTypes["comm.retry_exhausted"],
    description: "Emitted when notification retries are abandoned (max attempts, max age, or task terminal)",
    payloadSchema: CommRetryExhaustedPayloadSchema,
    publishers: ["notification-router"],
    subscribers: [],
  },
  {
    type: EventTypes["git.branch_deleted"],
    description: "Emitted when the daemon deletes a task branch from the remote after merge",
    payloadSchema: GitBranchDeletedPayloadSchema,
    publishers: ["daemon"],
    subscribers: [],
  },
  {
    type: EventTypes["evaluation.completed"],
    description: "Emitted when AI-as-Judge evaluation completes (or fails) for a task",
    payloadSchema: EvaluationCompletedPayloadSchema,
    publishers: ["evaluation"],
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
  const { config, eventBus, registry, taskEngine, clock, observer, engineerHome, dataLifecycleManager } = ctx;

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

  const evaluation = config.evaluation.enabled
    ? createEvaluationManager({
        config,
        registry,
        taskEngine,
        workspaceManager: ctx.workspaceManager,
        eventBus,
        observer,
        engineerHome,
      })
    : null;

  const retryPolicy = createRetryPolicy({
    config: ctx.config,
    taskEngine: ctx.taskEngine,
    clock: ctx.clock,
    observer: ctx.observer,
  });

  const scheduler = createTaskScheduler(
    ctx,
    notifications,
    {
      onTaskCompleted: (taskId, result) => handleTaskCompletion(taskId, result),
      onTaskError: (taskId, error) => handleTaskError(taskId, error),
    },
    retryPolicy,
    evaluation,
  );

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

  const reviewHandler = createReviewHandler(ctx, notifications);

  const healthMonitor = createDaemonHealthMonitor(ctx, notifications, () => scheduler.getActiveTaskIds());

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

    eventBus.subscribe("daemon:health-trigger", EventTypes["health.trigger_failure"], (event: Event) => {
      const p = event.payload as EventPayloads["health.trigger_failure"];
      if (!shouldNotifyHealth(`trigger:${p.trigger_id}`, clock.now())) {
        return;
      }
      notifications.notify({
        kind: "alert",
        taskId: null,
        message: `Trigger adapter "${p.trigger_id}" has failed ${String(p.consecutive_failures)} consecutive times (threshold: ${String(p.threshold)}). Last error: ${p.last_error}. Check your configuration.`,
      });
    });

    eventBus.subscribe("daemon:health-stuck", EventTypes["health.stuck_detected"], (event: Event) => {
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
    });

    eventBus.subscribe("daemon:health-plugin-failed", EventTypes["health.plugin_failed"], (event: Event) => {
      const p = event.payload as EventPayloads["health.plugin_failed"];
      if (!shouldNotifyHealth(`plugin:${p.plugin_id}`, clock.now())) {
        return;
      }
      notifications.notify({
        kind: "alert",
        taskId: null,
        message: `Plugin "${p.plugin_id}" (${p.plugin_type}) has failed ${String(p.consecutive_failures)} consecutive times (threshold: ${String(p.threshold)}). Error: ${p.error}`,
      });
    });

    eventBus.subscribe("daemon:health-plugin-unhealthy", EventTypes["health.plugin_unhealthy"], (event: Event) => {
      const p = event.payload as EventPayloads["health.plugin_unhealthy"];
      if (!shouldNotifyHealth(`plugin-unhealthy:${p.plugin_id}`, clock.now())) {
        return;
      }
      notifications.notify({
        kind: "alert",
        taskId: null,
        message: `Plugin "${p.plugin_id}" (${p.plugin_type}) is unhealthy after ${String(p.consecutive_failures)} consecutive failures. Error: ${p.error}`,
      });
    });

    observer.debug("Event subscriptions registered");
  }

  function unregisterSubscriptions(): void {
    eventBus.unsubscribe("daemon:cost");
    eventBus.unsubscribe("daemon:comm");
    eventBus.unsubscribe("daemon:state-sync");
    eventBus.unsubscribe("daemon:feedback");
    eventBus.unsubscribe("daemon:health-trigger");
    eventBus.unsubscribe("daemon:health-stuck");
    eventBus.unsubscribe("daemon:health-plugin-failed");
    eventBus.unsubscribe("daemon:health-plugin-unhealthy");
  }

  // ── Startup: Protocol P1 ──────────────────────────────────────────────

  /** Outcome of recovering a single orphaned task during boot. */
  type OrphanRecoveryOutcome = "recovered" | "failed_terminal" | "transition_failed";

  function recoverOrphanedTask(task: { id: string; sub_state: string | null }): OrphanRecoveryOutcome {
    observer.warn("Recovering orphaned active task", {
      taskId: task.id,
      subState: task.sub_state,
    });

    const disposition = retryPolicy.recordFailure("crash", task.id);

    if (disposition.disposition === "terminal") {
      const result = taskEngine.requestTransition(
        task.id,
        TaskStates.failed,
        null,
        `max_crash_retries_exceeded (${disposition.count}) — boot recovery`,
        "daemon",
      );
      if (!result.success) {
        observer.error("Crash recovery: terminal transition failed", {
          taskId: task.id,
          reason: result.reason,
        });
        return "transition_failed";
      }
      observer.error("Orphaned task exceeded crash budget — marking failed", {
        taskId: task.id,
        crashCount: disposition.count,
      });
      return "failed_terminal";
    }

    const result = taskEngine.requestTransition(task.id, TaskStates.queued, null, "crash_recovery", "daemon");
    if (!result.success) {
      observer.error("Crash recovery transition failed", {
        taskId: task.id,
        reason: result.reason,
      });
      return "transition_failed";
    }
    return "recovered";
  }

  function rebuildStateFromTaskEngine(): void {
    // Crash recovery: each orphaned active task is treated as a crash failure via
    // the retry-policy module. If a task's crash budget is exhausted (e.g., a poison
    // task that has crashed at boot N times in a row), retry-policy returns terminal
    // and we transition straight to failed instead of queued — closing the boot-loop
    // hole where a systemd-restarted daemon would re-pick up a guaranteed-to-crash task.
    const activeTasks = taskEngine.getTasksByState(TaskStates.active);
    const counts = { recovered: 0, failed_terminal: 0, transition_failed: 0 };

    for (const task of activeTasks) {
      if (!isSlotConsuming(task.state, task.sub_state)) {
        continue;
      }
      const outcome = recoverOrphanedTask(task);
      counts[outcome]++;
    }

    observer.info("Crash recovery scan complete", {
      activeTasks: activeTasks.length,
      orphansRecovered: counts.recovered,
      orphansFailedTerminal: counts.failed_terminal,
      recoveryFailures: counts.transition_failed,
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

    // Drain active evaluations (shorter timeout — evaluations are non-critical)
    if (evaluation) {
      await evaluation.drainForShutdown(Math.min(config.shutdown_timeout_ms, 15_000));
    }

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
