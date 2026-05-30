import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventBus } from "../../../../src/core/event-bus/index.js";
import type { CreateTaskInput } from "../../../../src/core/task-engine/index.js";
import { TaskEngine, isValidTransition } from "../../../../src/core/task-engine/index.js";
import { createInMemoryDatabase } from "../../../../src/db/database.js";
import { EventTypes } from "../../../../src/schemas/events.js";
import { Phases } from "../../../../src/schemas/orchestrator.js";
import type { ActionClass, SubState, Task, TaskState } from "../../../../src/schemas/task.js";
import { ActionClasses, SubStates, TaskStates, ValidTransitions } from "../../../../src/schemas/task.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";
import { type TestTaskEngineHandle, createTestTaskEngine } from "../../../helpers/test-task-engine.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const ULID_PATTERN = /^[0-9A-Z]{26}$/;

// ── Helpers ────────────────────────────────────────────────────────────────────

function assertDefined<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined, got ${String(value)}`);
  }
  return value;
}

let idempotencyKeySeq = 0;

function makeInput(overrides?: Partial<CreateTaskInput>): CreateTaskInput {
  return {
    title: "Test task",
    repo: "owner/test-repo",
    source: "test",
    // Unique by default so multiple tasks don't collide on the active dedup index.
    idempotency_key: `test:${String(idempotencyKeySeq++)}`,
    ...overrides,
  };
}

/**
 * Transition a task through a sequence of states to reach a target state.
 * Creates the task, then applies each transition in order.
 */
function createTaskInState(
  engine: TaskEngine,
  state: TaskState,
  subState: SubState | null,
  inputOverrides?: Partial<CreateTaskInput>,
): Task {
  const task = engine.createTask(makeInput(inputOverrides));
  const path = getPathToState(state, subState);
  for (const step of path) {
    const result = engine.requestTransition(task.id, step.state, step.sub, step.reason, "test");
    if (!result.success) {
      throw new Error(
        `Failed to reach ${state}.${subState}: transition to ${step.state}.${step.sub} failed: ${result.reason}`,
      );
    }
  }
  return assertDefined(engine.getTask(task.id), "task");
}

interface TransitionStep {
  state: TaskState;
  sub: SubState | null;
  reason: string;
}

/** Get the shortest path of transitions from requirements_gathering to a target state. */
function getPathToState(state: TaskState, subState: SubState | null): TransitionStep[] {
  if (state === TaskStates.requirements_gathering) {
    return [];
  }
  if (state === TaskStates.queued) {
    return [{ state: TaskStates.queued, sub: null, reason: "validated" }];
  }

  const base: TransitionStep[] = [{ state: TaskStates.queued, sub: null, reason: "validated" }];

  if (state === TaskStates.active && subState === SubStates.working) {
    return [...base, { state: TaskStates.active, sub: SubStates.working, reason: "scheduled" }];
  }
  if (state === TaskStates.blocked) {
    return [
      ...base,
      { state: TaskStates.active, sub: SubStates.working, reason: "scheduled" },
      { state: TaskStates.blocked, sub: null, reason: "needs human input" },
    ];
  }
  if (state === TaskStates.completed) {
    return [
      ...base,
      { state: TaskStates.active, sub: SubStates.working, reason: "scheduled" },
      { state: TaskStates.completed, sub: null, reason: "done" },
    ];
  }
  if (state === TaskStates.failed) {
    return [
      ...base,
      { state: TaskStates.active, sub: SubStates.working, reason: "scheduled" },
      { state: TaskStates.failed, sub: null, reason: "unrecoverable error" },
    ];
  }

  throw new Error(`No path defined for state ${state}.${subState}`);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("isValidTransition", () => {
  it("accepts requirements_gathering to queued", () => {
    expect(isValidTransition(TaskStates.requirements_gathering, null, TaskStates.queued, null)).toBe(true);
  });

  it("accepts requirements_gathering to failed", () => {
    expect(isValidTransition(TaskStates.requirements_gathering, null, TaskStates.failed, null)).toBe(true);
  });

  it("accepts queued to active.working", () => {
    expect(isValidTransition(TaskStates.queued, null, TaskStates.active, SubStates.working)).toBe(true);
  });

  it("rejects requirements_gathering to active (no such transition)", () => {
    expect(isValidTransition(TaskStates.requirements_gathering, null, TaskStates.active, SubStates.working)).toBe(
      false,
    );
  });

  it("rejects completed to anything", () => {
    expect(isValidTransition(TaskStates.completed, null, TaskStates.active, SubStates.working)).toBe(false);
    expect(isValidTransition(TaskStates.completed, null, TaskStates.queued, null)).toBe(false);
  });

  it("handles all 25 valid transitions from the table", () => {
    for (const entry of ValidTransitions) {
      const fromSub = "from_sub" in entry ? (entry.from_sub as SubState) : null;
      const toSub = "to_sub" in entry ? (entry.to_sub as SubState) : null;
      expect(
        isValidTransition(entry.from, fromSub, entry.to, toSub),
        `Expected ${entry.from}.${fromSub ?? "null"} -> ${entry.to}.${toSub ?? "null"} to be valid`,
      ).toBe(true);
    }
  });
});

describe("TaskEngine", () => {
  let handle: TestTaskEngineHandle;
  let engine: TaskEngine;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    handle = createTestTaskEngine();
    engine = handle.engine;
  });

  afterEach(() => {
    handle.cleanup();
    vi.restoreAllMocks();
  });

  // ── createTask ──────────────────────────────────────────────────────────────

  describe("createTask", () => {
    it("creates a task in requirements_gathering state", () => {
      const task = engine.createTask(makeInput());
      expect(task.state).toBe(TaskStates.requirements_gathering);
      expect(task.sub_state).toBeNull();
    });

    it("generates a ULID for the task id", () => {
      const task = engine.createTask(makeInput());
      expect(task.id).toMatch(ULID_PATTERN);
    });

    it("sets correct default values", () => {
      const task = engine.createTask(makeInput());
      expect(task.priority).toBe(50);
      expect(task.team).toEqual([]);
      expect(task.related).toEqual([]);
      expect(task.decisions).toEqual([]);
      expect(task.acceptance_criteria).toEqual([]);
      expect(task.description).toBe("");
      expect(task.source_text).toBe("");
      expect(task.external_ref).toBeNull();
      expect(task.workspace).toBeNull();
      expect(task.review).toBeNull();
      expect(task.blocked).toBeNull();
      expect(task.phase).toBeNull();
      expect(task.session_id).toBeNull();
      expect(task.started_at).toBeNull();
      expect(task.completed_at).toBeNull();
      expect(task.agent_tokens).toBe(0);
      expect(task.agent_cost_usd).toBe(0);
      expect(task.compute_time_ms).toBe(0);
    });

    it("persists the task to the database", () => {
      const task = engine.createTask(makeInput());
      const retrieved = engine.getTask(task.id);
      expect(retrieved).not.toBeNull();
      const defined = assertDefined(retrieved, "retrieved task");
      expect(defined.id).toBe(task.id);
      expect(defined.title).toBe("Test task");
    });

    it("emits task.created event with correct payload", () => {
      const task = engine.createTask(makeInput({ priority: 75, idempotency_key: "evt:key" }));
      handle.assertEventEmitted(EventTypes["task.created"], (payload) => {
        const p = payload as Record<string, unknown>;
        return (
          p["task_id"] === task.id &&
          p["title"] === "Test task" &&
          p["repo"] === "owner/test-repo" &&
          p["source"] === "test" &&
          p["idempotency_key"] === "evt:key" &&
          p["priority"] === 75
        );
      });
    });

    it("does not emit task.state_changed event", () => {
      engine.createTask(makeInput());
      const stateChangedEvents = handle.getEmittedEvents(EventTypes["task.state_changed"]);
      expect(stateChangedEvents).toHaveLength(0);
    });

    it("accepts optional fields", () => {
      const task = engine.createTask(
        makeInput({
          description: "A detailed description",
          source_text: "Original issue body",
          acceptance_criteria: ["Must pass all tests", "Must have docs"],
          priority: 80,
        }),
      );
      expect(task.description).toBe("A detailed description");
      expect(task.source_text).toBe("Original issue body");
      expect(task.acceptance_criteria).toEqual(["Must pass all tests", "Must have docs"]);
      expect(task.priority).toBe(80);
    });

    it("accepts external_ref", () => {
      const task = engine.createTask(
        makeInput({
          external_ref: { type: "test_issue", repo: "owner/repo", id: "42" },
        }),
      );
      expect(task.external_ref).toEqual({ type: "test_issue", repo: "owner/repo", id: "42" });
    });

    it("stores and round-trips the idempotency_key", () => {
      const task = engine.createTask(makeInput({ idempotency_key: "github:issue:owner/repo:42" }));
      expect(task.idempotency_key).toBe("github:issue:owner/repo:42");
      expect(engine.getTask(task.id)?.idempotency_key).toBe("github:issue:owner/repo:42");
    });

    it("rejects a second non-terminal task with the same idempotency_key", () => {
      engine.createTask(makeInput({ idempotency_key: "dup:key" }));
      expect(() => engine.createTask(makeInput({ idempotency_key: "dup:key" }))).toThrow();
    });
  });

  // ── findByIdempotencyKey (durable, active-scoped dedup) ──────────────────────

  describe("findByIdempotencyKey", () => {
    it("returns false for an unknown key", () => {
      expect(engine.findByIdempotencyKey("never:seen")).toBe(false);
    });

    it("returns true while a task with the key is non-terminal (round-trip)", () => {
      engine.createTask(makeInput({ idempotency_key: "rt:active" }));
      expect(engine.findByIdempotencyKey("rt:active")).toBe(true);
    });

    it("frees the key once the task is completed (active-scoped)", () => {
      createTaskInState(engine, TaskStates.completed, null, { idempotency_key: "rt:completed" });
      expect(engine.findByIdempotencyKey("rt:completed")).toBe(false);
    });

    it("frees the key once the task is failed (active-scoped)", () => {
      createTaskInState(engine, TaskStates.failed, null, { idempotency_key: "rt:failed" });
      expect(engine.findByIdempotencyKey("rt:failed")).toBe(false);
    });
  });

  // ── requestTransition — valid transitions ─────────────────────────────────

  describe("requestTransition — valid transitions", () => {
    it("transitions requirements_gathering to queued", () => {
      const task = engine.createTask(makeInput());
      const result = engine.requestTransition(task.id, TaskStates.queued, null, "validated", "daemon");
      expect(result).toEqual({ success: true });
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.state).toBe(TaskStates.queued);
      expect(updated.sub_state).toBeNull();
    });

    it("transitions queued to active.working", () => {
      const task = createTaskInState(engine, TaskStates.queued, null);
      const result = engine.requestTransition(task.id, TaskStates.active, SubStates.working, "scheduled", "daemon");
      expect(result.success).toBe(true);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.state).toBe(TaskStates.active);
      expect(updated.sub_state).toBe(SubStates.working);
    });

    it("updates last_transition_at timestamp", () => {
      const task = engine.createTask(makeInput());
      engine.requestTransition(task.id, TaskStates.queued, null, "validated", "daemon");
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.last_transition_at).toBeDefined();
      // Timestamps might be the same if fast enough, but should be valid ISO
      expect(new Date(updated.last_transition_at).toISOString()).toBe(updated.last_transition_at);
    });

    it("sets started_at on first transition to active", () => {
      const task = createTaskInState(engine, TaskStates.queued, null);
      expect(assertDefined(engine.getTask(task.id), "task").started_at).toBeNull();
      engine.requestTransition(task.id, TaskStates.active, SubStates.working, "scheduled", "daemon");
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.started_at).not.toBeNull();
    });

    it("does not overwrite started_at on subsequent active transitions", () => {
      const task = createTaskInState(engine, TaskStates.active, SubStates.working);
      const firstStarted = assertDefined(engine.getTask(task.id), "task").started_at;
      // Go blocked and back to active
      engine.requestTransition(task.id, TaskStates.blocked, null, "needs input", "orchestrator");
      engine.requestTransition(task.id, TaskStates.active, SubStates.working, "unblocked", "daemon");
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.started_at).toBe(firstStarted);
    });

    it("sets completed_at on transition to completed", () => {
      const task = createTaskInState(engine, TaskStates.active, SubStates.working);
      engine.requestTransition(task.id, TaskStates.completed, null, "done", "orchestrator");
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.completed_at).not.toBeNull();
    });

    it("sets completed_at on transition to failed", () => {
      const task = createTaskInState(engine, TaskStates.active, SubStates.working);
      engine.requestTransition(task.id, TaskStates.failed, null, "unrecoverable", "orchestrator");
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.completed_at).not.toBeNull();
    });

    it("records transition in state_transitions table", () => {
      const task = engine.createTask(makeInput());
      engine.requestTransition(task.id, TaskStates.queued, null, "validated", "daemon");
      const history = engine.getStateHistory(task.id);
      expect(history).toHaveLength(1);
      expect(history[0]!.from_state).toBe(TaskStates.requirements_gathering);
      expect(history[0]!.to_state).toBe(TaskStates.queued);
      expect(history[0]!.from_sub).toBeNull();
      expect(history[0]!.to_sub).toBeNull();
      expect(history[0]!.reason).toBe("validated");
      expect(history[0]!.triggered_by).toBe("daemon");
    });

    it("emits task.state_changed event with correct payload", () => {
      const task = engine.createTask(makeInput());
      engine.requestTransition(task.id, TaskStates.queued, null, "validated", "daemon");
      handle.assertEventEmitted(EventTypes["task.state_changed"], (payload) => {
        const p = payload as Record<string, unknown>;
        return (
          p["task_id"] === task.id &&
          p["from_state"] === TaskStates.requirements_gathering &&
          p["from_sub"] === null &&
          p["to_state"] === TaskStates.queued &&
          p["to_sub"] === null &&
          p["reason"] === "validated" &&
          p["triggered_by"] === "daemon"
        );
      });
    });

    it("handles all 25 valid transitions from the table", () => {
      for (const entry of ValidTransitions) {
        const fromSub = "from_sub" in entry ? (entry.from_sub as SubState) : null;
        const toSub = "to_sub" in entry ? (entry.to_sub as SubState) : null;

        const task = createTaskInState(engine, entry.from, fromSub, {
          title: `Test ${entry.from}.${fromSub} -> ${entry.to}.${toSub}`,
        });

        const result = engine.requestTransition(task.id, entry.to, toSub, "test transition", "test");
        expect(
          result.success,
          `Expected ${entry.from}.${fromSub ?? "null"} -> ${entry.to}.${toSub ?? "null"} to succeed, got: ${result.reason}`,
        ).toBe(true);

        const updated = assertDefined(engine.getTask(task.id), "task");
        expect(updated.state).toBe(entry.to);
        expect(updated.sub_state).toBe(toSub);
      }
    });
  });

  // ── requestTransition — invalid transitions ──────────────────────────────

  describe("requestTransition — invalid transitions", () => {
    it("rejects invalid transition with reason", () => {
      const task = engine.createTask(makeInput());
      const result = engine.requestTransition(task.id, TaskStates.active, SubStates.working, "invalid", "test");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("Invalid transition");
      expect(result.reason).toContain("requirements_gathering");
      expect(result.reason).toContain("active.working");
    });

    it("rejects transition from completed", () => {
      const task = createTaskInState(engine, TaskStates.completed, null);
      const result = engine.requestTransition(task.id, TaskStates.active, SubStates.working, "retry", "test");
      expect(result.success).toBe(false);
    });

    it("rejects transition from failed to active", () => {
      const task = createTaskInState(engine, TaskStates.failed, null);
      const result = engine.requestTransition(task.id, TaskStates.active, SubStates.working, "retry", "test");
      expect(result.success).toBe(false);
    });

    it("returns failure for non-existent task", () => {
      const result = engine.requestTransition("nonexistent", TaskStates.queued, null, "test", "test");
      expect(result.success).toBe(false);
      expect(result.reason).toBe("Task not found");
    });

    it("does not modify DB on rejection", () => {
      const task = engine.createTask(makeInput());
      engine.requestTransition(task.id, TaskStates.active, SubStates.working, "invalid", "test");
      const unchanged = assertDefined(engine.getTask(task.id), "task");
      expect(unchanged.state).toBe(TaskStates.requirements_gathering);
      expect(unchanged.sub_state).toBeNull();
    });

    it("does not emit events on rejection", () => {
      const task = engine.createTask(makeInput());
      const eventsBefore = handle.getEmittedEvents(EventTypes["task.state_changed"]).length;
      engine.requestTransition(task.id, TaskStates.active, SubStates.working, "invalid", "test");
      const eventsAfter = handle.getEmittedEvents(EventTypes["task.state_changed"]).length;
      expect(eventsAfter).toBe(eventsBefore);
    });
  });

  // ── checkPermission ──────────────────────────────────────────────────────

  describe("checkPermission", () => {
    it("allows read in requirements_gathering", () => {
      const task = engine.createTask(makeInput());
      expect(engine.checkPermission(task.id, ActionClasses.read)).toEqual({ allowed: true });
    });

    it("denies write in requirements_gathering", () => {
      const task = engine.createTask(makeInput());
      const result = engine.checkPermission(task.id, ActionClasses.write);
      expect(result.allowed).toBe(false);
    });

    it("allows read in queued", () => {
      const task = createTaskInState(engine, TaskStates.queued, null);
      expect(engine.checkPermission(task.id, ActionClasses.read)).toEqual({ allowed: true });
    });

    it("denies write in queued", () => {
      const task = createTaskInState(engine, TaskStates.queued, null);
      expect(engine.checkPermission(task.id, ActionClasses.write).allowed).toBe(false);
    });

    it("allows all 8 permitted actions in active.working", () => {
      const task = createTaskInState(engine, TaskStates.active, SubStates.working);
      const permitted: ActionClass[] = [
        ActionClasses.read,
        ActionClasses.write,
        ActionClasses.test,
        ActionClasses.git_local,
        ActionClasses.git_remote,
        ActionClasses.communicate,
        ActionClasses.task_manage,
        ActionClasses.ask_human,
      ];
      for (const action of permitted) {
        expect(
          engine.checkPermission(task.id, action).allowed,
          `Expected ${action} to be allowed in active.working`,
        ).toBe(true);
      }
    });

    it("denies merge and deploy in active.working", () => {
      const task = createTaskInState(engine, TaskStates.active, SubStates.working);
      expect(engine.checkPermission(task.id, ActionClasses.merge).allowed).toBe(false);
      expect(engine.checkPermission(task.id, ActionClasses.deploy).allowed).toBe(false);
    });

    it("allows read, communicate, ask_human in blocked", () => {
      const task = createTaskInState(engine, TaskStates.blocked, null);
      expect(engine.checkPermission(task.id, ActionClasses.read).allowed).toBe(true);
      expect(engine.checkPermission(task.id, ActionClasses.communicate).allowed).toBe(true);
      expect(engine.checkPermission(task.id, ActionClasses.ask_human).allowed).toBe(true);
      expect(engine.checkPermission(task.id, ActionClasses.write).allowed).toBe(false);
    });

    it("allows nothing in completed", () => {
      const task = createTaskInState(engine, TaskStates.completed, null);
      const allActions: ActionClass[] = [
        ActionClasses.read,
        ActionClasses.write,
        ActionClasses.test,
        ActionClasses.git_local,
        ActionClasses.git_remote,
        ActionClasses.communicate,
        ActionClasses.merge,
        ActionClasses.deploy,
        ActionClasses.task_manage,
        ActionClasses.ask_human,
      ];
      for (const action of allActions) {
        expect(engine.checkPermission(task.id, action).allowed, `Expected ${action} to be denied in completed`).toBe(
          false,
        );
      }
    });

    it("allows only communicate in failed", () => {
      const task = createTaskInState(engine, TaskStates.failed, null);
      expect(engine.checkPermission(task.id, ActionClasses.communicate).allowed).toBe(true);
      expect(engine.checkPermission(task.id, ActionClasses.read).allowed).toBe(false);
      expect(engine.checkPermission(task.id, ActionClasses.write).allowed).toBe(false);
    });

    it("returns failure for non-existent task", () => {
      const result = engine.checkPermission("nonexistent", ActionClasses.read);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Task not found");
    });
  });

  // ── getTask ────────────────────────────────────────────────────────────────

  describe("getTask", () => {
    it("returns full task object with correctly parsed JSON fields", () => {
      const task = engine.createTask(
        makeInput({
          external_ref: { type: "test_issue", repo: "owner/repo", id: "7" },
          acceptance_criteria: ["test1", "test2"],
        }),
      );
      const retrieved = assertDefined(engine.getTask(task.id), "task");
      expect(retrieved.external_ref).toEqual({
        type: "test_issue",
        repo: "owner/repo",
        id: "7",
      });
      expect(retrieved.acceptance_criteria).toEqual(["test1", "test2"]);
      expect(Array.isArray(retrieved.team)).toBe(true);
    });

    it("returns null for non-existent task", () => {
      expect(engine.getTask("nonexistent")).toBeNull();
    });

    it("round-trips all fields correctly", () => {
      const task = engine.createTask(
        makeInput({
          title: "Round trip test",
          description: "desc",
          source_text: "source",
          acceptance_criteria: ["ac1"],
          priority: 80,
          external_ref: { type: "jira", repo: "org/proj", id: "99" },
        }),
      );
      const retrieved = assertDefined(engine.getTask(task.id), "task");
      expect(retrieved.title).toBe("Round trip test");
      expect(retrieved.description).toBe("desc");
      expect(retrieved.source_text).toBe("source");
      expect(retrieved.acceptance_criteria).toEqual(["ac1"]);
      expect(retrieved.priority).toBe(80);
      expect(retrieved.external_ref).toEqual({ type: "jira", repo: "org/proj", id: "99" });
      expect(retrieved.created_at).toBe(task.created_at);
      expect(retrieved.last_transition_at).toBe(task.last_transition_at);
    });

    it("returns correct scalar types", () => {
      const task = engine.createTask(makeInput());
      const retrieved = assertDefined(engine.getTask(task.id), "task");
      expect(typeof retrieved.id).toBe("string");
      expect(typeof retrieved.priority).toBe("number");
      expect(typeof retrieved.agent_tokens).toBe("number");
      expect(typeof retrieved.agent_cost_usd).toBe("number");
      expect(typeof retrieved.compute_time_ms).toBe("number");
      expect(typeof retrieved.created_at).toBe("string");
    });
  });

  // ── getTasksByState ────────────────────────────────────────────────────────

  describe("getTasksByState", () => {
    it("returns tasks filtered by state", () => {
      const t1 = engine.createTask(makeInput({ title: "Task 1" }));
      engine.createTask(makeInput({ title: "Task 2" }));
      engine.requestTransition(t1.id, TaskStates.queued, null, "validated", "test");

      const intakeTasks = engine.getTasksByState(TaskStates.requirements_gathering);
      const queuedTasks = engine.getTasksByState(TaskStates.queued);
      expect(intakeTasks).toHaveLength(1);
      expect(intakeTasks[0]!.title).toBe("Task 2");
      expect(queuedTasks).toHaveLength(1);
      expect(queuedTasks[0]!.title).toBe("Task 1");
    });

    it("returns empty array when no tasks in state", () => {
      expect(engine.getTasksByState(TaskStates.completed)).toEqual([]);
    });

    it("returns tasks ordered by priority DESC, created_at ASC", () => {
      engine.createTask(makeInput({ title: "Low", priority: 20 }));
      engine.createTask(makeInput({ title: "High", priority: 90 }));
      engine.createTask(makeInput({ title: "Mid", priority: 50 }));

      const tasks = engine.getTasksByState(TaskStates.requirements_gathering);
      expect(tasks[0]!.title).toBe("High");
      expect(tasks[1]!.title).toBe("Mid");
      expect(tasks[2]!.title).toBe("Low");
    });

    it("returns multiple tasks in same state", () => {
      engine.createTask(makeInput({ title: "A" }));
      engine.createTask(makeInput({ title: "B" }));
      engine.createTask(makeInput({ title: "C" }));
      expect(engine.getTasksByState(TaskStates.requirements_gathering)).toHaveLength(3);
    });
  });

  // ── getQueuedByPriority ────────────────────────────────────────────────────

  describe("getQueuedByPriority", () => {
    it("returns only queued tasks", () => {
      engine.createTask(makeInput({ title: "Intake task" }));
      const t2 = engine.createTask(makeInput({ title: "Queued task" }));
      engine.requestTransition(t2.id, TaskStates.queued, null, "validated", "test");

      const queued = engine.getQueuedByPriority();
      expect(queued).toHaveLength(1);
      expect(queued[0]!.title).toBe("Queued task");
    });

    it("orders by priority DESC", () => {
      const low = engine.createTask(makeInput({ title: "Low", priority: 20 }));
      const high = engine.createTask(makeInput({ title: "High", priority: 90 }));
      engine.requestTransition(low.id, TaskStates.queued, null, "validated", "test");
      engine.requestTransition(high.id, TaskStates.queued, null, "validated", "test");

      const queued = engine.getQueuedByPriority();
      expect(queued[0]!.title).toBe("High");
      expect(queued[1]!.title).toBe("Low");
    });

    it("breaks priority ties by created_at ASC (oldest first)", () => {
      const first = engine.createTask(makeInput({ title: "First", priority: 50 }));
      const second = engine.createTask(makeInput({ title: "Second", priority: 50 }));
      engine.requestTransition(first.id, TaskStates.queued, null, "validated", "test");
      engine.requestTransition(second.id, TaskStates.queued, null, "validated", "test");

      const queued = engine.getQueuedByPriority();
      expect(queued[0]!.title).toBe("First");
      expect(queued[1]!.title).toBe("Second");
    });

    it("returns empty when no queued tasks", () => {
      engine.createTask(makeInput());
      expect(engine.getQueuedByPriority()).toEqual([]);
    });
  });

  // ── getStateHistory ────────────────────────────────────────────────────────

  describe("getStateHistory", () => {
    it("returns all transitions for a task", () => {
      const task = engine.createTask(makeInput());
      engine.requestTransition(task.id, TaskStates.queued, null, "validated", "daemon");
      engine.requestTransition(task.id, TaskStates.active, SubStates.working, "scheduled", "daemon");

      const history = engine.getStateHistory(task.id);
      expect(history).toHaveLength(2);
      expect(history[0]!.from_state).toBe(TaskStates.requirements_gathering);
      expect(history[0]!.to_state).toBe(TaskStates.queued);
      expect(history[1]!.from_state).toBe(TaskStates.queued);
      expect(history[1]!.to_state).toBe(TaskStates.active);
      expect(history[1]!.to_sub).toBe(SubStates.working);
    });

    it("returns transitions ordered by timestamp", () => {
      const task = engine.createTask(makeInput());
      engine.requestTransition(task.id, TaskStates.queued, null, "validated", "daemon");
      engine.requestTransition(task.id, TaskStates.active, SubStates.working, "scheduled", "daemon");

      const history = engine.getStateHistory(task.id);
      expect(
        history[0]?.timestamp !== undefined &&
          history[1]?.timestamp !== undefined &&
          history[0].timestamp <= history[1].timestamp,
      ).toBe(true);
    });

    it("returns empty array for task with no transitions", () => {
      const task = engine.createTask(makeInput());
      expect(engine.getStateHistory(task.id)).toEqual([]);
    });
  });

  // ── updateTaskField ──────────────────────────────────────────────────────

  describe("updateTaskField", () => {
    it("updates phase field", () => {
      const task = engine.createTask(makeInput());
      engine.updateTaskField(task.id, "phase", Phases.research);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.phase).toBe(Phases.research);
    });

    it("updates workspace with JSON serialization", () => {
      const task = engine.createTask(makeInput());
      const workspace = { repo: "owner/repo", branch: "engineer/task-1", worktree_path: null };
      engine.updateTaskField(task.id, "workspace", workspace);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.workspace).toEqual(workspace);
    });

    it("updates review with JSON serialization", () => {
      const task = engine.createTask(makeInput());
      const review = {
        pr_number: 42,
        pr_state: "ready" as const,
        demo_artifacts: [],
        feedback_rounds: [],
      };
      engine.updateTaskField(task.id, "review", review);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.review).toEqual(review);
    });

    it("updates blocked with JSON serialization", () => {
      const task = engine.createTask(makeInput());
      const blocked = {
        reason: "Need design approval",
        efforts_made: ["Checked docs", "Asked in channel"],
        contacted: [{ person: "farzam", channel: "telegram", timestamp: new Date().toISOString() }],
        needed: "Design decision on API shape",
        waiting_for: "farzam",
      };
      engine.updateTaskField(task.id, "blocked", blocked);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.blocked).toEqual(blocked);
    });

    it("does not affect other fields", () => {
      const task = engine.createTask(makeInput({ title: "Original", priority: 75 }));
      engine.updateTaskField(task.id, "phase", Phases.execution);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.title).toBe("Original");
      expect(updated.priority).toBe(75);
      expect(updated.state).toBe(TaskStates.requirements_gathering);
    });

    it("coerces boolean values to integers for SQLite", () => {
      const task = engine.createTask(makeInput());
      // better-sqlite3 rejects JS booleans — updateTaskField must coerce to 0/1
      engine.updateTaskField(task.id, "skip_research", true);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.skip_research).toBe(true); // rowToTask converts INTEGER back to boolean

      engine.updateTaskField(task.id, "skip_research", false);
      const updated2 = assertDefined(engine.getTask(task.id), "task");
      expect(updated2.skip_research).toBe(false);
    });

    it("warns on non-existent task", () => {
      const observer = createTestObserverFacade("task-engine");
      const warnSpy = vi.spyOn(observer, "warn");
      const tmpDb = createInMemoryDatabase();
      const tmpBus = new EventBus(tmpDb.db, { observer });
      const observedEngine = new TaskEngine(tmpDb.db, tmpBus, observer);
      observedEngine.updateTaskField("nonexistent", "phase", Phases.research);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("task not found"),
        expect.objectContaining({ taskId: "nonexistent" }),
      );
      tmpDb.db.close();
    });
  });

  // ── updateTracking ────────────────────────────────────────────────────────

  describe("updateTracking", () => {
    it("increments all three cost fields", () => {
      const task = engine.createTask(makeInput());
      engine.updateTracking(task.id, 1000, 0.05, 500);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.agent_tokens).toBe(1000);
      expect(updated.agent_cost_usd).toBeCloseTo(0.05);
      expect(updated.compute_time_ms).toBe(500);
    });

    it("accumulates across multiple increments", () => {
      const task = engine.createTask(makeInput());
      engine.updateTracking(task.id, 1000, 0.05, 500);
      engine.updateTracking(task.id, 2000, 0.1, 300);
      engine.updateTracking(task.id, 500, 0.02, 200);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.agent_tokens).toBe(3500);
      expect(updated.agent_cost_usd).toBeCloseTo(0.17);
      expect(updated.compute_time_ms).toBe(1000);
    });

    it("handles zero increment as no-op", () => {
      const task = engine.createTask(makeInput());
      engine.updateTracking(task.id, 0, 0, 0);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.agent_tokens).toBe(0);
      expect(updated.agent_cost_usd).toBe(0);
      expect(updated.compute_time_ms).toBe(0);
    });

    it("warns on non-existent task", () => {
      const observer = createTestObserverFacade("task-engine");
      const warnSpy = vi.spyOn(observer, "warn");
      const tmpDb = createInMemoryDatabase();
      const tmpBus = new EventBus(tmpDb.db, { observer });
      const observedEngine = new TaskEngine(tmpDb.db, tmpBus, observer);
      observedEngine.updateTracking("nonexistent", 100, 0.01, 50);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("task not found"),
        expect.objectContaining({ taskId: "nonexistent" }),
      );
      tmpDb.db.close();
    });
  });
});
