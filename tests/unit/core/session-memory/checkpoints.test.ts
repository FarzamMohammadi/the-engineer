import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";

import type { CreateCheckpointInput } from "../../../../src/core/interfaces/session-memory.interface.js";
import { CheckpointStore } from "../../../../src/core/session-memory/checkpoints.js";
import { SessionStore } from "../../../../src/core/session-memory/sessions.js";
import { CheckpointReasons, SessionEndReasons } from "../../../../src/schemas/session-memory.js";
import { type TestDatabaseHandle, createTestDatabase } from "../../../helpers/test-database.js";

let testDb: TestDatabaseHandle;
let checkpoints: CheckpointStore;
let sessions: SessionStore;

function setup(): void {
  testDb = createTestDatabase();
  checkpoints = new CheckpointStore(testDb.db);
  sessions = new SessionStore(testDb.db);
}

function insertTask(): string {
  const id = ulid();
  const now = new Date().toISOString();
  testDb.db
    .prepare(
      `INSERT INTO tasks (
      id, idempotency_key, state, cascade_policy, title, description, source_text,
      acceptance_criteria, children, team, related, decisions, child_summaries,
      priority, llm_tokens, llm_cost_usd, compute_time_ms, created_at, last_transition_at
    ) VALUES (?, ?, 'requirements_gathering', 'pause_siblings', 'Test', '', '', '[]', '[]', '[]', '[]', '[]', '[]', 50, 0, 0.0, 0, ?, ?)`,
    )
    .run(id, `test:${id}`, now, now);
  return id;
}

function makeInput(
  sessionId: string,
  taskId: string,
  overrides?: Partial<CreateCheckpointInput>,
): CreateCheckpointInput {
  return {
    sessionId,
    taskId,
    phase: "research",
    phaseProgress: "researched auth module",
    contextSummary: "Exploring auth patterns",
    keyFindings: ["Uses JWT", "No refresh tokens"],
    openQuestions: ["What about OAuth?"],
    nextAction: "Research OAuth",
    lastEventId: "01ABCDEF",
    workspaceRef: { branch: "engineer/47-dark-mode", last_commit: "abc123" },
    reason: CheckpointReasons.phase_transition,
    journalOffset: 5,
    ...overrides,
  };
}

afterEach(() => testDb.cleanup());

describe("CheckpointStore", () => {
  it("creates a checkpoint with ULID id", () => {
    setup();
    const taskId = insertTask();
    const session = sessions.createSession({ taskId });

    const checkpoint = checkpoints.createCheckpoint(makeInput(session.id, taskId));

    expect(checkpoint.id).toHaveLength(26);
    expect(checkpoint.session_id).toBe(session.id);
    expect(checkpoint.task_id).toBe(taskId);
    expect(checkpoint.phase).toBe("research");
  });

  it("round-trips JSON arrays correctly via getLatestCheckpoint", () => {
    setup();
    const taskId = insertTask();
    const session = sessions.createSession({ taskId });

    checkpoints.createCheckpoint(makeInput(session.id, taskId));
    const retrieved = checkpoints.getLatestCheckpoint(taskId);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.key_findings).toEqual(["Uses JWT", "No refresh tokens"]);
    expect(retrieved?.open_questions).toEqual(["What about OAuth?"]);
    expect(retrieved?.workspace_ref).toEqual({
      branch: "engineer/47-dark-mode",
      last_commit: "abc123",
    });
  });

  it("handles null workspace_ref", () => {
    setup();
    const taskId = insertTask();
    const session = sessions.createSession({ taskId });

    checkpoints.createCheckpoint(makeInput(session.id, taskId, { workspaceRef: null }));
    const retrieved = checkpoints.getLatestCheckpoint(taskId);

    expect(retrieved?.workspace_ref).toBeNull();
  });

  it("returns latest checkpoint by rowid ordering", () => {
    setup();
    const taskId = insertTask();

    const s1 = sessions.createSession({ taskId });
    checkpoints.createCheckpoint(makeInput(s1.id, taskId, { phase: "research" }));

    sessions.endSession(s1.id, SessionEndReasons.preempted);
    const s2 = sessions.createSession({ taskId, previousSessionId: s1.id });
    checkpoints.createCheckpoint(makeInput(s2.id, taskId, { phase: "planning" }));

    const latest = checkpoints.getLatestCheckpoint(taskId);
    expect(latest).not.toBeNull();
    expect(latest?.phase).toBe("planning");
    expect(latest?.session_id).toBe(s2.id);
  });

  it("returns null when no checkpoints exist", () => {
    setup();
    const taskId = insertTask();
    expect(checkpoints.getLatestCheckpoint(taskId)).toBeNull();
  });
});
