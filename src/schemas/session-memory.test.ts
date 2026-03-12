import { describe, expect, it } from "vitest";

const HEX_32 = /^[0-9a-f]{32}$/;

import {
  CheckpointReasonSchema,
  CheckpointSchema,
  JournalEntrySchema,
  JournalEntryTypeSchema,
  KnowledgeConfidenceSchema,
  KnowledgeDomainSchema,
  KnowledgeEntrySchema,
  KnowledgeScopeSchema,
  SessionEndReasonSchema,
  SessionSchema,
  knowledgeId,
} from "./session-memory.js";

// ── Session ────────────────────────────────────────────────────────────────────

describe("SessionSchema", () => {
  const validSession = {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    task_id: "01XYZ",
    started_at: "2026-03-10T12:00:00.000Z",
    ended_at: null,
    end_reason: null,
    previous_session_id: null,
    resumed_from_checkpoint: null,
  };

  it("parses a valid active session", () => {
    expect(SessionSchema.parse(validSession)).toEqual(validSession);
  });

  it("parses a completed session", () => {
    const completed = {
      ...validSession,
      ended_at: "2026-03-10T14:00:00.000Z",
      end_reason: "completed" as const,
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
    phase: "research",
    type: "action",
    summary: "Read auth module source code",
    detail: null,
    action_type: "file_read",
    finding_type: null,
    decision_key: null,
    error_detail: null,
    comm_target: null,
    tags: ["auth"],
  };

  it("parses a valid journal entry", () => {
    expect(JournalEntrySchema.parse(validEntry)).toEqual(validEntry);
  });

  it("has exactly 7 entry types", () => {
    expect(JournalEntryTypeSchema.options).toHaveLength(7);
  });

  it("accepts all 7 entry types", () => {
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
    expect(
      JournalEntrySchema.parse({ ...validEntry, tags: ["auth", "css", "migration"] }),
    ).toBeDefined();
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
    phase: "research",
    phase_progress: "researched auth module, found 3 patterns",
    context_summary: "Investigating authentication patterns in the codebase",
    key_findings: ["Uses JWT tokens", "Middleware pattern for auth"],
    open_questions: ["Where are refresh tokens stored?"],
    next_action: "Read the token refresh endpoint",
    last_event_id: "01EVTID",
    workspace_ref: { branch: "engineer/42-auth", last_commit: "abc123" },
    reason: "phase_transition",
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

  it("has exactly 4 checkpoint reasons", () => {
    expect(CheckpointReasonSchema.options).toHaveLength(4);
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

// ── KnowledgeEntry ─────────────────────────────────────────────────────────────

describe("KnowledgeEntrySchema", () => {
  const validKnowledge = {
    id: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    scope: "repo",
    repo_scope: "owner/repo",
    domain: "conventions",
    key: "test framework",
    body: "Uses Vitest with forks pool for all test tiers",
    confidence: "observed",
    evidence: [{ task_id: "01TASK", description: "saw this pattern in 5 files during task #42" }],
    created_at: "2026-03-10T12:00:00.000Z",
    last_confirmed: "2026-03-10T12:00:00.000Z",
    superseded_by: null,
    source_task_id: "01TASK",
    source_phase: "research",
  };

  it("parses a valid knowledge entry", () => {
    expect(KnowledgeEntrySchema.parse(validKnowledge)).toEqual(validKnowledge);
  });

  it("accepts null repo_scope for user-scoped knowledge", () => {
    const userScoped = { ...validKnowledge, scope: "user", repo_scope: null };
    expect(KnowledgeEntrySchema.parse(userScoped)).toBeDefined();
  });

  it("accepts superseded_by when set", () => {
    const superseded = { ...validKnowledge, superseded_by: "newid123" };
    expect(KnowledgeEntrySchema.parse(superseded)).toBeDefined();
  });

  it("has exactly 2 scopes", () => {
    expect(KnowledgeScopeSchema.options).toHaveLength(2);
  });

  it("has exactly 3 confidence levels", () => {
    expect(KnowledgeConfidenceSchema.options).toHaveLength(3);
  });

  it("has exactly 6 domains", () => {
    expect(KnowledgeDomainSchema.options).toHaveLength(6);
  });

  it("rejects invalid scope", () => {
    expect(() => KnowledgeEntrySchema.parse({ ...validKnowledge, scope: "global" })).toThrow();
  });

  it("rejects invalid domain", () => {
    expect(() =>
      KnowledgeEntrySchema.parse({ ...validKnowledge, domain: "architecture" }),
    ).toThrow();
  });
});

// ── knowledgeId ────────────────────────────────────────────────────────────────

describe("knowledgeId", () => {
  it("returns a 32-character hex string", () => {
    const id = knowledgeId("repo", "owner/repo", "test framework", "Uses Vitest");
    expect(id).toHaveLength(32);
    expect(id).toMatch(HEX_32);
  });

  it("is deterministic (same inputs produce same output)", () => {
    const id1 = knowledgeId("repo", "owner/repo", "key", "body");
    const id2 = knowledgeId("repo", "owner/repo", "key", "body");
    expect(id1).toBe(id2);
  });

  it("produces different IDs for different inputs", () => {
    const id1 = knowledgeId("repo", "owner/repo", "key", "body1");
    const id2 = knowledgeId("repo", "owner/repo", "key", "body2");
    expect(id1).not.toBe(id2);
  });

  it("different scopes with same key+body produce different IDs", () => {
    const id1 = knowledgeId("repo", "owner/repo", "key", "body");
    const id2 = knowledgeId("user", null, "key", "body");
    expect(id1).not.toBe(id2);
  });

  it("different repo_scopes with same scope+key+body produce different IDs", () => {
    const id1 = knowledgeId("repo", "owner/repo-a", "key", "body");
    const id2 = knowledgeId("repo", "owner/repo-b", "key", "body");
    expect(id1).not.toBe(id2);
  });

  it("null repo_scope treated as empty string in hash", () => {
    const id1 = knowledgeId("user", null, "key", "body");
    const id2 = knowledgeId("user", null, "key", "body");
    expect(id1).toBe(id2);
  });

  it("handles empty strings", () => {
    const id = knowledgeId("", null, "", "");
    expect(id).toHaveLength(32);
    expect(id).toMatch(HEX_32);
  });

  it("handles special characters", () => {
    const id = knowledgeId(
      "repo",
      "owner/repo",
      "key with spaces & symbols!",
      "body with\nnewlines\tand\ttabs",
    );
    expect(id).toHaveLength(32);
    expect(id).toMatch(HEX_32);
  });

  it("handles unicode content", () => {
    const id = knowledgeId("repo", "owner/repo", "clé", "données avec émojis 🚀");
    expect(id).toHaveLength(32);
    expect(id).toMatch(HEX_32);
  });
});
