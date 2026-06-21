import { ulid } from "ulid";
import { afterEach, describe, expect, it } from "vitest";

import { JournalStore } from "../../../../src/core/session-memory/journal.js";
import { SessionStore } from "../../../../src/core/session-memory/sessions.js";
import { JournalEntryTypes } from "../../../../src/schemas/session-memory.js";
import { type TestDatabaseHandle, createTestDatabase } from "../../../helpers/test-database.js";

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
      id, idempotency_key, state, title, description, source_text,
      acceptance_criteria, team, related, decisions,
      priority, agent_tokens, agent_cost_usd, compute_time_ms, created_at, last_transition_at
    ) VALUES (?, ?, 'queued', 'Test', '', '', '[]', '[]', '[]', '[]', 50, 0, 0.0, 0, ?, ?)`,
    )
    .run(id, `test:${id}`, now, now);
  return id;
}

function createSession(taskId: string): string {
  return sessions.create({ taskId }).id;
}

afterEach(() => testDb.cleanup());

describe("JournalStore", () => {
  it("creates an entry with ULID id and correct fields", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);

    const entry = journal.addEntry({
      sessionId,
      taskId,
      phase: "research",
      type: JournalEntryTypes.phase_change,
      summary: "Completed research phase",
    });

    expect(entry.id).toHaveLength(26);
    expect(entry.session_id).toBe(sessionId);
    expect(entry.task_id).toBe(taskId);
    expect(entry.phase).toBe("research");
    expect(entry.type).toBe(JournalEntryTypes.phase_change);
    expect(entry.tags).toEqual([]);
  });

  it("serializes tags as JSON", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);

    const entry = journal.addEntry({
      sessionId,
      taskId,
      phase: "research",
      type: JournalEntryTypes.phase_change,
      summary: "Found patterns",
      tags: ["auth", "css"],
    });

    expect(entry.tags).toEqual(["auth", "css"]);
  });

  it("sanitizes secrets in summary, detail, and errorDetail", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);

    const secretUrl = "https://git:my-secret-token@github.com/owner/repo.git";
    const entry = journal.addEntry({
      sessionId,
      taskId,
      phase: "execution",
      type: JournalEntryTypes.error,
      summary: `Clone failed at ${secretUrl}`,
      detail: `Detail: ${secretUrl}`,
      errorDetail: `Error: ${secretUrl}`,
    });

    expect(entry.summary).not.toContain("my-secret-token");
    expect(entry.detail).not.toContain("my-secret-token");
    expect(entry.error_detail).not.toContain("my-secret-token");
    expect(entry.summary).toContain("https://git:***@");
  });

  it("populates error_detail field", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);

    const entry = journal.addEntry({
      sessionId,
      taskId,
      phase: "execution",
      type: JournalEntryTypes.error,
      summary: "Test failure",
      detail: "3 assertions failed",
      errorDetail: "auth.test.ts: expected 200, got 401",
      tags: ["testing"],
    });

    expect(entry.detail).toBe("3 assertions failed");
    expect(entry.error_detail).toBe("auth.test.ts: expected 200, got 401");
  });

  it("queries all entries when called without filters", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);
    addSampleEntries(sessionId, taskId);

    const entries = journal.query(taskId);
    expect(entries).toHaveLength(3);
  });

  function addSampleEntries(sessionId: string, taskId: string): void {
    journal.addEntry({
      sessionId,
      taskId,
      phase: "research",
      type: JournalEntryTypes.phase_change,
      summary: "Completed research",
      tags: ["auth"],
    });
    journal.addEntry({
      sessionId,
      taskId,
      phase: "planning",
      type: JournalEntryTypes.phase_change,
      summary: "Completed planning",
      tags: ["architecture"],
    });
    journal.addEntry({
      sessionId,
      taskId,
      phase: "execution",
      type: JournalEntryTypes.error,
      summary: "Test failure",
      tags: ["testing"],
    });
  }

  it("getLatestTimestamp returns latest timestamp", () => {
    setup();
    const taskId = insertTask();
    const sessionId = createSession(taskId);

    journal.addEntry({
      sessionId,
      taskId,
      phase: "research",
      type: JournalEntryTypes.phase_change,
      summary: "First entry",
    });
    journal.addEntry({
      sessionId,
      taskId,
      phase: "research",
      type: JournalEntryTypes.phase_change,
      summary: "Second entry",
    });

    const latest = journal.getLatestTimestamp(taskId);
    expect(latest).not.toBeNull();

    const entries = journal.query(taskId);
    const maxTimestamp = entries
      .map((e) => e.timestamp)
      .sort()
      .pop();
    expect(latest).toBe(maxTimestamp);
  });

  it("getLatestTimestamp returns null for task with no entries", () => {
    setup();
    const taskId = insertTask();
    expect(journal.getLatestTimestamp(taskId)).toBeNull();
  });
});
