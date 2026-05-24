import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";

import { SessionStore } from "../../../../src/core/session-memory/sessions.js";
import { SessionEndReasons } from "../../../../src/schemas/session-memory.js";
import { type TestDatabaseHandle, createTestDatabase } from "../../../helpers/test-database.js";

let testDb: TestDatabaseHandle;
let store: SessionStore;

function setup(): void {
  testDb = createTestDatabase();
  store = new SessionStore(testDb.db);
}

function insertTask(title?: string): string {
  const id = ulid();
  const now = new Date().toISOString();
  testDb.db
    .prepare(
      `INSERT INTO tasks (
      id, idempotency_key, state, title, description, source_text,
      acceptance_criteria, team, related, decisions,
      priority, llm_tokens, llm_cost_usd, compute_time_ms, created_at, last_transition_at
    ) VALUES (?, ?, 'requirements_gathering', ?, '', '', '[]', '[]', '[]', '[]', 50, 0, 0.0, 0, ?, ?)`,
    )
    .run(id, `test:${id}`, title ?? "Test task", now, now);
  return id;
}

afterEach(() => testDb.cleanup());

describe("SessionStore", () => {
  it("creates a session with correct fields", () => {
    setup();
    const taskId = insertTask();
    const session = store.create({ taskId });

    expect(session.id).toHaveLength(26);
    expect(session.task_id).toBe(taskId);
    expect(session.started_at).toBeTruthy();
    expect(session.ended_at).toBeNull();
    expect(session.end_reason).toBeNull();
  });

  it("ends a session with reason", () => {
    setup();
    const taskId = insertTask();
    const session = store.create({ taskId });

    store.end(session.id, SessionEndReasons.completed);

    const row = testDb.db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as Record<string, unknown>;
    expect(row["ended_at"]).toBeTruthy();
    expect(row["end_reason"]).toBe(SessionEndReasons.completed);
  });

  it("throws for non-existent session on end", () => {
    setup();
    expect(() => store.end("nonexistent", SessionEndReasons.completed)).toThrow('Session "nonexistent" not found');
  });
});
