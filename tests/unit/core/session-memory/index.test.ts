import { afterEach, describe, expect, it } from "vitest";

import type {
  AddJournalEntryInput,
  CreateCheckpointInput,
} from "../../../../src/core/interfaces/session-memory.interface.js";
import { Phases } from "../../../../src/schemas/orchestrator.js";
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

describe("createSession", () => {
  it("creates a session with a ULID id and correct fields", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();

    const session = sessionMemory.createSession({ taskId });

    expect(session.id).toHaveLength(26); // ULID
    expect(session.task_id).toBe(taskId);
    expect(session.started_at).toBeTruthy();
    expect(session.ended_at).toBeNull();
    expect(session.end_reason).toBeNull();
    expect(session.previous_session_id).toBeNull();
    expect(session.resumed_from_checkpoint).toBeNull();
  });

  it("links to a previous session", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();

    const s1 = sessionMemory.createSession({ taskId });
    const s2 = sessionMemory.createSession({
      taskId,
      previousSessionId: s1.id,
    });

    expect(s2.previous_session_id).toBe(s1.id);
  });

  it("records resumed_from_checkpoint", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();

    const session = sessionMemory.createSession({
      taskId,
      resumedFromCheckpoint: "chk-abc",
    });

    expect(session.resumed_from_checkpoint).toBe("chk-abc");
  });
});

describe("endSession", () => {
  it("sets ended_at and end_reason", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.createSession({ taskId });

    sessionMemory.endSession(session.id, SessionEndReasons.completed);

    const chain = sessionMemory.getSessionChain(taskId);
    expect(chain).toHaveLength(1);
    expect(chain[0]!.ended_at).toBeTruthy();
    expect(chain[0]!.end_reason).toBe(SessionEndReasons.completed);
  });

  it("throws for non-existent session", () => {
    setup();
    expect(() => {
      handle.sessionMemory.endSession("nonexistent", SessionEndReasons.completed);
    }).toThrow('Session "nonexistent" not found');
  });
});

// ── Journal ────────────────────────────────────────────────────────────────────

describe("addJournalEntry", () => {
  it("creates an entry with ULID id and correct fields", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.createSession({ taskId });

    const entry = sessionMemory.addJournalEntry({
      sessionId: session.id,
      taskId,
      phase: Phases.research,
      type: JournalEntryTypes.action,
      summary: "Read 12 files in src/auth/",
      actionType: "file_read",
    });

    expect(entry.id).toHaveLength(26);
    expect(entry.session_id).toBe(session.id);
    expect(entry.task_id).toBe(taskId);
    expect(entry.phase).toBe("research");
    expect(entry.type).toBe(JournalEntryTypes.action);
    expect(entry.summary).toBe("Read 12 files in src/auth/");
    expect(entry.action_type).toBe("file_read");
    expect(entry.tags).toEqual([]);
  });

  it("serializes tags as JSON", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.createSession({ taskId });

    const entry = sessionMemory.addJournalEntry({
      sessionId: session.id,
      taskId,
      phase: Phases.research,
      type: JournalEntryTypes.finding,
      summary: "Found patterns",
      tags: ["auth", "css"],
    });

    expect(entry.tags).toEqual(["auth", "css"]);
  });

  it("populates all type-specific fields", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.createSession({ taskId });

    const input: AddJournalEntryInput = {
      sessionId: session.id,
      taskId,
      phase: Phases.execution,
      type: JournalEntryTypes.error,
      summary: "Test failure",
      detail: "3 assertions failed",
      errorDetail: "auth.test.ts: expected 200, got 401",
      tags: ["testing"],
    };

    const entry = sessionMemory.addJournalEntry(input);
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

describe("createCheckpoint", () => {
  it("creates a checkpoint with ULID id", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.createSession({ taskId });

    const checkpoint = sessionMemory.createCheckpoint(makeCheckpointInput(session.id, taskId));

    expect(checkpoint.id).toHaveLength(26);
    expect(checkpoint.session_id).toBe(session.id);
    expect(checkpoint.task_id).toBe(taskId);
    expect(checkpoint.phase).toBe("research");
  });

  it("round-trips JSON arrays correctly", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.createSession({ taskId });

    sessionMemory.createCheckpoint(makeCheckpointInput(session.id, taskId));
    const retrieved = sessionMemory.getLatestCheckpoint(taskId);

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
    const session = sessionMemory.createSession({ taskId });

    sessionMemory.createCheckpoint(makeCheckpointInput(session.id, taskId, { workspaceRef: null }));
    const retrieved = sessionMemory.getLatestCheckpoint(taskId);

    expect(retrieved?.workspace_ref).toBeNull();
  });
});

