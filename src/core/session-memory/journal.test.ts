import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";

import {
  type TestDatabaseHandle,
  createTestDatabase,
} from "../../../test/helpers/test-database.js";
import { JournalStore } from "./journal.js";
import { SessionStore } from "./sessions.js";

let testDb: TestDatabaseHandle;
let journal: JournalStore;
let sessions: SessionStore;

function setup(): void {
  testDb = createTestDatabase();
  journal = new JournalStore(testDb.db);
  sessions = new SessionStore(testDb.db);
}

function insertTask(): string {
  const id = ulid();
  const now = new Date().toISOString();
  testDb.db
    .prepare(
      `INSERT INTO tasks (
      id, state, cascade_policy, title, description, source_text,
      acceptance_criteria, children, team, related, decisions, child_summaries,
      priority, llm_tokens, llm_cost_usd, compute_time_ms, created_at, last_transition_at
    ) VALUES (?, 'intake', 'pause_siblings', 'Test', '', '', '[]', '[]', '[]', '[]', '[]', '[]', 50, 0, 0.0, 0, ?, ?)`,
    )
    .run(id, now, now);
  return id;
}

function createSession(taskId: string): string {
  return sessions.createSession({ taskId }).id;
}

afterEach(() => testDb.cleanup());

describe("JournalStore", () => {
  it("creates an entry with ULID id and correct fields", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);

    const entry = journal.addJournalEntry({
      sessionId,
      taskId,
      phase: "research",
      type: "action",
      summary: "Read 12 files",
      actionType: "file_read",
    });

    expect(entry.id).toHaveLength(26);
    expect(entry.session_id).toBe(sessionId);
    expect(entry.task_id).toBe(taskId);
    expect(entry.phase).toBe("research");
    expect(entry.type).toBe("action");
    expect(entry.action_type).toBe("file_read");
    expect(entry.tags).toEqual([]);
  });

  it("serializes tags as JSON", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);

    const entry = journal.addJournalEntry({
      sessionId,
      taskId,
      phase: "research",
      type: "finding",
      summary: "Found patterns",
      tags: ["auth", "css"],
    });

    expect(entry.tags).toEqual(["auth", "css"]);
  });

  it("sanitizes secrets in summary, detail, and errorDetail", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);

    // sanitizeSecrets redacts URL-embedded tokens (git credential URLs)
    const secretUrl = "https://git:my-secret-token@github.com/owner/repo.git";
    const entry = journal.addJournalEntry({
      sessionId,
      taskId,
      phase: "execution",
      type: "error",
      summary: `Clone failed at ${secretUrl}`,
      detail: `Detail: ${secretUrl}`,
      errorDetail: `Error: ${secretUrl}`,
    });

    expect(entry.summary).not.toContain("my-secret-token");
    expect(entry.detail).not.toContain("my-secret-token");
    expect(entry.error_detail).not.toContain("my-secret-token");
    expect(entry.summary).toContain("https://git:***@");
  });

  it("populates all type-specific fields", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);

    const entry = journal.addJournalEntry({
      sessionId,
      taskId,
      phase: "execution",
      type: "error",
      summary: "Test failure",
      detail: "3 assertions failed",
      errorDetail: "auth.test.ts: expected 200, got 401",
      findingType: "test_failure",
      decisionKey: "retry-strategy",
      commTarget: "github:owner/repo#42",
      tags: ["testing"],
    });

    expect(entry.detail).toBe("3 assertions failed");
    expect(entry.error_detail).toBe("auth.test.ts: expected 200, got 401");
    expect(entry.finding_type).toBe("test_failure");
    expect(entry.decision_key).toBe("retry-strategy");
    expect(entry.comm_target).toBe("github:owner/repo#42");
  });

  it("queries all entries when no filters", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);
    addSampleEntries(sessionId, taskId);

    const entries = journal.queryJournal(taskId);
    expect(entries).toHaveLength(4);
  });

  it("filters by type", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);
    addSampleEntries(sessionId, taskId);

    const entries = journal.queryJournal(taskId, { type: "finding" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe("finding");
  });

  it("filters by phase", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);
    addSampleEntries(sessionId, taskId);

    const entries = journal.queryJournal(taskId, { phase: "research" });
    expect(entries).toHaveLength(2);
  });

  it("filters by tags with AND semantics", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);
    addSampleEntries(sessionId, taskId);

    const entries = journal.queryJournal(taskId, { tags: ["auth", "patterns"] });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("Found patterns");
  });

  it("combines multiple filters", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);
    addSampleEntries(sessionId, taskId);

    const entries = journal.queryJournal(taskId, { type: "action", phase: "research" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toBe("Read files");
  });

  function addSampleEntries(sessionId: string, taskId: string): void {
    journal.addJournalEntry({
      sessionId,
      taskId,
      phase: "research",
      type: "action",
      summary: "Read files",
      tags: ["auth"],
    });
    journal.addJournalEntry({
      sessionId,
      taskId,
      phase: "research",
      type: "finding",
      summary: "Found patterns",
      tags: ["auth", "patterns"],
    });
    journal.addJournalEntry({
      sessionId,
      taskId,
      phase: "planning",
      type: "decision",
      summary: "Chose approach",
      tags: ["architecture"],
    });
    journal.addJournalEntry({
      sessionId,
      taskId,
      phase: "execution",
      type: "error",
      summary: "Test failure",
      tags: ["testing"],
    });
  }
});
