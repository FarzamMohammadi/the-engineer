import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { shouldPreempt } from "../../../../src/core/daemon/preemption-manager.js";
import { isSlotConsuming } from "../../../../src/core/daemon/task-scheduler.js";
import type { ExecuteTaskResult } from "../../../../src/core/orchestrator/index.js";
import { EventTypes } from "../../../../src/schemas/events.js";
import { BlockCategories, BlockReasons, SubStates, TaskStates } from "../../../../src/schemas/task.js";
import { createMockTask } from "../../../helpers/mock-factories.js";
import { createMockTriggerPlugin, createTestDaemon, createTestTriggerEvent } from "../../../helpers/test-daemon.js";

// ── Pure Function Tests ───────────────────────────────────────────────────────

describe("isSlotConsuming", () => {
  it("returns true for active.working", () => {
    expect(isSlotConsuming(TaskStates.active, SubStates.working)).toBe(true);
  });

  it("returns false for queued", () => {
    expect(isSlotConsuming(TaskStates.queued, null)).toBe(false);
  });
});

describe("shouldPreempt", () => {
  it("returns true when delta exceeds threshold", () => {
    expect(shouldPreempt(50, 75, 20)).toBe(true);
  });

  it("returns false when delta below threshold", () => {
    expect(shouldPreempt(50, 60, 20)).toBe(false);
  });

  it("returns true when delta exactly equals threshold", () => {
    expect(shouldPreempt(50, 70, 20)).toBe(true);
  });
});

// ── Daemon Tests ──────────────────────────────────────────────────────────────

