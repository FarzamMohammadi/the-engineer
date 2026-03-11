import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";

import type { TriggerAdapter } from "../../adapters/trigger.js";
import type { TriggerEvent } from "../../schemas/adapters.js";
import type { DaemonConfig } from "../../schemas/config.js";
import type { Dispatch } from "../../schemas/ephemeral.js";
import type { Event, EventPayloads } from "../../schemas/events.js";
import type { ActionPipeline } from "../action-pipeline/index.js";
import type { EventBus, PublishInput } from "../event-bus/index.js";
import type { ExecuteTaskResult, Orchestrator } from "../orchestrator/index.js";
import type { PeopleDirectory } from "../people-directory/index.js";
import type { Registry } from "../registry/index.js";
import type { SafetyLayer } from "../safety-layer/index.js";
import type { SessionMemory } from "../session-memory/index.js";
import type { TaskEngine } from "../task-engine/index.js";
import type { WorkspaceManager } from "../workspace-manager/index.js";

// ── Clock Interface ─────────────────────────────────────────────────────────

/** Minimal clock interface for injectable time control. */
export interface Clock {
  now(): number;
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

  const activeDispatches = new Map<string, Promise<ExecuteTaskResult>>();
  const triggerLastPoll = new Map<string, number>();
  const triggerFailures = new Map<string, number>();
  const seenTriggerKeys = new Map<string, number>();
  const basePriorities = new Map<string, number>();
  let pendingPreemption: PendingPreemption | null = null;
  const costLimitTasks: string[] = [];

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

    // TODO: Phase 14b — implement comm.message_received handler (Query Handler).
    // When communication plugins exist, route to query handler (status, progress,
    // cost queries) or task response. See daemon-scheduler.md § Query Handler.
    eventBus.subscribe("daemon:comm", "comm.message_received", (_event: Event) => {
      logger.debug(
        "comm.message_received received — Query Handler not yet implemented (Phase 14b)",
      );
    });
  }

  function unregisterSubscriptions(): void {
    eventBus.unsubscribe("daemon:cost");
    eventBus.unsubscribe("daemon:comm");
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

    // Initialize base priorities for queued tasks (aging)
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
        metadata: event.metadata,
      },
    } satisfies PublishInput<"trigger.new_event">);

    // Create task: intake → queued
    // TODO: Phase 14b — map trigger event external_ref to ExternalRef shape
    const task = taskEngine.createTask({
      title: event.title,
      repo: event.repo,
      source: event.source,
      description: event.body ?? "",
    });

    taskEngine.requestTransition(task.id, "queued", null, "new_trigger_event", "daemon");
    basePriorities.set(task.id, task.priority);
    logger.info({ taskId: task.id, title: event.title }, "Task created from trigger event");
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

  async function scheduleNext(): Promise<void> {
    if (getAvailableSlots() <= 0) {
      return;
    }

    const queuedTasks = taskEngine.getQueuedByPriority();
    // TODO: Phase 15 — check dependency ordering for child tasks (is_eligible)
    const candidate = queuedTasks[0];
    if (!candidate) {
      return;
    }

    // Build dispatch package
    const checkpoint = sessionMemory.getLatestCheckpoint(candidate.id);
    const repoKnowledge = candidate.workspace
      ? sessionMemory.getKnowledge("repo", (candidate.workspace as { repo?: string }).repo)
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
      logger.info({ taskId }, "Task completed");
    } else if (result.outcome === "preempted") {
      logger.info({ taskId, lastPhase: result.lastPhase }, "Task preempted — returned to queue");
      pendingPreemption = null;
    } else {
      logger.error({ taskId, phase: result.phase, reason: result.reason }, "Task error");
      taskEngine.requestTransition(taskId, "blocked", null, result.reason, "daemon");
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

    // TODO: Phase 15 — implement full blocked timeout escalation.
    // 3-stage: reminder → self_unblock_check → alert, querying
    // SafetyLayer.getTimeoutPolicy() on each health tick.
    // Also implement review_pending timeout reminders.
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
    while (costLimitTasks.length > 0) {
      const taskId = costLimitTasks.pop();
      if (!taskId) {
        break;
      }

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
    await scheduleNext();

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

    // Signal handling
    process.on("SIGTERM", () => {
      stop().catch((error: unknown) => {
        logger.error({ error }, "Error during SIGTERM shutdown");
      });
    });
    process.on("SIGINT", () => {
      stop().catch((error: unknown) => {
        logger.error({ error }, "Error during SIGINT shutdown");
      });
    });

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

    // Remove PID file
    removePidFile();

    // Final state
    running = false;
    logger.info("Daemon stopped");
  }

  async function drainActiveDispatches(): Promise<void> {
    const shutdownDeadline = clock.now() + config.shutdown_timeout_ms;
    for (const [taskId, promise] of activeDispatches) {
      const remaining = shutdownDeadline - clock.now();
      if (remaining > 0) {
        try {
          await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("shutdown_timeout")), remaining);
            }),
          ]);
        } catch {
          logger.warn({ taskId }, "Shutdown timeout waiting for task");
        }
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
