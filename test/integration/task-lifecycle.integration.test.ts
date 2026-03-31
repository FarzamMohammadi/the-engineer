import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../../src/core/event-bus/index.js";
import { TaskEngine } from "../../src/core/task-engine/index.js";
import type { Event } from "../../src/schemas/events.js";
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
        description: "A test task",
      });
      expect(task.state).toBe("requirements_gathering");

      // requirements_gathering → queued
      const r1 = taskEngine.requestTransition(task.id, "queued", null, "triggered", "daemon");
      expect(r1.success).toBe(true);
      expect(taskEngine.getTask(task.id)?.state).toBe("queued");

      // queued → active.working
      const r2 = taskEngine.requestTransition(task.id, "active", "working", "scheduled", "daemon");
      expect(r2.success).toBe(true);
      const activeTask = taskEngine.getTask(task.id);
      expect(activeTask?.state).toBe("active");
      expect(activeTask?.sub_state).toBe("working");

      // active.working → completed
      const r3 = taskEngine.requestTransition(task.id, "completed", null, "done", "orchestrator");
      expect(r3.success).toBe(true);
      expect(taskEngine.getTask(task.id)?.state).toBe("completed");

      // Verify events emitted for each transition
      expect(events).toHaveLength(3);
      expect(events[0]?.payload).toMatchObject({
        from_state: "requirements_gathering",
        to_state: "queued",
      });
      expect(events[1]?.payload).toMatchObject({ from_state: "queued", to_state: "active" });
      expect(events[2]?.payload).toMatchObject({ from_state: "active", to_state: "completed" });
    });

    it("transitions through review_pending.demo → review_pending.code → completed", () => {
      setup();

      const task = taskEngine.createTask({
        title: "Review task",
        repo: "test/repo",
        source: "test",
        description: "",
      });

      taskEngine.requestTransition(task.id, "queued", null, "triggered", "daemon");
      taskEngine.requestTransition(task.id, "active", "working", "scheduled", "daemon");
      taskEngine.requestTransition(task.id, "review_pending", "demo", "demo_ready", "orchestrator");

      expect(taskEngine.getTask(task.id)?.state).toBe("review_pending");
      expect(taskEngine.getTask(task.id)?.sub_state).toBe("demo");

      taskEngine.requestTransition(task.id, "review_pending", "code", "demo_approved", "reviewer");
      expect(taskEngine.getTask(task.id)?.sub_state).toBe("code");

      taskEngine.requestTransition(task.id, "completed", null, "approved", "reviewer");
      expect(taskEngine.getTask(task.id)?.state).toBe("completed");
    });
  });

  describe("blocked path", () => {
    it("transitions active.working → blocked → active.working → completed", () => {
      setup();

      const task = taskEngine.createTask({
        title: "Blocked task",
        repo: "test/repo",
        source: "test",
        description: "",
      });

      taskEngine.requestTransition(task.id, "queued", null, "triggered", "daemon");
      taskEngine.requestTransition(task.id, "active", "working", "scheduled", "daemon");
      taskEngine.requestTransition(task.id, "blocked", null, "waiting_for_input", "orchestrator");

      expect(taskEngine.getTask(task.id)?.state).toBe("blocked");

      taskEngine.requestTransition(task.id, "active", "working", "unblocked", "daemon");
      expect(taskEngine.getTask(task.id)?.state).toBe("active");

      taskEngine.requestTransition(task.id, "completed", null, "done", "orchestrator");
      expect(taskEngine.getTask(task.id)?.state).toBe("completed");
    });
  });

  describe("failed path", () => {
    it("transitions active.working → failed", () => {
      setup();

      const task = taskEngine.createTask({
        title: "Failing task",
        repo: "test/repo",
        source: "test",
        description: "",
      });

      taskEngine.requestTransition(task.id, "queued", null, "triggered", "daemon");
      taskEngine.requestTransition(task.id, "active", "working", "scheduled", "daemon");
      taskEngine.requestTransition(task.id, "failed", null, "unrecoverable_error", "orchestrator");

      expect(taskEngine.getTask(task.id)?.state).toBe("failed");
    });
  });

  describe("invalid transitions", () => {
    it("rejects transition from intake directly to active", () => {
      setup();

      const task = taskEngine.createTask({
        title: "Invalid task",
        repo: "test/repo",
        source: "test",
        description: "",
      });

      const result = taskEngine.requestTransition(task.id, "active", "working", "bad", "daemon");
      expect(result.success).toBe(false);
    });

    it("rejects transition from completed to any state", () => {
      setup();

      const task = taskEngine.createTask({
        title: "Completed task",
        repo: "test/repo",
        source: "test",
        description: "",
      });

      taskEngine.requestTransition(task.id, "queued", null, "triggered", "daemon");
      taskEngine.requestTransition(task.id, "active", "working", "scheduled", "daemon");
      taskEngine.requestTransition(task.id, "completed", null, "done", "orchestrator");

      const result = taskEngine.requestTransition(task.id, "queued", null, "retry", "daemon");
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
        description: "",
      });

      taskEngine.requestTransition(task.id, "queued", null, "triggered", "daemon");
      taskEngine.requestTransition(task.id, "active", "working", "scheduled", "daemon");
      taskEngine.requestTransition(task.id, "completed", null, "done", "orchestrator");

      const history = taskEngine.getStateHistory(task.id);
      expect(history).toHaveLength(3);
      expect(history[0]).toMatchObject({
        from_state: "requirements_gathering",
        to_state: "queued",
      });
      expect(history[1]).toMatchObject({ from_state: "queued", to_state: "active" });
      expect(history[2]).toMatchObject({ from_state: "active", to_state: "completed" });
    });
  });

  describe("child task linkage", () => {
    it("creates child tasks linked to parent via parent_id", () => {
      setup();

      const parent = taskEngine.createTask({
        title: "Parent task",
        repo: "test/repo",
        source: "test",
        description: "",
      });

      const child1 = taskEngine.createTask({
        title: "Child 1",
        repo: "test/repo",
        source: "test",
        description: "",
        parent_id: parent.id,
      });

      const child2 = taskEngine.createTask({
        title: "Child 2",
        repo: "test/repo",
        source: "test",
        description: "",
        parent_id: parent.id,
      });

      const children = taskEngine.getChildren(parent.id);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id)).toContain(child1.id);
      expect(children.map((c) => c.id)).toContain(child2.id);
    });
  });

  describe("query methods", () => {
    it("getTasksByState returns tasks in the requested state", () => {
      setup();

      const t1 = taskEngine.createTask({ title: "T1", repo: "r", source: "s", description: "" });
      const t2 = taskEngine.createTask({ title: "T2", repo: "r", source: "s", description: "" });
      taskEngine.requestTransition(t1.id, "queued", null, "go", "daemon");
      taskEngine.requestTransition(t2.id, "queued", null, "go", "daemon");
      taskEngine.requestTransition(t1.id, "active", "working", "go", "daemon");

      const queued = taskEngine.getTasksByState("queued");
      expect(queued).toHaveLength(1);
      expect(queued[0]?.id).toBe(t2.id);

      const active = taskEngine.getTasksByState("active");
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(t1.id);
    });
  });
});