describe("Daemon", () => {
  let handle: ReturnType<typeof createTestDaemon>;

  afterEach(async () => {
    if (handle) {
      try {
        await handle.daemon.stop();
      } catch {
        // Ignore stop errors during cleanup
      }
      handle.cleanup();
    }
  });

  // ── Tick Loop Basics ──────────────────────────────────────────────────

  describe("tick loop", () => {
    it("calls trigger poll on registered triggers", async () => {
      handle = createTestDaemon({ trigger_poll_interval_ms: 0 });
      const trigger = createMockTriggerPlugin();
      handle.registry.getPluginsByType.mockReturnValue([trigger]);

      await handle.daemon.tick();

      expect(trigger.poll).toHaveBeenCalledOnce();
    });

    it("respects poll interval — does not poll too early", async () => {
      handle = createTestDaemon({ trigger_poll_interval_ms: 30_000 });
      const trigger = createMockTriggerPlugin();
      handle.registry.getPluginsByType.mockReturnValue([trigger]);

      await handle.daemon.tick(); // First tick polls
      await handle.daemon.tick(); // Second tick — too early

      expect(trigger.poll).toHaveBeenCalledOnce();
    });

    it("polls again when enough time has elapsed", async () => {
      handle = createTestDaemon({ trigger_poll_interval_ms: 30_000 });
      const trigger = createMockTriggerPlugin();
      handle.registry.getPluginsByType.mockReturnValue([trigger]);

      await handle.daemon.tick();
      handle.clock.advance(30_001);
      await handle.daemon.tick();

      expect(trigger.poll).toHaveBeenCalledTimes(2);
    });
  });

  // ── Deduplication ─────────────────────────────────────────────────────

  describe("deduplication", () => {
    it("new trigger event creates a task", async () => {
      handle = createTestDaemon({ trigger_poll_interval_ms: 0 });
      const event = createTestTriggerEvent({ idempotency_key: "test:1" });
      const trigger = createMockTriggerPlugin([event]);
      handle.registry.getPluginsByType.mockReturnValue([trigger]);

      await handle.daemon.tick();

      expect(handle.taskEngine.createTask).toHaveBeenCalledOnce();
      expect(handle.taskEngine.requestTransition).toHaveBeenCalledWith(
        expect.any(String),
        TaskStates.queued,
        null,
        "new_trigger_event",
        "daemon",
      );
    });

    it("duplicate idempotency key is ignored", async () => {
      handle = createTestDaemon({ trigger_poll_interval_ms: 0 });
      const event = createTestTriggerEvent({ idempotency_key: "test:dup" });
      const trigger = createMockTriggerPlugin([event]);
      handle.registry.getPluginsByType.mockReturnValue([trigger]);

      await handle.daemon.tick();
      await handle.daemon.tick();

      expect(handle.taskEngine.createTask).toHaveBeenCalledOnce();
    });

    it("expired seen key allows re-processing", async () => {
      handle = createTestDaemon({ trigger_poll_interval_ms: 0, seen_keys_ttl_ms: 10_000 });
      const event = createTestTriggerEvent({ idempotency_key: "test:expire" });
      const trigger = createMockTriggerPlugin([event]);
      handle.registry.getPluginsByType.mockReturnValue([trigger]);

      await handle.daemon.tick();
      handle.clock.advance(10_001); // Past TTL
      await handle.daemon.tick();

      expect(handle.taskEngine.createTask).toHaveBeenCalledTimes(2);
    });
  });

  // ── Scheduling ────────────────────────────────────────────────────────

  describe("scheduling", () => {
    it("schedules highest-priority queued task when slot available", async () => {
      handle = createTestDaemon();
      const task = createMockTask({
        id: "task-high",
        state: TaskStates.queued,
        sub_state: null,
        priority: 80,
      });
      handle.taskEngine.getQueuedByPriority.mockReturnValue([task]);

      await handle.daemon.tick();

      expect(handle.orchestrator.executeTask).toHaveBeenCalledOnce();
      expect(handle.taskEngine.requestTransition).toHaveBeenCalledWith(
        "task-high",
        TaskStates.active,
        SubStates.working,
        "scheduled",
        "daemon",
      );
    });

    it("does not schedule when no slots available", async () => {
      handle = createTestDaemon({ trigger_poll_interval_ms: 0 });

      // Simulate an active dispatch by scheduling first
      const task1 = createMockTask({ id: "task-1", state: TaskStates.queued, sub_state: null });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([task1]);
      // Make orchestrator return a never-resolving promise to keep slot occupied
      handle.orchestrator.executeTask.mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );

      await handle.daemon.tick(); // Schedules task-1

      // Now another queued task should not be scheduled
      const task2 = createMockTask({ id: "task-2", state: TaskStates.queued, sub_state: null });
      handle.taskEngine.getQueuedByPriority.mockReturnValue([task2]);
      await handle.daemon.tick();

      expect(handle.orchestrator.executeTask).toHaveBeenCalledOnce();
    });

    it("schedules after slot freed by task completion", async () => {
      handle = createTestDaemon();

      // First task completes immediately
      const task1 = createMockTask({ id: "task-1", state: TaskStates.queued, sub_state: null });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([task1]);
      handle.orchestrator.executeTask.mockResolvedValueOnce({
        outcome: "completed",
      });

      await handle.daemon.tick(); // Dispatch task-1

      // Allow Promise microtask to resolve
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Second task available
      const task2 = createMockTask({ id: "task-2", state: TaskStates.queued, sub_state: null });
      handle.taskEngine.getQueuedByPriority.mockReturnValue([task2]);
      handle.orchestrator.executeTask.mockResolvedValueOnce({
        outcome: "completed",
      });

      await handle.daemon.tick();

      expect(handle.orchestrator.executeTask).toHaveBeenCalledTimes(2);
    });
  });

  // ── Dispatch ──────────────────────────────────────────────────────────

  describe("dispatch", () => {
    it("includes checkpoint for resumed task", async () => {
      handle = createTestDaemon();
      const task = createMockTask({ id: "task-resume", state: TaskStates.queued, sub_state: null });
      handle.taskEngine.getQueuedByPriority.mockReturnValue([task]);
      const checkpoint = { id: "cp-1", phase: "research" };
      handle.sessionMemory.checkpoints.getLatest.mockReturnValue(checkpoint);

      await handle.daemon.tick();

      expect(handle.orchestrator.executeTask).toHaveBeenCalledWith(
        expect.objectContaining({ resume_from: checkpoint }),
      );
      expect(handle.taskEngine.requestTransition).toHaveBeenCalledWith(
        "task-resume",
        TaskStates.active,
        SubStates.working,
        "resumed_from_checkpoint",
        "daemon",
      );
    });

    it("handles orchestrator completion", async () => {
      handle = createTestDaemon();
      const task = createMockTask({ id: "task-done", state: TaskStates.queued, sub_state: null });
      handle.taskEngine.getQueuedByPriority.mockReturnValue([task]);

      await handle.daemon.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handle.getState().tasksCompleted).toBe(1);
      expect(handle.getState().activeTaskIds).toEqual([]);
    });

    it("handles orchestrator crash with recovery and backoff", async () => {
      handle = createTestDaemon();
      const task = createMockTask({ id: "task-crash", state: TaskStates.queued, sub_state: null });
      handle.taskEngine.getQueuedByPriority.mockReturnValue([task]);
      handle.orchestrator.executeTask.mockRejectedValueOnce(new Error("crash"));

      await handle.daemon.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Should emit health.stuck_detected and transition to queued with backoff
      expect(handle.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventTypes["health.stuck_detected"],
          payload: expect.objectContaining({
            condition: "orchestrator_crash",
          }),
        }),
      );
      expect(handle.taskEngine.requestTransition).toHaveBeenCalledWith(
        "task-crash",
        TaskStates.queued,
        null,
        "crash_recovery_with_backoff",
        "daemon",
      );
    });
  });

  // ── Cancel Detection ──────────────────────────────────────────────────

  describe("cancel detection", () => {
    it("aborts the in-flight dispatch of a task cancelled from another process", async () => {
      handle = createTestDaemon();
      const task = createMockTask({ id: "task-cancel", state: TaskStates.queued, sub_state: null });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([task]);

      // The orchestrator runs until its dispatch signal aborts — that abort is the SIGTERM to the agent.
      let aborted = false;
      handle.orchestrator.executeTask.mockImplementation((dispatch: { signal: AbortSignal }) => {
        return new Promise((resolve) => {
          dispatch.signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ outcome: "completed" });
          });
        });
      });

      await handle.daemon.tick(); // dispatch task-cancel (now in flight)
      expect(handle.getState().activeTaskIds).toEqual(["task-cancel"]);

      // Another process flips the DB to `cancelled`.
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({ id: "task-cancel", state: TaskStates.cancelled, sub_state: null }),
      );

      await handle.daemon.tick(); // cancel scan detects it → terminate → signal aborts
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the settle microtask run

      expect(aborted).toBe(true); // the agent was SIGTERM'd
      expect(handle.getState().activeTaskIds).toEqual([]); // the dispatch settled and was removed
    });

    it("re-detecting a still-settling cancel each tick is a safe no-op (idempotent terminate)", async () => {
      handle = createTestDaemon();
      const task = createMockTask({ id: "task-cancel", state: TaskStates.queued, sub_state: null });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([task]);

      // The agent ignores SIGTERM, so the dispatch never settles and is re-detected every tick.
      let abortCount = 0;
      handle.orchestrator.executeTask.mockImplementation((dispatch: { signal: AbortSignal }) => {
        return new Promise(() => {
          dispatch.signal.addEventListener("abort", () => {
            abortCount++;
          });
        });
      });

      await handle.daemon.tick();
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({ id: "task-cancel", state: TaskStates.cancelled, sub_state: null }),
      );

      await handle.daemon.tick(); // detect + terminate
      await handle.daemon.tick(); // re-detect — terminate is idempotent (keeps the first reason)
      await handle.daemon.tick();

      // The signal aborts at most once even though terminate is re-issued each tick — no runaway.
      expect(abortCount).toBe(1);
      expect(handle.getState().activeTaskIds).toEqual(["task-cancel"]); // still in flight (agent ignores SIGTERM)
    });
  });

  // ── Stuck Detection ───────────────────────────────────────────────────

  describe("stuck detection", () => {
    it("emits health.stuck_detected for task with no journal entries past threshold", async () => {
      handle = createTestDaemon({ stuck_threshold_ms: 1_800_000 });

      // Simulate active dispatch
      const task = createMockTask({
        id: "task-stuck",
        state: TaskStates.queued,
        sub_state: null,
      });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([task]);
      handle.orchestrator.executeTask.mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({
          id: "task-stuck",
          state: TaskStates.active,
          sub_state: SubStates.working,
          started_at: new Date(handle.clock.now()).toISOString(),
        }),
      );

      await handle.daemon.tick(); // Schedule task

      handle.clock.advance(1_800_001); // Past stuck threshold
      handle.sessionMemory.journal.query.mockReturnValue([]);

      await handle.daemon.tick(); // Stuck check

      expect(handle.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventTypes["health.stuck_detected"],
          payload: expect.objectContaining({
            task_id: "task-stuck",
            condition: "no_journal_entries",
          }),
        }),
      );
    });

    it("emits health.stuck_detected for task exceeding max active duration", async () => {
      handle = createTestDaemon({ max_active_duration_ms: 28_800_000 });

      const task = createMockTask({ id: "task-long", state: TaskStates.queued, sub_state: null });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([task]);
      handle.orchestrator.executeTask.mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({
          id: "task-long",
          state: TaskStates.active,
          sub_state: SubStates.working,
          started_at: new Date(handle.clock.now()).toISOString(),
        }),
      );

      await handle.daemon.tick();

      handle.clock.advance(28_800_001); // Past 8 hours
      await handle.daemon.tick();

      expect(handle.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventTypes["health.stuck_detected"],
          payload: expect.objectContaining({
            condition: "no_state_transition",
          }),
        }),
      );
    });

    it("does not emit stuck for healthy active task", async () => {
      handle = createTestDaemon({ stuck_threshold_ms: 1_800_000 });

      const task = createMockTask({ id: "task-ok", state: TaskStates.queued, sub_state: null });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([task]);
      handle.orchestrator.executeTask.mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({
          id: "task-ok",
          state: TaskStates.active,
          sub_state: SubStates.working,
          started_at: new Date(handle.clock.now()).toISOString(),
        }),
      );

      await handle.daemon.tick();

      handle.clock.advance(900_000); // 15 min — below threshold
      await handle.daemon.tick();

      const stuckCalls = handle.eventBus.publish.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["health.stuck_detected"],
      );
      expect(stuckCalls).toHaveLength(0);
    });
  });

  // ── Hard-cap subscriber ───────────────────────────────────────────────

  describe("hard-cap subscriber", () => {
    it("registers a subscriber on health.stuck_detected for termination", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();
      const callback = handle.getSubscriptionCallback("daemon:hard-cap");
      expect(callback).toBeDefined();
    });

    it("terminates an in-flight dispatch when hard-cap is exceeded — routes to failed", async () => {
      handle = createTestDaemon({ max_active_duration_ms: 28_800_000 });
      await handle.daemon.start();

      const task = createMockTask({ id: "task-cap", state: TaskStates.queued, sub_state: null });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([task]);

      let resolveExecute: ((value: ExecuteTaskResult) => void) | undefined;
      handle.orchestrator.executeTask.mockReturnValue(
        new Promise<ExecuteTaskResult>((resolve) => {
          resolveExecute = resolve;
        }),
      );
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({
          id: "task-cap",
          state: TaskStates.active,
          sub_state: SubStates.working,
          started_at: new Date(handle.clock.now()).toISOString(),
        }),
      );

      await handle.daemon.tick();
      handle.clock.advance(28_800_001);
      await handle.daemon.tick();

      // Health-monitor's tick publishes health.stuck_detected. Auto-dispatch
      // is not wired in the mock — fire the hard-cap callback directly.
      const hardCap = handle.getSubscriptionCallback("daemon:hard-cap");
      expect(hardCap).toBeDefined();
      hardCap?.({
        id: "evt-cap",
        type: EventTypes["health.stuck_detected"],
        source: "health-monitor",
        sequence: 1,
        task_id: "task-cap",
        timestamp: new Date(handle.clock.now()).toISOString(),
        payload: {
          task_id: "task-cap",
          condition: "no_state_transition",
          threshold_ms: 28_800_000,
          elapsed_ms: 28_800_001,
          last_activity: null,
        },
      });

      // Settle the orchestrator promise so the late callback can route the outcome.
      // The runner error is re-routed as terminated when the tracker has a recorded reason.
      resolveExecute?.({ outcome: "error", error: new Error("aborted") } as unknown as ExecuteTaskResult);
      await new Promise((r) => setImmediate(r));

      const failedTransition = handle.taskEngine.requestTransition.mock.calls.find(
        (c: unknown[]) => c[1] === TaskStates.failed && c[3] === "hard_cap_exceeded",
      );
      expect(failedTransition).toBeDefined();
    });

    it("ignores stuck events with conditions other than no_state_transition", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();
      const callback = handle.getSubscriptionCallback("daemon:hard-cap");
      expect(callback).toBeDefined();

      callback?.({
        id: "evt-1",
        type: EventTypes["health.stuck_detected"],
        source: "health-monitor",
        sequence: 1,
        task_id: "task-stale",
        timestamp: new Date(handle.clock.now()).toISOString(),
        payload: {
          task_id: "task-stale",
          condition: "stale_journal",
          threshold_ms: 1_800_000,
          elapsed_ms: 2_000_000,
          last_activity: null,
        },
      });

      const failedTransitions = handle.taskEngine.requestTransition.mock.calls.filter(
        (c: unknown[]) => c[1] === TaskStates.failed,
      );
      expect(failedTransitions).toHaveLength(0);
    });
  });

  // ── Preemption ────────────────────────────────────────────────────────

  describe("preemption", () => {
    it("initiates preemption when priority delta exceeds threshold", async () => {
      handle = createTestDaemon({ preemption_threshold: 20 });

      // Schedule a low-priority task
      const lowTask = createMockTask({
        id: "task-low",
        state: TaskStates.queued,
        sub_state: null,
        priority: 50,
      });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([lowTask]);
      handle.orchestrator.executeTask.mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );

      await handle.daemon.tick();

      // Now a high-priority task appears in queue
      const highTask = createMockTask({
        id: "task-high",
        state: TaskStates.queued,
        sub_state: null,
        priority: 75,
      });
      handle.taskEngine.getQueuedByPriority.mockReturnValue([highTask]);
      handle.taskEngine.getTask.mockReturnValue(createMockTask({ id: "task-low", priority: 50 }));

      await handle.daemon.tick();

      expect(handle.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventTypes["preemption.requested"],
          payload: expect.objectContaining({
            target_task_id: "task-low",
            preempting_task_id: "task-high",
          }),
        }),
      );
    });

    it("does not preempt when delta below threshold", async () => {
      handle = createTestDaemon({ preemption_threshold: 20 });

      const lowTask = createMockTask({
        id: "task-low",
        state: TaskStates.queued,
        sub_state: null,
        priority: 50,
      });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([lowTask]);
      handle.orchestrator.executeTask.mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );

      await handle.daemon.tick();

      // Queued task has insufficient priority delta
      const medTask = createMockTask({
        id: "task-med",
        state: TaskStates.queued,
        sub_state: null,
        priority: 60,
      });
      handle.taskEngine.getQueuedByPriority.mockReturnValue([medTask]);
      handle.taskEngine.getTask.mockReturnValue(createMockTask({ id: "task-low", priority: 50 }));

      await handle.daemon.tick();

      const preemptCalls = handle.eventBus.publish.mock.calls.filter(
        (c: unknown[]) => (c[0] as { type: string }).type === EventTypes["preemption.requested"],
      );
      expect(preemptCalls).toHaveLength(0);
    });

    it("completes preemption when orchestrator returns terminated/cooperative_preemption", async () => {
      handle = createTestDaemon({ preemption_threshold: 20 });

      const lowTask = createMockTask({
        id: "task-low",
        state: TaskStates.queued,
        sub_state: null,
        priority: 50,
      });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([lowTask]);

      // Orchestrator will yield via Outcomes.terminated with reason cooperative_preemption.
      let resolveExecute: ((result: ExecuteTaskResult) => void) | undefined;
      handle.orchestrator.executeTask.mockReturnValueOnce(
        new Promise<ExecuteTaskResult>((resolve) => {
          resolveExecute = resolve;
        }),
      );

      await handle.daemon.tick(); // Schedule task-low

      // Preemption requested
      const highTask = createMockTask({
        id: "task-high",
        state: TaskStates.queued,
        sub_state: null,
        priority: 75,
      });
      handle.taskEngine.getQueuedByPriority.mockReturnValue([highTask]);
      handle.taskEngine.getTask.mockReturnValue(createMockTask({ id: "task-low", priority: 50 }));
      await handle.daemon.tick();

      // Orchestrator yields
      resolveExecute?.({
        outcome: "terminated",
        reason: "cooperative_preemption",
        lastPhase: "research",
        checkpointId: "cp-1",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handle.getState().pendingPreemption).toBeNull();
    });
  });

  // ── Startup (P1) ──────────────────────────────────────────────────────

  describe("start (P1)", () => {
    it("writes PID file", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();

      const pidPath = join(handle.engineerHome, "run", "engineer.pid");
      expect(existsSync(pidPath)).toBe(true);
      expect(readFileSync(pidPath, "utf-8").trim()).toBe(String(process.pid));
    });

    it("refuses if another instance is running", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();

      // Create a second daemon pointing to the same home
      const daemon2 = createTestDaemon();
      // Manually write our own PID to simulate another instance
      const pidPath = join(daemon2.engineerHome, "run", "engineer.pid");
      const { writeFileSync: ws } = await import("node:fs");
      ws(pidPath, String(process.pid)); // Current process is alive

      await expect(daemon2.daemon.start()).rejects.toThrow("Another Daemon instance is already running");
      daemon2.cleanup();
    });

    it("recovers orphaned active tasks on startup", async () => {
      handle = createTestDaemon();
      const orphan = createMockTask({
        id: "orphan-1",
        state: TaskStates.active,
        sub_state: SubStates.working,
        consecutive_crash_count: 0,
      });
      handle.taskEngine.getTasksByState.mockImplementation((state: string) => {
        if (state === TaskStates.active) {
          return [orphan];
        }
        return [];
      });
      handle.taskEngine.getTask.mockReturnValue(orphan);

      await handle.daemon.start();

      expect(handle.taskEngine.requestTransition).toHaveBeenCalledWith(
        "orphan-1",
        TaskStates.queued,
        null,
        "crash_recovery",
        "daemon",
      );
    });

    // Boot-loop hole closure: an orphaned task that has already crashed up to its
    // budget ceiling must transition straight to failed at boot — not back to queued,
    // which would let a systemd-restarted daemon re-pick it up and crash again forever.
    it("transitions orphaned tasks at the crash ceiling straight to failed", async () => {
      handle = createTestDaemon();
      const orphan = createMockTask({
        id: "orphan-poison",
        state: TaskStates.active,
        sub_state: SubStates.working,
        consecutive_crash_count: 4, // Will become 5 = max_attempts → terminal
      });
      handle.taskEngine.getTasksByState.mockImplementation((state: string) => {
        if (state === TaskStates.active) {
          return [orphan];
        }
        return [];
      });
      handle.taskEngine.getTask.mockReturnValue(orphan);

      await handle.daemon.start();

      expect(handle.taskEngine.updateTaskField).toHaveBeenCalledWith("orphan-poison", "consecutive_crash_count", 5);
      expect(handle.taskEngine.requestTransition).toHaveBeenCalledWith(
        "orphan-poison",
        TaskStates.failed,
        null,
        expect.stringContaining("max_crash_retries_exceeded"),
        "daemon",
      );
      expect(handle.taskEngine.requestTransition).not.toHaveBeenCalledWith(
        "orphan-poison",
        TaskStates.queued,
        null,
        "crash_recovery",
        "daemon",
      );
    });

    it("starts registry health check loop", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();

      expect(handle.registry.startHealthCheckLoop).toHaveBeenCalledOnce();
    });
  });

  // ── Shutdown (P15) ────────────────────────────────────────────────────

  describe("stop (P15)", () => {
    it("removes PID file", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();

      const pidPath = join(handle.engineerHome, "run", "engineer.pid");
      expect(existsSync(pidPath)).toBe(true);

      await handle.daemon.stop();
      expect(existsSync(pidPath)).toBe(false);
    });

    it("transitions active tasks to queued", async () => {
      handle = createTestDaemon({ shutdown_timeout_ms: 10 });
      await handle.daemon.start();

      // Schedule a task
      const task = createMockTask({
        id: "task-shutdown",
        state: TaskStates.queued,
        sub_state: null,
      });
      handle.taskEngine.getQueuedByPriority.mockReturnValue([task]);
      handle.orchestrator.executeTask.mockReturnValue(
        new Promise(() => {
          /* never resolves */
        }),
      );
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({
          id: "task-shutdown",
          state: TaskStates.active,
          sub_state: SubStates.working,
        }),
      );

      await handle.daemon.tick();
      await handle.daemon.stop();

      expect(handle.taskEngine.requestTransition).toHaveBeenCalledWith(
        "task-shutdown",
        TaskStates.queued,
        null,
        "graceful_shutdown",
        "daemon",
      );
    });

    it("calls registry.shutdownAll", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();
      await handle.daemon.stop();

      expect(handle.registry.shutdownAll).toHaveBeenCalledOnce();
    });

    it("is idempotent", async () => {
      handle = createTestDaemon();
      await handle.daemon.start();
      await handle.daemon.stop();
      await handle.daemon.stop(); // Second call — should not throw

      expect(handle.registry.shutdownAll).toHaveBeenCalledOnce();
    });
  });

  // ── Event Handlers ────────────────────────────────────────────────────

  describe("event handlers", () => {
    it("cost.limit_reached terminates the in-flight dispatch and routes to blocked when it settles", async () => {
      handle = createTestDaemon();

      // Dispatch a task — orchestrator will yield via the abort signal so the
      // scheduler's late-callback path can route the terminate routing to `blocked`.
      const task = createMockTask({
        id: "task-costly",
        state: TaskStates.queued,
        sub_state: null,
      });
      handle.taskEngine.getQueuedByPriority.mockReturnValueOnce([task]);
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({
          id: "task-costly",
          state: TaskStates.active,
          sub_state: SubStates.working,
        }),
      );

      let executeSettle: ((result: ExecuteTaskResult) => void) | undefined;
      handle.orchestrator.executeTask.mockReturnValueOnce(
        new Promise<ExecuteTaskResult>((resolve) => {
          executeSettle = resolve;
        }),
      );

      await handle.daemon.start();
      await handle.daemon.tick(); // Dispatch task-costly

      // Simulate cost.limit_reached event
      const callback = handle.getSubscriptionCallback(EventTypes["cost.limit_reached"]);
      expect(callback).toBeDefined();
      callback?.({
        id: "evt-1",
        sequence: 1,
        type: EventTypes["cost.limit_reached"],
        source: "safety",
        task_id: "task-costly",
        timestamp: new Date().toISOString(),
        payload: {
          task_id: "task-costly",
          limit_type: "daily",
          limit_scope: null,
          current_spend: 100,
          limit_value: 100,
          resets_at: null,
        },
      });

      // Drain the cost-limit-queue — fires dispatchTracker.terminate + immediate notifications.
      await handle.daemon.tick();

      // The orchestrator promise settles after the abort — drives the late callback,
      // which routes the terminated outcome to `blocked` via the scheduler.
      executeSettle?.({
        outcome: "terminated",
        reason: "cost_limit_reached",
        lastPhase: null,
        checkpointId: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handle.taskEngine.requestTransition).toHaveBeenCalledWith(
        "task-costly",
        TaskStates.blocked,
        null,
        "cost_limit_reached",
        "daemon",
      );
    });
  });

  // ── Trigger Error Handling ────────────────────────────────────────────

  describe("trigger error handling", () => {
    it("poll failure increments consecutive failures", async () => {
      handle = createTestDaemon({
        trigger_poll_interval_ms: 0,
        plugins: {
          dirs: [],
          health_check_interval_ms: 60_000,
          health_check_timeout_ms: 5_000,
          consecutive_failures_threshold: 3,
        },
      });
      const trigger = createMockTriggerPlugin();
      trigger.poll.mockRejectedValue(new Error("network error"));
      handle.registry.getPluginsByType.mockReturnValue([trigger]);

      await handle.daemon.tick();
      await handle.daemon.tick();
      await handle.daemon.tick();

      // After 3 failures, should emit health.trigger_failure
      expect(handle.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: EventTypes["health.trigger_failure"],
          payload: expect.objectContaining({
            trigger_id: "test-trigger",
            consecutive_failures: 3,
          }),
        }),
      );
    });
  });

  // ── Blocked Escalation ─────────────────────────────────────────────────

  describe("blocked escalation", () => {
    it("sends reminder for tasks blocked past reminder threshold", async () => {
      handle = createTestDaemon();
      const fourHoursAgo = new Date(handle.clock.now() - 14_400_000 - 1000).toISOString();
      const blockedTask = createMockTask({
        id: "blocked-1",
        state: TaskStates.blocked,
        sub_state: null,
        title: "Stuck task",
        last_transition_at: fourHoursAgo,
      });
      handle.taskEngine.getTasksByState.mockImplementation((state: string) => {
        if (state === TaskStates.blocked) {
          return [blockedTask];
        }
        return [];
      });
      handle.taskEngine.getTask.mockReturnValue(blockedTask);

      const owner = {
        id: "owner-1",
        name: "Alice",
        role: "owner",
        contacts: [{ channel: "telegram", handle: "owner-1" }],
      };
      handle.peopleDirectory.getOwner.mockReturnValue(owner);

      const mockComm = {
        manifest: { id: "test-comm", adapter_meta: { channel: "telegram" } },
        hasCapability: () => true,
        formatMessage: (c: string) => c,
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      handle.registry.getPluginsByType.mockImplementation((type: string) => {
        if (type === "communication") {
          return [mockComm];
        }
        return [];
      });

      await handle.daemon.tick();

      expect(mockComm.sendMessage).toHaveBeenCalledWith(
        { user_id: "owner-1", channel: "telegram" },
        expect.objectContaining({
          content: expect.stringContaining("Stuck task"),
        }),
      );
    });

    it("calls attemptSelfUnblock for tasks blocked past self-unblock threshold", async () => {
      handle = createTestDaemon();
      const eightHoursAgo = new Date(handle.clock.now() - 28_800_000 - 1000).toISOString();
      const blockedTask = createMockTask({
        id: "blocked-2",
        state: TaskStates.blocked,
        sub_state: null,
        title: "Self-unblock candidate",
        last_transition_at: eightHoursAgo,
      });
      handle.taskEngine.getTasksByState.mockImplementation((state: string) => {
        if (state === TaskStates.blocked) {
          return [blockedTask];
        }
        return [];
      });

      // No owner = skip reminder, but self-unblock still runs
      handle.peopleDirectory.getOwner.mockReturnValue(null);

      await handle.daemon.tick();

      expect(handle.orchestrator.attemptSelfUnblock).toHaveBeenCalledWith("blocked-2");
    });

    it("escalates to failed for tasks blocked past escalation threshold", async () => {
      handle = createTestDaemon();
      const twoDaysAgo = new Date(handle.clock.now() - 172_800_000 - 1000).toISOString();
      const blockedTask = createMockTask({
        id: "blocked-3",
        state: TaskStates.blocked,
        sub_state: null,
        title: "Escalation task",
        last_transition_at: twoDaysAgo,
      });
      handle.taskEngine.getTasksByState.mockImplementation((state: string) => {
        if (state === TaskStates.blocked) {
          return [blockedTask];
        }
        return [];
      });
      handle.peopleDirectory.getOwner.mockReturnValue(null);
      handle.peopleDirectory.getReviewers.mockReturnValue([]);

      await handle.daemon.tick();

      expect(handle.taskEngine.requestTransition).toHaveBeenCalledWith(
        "blocked-3",
        TaskStates.failed,
        null,
        "blocked_timeout_escalation",
        "daemon",
      );
    });
  });

  // ── Review Pending Reminders ───────────────────────────────────────────

  describe("review pending reminders", () => {
    it("sends reminder for tasks pending review past threshold", async () => {
      handle = createTestDaemon();
      const oneDayAgo = new Date(handle.clock.now() - 86_400_000 - 1000).toISOString();
      const reviewTask = createMockTask({
        id: "review-1",
        state: TaskStates.blocked,
        sub_state: null,
        blocked: {
          reason: BlockReasons.pr_review_pending,
          category: BlockCategories.awaiting_pr_review,
          sub_phase: "await-review",
          needed: "review",
        },
        title: "Needs review",
        last_transition_at: oneDayAgo,
      });
      handle.taskEngine.getBlockedTasksByReason.mockImplementation((reason: string) => {
        if (reason === BlockReasons.pr_review_pending) {
          return [reviewTask];
        }
        return [];
      });
      handle.taskEngine.getTask.mockReturnValue(reviewTask);

      const reviewer = {
        id: "rev-1",
        name: "Bob",
        role: "reviewer",
        contacts: [{ channel: "telegram", handle: "rev-1" }],
      };
      handle.peopleDirectory.getReviewers.mockReturnValue([reviewer]);

      const mockComm = {
        manifest: { id: "test-comm", adapter_meta: { channel: "telegram" } },
        hasCapability: () => true,
        formatMessage: (c: string) => c,
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      handle.registry.getPluginsByType.mockImplementation((type: string) => {
        if (type === "communication") {
          return [mockComm];
        }
        return [];
      });

      await handle.daemon.tick();

      expect(mockComm.sendMessage).toHaveBeenCalledWith(
        { user_id: "rev-1", channel: "telegram" },
        expect.objectContaining({
          content: expect.stringContaining("Needs review"),
        }),
      );
    });

    it("does not send reminder before threshold", async () => {
      handle = createTestDaemon();
      const recentTime = new Date(handle.clock.now() - 3_600_000).toISOString(); // 1h ago
      const reviewTask = createMockTask({
        id: "review-2",
        state: TaskStates.blocked,
        sub_state: null,
        blocked: {
          reason: BlockReasons.pr_review_pending,
          category: BlockCategories.awaiting_pr_review,
          sub_phase: "await-review",
          needed: "review",
        },
        title: "Too early",
        last_transition_at: recentTime,
      });
      handle.taskEngine.getBlockedTasksByReason.mockImplementation((reason: string) => {
        if (reason === BlockReasons.pr_review_pending) {
          return [reviewTask];
        }
        return [];
      });

      const mockComm = {
        hasCapability: () => true,
        formatMessage: (c: string) => c,
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      handle.registry.getPluginsByType.mockImplementation((type: string) => {
        if (type === "communication") {
          return [mockComm];
        }
        return [];
      });

      await handle.daemon.tick();

      expect(mockComm.sendMessage).not.toHaveBeenCalled();
    });

    it("does not repeat reminder within interval", async () => {
      handle = createTestDaemon();
      const oneDayAgo = new Date(handle.clock.now() - 86_400_000 - 1000).toISOString();
      const reviewTask = createMockTask({
        id: "review-3",
        state: TaskStates.blocked,
        sub_state: null,
        blocked: {
          reason: BlockReasons.pr_review_pending,
          category: BlockCategories.awaiting_pr_review,
          sub_phase: "await-review",
          needed: "review",
        },
        title: "Repeat check",
        last_transition_at: oneDayAgo,
      });
      handle.taskEngine.getBlockedTasksByReason.mockImplementation((reason: string) => {
        if (reason === BlockReasons.pr_review_pending) {
          return [reviewTask];
        }
        return [];
      });

      const reviewer = {
        id: "rev-1",
        name: "Bob",
        role: "reviewer",
        contacts: [{ channel: "telegram", handle: "rev-1" }],
      };
      handle.peopleDirectory.getReviewers.mockReturnValue([reviewer]);

      const mockComm = {
        manifest: { id: "test-comm", adapter_meta: { channel: "telegram" } },
        hasCapability: () => true,
        formatMessage: (c: string) => c,
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };
      handle.registry.getPluginsByType.mockImplementation((type: string) => {
        if (type === "communication") {
          return [mockComm];
        }
        return [];
      });

      // First tick — sends reminder
      await handle.daemon.tick();
      expect(mockComm.sendMessage).toHaveBeenCalledTimes(1);

      // Second tick without advancing clock — should not repeat
      mockComm.sendMessage.mockClear();
      await handle.daemon.tick();
      expect(mockComm.sendMessage).not.toHaveBeenCalled();

      // Third tick after advancing clock past repeat interval — should send again
      mockComm.sendMessage.mockClear();
      handle.clock.advance(86_400_000 + 1000);
      await handle.daemon.tick();
      expect(mockComm.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ── Review Pending ──────────────────────────────────────────────────

  describe("review pending", () => {
    it("leaves a pr_review_pending task blocked — no terminal transition by the daemon", async () => {
      handle = createTestDaemon();
      const task = createMockTask({
        id: "task-pr",
        state: TaskStates.queued,
        sub_state: null,
        title: "PR task",
      });
      handle.taskEngine.getQueuedByPriority.mockReturnValue([task]);
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({
          id: "task-pr",
          state: TaskStates.blocked,
          sub_state: null,
          blocked: {
            reason: BlockReasons.pr_review_pending,
            category: BlockCategories.awaiting_pr_review,
            sub_phase: "await-review",
            needed: "review",
          },
        }),
      );
      handle.orchestrator.executeTask.mockResolvedValueOnce({
        outcome: "blocked",
        phase: "demo_prep",
        reason: "pr_review_pending",
      } satisfies ExecuteTaskResult);

      await handle.daemon.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The phase-runner owns the block; the daemon must not complete or fail the task.
      expect(handle.taskEngine.requestTransition).not.toHaveBeenCalledWith(
        "task-pr",
        TaskStates.completed,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      expect(handle.taskEngine.requestTransition).not.toHaveBeenCalledWith(
        "task-pr",
        TaskStates.failed,
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("does not cleanup workspace on pr_review_pending blocked outcome", async () => {
      handle = createTestDaemon();
      const task = createMockTask({
        id: "task-pr",
        state: TaskStates.queued,
        sub_state: null,
      });
      handle.taskEngine.getQueuedByPriority.mockReturnValue([task]);
      handle.taskEngine.getTask.mockReturnValue(
        createMockTask({
          id: "task-pr",
          state: TaskStates.blocked,
          sub_state: null,
          blocked: {
            reason: BlockReasons.pr_review_pending,
            category: BlockCategories.awaiting_pr_review,
            sub_phase: "await-review",
            needed: "review",
          },
        }),
      );
      handle.orchestrator.executeTask.mockResolvedValueOnce({
        outcome: "blocked",
        phase: "demo_prep",
        reason: "pr_review_pending",
      } satisfies ExecuteTaskResult);

      await handle.daemon.tick();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(handle.workspaceManager.cleanupWorkspace).not.toHaveBeenCalled();
    });

    it("re-enters a review-pending task through the poller when PR feedback arrives", async () => {
      handle = createTestDaemon();
      const task = createMockTask({
        id: "task-feedback",
        state: TaskStates.blocked,
        sub_state: null,
        repo: "org/repo",
        blocked: {
          reason: BlockReasons.pr_review_pending,
          category: BlockCategories.awaiting_pr_review,
          sub_phase: "await-review",
          needed: "review",
        },
        review: {
          pr_number: 42,
          merged_at: null,
          feedback_rounds: [],
          accommodated_comment_ids: [],
          accommodated_review_state: null,
        },
      });
      handle.taskEngine.getBlockedTasksByReason.mockImplementation((reason: string) =>
        reason === BlockReasons.pr_review_pending ? [task] : [],
      );
      const fakeHosting = {
        detectPrEvents: vi.fn().mockResolvedValue([
          {
            type: "pr_comments",
            comments: [{ id: "c1", author: "alice", body: "tighten the naming", created_at: "2026-05-31T00:00:00Z" }],
          },
        ]),
      };
      handle.registry.getPrimaryPlugin.mockImplementation((type: string) =>
        type === "git_hosting" ? fakeHosting : null,
      );

      await handle.daemon.tick();

      expect(fakeHosting.detectPrEvents).toHaveBeenCalledWith("org/repo", 42);
      expect(handle.taskEngine.updateTaskField).toHaveBeenCalledWith(
        "task-feedback",
        "pending_pr_event",
        "pr_comments",
      );
      expect(handle.taskEngine.requestTransition).toHaveBeenCalledWith(
        "task-feedback",
        TaskStates.queued,
        null,
        "pr_event:pr_comments",
        "daemon",
      );
    });
  });
});