describe("getLatestCheckpoint", () => {
  it("returns the most recent checkpoint across sessions", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();

    const s1 = sessionMemory.createSession({ taskId });
    sessionMemory.createCheckpoint(makeCheckpointInput(s1.id, taskId, { phase: Phases.research }));

    sessionMemory.endSession(s1.id, SessionEndReasons.preempted);
    const s2 = sessionMemory.createSession({ taskId, previousSessionId: s1.id });
    sessionMemory.createCheckpoint(makeCheckpointInput(s2.id, taskId, { phase: Phases.planning }));

    const latest = sessionMemory.getLatestCheckpoint(taskId);
    expect(latest).not.toBeNull();
    expect(latest?.phase).toBe("planning");
    expect(latest?.session_id).toBe(s2.id);
  });

  it("returns null when no checkpoints exist", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();

    const result = sessionMemory.getLatestCheckpoint(taskId);
    expect(result).toBeNull();
  });
});

// ── queryJournal ─────────────────────────────────────────────────────────────

describe("queryJournal", () => {
  function addEntries(sm: typeof handle.sessionMemory, sessionId: string, taskId: string): void {
    sm.addJournalEntry({
      sessionId,
      taskId,
      phase: Phases.research,
      type: JournalEntryTypes.action,
      summary: "Read files",
      tags: ["auth"],
    });
    sm.addJournalEntry({
      sessionId,
      taskId,
      phase: Phases.research,
      type: JournalEntryTypes.finding,
      summary: "Found patterns",
      tags: ["auth", "patterns"],
    });
    sm.addJournalEntry({
      sessionId,
      taskId,
      phase: Phases.planning,
      type: JournalEntryTypes.decision,
      summary: "Chose approach",
      tags: ["architecture"],
    });
    sm.addJournalEntry({
      sessionId,
      taskId,
      phase: Phases.execution,
      type: JournalEntryTypes.error,
      summary: "Test failure",
      tags: ["testing"],
    });
  }

  it("returns all entries when no filters", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.createSession({ taskId });
    addEntries(sessionMemory, session.id, taskId);

    const entries = sessionMemory.queryJournal(taskId);
    expect(entries).toHaveLength(4);
  });

  it("filters by type", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.createSession({ taskId });
    addEntries(sessionMemory, session.id, taskId);

    const entries = sessionMemory.queryJournal(taskId, { type: JournalEntryTypes.finding });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe(JournalEntryTypes.finding);
  });

  it("filters by phase", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.createSession({ taskId });
    addEntries(sessionMemory, session.id, taskId);

    const entries = sessionMemory.queryJournal(taskId, { phase: Phases.research });
    expect(entries).toHaveLength(2);
  });

  it("filters by tags (AND semantics)", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.createSession({ taskId });
    addEntries(sessionMemory, session.id, taskId);

    const entries = sessionMemory.queryJournal(taskId, {
      tags: ["auth", "patterns"],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("Found patterns");
  });

  it("filters by since (timestamp)", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.createSession({ taskId });

    sessionMemory.addJournalEntry({
      sessionId: session.id,
      taskId,
      phase: Phases.research,
      type: JournalEntryTypes.action,
      summary: "Early entry",
    });

    // Get the timestamp of the entry just added
    const allEntries = sessionMemory.queryJournal(taskId);
    const sinceTime = allEntries[0]!.timestamp;

    sessionMemory.addJournalEntry({
      sessionId: session.id,
      taskId,
      phase: Phases.planning,
      type: JournalEntryTypes.decision,
      summary: "Later entry",
    });

    // Filter entries since the first entry's timestamp — should get both (>=)
    const entries = sessionMemory.queryJournal(taskId, { since: sinceTime });
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("combines multiple filters", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();
    const session = sessionMemory.createSession({ taskId });
    addEntries(sessionMemory, session.id, taskId);

    const entries = sessionMemory.queryJournal(taskId, {
      type: JournalEntryTypes.action,
      phase: Phases.research,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("Read files");
  });
});

// ── getSessionChain ──────────────────────────────────────────────────────────

describe("getSessionChain", () => {
  it("returns all sessions for a task in order", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();

    const s1 = sessionMemory.createSession({ taskId });
    sessionMemory.endSession(s1.id, SessionEndReasons.preempted);
    const s2 = sessionMemory.createSession({ taskId, previousSessionId: s1.id });
    sessionMemory.endSession(s2.id, SessionEndReasons.new_session);
    const s3 = sessionMemory.createSession({ taskId, previousSessionId: s2.id });

    const chain = sessionMemory.getSessionChain(taskId);
    expect(chain).toHaveLength(3);
    expect(chain[0]!.id).toBe(s1.id);
    expect(chain[1]!.id).toBe(s2.id);
    expect(chain[2]!.id).toBe(s3.id);
    expect(chain[1]!.previous_session_id).toBe(s1.id);
    expect(chain[2]!.previous_session_id).toBe(s2.id);
  });

  it("returns empty array for task with no sessions", () => {
    const { sessionMemory, insertTask } = setup();
    const taskId = insertTask();

    const chain = sessionMemory.getSessionChain(taskId);
    expect(chain).toEqual([]);
  });
});
