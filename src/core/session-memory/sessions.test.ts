import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";

import {
  type TestDatabaseHandle,
  createTestDatabase,
} from "../../../test/helpers/test-database.js";
import { SessionStore } from "./sessions.js";

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
      id, state, cascade_policy, title, description, source_text,
      acceptance_criteria, children, team, related, decisions, child_summaries,
      priority, llm_tokens, llm_cost_usd, compute_time_ms, created_at, last_transition_at
    ) VALUES (?, 'requirements_gathering', 'pause_siblings', ?, '', '', '[]', '[]', '[]', '[]', '[]', '[]', 50, 0, 0.0, 0, ?, ?)`,
    )
    .run(id, title ?? "Test task", now, now);
  return id;
}

afterEach(() => testDb.cleanup());

describe("SessionStore", () => {
  it("creates a session with correct fields", () => {
    setup();
    const taskId = insertTask();
    const session = store.createSession({ taskId });

    expect(session.id).toHaveLength(26);
    expect(session.task_id).toBe(taskId);
    expect(session.started_at).toBeTruthy();
    expect(session.ended_at).toBeNull();
    expect(session.end_reason).toBeNull();
    expect(session.previous_session_id).toBeNull();
  });

  it("links to a previous session", () => {
    setup();
    const taskId = insertTask();
    const s1 = store.createSession({ taskId });
    const s2 = store.createSession({ taskId, previousSessionId: s1.id });

    expect(s2.previous_session_id).toBe(s1.id);
  });

  it("records resumed_from_checkpoint", () => {
    setup();
    const taskId = insertTask();
    const session = store.createSession({ taskId, resumedFromCheckpoint: "chk-abc" });

    expect(session.resumed_from_checkpoint).toBe("chk-abc");
  });

  it("ends a session with reason", () => {
    setup();
    const taskId = insertTask();
    const session = store.createSession({ taskId });

    store.endSession(session.id, "completed");

    const chain = store.getSessionChain(taskId);
    expect(chain).toHaveLength(1);
    expect(chain[0]!.ended_at).toBeTruthy();
    expect(chain[0]!.end_reason).toBe("completed");
  });

  it("throws for non-existent session on endSession", () => {
    setup();
    expect(() => store.endSession("nonexistent", "completed")).toThrow(
      'Session "nonexistent" not found',
    );
  });

  it("returns session chain in order", () => {
    setup();
    const taskId = insertTask();

    const s1 = store.createSession({ taskId });
    store.endSession(s1.id, "preempted");
    const s2 = store.createSession({ taskId, previousSessionId: s1.id });
    store.endSession(s2.id, "new_session");
    const s3 = store.createSession({ taskId, previousSessionId: s2.id });

    const chain = store.getSessionChain(taskId);
    expect(chain).toHaveLength(3);
    expect(chain[0]!.id).toBe(s1.id);
    expect(chain[1]!.id).toBe(s2.id);
    expect(chain[2]!.id).toBe(s3.id);
    expect(chain[2]!.previous_session_id).toBe(s2.id);
  });

  it("returns empty array for task with no sessions", () => {
    setup();
    const taskId = insertTask();
    expect(store.getSessionChain(taskId)).toEqual([]);
  });
});
