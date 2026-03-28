import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import {
  type TestTaskEngineHandle,
  createTestTaskEngine,
} from "../../../test/helpers/test-task-engine.js";
import { createInMemoryDatabase } from "../../db/database.js";
import type { ActionClass, SubState, Task, TaskState } from "../../schemas/task.js";
import { ValidTransitions } from "../../schemas/task.js";
import { EventBus } from "../event-bus/index.js";
import type { CreateTaskInput } from "./index.js";
import { TaskEngine, isValidTransition } from "./index.js";

// ── Constants ──────────────────────────────────────────────────────────────────

const ULID_PATTERN = /^[0-9A-Z]{26}$/;

// ── Helpers ────────────────────────────────────────────────────────────────────

function assertDefined<T>(value: T | null | undefined, label = "value"): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${label} to be defined, got ${String(value)}`);
  }
  return value;
}

function makeInput(overrides?: Partial<CreateTaskInput>): CreateTaskInput {
  return {
    title: "Test task",
    repo: "owner/test-repo",
    source: "test",
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

/** Get the shortest path of transitions from intake to a target state. */
function getPathToState(state: TaskState, subState: SubState | null): TransitionStep[] {
  if (state === "intake") {
    return [];
  }
  if (state === "queued") {
    return [{ state: "queued", sub: null, reason: "validated" }];
  }

  const base: TransitionStep[] = [{ state: "queued", sub: null, reason: "validated" }];

  if (state === "active" && subState === "working") {
    return [...base, { state: "active", sub: "working", reason: "scheduled" }];
  }
  if (state === "active" && subState === "supervising") {
    return [
      ...base,
      { state: "active", sub: "working", reason: "scheduled" },
      { state: "active", sub: "supervising", reason: "children created" },
    ];
  }
  if (state === "active" && subState === "integrating") {
    return [
      ...base,
      { state: "active", sub: "working", reason: "scheduled" },
      { state: "active", sub: "supervising", reason: "children created" },
      { state: "active", sub: "integrating", reason: "all children done" },
    ];
  }
  if (state === "blocked") {
    return [
      ...base,
      { state: "active", sub: "working", reason: "scheduled" },
      { state: "blocked", sub: null, reason: "needs human input" },
    ];
  }
  if (state === "review_pending" && subState === "demo") {
    return [
      ...base,
      { state: "active", sub: "working", reason: "scheduled" },
      { state: "review_pending", sub: "demo", reason: "draft PR opened" },
    ];
  }
  if (state === "review_pending" && subState === "code") {
    return [
      ...base,
      { state: "active", sub: "working", reason: "scheduled" },
      { state: "review_pending", sub: "code", reason: "PR ready" },
    ];
  }
  if (state === "completed") {
    return [
      ...base,
      { state: "active", sub: "working", reason: "scheduled" },
      { state: "completed", sub: null, reason: "done" },
    ];
  }
  if (state === "failed") {
    return [
      ...base,
      { state: "active", sub: "working", reason: "scheduled" },
      { state: "failed", sub: null, reason: "unrecoverable error" },
    ];
  }

  throw new Error(`No path defined for state ${state}.${subState}`);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("isValidTransition", () => {
  it("accepts intake to queued", () => {
    expect(isValidTransition("intake", null, "queued", null)).toBe(true);
  });

  it("accepts intake to failed", () => {
    expect(isValidTransition("intake", null, "failed", null)).toBe(true);
  });

  it("accepts queued to active.working", () => {
    expect(isValidTransition("queued", null, "active", "working")).toBe(true);
  });

  it("accepts active.working to active.supervising", () => {
    expect(isValidTransition("active", "working", "active", "supervising")).toBe(true);
  });

  it("rejects intake to active (no such transition)", () => {
    expect(isValidTransition("intake", null, "active", "working")).toBe(false);
  });

  it("rejects active.integrating to active.supervising (not in table)", () => {
    expect(isValidTransition("active", "integrating", "active", "supervising")).toBe(false);
  });

  it("rejects when from_sub is wrong", () => {
    // active.supervising -> review_pending.demo is NOT valid (only active.working can)
    expect(isValidTransition("active", "supervising", "review_pending", "demo")).toBe(false);
  });

  it("rejects when to_sub is wrong", () => {
    // queued -> active.supervising is NOT valid (must go to active.working)
    expect(isValidTransition("queued", null, "active", "supervising")).toBe(false);
  });

  it("rejects completed to anything", () => {
    expect(isValidTransition("completed", null, "active", "working")).toBe(false);
    expect(isValidTransition("completed", null, "queued", null)).toBe(false);
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
    it("creates a task in intake state", () => {
      const task = engine.createTask(makeInput());
      expect(task.state).toBe("intake");
      expect(task.sub_state).toBeNull();
    });

    it("generates a ULID for the task id", () => {
      const task = engine.createTask(makeInput());
      expect(task.id).toMatch(ULID_PATTERN);
    });

    it("sets correct default values", () => {
      const task = engine.createTask(makeInput());
      expect(task.priority).toBe(50);
      expect(task.cascade_policy).toBe("pause_siblings");
      expect(task.children).toEqual([]);
      expect(task.team).toEqual([]);
      expect(task.related).toEqual([]);
      expect(task.decisions).toEqual([]);
      expect(task.child_summaries).toEqual([]);
      expect(task.acceptance_criteria).toEqual([]);
      expect(task.description).toBe("");
      expect(task.source_text).toBe("");
      expect(task.external_ref).toBeNull();
      expect(task.workspace).toBeNull();
      expect(task.review).toBeNull();
      expect(task.blocked).toBeNull();
      expect(task.parent_id).toBeNull();
      expect(task.phase).toBeNull();
      expect(task.session_id).toBeNull();
      expect(task.started_at).toBeNull();
      expect(task.completed_at).toBeNull();
      expect(task.llm_tokens).toBe(0);
      expect(task.llm_cost_usd).toBe(0);
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
      const task = engine.createTask(makeInput({ priority: 75 }));
      handle.assertEventEmitted("task.created", (payload) => {
        const p = payload as Record<string, unknown>;
        return (
          p["task_id"] === task.id &&
          p["title"] === "Test task" &&
          p["repo"] === "owner/test-repo" &&
          p["source"] === "test" &&
          p["priority"] === 75 &&
          p["parent_id"] === null
        );
      });
    });

    it("does not emit task.state_changed event", () => {
      engine.createTask(makeInput());
      const stateChangedEvents = handle.getEmittedEvents("task.state_changed");
      expect(stateChangedEvents).toHaveLength(0);
    });

    it("accepts optional fields", () => {
      const task = engine.createTask(
        makeInput({
          description: "A detailed description",
          source_text: "Original issue body",
          acceptance_criteria: ["Must pass all tests", "Must have docs"],
          priority: 80,
          cascade_policy: "fail_fast",
        }),
      );
      expect(task.description).toBe("A detailed description");
      expect(task.source_text).toBe("Original issue body");
      expect(task.acceptance_criteria).toEqual(["Must pass all tests", "Must have docs"]);
      expect(task.priority).toBe(80);
      expect(task.cascade_policy).toBe("fail_fast");
    });

    it("accepts external_ref", () => {
      const task = engine.createTask(
        makeInput({
          external_ref: { type: "test_issue", repo: "owner/repo", id: "42" },
        }),
      );
      expect(task.external_ref).toEqual({ type: "test_issue", repo: "owner/repo", id: "42" });
    });

    it("accepts parent_id", () => {
      const parent = engine.createTask(makeInput({ title: "Parent task" }));
      const child = engine.createTask(makeInput({ title: "Child task", parent_id: parent.id }));
      expect(child.parent_id).toBe(parent.id);
    });
  });

  // ── requestTransition — valid transitions ─────────────────────────────────

  describe("requestTransition — valid transitions", () => {
    it("transitions intake to queued", () => {
      const task = engine.createTask(makeInput());
      const result = engine.requestTransition(task.id, "queued", null, "validated", "daemon");
      expect(result).toEqual({ success: true });
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.state).toBe("queued");
      expect(updated.sub_state).toBeNull();
    });

    it("transitions queued to active.working", () => {
      const task = createTaskInState(engine, "queued", null);
      const result = engine.requestTransition(task.id, "active", "working", "scheduled", "daemon");
      expect(result.success).toBe(true);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.state).toBe("active");
      expect(updated.sub_state).toBe("working");
    });

    it("updates last_transition_at timestamp", () => {
      const task = engine.createTask(makeInput());
      engine.requestTransition(task.id, "queued", null, "validated", "daemon");
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.last_transition_at).toBeDefined();
      // Timestamps might be the same if fast enough, but should be valid ISO
      expect(new Date(updated.last_transition_at).toISOString()).toBe(updated.last_transition_at);
    });

    it("sets started_at on first transition to active", () => {
      const task = createTaskInState(engine, "queued", null);
      expect(assertDefined(engine.getTask(task.id), "task").started_at).toBeNull();
      engine.requestTransition(task.id, "active", "working", "scheduled", "daemon");
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.started_at).not.toBeNull();
    });

    it("does not overwrite started_at on subsequent active transitions", () => {
      const task = createTaskInState(engine, "active", "working");
      const firstStarted = assertDefined(engine.getTask(task.id), "task").started_at;
      // Go blocked and back to active
      engine.requestTransition(task.id, "blocked", null, "needs input", "orchestrator");
      engine.requestTransition(task.id, "active", "working", "unblocked", "daemon");
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.started_at).toBe(firstStarted);
    });

    it("sets completed_at on transition to completed", () => {
      const task = createTaskInState(engine, "active", "working");
      engine.requestTransition(task.id, "completed", null, "done", "orchestrator");
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.completed_at).not.toBeNull();
    });

    it("sets completed_at on transition to failed", () => {
      const task = createTaskInState(engine, "active", "working");
      engine.requestTransition(task.id, "failed", null, "unrecoverable", "orchestrator");
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.completed_at).not.toBeNull();
    });

    it("records transition in state_transitions table", () => {
      const task = engine.createTask(makeInput());
      engine.requestTransition(task.id, "queued", null, "validated", "daemon");
      const history = engine.getStateHistory(task.id);
      expect(history).toHaveLength(1);
      expect(history[0]!.from_state).toBe("intake");
      expect(history[0]!.to_state).toBe("queued");
      expect(history[0]!.from_sub).toBeNull();
      expect(history[0]!.to_sub).toBeNull();
      expect(history[0]!.reason).toBe("validated");
      expect(history[0]!.triggered_by).toBe("daemon");
    });

    it("emits task.state_changed event with correct payload", () => {
      const task = engine.createTask(makeInput());
      engine.requestTransition(task.id, "queued", null, "validated", "daemon");
      handle.assertEventEmitted("task.state_changed", (payload) => {
        const p = payload as Record<string, unknown>;
        return (
          p["task_id"] === task.id &&
          p["from_state"] === "intake" &&
          p["from_sub"] === null &&
          p["to_state"] === "queued" &&
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

        const result = engine.requestTransition(
          task.id,
          entry.to,
          toSub,
          "test transition",
          "test",
        );
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
      const result = engine.requestTransition(task.id, "active", "working", "invalid", "test");
      expect(result.success).toBe(false);
      expect(result.reason).toContain("Invalid transition");
      expect(result.reason).toContain("intake");
      expect(result.reason).toContain("active.working");
    });

    it("rejects transition from completed", () => {
      const task = createTaskInState(engine, "completed", null);
      const result = engine.requestTransition(task.id, "active", "working", "retry", "test");
      expect(result.success).toBe(false);
    });

    it("rejects transition from failed to active", () => {
      const task = createTaskInState(engine, "failed", null);
      const result = engine.requestTransition(task.id, "active", "working", "retry", "test");
      expect(result.success).toBe(false);
    });

    it("rejects wrong from_sub", () => {
      // active.supervising → review_pending.demo is NOT valid
      const task = createTaskInState(engine, "active", "supervising");
      const result = engine.requestTransition(task.id, "review_pending", "demo", "test", "test");
      expect(result.success).toBe(false);
    });

    it("rejects wrong to_sub", () => {
      // queued → active.supervising is NOT valid (must be active.working)
      const task = createTaskInState(engine, "queued", null);
      const result = engine.requestTransition(task.id, "active", "supervising", "test", "test");
      expect(result.success).toBe(false);
    });

    it("returns failure for non-existent task", () => {
      const result = engine.requestTransition("nonexistent", "queued", null, "test", "test");
      expect(result.success).toBe(false);
      expect(result.reason).toBe("Task not found");
    });

    it("does not modify DB on rejection", () => {
      const task = engine.createTask(makeInput());
      engine.requestTransition(task.id, "active", "working", "invalid", "test");
      const unchanged = assertDefined(engine.getTask(task.id), "task");
      expect(unchanged.state).toBe("intake");
      expect(unchanged.sub_state).toBeNull();
    });

    it("does not emit events on rejection", () => {
      const task = engine.createTask(makeInput());
      const eventsBefore = handle.getEmittedEvents("task.state_changed").length;
      engine.requestTransition(task.id, "active", "working", "invalid", "test");
      const eventsAfter = handle.getEmittedEvents("task.state_changed").length;
      expect(eventsAfter).toBe(eventsBefore);
    });
  });

  // ── checkPermission ──────────────────────────────────────────────────────

  describe("checkPermission", () => {
    it("allows read in intake", () => {
      const task = engine.createTask(makeInput());
      expect(engine.checkPermission(task.id, "read")).toEqual({ allowed: true });
    });

    it("denies write in intake", () => {
      const task = engine.createTask(makeInput());
      const result = engine.checkPermission(task.id, "write");
      expect(result.allowed).toBe(false);
    });

    it("allows read in queued", () => {
      const task = createTaskInState(engine, "queued", null);
      expect(engine.checkPermission(task.id, "read")).toEqual({ allowed: true });
    });

    it("denies write in queued", () => {
      const task = createTaskInState(engine, "queued", null);
      expect(engine.checkPermission(task.id, "write").allowed).toBe(false);
    });

    it("allows all 8 permitted actions in active.working", () => {
      const task = createTaskInState(engine, "active", "working");
      const permitted: ActionClass[] = [
        "read",
        "write",
        "test",
        "git_local",
        "git_remote",
        "communicate",
        "task_manage",
        "ask_human",
      ];
      for (const action of permitted) {
        expect(
          engine.checkPermission(task.id, action).allowed,
          `Expected ${action} to be allowed in active.working`,
        ).toBe(true);
      }
    });

    it("denies merge and deploy in active.working", () => {
      const task = createTaskInState(engine, "active", "working");
      expect(engine.checkPermission(task.id, "merge").allowed).toBe(false);
      expect(engine.checkPermission(task.id, "deploy").allowed).toBe(false);
    });

    it("allows only read, communicate, task_manage, ask_human in active.supervising", () => {
      const task = createTaskInState(engine, "active", "supervising");
      expect(engine.checkPermission(task.id, "read").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "communicate").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "task_manage").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "ask_human").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "write").allowed).toBe(false);
      expect(engine.checkPermission(task.id, "test").allowed).toBe(false);
      expect(engine.checkPermission(task.id, "git_local").allowed).toBe(false);
    });

    it("allows write/test/git in active.integrating but denies merge", () => {
      const task = createTaskInState(engine, "active", "integrating");
      expect(engine.checkPermission(task.id, "write").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "test").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "git_local").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "git_remote").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "merge").allowed).toBe(false);
      expect(engine.checkPermission(task.id, "deploy").allowed).toBe(false);
      expect(engine.checkPermission(task.id, "task_manage").allowed).toBe(false);
    });

    it("allows only read and communicate in review_pending.demo", () => {
      const task = createTaskInState(engine, "review_pending", "demo");
      expect(engine.checkPermission(task.id, "read").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "communicate").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "write").allowed).toBe(false);
      expect(engine.checkPermission(task.id, "ask_human").allowed).toBe(false);
    });

    it("returns conditional for merge in review_pending.code", () => {
      const task = createTaskInState(engine, "review_pending", "code");
      expect(engine.checkPermission(task.id, "read").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "communicate").allowed).toBe(true);
      const mergeResult = engine.checkPermission(task.id, "merge");
      expect(mergeResult.allowed).toBe(true);
      expect(mergeResult.conditional).toBe("auto_merge_after_approval configured for repo");
    });

    it("allows read, communicate, ask_human in blocked", () => {
      const task = createTaskInState(engine, "blocked", null);
      expect(engine.checkPermission(task.id, "read").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "communicate").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "ask_human").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "write").allowed).toBe(false);
    });

    it("allows nothing in completed", () => {
      const task = createTaskInState(engine, "completed", null);
      const allActions: ActionClass[] = [
        "read",
        "write",
        "test",
        "git_local",
        "git_remote",
        "communicate",
        "merge",
        "deploy",
        "task_manage",
        "ask_human",
      ];
      for (const action of allActions) {
        expect(
          engine.checkPermission(task.id, action).allowed,
          `Expected ${action} to be denied in completed`,
        ).toBe(false);
      }
    });

    it("allows only communicate in failed", () => {
      const task = createTaskInState(engine, "failed", null);
      expect(engine.checkPermission(task.id, "communicate").allowed).toBe(true);
      expect(engine.checkPermission(task.id, "read").allowed).toBe(false);
      expect(engine.checkPermission(task.id, "write").allowed).toBe(false);
    });

    it("returns failure for non-existent task", () => {
      const result = engine.checkPermission("nonexistent", "read");
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
      expect(retrieved.children).toEqual([]);
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
          cascade_policy: "best_effort",
          external_ref: { type: "jira", repo: "org/proj", id: "99" },
        }),
      );
      const retrieved = assertDefined(engine.getTask(task.id), "task");
      expect(retrieved.title).toBe("Round trip test");
      expect(retrieved.description).toBe("desc");
      expect(retrieved.source_text).toBe("source");
      expect(retrieved.acceptance_criteria).toEqual(["ac1"]);
      expect(retrieved.priority).toBe(80);
      expect(retrieved.cascade_policy).toBe("best_effort");
      expect(retrieved.external_ref).toEqual({ type: "jira", repo: "org/proj", id: "99" });
      expect(retrieved.created_at).toBe(task.created_at);
      expect(retrieved.last_transition_at).toBe(task.last_transition_at);
    });

    it("returns correct scalar types", () => {
      const task = engine.createTask(makeInput());
      const retrieved = assertDefined(engine.getTask(task.id), "task");
      expect(typeof retrieved.id).toBe("string");
      expect(typeof retrieved.priority).toBe("number");
      expect(typeof retrieved.llm_tokens).toBe("number");
      expect(typeof retrieved.llm_cost_usd).toBe("number");
      expect(typeof retrieved.compute_time_ms).toBe("number");
      expect(typeof retrieved.created_at).toBe("string");
    });
  });

  // ── getTasksByState ────────────────────────────────────────────────────────

  describe("getTasksByState", () => {
    it("returns tasks filtered by state", () => {
      const t1 = engine.createTask(makeInput({ title: "Task 1" }));
      engine.createTask(makeInput({ title: "Task 2" }));
      engine.requestTransition(t1.id, "queued", null, "validated", "test");

      const intakeTasks = engine.getTasksByState("intake");
      const queuedTasks = engine.getTasksByState("queued");
      expect(intakeTasks).toHaveLength(1);
      expect(intakeTasks[0]!.title).toBe("Task 2");
      expect(queuedTasks).toHaveLength(1);
      expect(queuedTasks[0]!.title).toBe("Task 1");
    });

    it("returns empty array when no tasks in state", () => {
      expect(engine.getTasksByState("completed")).toEqual([]);
    });

    it("returns tasks ordered by priority DESC, created_at ASC", () => {
      engine.createTask(makeInput({ title: "Low", priority: 20 }));
      engine.createTask(makeInput({ title: "High", priority: 90 }));
      engine.createTask(makeInput({ title: "Mid", priority: 50 }));

      const tasks = engine.getTasksByState("intake");
      expect(tasks[0]!.title).toBe("High");
      expect(tasks[1]!.title).toBe("Mid");
      expect(tasks[2]!.title).toBe("Low");
    });

    it("returns multiple tasks in same state", () => {
      engine.createTask(makeInput({ title: "A" }));
      engine.createTask(makeInput({ title: "B" }));
      engine.createTask(makeInput({ title: "C" }));
      expect(engine.getTasksByState("intake")).toHaveLength(3);
    });
  });

  // ── getQueuedByPriority ────────────────────────────────────────────────────

  describe("getQueuedByPriority", () => {
    it("returns only queued tasks", () => {
      engine.createTask(makeInput({ title: "Intake task" }));
      const t2 = engine.createTask(makeInput({ title: "Queued task" }));
      engine.requestTransition(t2.id, "queued", null, "validated", "test");

      const queued = engine.getQueuedByPriority();
      expect(queued).toHaveLength(1);
      expect(queued[0]!.title).toBe("Queued task");
    });

    it("orders by priority DESC", () => {
      const low = engine.createTask(makeInput({ title: "Low", priority: 20 }));
      const high = engine.createTask(makeInput({ title: "High", priority: 90 }));
      engine.requestTransition(low.id, "queued", null, "validated", "test");
      engine.requestTransition(high.id, "queued", null, "validated", "test");

      const queued = engine.getQueuedByPriority();
      expect(queued[0]!.title).toBe("High");
      expect(queued[1]!.title).toBe("Low");
    });

    it("breaks priority ties by created_at ASC (oldest first)", () => {
      const first = engine.createTask(makeInput({ title: "First", priority: 50 }));
      const second = engine.createTask(makeInput({ title: "Second", priority: 50 }));
      engine.requestTransition(first.id, "queued", null, "validated", "test");
      engine.requestTransition(second.id, "queued", null, "validated", "test");

      const queued = engine.getQueuedByPriority();
      expect(queued[0]!.title).toBe("First");
      expect(queued[1]!.title).toBe("Second");
    });

    it("returns empty when no queued tasks", () => {
      engine.createTask(makeInput());
      expect(engine.getQueuedByPriority()).toEqual([]);
    });
  });

  // ── getChildren ────────────────────────────────────────────────────────────

  describe("getChildren", () => {
    it("returns children of a parent", () => {
      const parent = engine.createTask(makeInput({ title: "Parent" }));
      engine.createTask(makeInput({ title: "Child 1", parent_id: parent.id }));
      engine.createTask(makeInput({ title: "Child 2", parent_id: parent.id }));

      const children = engine.getChildren(parent.id);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.title)).toEqual(["Child 1", "Child 2"]);
    });

    it("returns empty array when no children", () => {
      const task = engine.createTask(makeInput());
      expect(engine.getChildren(task.id)).toEqual([]);
    });

    it("does not return grandchildren", () => {
      const grandparent = engine.createTask(makeInput({ title: "Grandparent" }));
      const parent = engine.createTask(makeInput({ title: "Parent", parent_id: grandparent.id }));
      engine.createTask(makeInput({ title: "Grandchild", parent_id: parent.id }));

      const children = engine.getChildren(grandparent.id);
      expect(children).toHaveLength(1);
      expect(children[0]!.title).toBe("Parent");
    });
  });

  // ── getStateHistory ────────────────────────────────────────────────────────

  describe("getStateHistory", () => {
    it("returns all transitions for a task", () => {
      const task = engine.createTask(makeInput());
      engine.requestTransition(task.id, "queued", null, "validated", "daemon");
      engine.requestTransition(task.id, "active", "working", "scheduled", "daemon");

      const history = engine.getStateHistory(task.id);
      expect(history).toHaveLength(2);
      expect(history[0]!.from_state).toBe("intake");
      expect(history[0]!.to_state).toBe("queued");
      expect(history[1]!.from_state).toBe("queued");
      expect(history[1]!.to_state).toBe("active");
      expect(history[1]!.to_sub).toBe("working");
    });

    it("returns transitions ordered by timestamp", () => {
      const task = engine.createTask(makeInput());
      engine.requestTransition(task.id, "queued", null, "validated", "daemon");
      engine.requestTransition(task.id, "active", "working", "scheduled", "daemon");

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
      engine.updateTaskField(task.id, "phase", "research");
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.phase).toBe("research");
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
        pr_state: "draft" as const,
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
      engine.updateTaskField(task.id, "phase", "execution");
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.title).toBe("Original");
      expect(updated.priority).toBe(75);
      expect(updated.state).toBe("intake");
    });

    it("warns on non-existent task", () => {
      const observer = createTestObserverFacade("task-engine");
      const warnSpy = vi.spyOn(observer, "warn");
      const tmpDb = createInMemoryDatabase();
      const tmpBus = new EventBus(tmpDb.db, { observer });
      const observedEngine = new TaskEngine(tmpDb.db, tmpBus, observer);
      observedEngine.updateTaskField("nonexistent", "phase", "research");
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
      expect(updated.llm_tokens).toBe(1000);
      expect(updated.llm_cost_usd).toBeCloseTo(0.05);
      expect(updated.compute_time_ms).toBe(500);
    });

    it("accumulates across multiple increments", () => {
      const task = engine.createTask(makeInput());
      engine.updateTracking(task.id, 1000, 0.05, 500);
      engine.updateTracking(task.id, 2000, 0.1, 300);
      engine.updateTracking(task.id, 500, 0.02, 200);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.llm_tokens).toBe(3500);
      expect(updated.llm_cost_usd).toBeCloseTo(0.17);
      expect(updated.compute_time_ms).toBe(1000);
    });

    it("handles zero increment as no-op", () => {
      const task = engine.createTask(makeInput());
      engine.updateTracking(task.id, 0, 0, 0);
      const updated = assertDefined(engine.getTask(task.id), "task");
      expect(updated.llm_tokens).toBe(0);
      expect(updated.llm_cost_usd).toBe(0);
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
