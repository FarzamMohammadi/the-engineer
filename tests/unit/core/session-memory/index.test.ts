import { afterEach, describe, expect, it } from "vitest";

import type { CreateCheckpointInput } from "../../../../src/core/interfaces/session-memory.interface.js";
import { Phases } from "../../../../src/core/orchestrator/pipeline/types.js";
import { CheckpointReasons, JournalEntryTypes, SessionEndReasons } from "../../../../src/schemas/session-memory.js";
import type { TestSessionMemoryHandle } from "../../../helpers/test-session-memory.js";
import { createTestSessionMemory } from "../../../helpers/test-session-memory.js";

let handle: TestSessionMemoryHandle;

afterEach(() => {
  handle.cleanup();
});

function setup(): TestSessionMemoryHandle {
  handle = createTestSessionMemory();
  return handle;
}

// ── Session Lifecycle ──────────────────────────────────────────────────────────

describe("sessions.create", () => {
  it("creates a session with a ULID id and correct fields", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();

    const session = sessionMemory.sessions.create({ taskId });

    expect(session.id).toHaveLength(26);
    expect(session.task_id).toBe(taskId);
    expect(session.started_at).toBeTruthy();
    expect(session.ended_at).toBeNull();
    expect(session.end_reason).toBeNull();
  });
});

describe("sessions.end", () => {
  it("sets ended_at and end_reason", () => {
    const { sessionMemory, insertTask, db } = setup();
    const taskId = insertTask();
    const session = sessionMemory.sessions.create({ taskId });

    sessionMemory.sessions.end(session.id, SessionEndReasons.completed);

    const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as Record<string, unknown>;
    expect(row["ended_at"]).toBeTruthy();
    expect(row["end_reason"]).toBe(SessionEndReasons.completed);
  });

  it("throws for non-existent session", () => {
    setup();
    expect(() => {
      handle.sessionMemory.sessions.end("nonexistent", SessionEndReasons.completed);
    }).toThrow('Session "nonexistent" not found');
  });
});

// ── Journal ────────────────────────────────────────────────────────────────────

describe("journal.addEntry", () => {
  it("creates an entry with ULID id and correct fields", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.sessions.create({ taskId });

    const entry = sessionMemory.journal.addEntry({
      sessionId: session.id,
      taskId,
      phase: Phases.research,
      type: JournalEntryTypes.phase_change,
      summary: "Completed research phase",
    });

    expect(entry.id).toHaveLength(26);
    expect(entry.session_id).toBe(session.id);
    expect(entry.task_id).toBe(taskId);
    expect(entry.phase).toBe("research");
    expect(entry.type).toBe(JournalEntryTypes.phase_change);
    expect(entry.tags).toEqual([]);
  });

  it("serializes tags as JSON", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.sessions.create({ taskId });

    const entry = sessionMemory.journal.addEntry({
      sessionId: session.id,
      taskId,
      phase: Phases.research,
      type: JournalEntryTypes.phase_change,
      summary: "Found patterns",
      tags: ["auth", "css"],
    });

    expect(entry.tags).toEqual(["auth", "css"]);
  });

  it("populates error_detail field", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.sessions.create({ taskId });

    const entry = sessionMemory.journal.addEntry({
      sessionId: session.id,
      taskId,
      phase: Phases.execution,
      type: JournalEntryTypes.error,
      summary: "Test failure",
      detail: "3 assertions failed",
      errorDetail: "auth.test.ts: expected 200, got 401",
      tags: ["testing"],
    });

    expect(entry.detail).toBe("3 assertions failed");
    expect(entry.error_detail).toBe("auth.test.ts: expected 200, got 401");
  });
});

// ── Checkpoints ──────────────────────────────────────────────────────────────

