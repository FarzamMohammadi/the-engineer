import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskQueries } from "../../../../src/core/task-engine/queries.js";
import { SubStates, TaskStates } from "../../../../src/schemas/task.js";
import { createTestDatabase } from "../../../helpers/test-database.js";
import type { TestDatabaseHandle } from "../../../helpers/test-database.js";

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
        id, external_ref, idempotency_key, state, sub_state, phase,
        title, description, source_text, acceptance_criteria,
        team, related, decisions,
        repo, clone_url, workspace, review, blocked,
        priority, agent_tokens, agent_cost_usd, compute_time_ms,
        created_at, started_at, completed_at, last_transition_at,
        session_id, version
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )`,
      )
      .run(
        id,
        (overrides["external_ref"] as string) ?? null,
        (overrides["idempotency_key"] as string) ?? `test:${id}`,
        (overrides["state"] as string) ?? TaskStates.requirements_gathering,
        (overrides["sub_state"] as string) ?? null,
        (overrides["phase"] as string) ?? null,
        (overrides["title"] as string) ?? `Task ${id}`,
        "",
        "",
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
      .run(ulid(), taskId, fromState, toState, null, null, "test", new Date().toISOString(), "test");
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
      expect(task?.acceptance_criteria).toEqual([]);
    });
  });

  describe("getUnreapedTerminalTasks", () => {
    function setColumn(taskId: string, column: "reaped_at" | "completed_at", value: string): void {
      dbHandle.db.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ?`).run(value, taskId);
    }

    it("returns completed and cancelled tasks that are not yet reaped", () => {
      const completed = insertTask({ state: TaskStates.completed });
      const cancelled = insertTask({ state: TaskStates.cancelled });

      const ids = queries.getUnreapedTerminalTasks().map((t) => t.id);
      expect(ids).toContain(completed);
      expect(ids).toContain(cancelled);
      expect(ids).toHaveLength(2);
    });

    it("never returns failed tasks — they are preserved for debugging and retry", () => {
      insertTask({ state: TaskStates.failed });
      expect(queries.getUnreapedTerminalTasks()).toEqual([]);
    });

    it("excludes non-terminal tasks", () => {
      insertTask({ state: TaskStates.queued });
      insertTask({ state: TaskStates.active, sub_state: SubStates.working });
      insertTask({ state: TaskStates.blocked });
      insertTask({ state: TaskStates.requirements_gathering });
      expect(queries.getUnreapedTerminalTasks()).toEqual([]);
    });

    it("excludes tasks that have already been reaped", () => {
      const reaped = insertTask({ state: TaskStates.completed });
      const unreaped = insertTask({ state: TaskStates.completed });
      setColumn(reaped, "reaped_at", new Date().toISOString());

      const ids = queries.getUnreapedTerminalTasks().map((t) => t.id);
      expect(ids).toEqual([unreaped]);
    });

    it("orders by completed_at ascending (oldest finished first)", () => {
      const newer = insertTask({ state: TaskStates.completed });
      const older = insertTask({ state: TaskStates.completed });
      setColumn(newer, "completed_at", "2026-02-01T00:00:00.000Z");
      setColumn(older, "completed_at", "2026-01-01T00:00:00.000Z");

      const ids = queries.getUnreapedTerminalTasks().map((t) => t.id);
      expect(ids).toEqual([older, newer]);
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

  describe("findByIdempotencyKey", () => {
    it("returns false when no task has the key", () => {
      expect(queries.findByIdempotencyKey("never:seen")).toBe(false);
    });

    it("returns true for a non-terminal task with the key", () => {
      insertTask({ idempotency_key: "github:issue:owner/repo:42", state: TaskStates.queued });
      expect(queries.findByIdempotencyKey("github:issue:owner/repo:42")).toBe(true);
    });

    it("ignores completed and failed tasks (active-scoped)", () => {
      insertTask({ idempotency_key: "done:key", state: TaskStates.completed });
      insertTask({ idempotency_key: "dead:key", state: TaskStates.failed });
      expect(queries.findByIdempotencyKey("done:key")).toBe(false);
      expect(queries.findByIdempotencyKey("dead:key")).toBe(false);
    });
  });
});
