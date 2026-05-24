import { describe, expect, it } from "vitest";

import { Phases } from "../../../src/schemas/orchestrator.js";
import {
  CheckpointReasonSchema,
  CheckpointReasons,
  CheckpointSchema,
  JournalEntrySchema,
  JournalEntryTypeSchema,
  JournalEntryTypes,
  SessionEndReasonSchema,
  SessionEndReasons,
  SessionSchema,
} from "../../../src/schemas/session-memory.js";

// ── Session ────────────────────────────────────────────────────────────────────

describe("SessionSchema", () => {
  const validSession = {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    task_id: "01XYZ",
    started_at: "2026-03-10T12:00:00.000Z",
    ended_at: null,
    end_reason: null,
  };

  it("parses a valid active session", () => {
    expect(SessionSchema.parse(validSession)).toEqual(validSession);
  });

  it("parses a completed session", () => {
    const completed = {
      ...validSession,
      ended_at: "2026-03-10T14:00:00.000Z",
      end_reason: SessionEndReasons.completed,
    };
    expect(SessionSchema.parse(completed)).toEqual(completed);
  });

  it("accepts all end reasons", () => {
    for (const reason of SessionEndReasonSchema.options) {
      expect(
        SessionSchema.parse({
          ...validSession,
          ended_at: "2026-03-10T14:00:00.000Z",
          end_reason: reason,
        }),
      ).toBeDefined();
    }
  });

  it("rejects invalid end reason", () => {
    expect(() => SessionSchema.parse({ ...validSession, end_reason: "timeout" })).toThrow();
  });

  it("has exactly 5 end reasons", () => {
    expect(SessionEndReasonSchema.options).toHaveLength(5);
  });
});

// ── JournalEntry ───────────────────────────────────────────────────────────────

describe("JournalEntrySchema", () => {
  const validEntry = {
    id: "01ABC",
    session_id: "01SESSION",
    task_id: "01TASK",
    timestamp: "2026-03-10T12:00:00.000Z",
    phase: Phases.research,
    type: JournalEntryTypes.phase_change,
    summary: "Read auth module source code",
    detail: null,
    error_detail: null,
    tags: ["auth"],
  };

  it("parses a valid journal entry", () => {
    expect(JournalEntrySchema.parse(validEntry)).toEqual(validEntry);
  });

  it("has exactly 3 entry types", () => {
    expect(JournalEntryTypeSchema.options).toHaveLength(3);
  });

  it("accepts all 3 entry types", () => {
    for (const type of JournalEntryTypeSchema.options) {
      expect(JournalEntrySchema.parse({ ...validEntry, type })).toBeDefined();
    }
  });

  it("rejects invalid entry type", () => {
    expect(() => JournalEntrySchema.parse({ ...validEntry, type: "note" })).toThrow();
  });

  it("accepts empty tags array", () => {
    expect(JournalEntrySchema.parse({ ...validEntry, tags: [] })).toBeDefined();
  });

  it("accepts multiple tags", () => {
    expect(JournalEntrySchema.parse({ ...validEntry, tags: ["auth", "css", "migration"] })).toBeDefined();
  });

  it("accepts detail when populated", () => {
    const withDetail = {
      ...validEntry,
      detail: "Explored src/auth/ directory, found 3 middleware files",
    };
    expect(JournalEntrySchema.parse(withDetail)).toEqual(withDetail);
  });
});

// ── Checkpoint ─────────────────────────────────────────────────────────────────

describe("CheckpointSchema", () => {
  const validCheckpoint = {
    id: "01CHK",
    session_id: "01SESSION",
    task_id: "01TASK",
    phase: Phases.research,
    phase_progress: "researched auth module, found 3 patterns",
    context_summary: "Investigating authentication patterns in the codebase",
    key_findings: ["Uses JWT tokens", "Middleware pattern for auth"],
    open_questions: ["Where are refresh tokens stored?"],
    next_action: "Read the token refresh endpoint",
    last_event_id: "01EVTID",
    workspace_ref: { branch: "engineer/42-auth", last_commit: "abc123" },
    reason: CheckpointReasons.phase_transition,
    timestamp: "2026-03-10T12:30:00.000Z",
    journal_offset: 5,
  };

  it("parses a valid checkpoint", () => {
    expect(CheckpointSchema.parse(validCheckpoint)).toEqual(validCheckpoint);
  });

  it("accepts null workspace_ref", () => {
    const noWorkspace = { ...validCheckpoint, workspace_ref: null };
    expect(CheckpointSchema.parse(noWorkspace)).toEqual(noWorkspace);
  });

  it("has exactly 2 checkpoint reasons", () => {
    expect(CheckpointReasonSchema.options).toHaveLength(2);
  });

  it("accepts all checkpoint reasons", () => {
    for (const reason of CheckpointReasonSchema.options) {
      expect(CheckpointSchema.parse({ ...validCheckpoint, reason })).toBeDefined();
    }
  });

  it("rejects invalid checkpoint reason", () => {
    expect(() => CheckpointSchema.parse({ ...validCheckpoint, reason: "manual" })).toThrow();
  });

  it("rejects non-integer journal_offset", () => {
    expect(() => CheckpointSchema.parse({ ...validCheckpoint, journal_offset: 5.5 })).toThrow();
  });
});
