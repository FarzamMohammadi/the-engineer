import type Database from "better-sqlite3";
import { ulid } from "ulid";

import { SessionMemory } from "../../src/core/session-memory/index.js";
import { type TestDatabaseHandle, createTestDatabase } from "./test-database.js";

export interface TestSessionMemoryHandle {
  sessionMemory: SessionMemory;
  /** Exposed for direct queries in tests. */
  db: Database.Database;
  /**
   * Insert a minimal task row to satisfy the FK constraint on sessions.task_id.
   * Returns the task ID — the caller's `id` when given (to align with a workspace under the same id),
   * otherwise a generated one.
   */
  insertTask(title?: string, id?: string): string;
  /** Close the database. Call in afterEach. */
  cleanup(): void;
}

/**
 * Creates a fresh SessionMemory backed by an in-memory database with all migrations applied.
 *
 * The sessions table has a FK to tasks, so tests must call `insertTask()` before
 * creating sessions. This helper provides that convenience method.
 */
export function createTestSessionMemory(): TestSessionMemoryHandle {
  const testDb: TestDatabaseHandle = createTestDatabase();
  const sessionMemory = new SessionMemory(testDb.db);

  const insertTaskStmt = testDb.db.prepare(`
    INSERT INTO tasks (
      id, idempotency_key, state, title, description, source_text,
      acceptance_criteria, team, related, decisions,
      priority, agent_tokens, agent_cost_usd, compute_time_ms,
      created_at, last_transition_at
    ) VALUES (
      ?, ?, 'queued', ?, '', '',
      '[]', '[]', '[]', '[]',
      50, 0, 0.0, 0,
      ?, ?
    )
  `);

  return {
    sessionMemory,
    db: testDb.db,

    insertTask(title?: string, id?: string): string {
      const taskId = id ?? ulid();
      const now = new Date().toISOString();
      insertTaskStmt.run(taskId, `test:${taskId}`, title ?? "Test task", now, now);
      return taskId;
    },

    cleanup() {
      testDb.cleanup();
    },
  };
}