function makeCheckpointInput(
  sessionId: string,
  taskId: string,
  overrides?: Partial<CreateCheckpointInput>,
): CreateCheckpointInput {
  return {
    sessionId,
    taskId,
    phase: Phases.research,
    subPhase: "investigate",
    phaseIteration: 0,
    totalReworks: 0,
    phaseProgress: "researched auth module, found 3 patterns",
    contextSummary: "Exploring auth patterns in the codebase",
    keyFindings: ["Uses JWT", "No refresh tokens"],
    openQuestions: ["What about OAuth?"],
    nextAction: "Research OAuth integration",
    lastEventId: "01ABCDEF",
    workspaceRef: { branch: "engineer/47-dark-mode", last_commit: "abc123" },
    reason: CheckpointReasons.phase_transition,
    journalOffset: 5,
    ...overrides,
  };
}

describe("checkpoints.create", () => {
  it("creates a checkpoint with ULID id", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.sessions.create({ taskId });

    const checkpoint = sessionMemory.checkpoints.create(makeCheckpointInput(session.id, taskId));

    expect(checkpoint.id).toHaveLength(26);
    expect(checkpoint.session_id).toBe(session.id);
    expect(checkpoint.task_id).toBe(taskId);
    expect(checkpoint.phase).toBe("research");
  });

  it("round-trips JSON arrays correctly", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.sessions.create({ taskId });

    sessionMemory.checkpoints.create(makeCheckpointInput(session.id, taskId));
    const retrieved = sessionMemory.checkpoints.getLatest(taskId);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.key_findings).toEqual(["Uses JWT", "No refresh tokens"]);
    expect(retrieved?.open_questions).toEqual(["What about OAuth?"]);
    expect(retrieved?.workspace_ref).toEqual({
      branch: "engineer/47-dark-mode",
      last_commit: "abc123",
    });
  });

  it("handles null workspace_ref", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.sessions.create({ taskId });

    sessionMemory.checkpoints.create(makeCheckpointInput(session.id, taskId, { workspaceRef: null }));
    const retrieved = sessionMemory.checkpoints.getLatest(taskId);

    expect(retrieved?.workspace_ref).toBeNull();
  });
});

describe("checkpoints.getLatest", () => {
  it("returns the most recent checkpoint across sessions", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();

    const s1 = sessionMemory.sessions.create({ taskId });
    sessionMemory.checkpoints.create(makeCheckpointInput(s1.id, taskId, { phase: Phases.research }));

    sessionMemory.sessions.end(s1.id, SessionEndReasons.preempted);
    const s2 = sessionMemory.sessions.create({ taskId });
    sessionMemory.checkpoints.create(makeCheckpointInput(s2.id, taskId, { phase: Phases.planning }));

    const latest = sessionMemory.checkpoints.getLatest(taskId);
    expect(latest).not.toBeNull();
    expect(latest?.phase).toBe("planning");
    expect(latest?.session_id).toBe(s2.id);
  });

  it("returns null when no checkpoints exist", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();

    const result = sessionMemory.checkpoints.getLatest(taskId);
    expect(result).toBeNull();
  });
});

// ── journal.query ─────────────────────────────────────────────────────────────

describe("journal.query", () => {
  function addEntries(sm: typeof handle.sessionMemory, sessionId: string, taskId: string): void {
    sm.journal.addEntry({
      sessionId,
      taskId,
      phase: Phases.research,
      type: JournalEntryTypes.phase_change,
      summary: "Completed research",
      tags: ["auth"],
    });
    sm.journal.addEntry({
      sessionId,
      taskId,
      phase: Phases.planning,
      type: JournalEntryTypes.phase_change,
      summary: "Completed planning",
      tags: ["architecture"],
    });
    sm.journal.addEntry({
      sessionId,
      taskId,
      phase: Phases.execution,
      type: JournalEntryTypes.error,
      summary: "Test failure",
      tags: ["testing"],
    });
  }

  it("returns all entries when called without filters", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.sessions.create({ taskId });
    addEntries(sessionMemory, session.id, taskId);

    const entries = sessionMemory.journal.query(taskId);
    expect(entries).toHaveLength(3);
  });
});
