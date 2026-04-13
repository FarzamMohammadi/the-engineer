import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../../../test/helpers/test-database.js";
import type { TestDatabaseHandle } from "../../../test/helpers/test-database.js";
import { CascadePolicies, TaskStates } from "../../schemas/task.js";
import { TaskQueries } from "./queries.js";

describe("TaskQueries", () => {
  let dbHandle: TestDatabaseHandle;
  let queries: TaskQueries;

  beforeEach(() => {
    dbHandle = createTestDatabase();
    queries = new TaskQueries(dbHandle.db);
  });

  afterEach(() => {
    dbHandle.cleanup();
  });

  function insertTask(overrides: Record<string, unknown> = {}): string {
    const id = (overrides["id"] as string) ?? ulid();
    const now = new Date().toISOString();
    dbHandle.db
      .prepare(
        `INSERT INTO tasks (
        id, external_ref, state, sub_state, phase,
        parent_id, children, cascade_policy,
        title, description, source_text, acceptance_criteria,
        team, related, decisions, child_summaries,
        repo, clone_url, workspace, review, blocked,
        priority, llm_tokens, llm_cost_usd, compute_time_ms,
        created_at, started_at, completed_at, last_transition_at,
        session_id, version
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )`,
      )
      .run(
        id,
        (overrides["external_ref"] as string) ?? null,
        (overrides["state"] as string) ?? TaskStates.requirements_gathering,
        (overrides["sub_state"] as string) ?? null,
        (overrides["phase"] as string) ?? null,
        (overrides["parent_id"] as string) ?? null,
        "[]",
        CascadePolicies.pause_siblings,
        (overrides["title"] as string) ?? `Task ${id}`,
        "",
        "",
        "[]",
        "[]",
        "[]",
        "[]",
        "[]",
        (overrides["repo"] as string) ?? "test/repo",
        null,
        null,
        null,
        null,
        (overrides["priority"] as number) ?? 50,
        0,
        0,
        0,
        (overrides["created_at"] as string) ?? now,
        null,
        null,
        now,
        null,
        1,
      );
    return id;
  }

  function insertTransition(taskId: string, fromState: string, toState: string): void {
    dbHandle.db
      .prepare(
        `INSERT INTO state_transitions (id, task_id, from_state, to_state, from_sub, to_sub, reason, timestamp, triggered_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        taskId,
        fromState,
        toState,
        null,
        null,
        "test",
        new Date().toISOString(),
        "test",
      );
  }

  describe("getTask", () => {
    it("returns null for nonexistent task", () => {
      expect(queries.getTask("nonexistent")).toBeNull();
    });

    it("returns task with parsed JSON fields", () => {
      const id = insertTask({ title: "Test Task" });
      const task = queries.getTask(id);
      expect(task).not.toBeNull();
      expect(task?.id).toBe(id);
      expect(task?.title).toBe("Test Task");
      expect(task?.children).toEqual([]);
      expect(task?.acceptance_criteria).toEqual([]);
    });
  });

  describe("getTasksByState", () => {
    it("returns empty array when no tasks in state", () => {
      expect(queries.getTasksByState(TaskStates.queued)).toEqual([]);
    });

    it("returns tasks filtered by state", () => {
      insertTask({ state: TaskStates.requirements_gathering });
      insertTask({ state: TaskStates.queued });
      insertTask({ state: TaskStates.queued });

      const queued = queries.getTasksByState(TaskStates.queued);
      expect(queued).toHaveLength(2);
      for (const t of queued) {
        expect(t.state).toBe(TaskStates.queued);
      }
    });

    it("orders by priority DESC then created_at ASC", () => {
      const id1 = insertTask({
        state: TaskStates.queued,
        priority: 30,
        created_at: "2024-01-01T00:00:00.000Z",
      });
      const id2 = insertTask({
        state: TaskStates.queued,
        priority: 80,
        created_at: "2024-01-02T00:00:00.000Z",
      });
      const id3 = insertTask({
        state: TaskStates.queued,
        priority: 80,
        created_at: "2024-01-01T00:00:00.000Z",
      });

      const result = queries.getTasksByState(TaskStates.queued);
      expect(result.map((t) => t.id)).toEqual([id3, id2, id1]);
    });
  });

  describe("getQueuedByPriority", () => {
    it("returns only queued tasks", () => {
      insertTask({ state: TaskStates.requirements_gathering });
      insertTask({ state: TaskStates.queued });

      const result = queries.getQueuedByPriority();
      expect(result).toHaveLength(1);
      expect(result[0]?.state).toBe(TaskStates.queued);
    });
  });

  describe("getChildren", () => {
    it("returns children ordered by created_at", () => {
      const parentId = insertTask();
      const child1 = insertTask({
        parent_id: parentId,
        created_at: "2024-01-01T00:00:00.000Z",
      });
      const child2 = insertTask({
        parent_id: parentId,
        created_at: "2024-01-02T00:00:00.000Z",
      });
      insertTask(); // unrelated task

      const children = queries.getChildren(parentId);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.id)).toEqual([child1, child2]);
    });

    it("returns empty for tasks with no children", () => {
      const id = insertTask();
      expect(queries.getChildren(id)).toEqual([]);
    });
  });

  describe("getStateHistory", () => {
    it("returns transitions ordered by timestamp", () => {
      const id = insertTask();
      insertTransition(id, TaskStates.requirements_gathering, TaskStates.queued);
      insertTransition(id, TaskStates.queued, TaskStates.active);

      const history = queries.getStateHistory(id);
      expect(history).toHaveLength(2);
      expect(history[0]?.from_state).toBe(TaskStates.requirements_gathering);
      expect(history[1]?.from_state).toBe(TaskStates.queued);
    });

    it("returns empty for task with no transitions", () => {
      const id = insertTask();
      expect(queries.getStateHistory(id)).toEqual([]);
    });
  });
});
