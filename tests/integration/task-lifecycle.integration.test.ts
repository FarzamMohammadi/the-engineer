import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../../src/core/event-bus/index.js";
import { TaskEngine } from "../../src/core/task-engine/index.js";
import type { Event } from "../../src/schemas/events.js";
import { SubStates, TaskStates } from "../../src/schemas/task.js";
import { type TestDatabaseHandle, createTestDatabase } from "../helpers/test-database.js";
import { createTestObserverFacade } from "../helpers/test-observer-facade.js";

describe("Task lifecycle (integration)", () => {
  let dbHandle: TestDatabaseHandle;
  let eventBus: EventBus;
  let taskEngine: TaskEngine;

  function setup(): void {
    dbHandle = createTestDatabase();
    const observer = createTestObserverFacade("event-bus");
    eventBus = new EventBus(dbHandle.db, { observer });
    taskEngine = new TaskEngine(dbHandle.db, eventBus, observer.child("task-engine"));
  }

  afterEach(() => {
    dbHandle?.cleanup();
  });

  describe("happy path", () => {
    it("transitions through intake → queued → active.working → completed", () => {
      setup();
      const events: Event[] = [];
      eventBus.subscribe("test", "task.state_changed", (e) => events.push(e));

      const task = taskEngine.createTask({
        title: "Test task",
        repo: "test/repo",
        source: "test",
        idempotency_key: "lifecycle:happy",
        description: "A test task",
      });
      expect(task.state).toBe(TaskStates.requirements_gathering);

      // requirements_gathering → queued
      const r1 = taskEngine.requestTransition(task.id, TaskStates.queued, null, "triggered", "daemon");
      expect(r1.success).toBe(true);
      expect(taskEngine.getTask(task.id)?.state).toBe(TaskStates.queued);

      // queued → active.working
      const r2 = taskEngine.requestTransition(task.id, TaskStates.active, SubStates.working, "scheduled", "daemon");
      expect(r2.success).toBe(true);
      const activeTask = taskEngine.getTask(task.id);
      expect(activeTask?.state).toBe(TaskStates.active);
      expect(activeTask?.sub_state).toBe(SubStates.working);

      // active.working → completed
      const r3 = taskEngine.requestTransition(task.id, TaskStates.completed, null, "done", "orchestrator");
      expect(r3.success).toBe(true);
      expect(taskEngine.getTask(task.id)?.state).toBe(TaskStates.completed);

      // Verify events emitted for each transition
      expect(events).toHaveLength(3);
      expect(events[0]?.payload).toMatchObject({
        from_state: TaskStates.requirements_gathering,
        to_state: TaskStates.queued,
      });
      expect(events[1]?.payload).toMatchObject({
        from_state: TaskStates.queued,
        to_state: TaskStates.active,
      });
      expect(events[2]?.payload).toMatchObject({
        from_state: TaskStates.active,
        to_state: TaskStates.completed,
      });
    });

    it("transitions through review_pending.demo → review_pending.code → completed", () => {
      setup();

      const task = taskEngine.createTask({
        title: "Review task",
        repo: "test/repo",
        source: "test",
        idempotency_key: "lifecycle:review",
        description: "",
      });

      taskEngine.requestTransition(task.id, TaskStates.queued, null, "triggered", "daemon");
      taskEngine.requestTransition(task.id, TaskStates.active, SubStates.working, "scheduled", "daemon");
      taskEngine.requestTransition(task.id, TaskStates.review_pending, SubStates.code, "demo_ready", "orchestrator");

      expect(taskEngine.getTask(task.id)?.state).toBe(TaskStates.review_pending);
      expect(taskEngine.getTask(task.id)?.sub_state).toBe(SubStates.code);

      taskEngine.requestTransition(task.id, TaskStates.review_pending, SubStates.code, "demo_approved", "reviewer");
      expect(taskEngine.getTask(task.id)?.sub_state).toBe(SubStates.code);

      taskEngine.requestTransition(task.id, TaskStates.completed, null, "approved", "reviewer");
      expect(taskEngine.getTask(task.id)?.state).toBe(TaskStates.completed);
    });
  });

  describe("blocked path", () => {
    it("transitions active.working → blocked → active.working → completed", () => {
      setup();

      const task = taskEngine.createTask({
        title: "Blocked task",
        repo: "test/repo",
        source: "test",
        idempotency_key: "lifecycle:blocked",
        description: "",
      });

      taskEngine.requestTransition(task.id, TaskStates.queued, null, "triggered", "daemon");
      taskEngine.requestTransition(task.id, TaskStates.active, SubStates.working, "scheduled", "daemon");
      taskEngine.requestTransition(task.id, TaskStates.blocked, null, "waiting_for_input", "orchestrator");

      expect(taskEngine.getTask(task.id)?.state).toBe(TaskStates.blocked);

      taskEngine.requestTransition(task.id, TaskStates.active, SubStates.working, "unblocked", "daemon");
      expect(taskEngine.getTask(task.id)?.state).toBe(TaskStates.active);

      taskEngine.requestTransition(task.id, TaskStates.completed, null, "done", "orchestrator");
      expect(taskEngine.getTask(task.id)?.state).toBe(TaskStates.completed);
    });
  });

  describe("failed path", () => {
    it("transitions active.working → failed", () => {
      setup();

      const task = taskEngine.createTask({
        title: "Failing task",
        repo: "test/repo",
        source: "test",
        idempotency_key: "lifecycle:failed",
        description: "",
      });

      taskEngine.requestTransition(task.id, TaskStates.queued, null, "triggered", "daemon");
      taskEngine.requestTransition(task.id, TaskStates.active, SubStates.working, "scheduled", "daemon");
      taskEngine.requestTransition(task.id, TaskStates.failed, null, "unrecoverable_error", "orchestrator");

      expect(taskEngine.getTask(task.id)?.state).toBe(TaskStates.failed);
    });
  });

  describe("invalid transitions", () => {
    it("rejects transition from intake directly to active", () => {
      setup();

      const task = taskEngine.createTask({
        title: "Invalid task",
        repo: "test/repo",
        source: "test",
        idempotency_key: "lifecycle:invalid",
        description: "",
      });

      const result = taskEngine.requestTransition(task.id, TaskStates.active, SubStates.working, "bad", "daemon");
      expect(result.success).toBe(false);
    });

    it("rejects transition from completed to any state", () => {
      setup();

      const task = taskEngine.createTask({
        title: "Completed task",
        repo: "test/repo",
        source: "test",
        idempotency_key: "lifecycle:completed",
        description: "",
      });

      taskEngine.requestTransition(task.id, TaskStates.queued, null, "triggered", "daemon");
      taskEngine.requestTransition(task.id, TaskStates.active, SubStates.working, "scheduled", "daemon");
      taskEngine.requestTransition(task.id, TaskStates.completed, null, "done", "orchestrator");

      const result = taskEngine.requestTransition(task.id, TaskStates.queued, null, "retry", "daemon");
      expect(result.success).toBe(false);
    });
  });

  describe("state history", () => {
    it("records all transitions in state history", () => {
      setup();

      const task = taskEngine.createTask({
        title: "History task",
        repo: "test/repo",
        source: "test",
        idempotency_key: "lifecycle:history",
        description: "",
      });

      taskEngine.requestTransition(task.id, TaskStates.queued, null, "triggered", "daemon");
      taskEngine.requestTransition(task.id, TaskStates.active, SubStates.working, "scheduled", "daemon");
      taskEngine.requestTransition(task.id, TaskStates.completed, null, "done", "orchestrator");

      const history = taskEngine.getStateHistory(task.id);
      expect(history).toHaveLength(3);
      expect(history[0]).toMatchObject({
        from_state: TaskStates.requirements_gathering,
        to_state: TaskStates.queued,
      });
      expect(history[1]).toMatchObject({
        from_state: TaskStates.queued,
        to_state: TaskStates.active,
      });
      expect(history[2]).toMatchObject({
        from_state: TaskStates.active,
        to_state: TaskStates.completed,
      });
    });
  });

  describe("query methods", () => {
    it("getTasksByState returns tasks in the requested state", () => {
      setup();

      const t1 = taskEngine.createTask({
        title: "T1",
        repo: "r",
        source: "s",
        idempotency_key: "lifecycle:t1",
        description: "",
      });
      const t2 = taskEngine.createTask({
        title: "T2",
        repo: "r",
        source: "s",
        idempotency_key: "lifecycle:t2",
        description: "",
      });
      taskEngine.requestTransition(t1.id, TaskStates.queued, null, "go", "daemon");
      taskEngine.requestTransition(t2.id, TaskStates.queued, null, "go", "daemon");
      taskEngine.requestTransition(t1.id, TaskStates.active, SubStates.working, "go", "daemon");

      const queued = taskEngine.getTasksByState(TaskStates.queued);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.id).toBe(t2.id);

      const active = taskEngine.getTasksByState(TaskStates.active);
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(t1.id);
    });
  });
});
