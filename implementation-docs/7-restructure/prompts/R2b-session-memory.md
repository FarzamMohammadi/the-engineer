# R2b — SessionMemory Decomposition

**Wave 2 (Parallel) — Depends on R0 (Interface Foundation) being complete.**

---

## Worktree Setup (DO THIS FIRST)

This phase runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-R2b -b layer7/R2b main
cd ../engineer-R2b
```

**Rules:**
- Work ONLY in this worktree (`../engineer-R2b/`)
- Commit your changes to the `layer7/R2b` branch
- Do NOT push — the merge prompt will collect this branch
- Do NOT modify files outside the scope listed in this prompt
- When done: commit, verify tests pass, stop. The merge wave handles the rest.

---

You are implementing a structural restructuring phase for The Engineer, an autonomous software engineering agent. This phase decomposes the SessionMemory (~606 LOC) into four focused modules: sessions, journal, checkpoints, and knowledge. No new features, no behavior changes. Every existing test must pass after.

---

## 1. Identity Preamble

Before writing any code, read these files to understand the project's identity and principles:

- `docs/persona.md` — who The Engineer is
- `docs/philosophy.md` — core beliefs driving every decision
- `implementation-docs/0-foundation/philosophy.md` — builder-specific principles

Key takeaways:
- Derive from Proven Systems: session memory derives from journaling filesystems and flight recorders
- Isolation as Survival: each task has its own session, journal, and knowledge scope
- Say It Once: row mappers are pure functions, defined once, used everywhere

---

## 2. Architecture Catchup

Read these docs:

- `implementation-docs/2-components/session-memory.md` — SessionMemory design (three concerns: journal, checkpoints, knowledge)
- `implementation-docs/3-interactions/protocols.md` — Protocol P9 (Session Resume), Protocol P10 (Checkpoint)
- `implementation-docs/4-implementation/schemas/` — session-memory schema
- `implementation-docs/7-restructure/assessment.md` — SessionMemory identified as mid-tier bloat (606 LOC, 4 mixed concerns)

---

## 3. Decision Log Review

- `implementation-docs/7-restructure/decisions.md` — Layer 7 decisions
- `implementation-docs/decisions.md` — historical

Key decisions:
- D85-D87: Session memory schema (journal, checkpoints, knowledge)
- D88: Knowledge ID generation (content hash)
- D154: Token sanitization in journal entries

---

## 4. Current Code Deep-Read

Read ALL of these files before making any changes:

### The file being decomposed
- `src/core/session-memory/index.ts` — the entire SessionMemory class (606 LOC)
- `src/core/session-memory/index.test.ts` — all existing tests

### Interface (created by R0)
- `src/core/interfaces/session-memory.interface.ts` — ISessionMemory contract
- `src/core/interfaces/index.ts` — barrel

### Schema
- `src/schemas/session-memory.ts` — SessionSchema, JournalEntrySchema, CheckpointSchema, KnowledgeEntrySchema, all enum schemas, knowledgeId()
  - Note the enum constants added by R0: `SessionEndReasons`, `JournalEntryTypes`, `CheckpointReasons`, `KnowledgeScopes`, `KnowledgeDomains`, `KnowledgeConfidences`

### Utilities
- `src/utils/sanitize.ts` — sanitizeSecrets() (used in journal entry creation)

### Consumers
- `src/core/orchestrator/index.ts` — imports SessionMemory, calls createSession, endSession, addJournalEntry, createCheckpoint, getLatestCheckpoint, storeKnowledge, getKnowledge, queryJournal
- `src/core/daemon/index.ts` — imports SessionMemory (for session chain in crash recovery)
- `src/cli/bootstrap.ts` — creates SessionMemory instance

### Test infrastructure
- `test/helpers/test-session-memory.ts` — createTestSessionMemory()
- `test/helpers/integration-context.ts`
- `test/helpers/test-orchestrator.ts`

---

## 5. Exact Specifications

> **SOURCE OF TRUTH:** The method names, signatures, and structures in this prompt are approximate guidance. You MUST read the actual source code first (Step 4) and derive your implementation from what's really there. If the code differs from this prompt, **the code is the source of truth**.

### 5A. New File Structure

Transform `src/core/session-memory/` from a single file to a module directory:

```
src/core/session-memory/
  index.ts              — SessionMemory class (facade, implements ISessionMemory, delegates)
  sessions.ts           — Session lifecycle (create, end, chain)
  journal.ts            — Journal entries (add, query with dynamic SQL)
  checkpoints.ts        — Checkpoint creation and retrieval
  knowledge.ts          — Knowledge store (upsert, query, supersede, confirm)
  row-mappers.ts        — All row-to-domain mapping functions (pure)
  index.test.ts         — existing tests (update imports if needed)
  sessions.test.ts      — new tests for sessions in isolation
  journal.test.ts       — new tests for journal in isolation
  checkpoints.test.ts   — new tests for checkpoints in isolation
  knowledge.test.ts     — new tests for knowledge in isolation
```

### 5B. `src/core/session-memory/row-mappers.ts`

Extract all row types and mapping functions as pure functions:

```typescript
import type {
  Checkpoint, CheckpointReason, JournalEntry, JournalEntryType,
  KnowledgeConfidence, KnowledgeDomain, KnowledgeEntry, KnowledgeEvidence,
  KnowledgeScope, Session, SessionEndReason,
} from "../../schemas/session-memory.js";

// ── Row Types ────────────────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  task_id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  previous_session_id: string | null;
  resumed_from_checkpoint: string | null;
}

export interface JournalEntryRow {
  id: string;
  session_id: string;
  task_id: string;
  timestamp: string;
  phase: string;
  type: string;
  summary: string;
  detail: string | null;
  action_type: string | null;
  finding_type: string | null;
  decision_key: string | null;
  error_detail: string | null;
  comm_target: string | null;
  tags: string;
}

export interface CheckpointRow {
  id: string;
  session_id: string;
  task_id: string;
  phase: string;
  phase_progress: string;
  context_summary: string;
  key_findings: string;
  open_questions: string;
  next_action: string;
  last_event_id: string;
  workspace_ref: string | null;
  reason: string;
  timestamp: string;
  journal_offset: number;
}

export interface KnowledgeEntryRow {
  id: string;
  scope: string;
  repo_scope: string | null;
  domain: string;
  key: string;
  body: string;
  confidence: string;
  evidence: string;
  created_at: string;
  last_confirmed: string;
  superseded_by: string | null;
  source_task_id: string;
  source_phase: string;
}

// ── Mappers (pure functions) ─────────────────────────────────────────────────

/** Convert a `sessions` table row to a typed Session object. */
export function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    task_id: row.task_id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    end_reason: row.end_reason as SessionEndReason | null,
    previous_session_id: row.previous_session_id,
    resumed_from_checkpoint: row.resumed_from_checkpoint,
  };
}

/** Convert a `journal_entries` table row to a typed JournalEntry object. */
export function rowToJournalEntry(row: JournalEntryRow): JournalEntry {
  return {
    id: row.id,
    session_id: row.session_id,
    task_id: row.task_id,
    timestamp: row.timestamp,
    phase: row.phase,
    type: row.type as JournalEntryType,
    summary: row.summary,
    detail: row.detail,
    action_type: row.action_type,
    finding_type: row.finding_type,
    decision_key: row.decision_key,
    error_detail: row.error_detail,
    comm_target: row.comm_target,
    tags: JSON.parse(row.tags) as string[],
  };
}

/** Convert a `checkpoints` table row to a typed Checkpoint object. */
export function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    session_id: row.session_id,
    task_id: row.task_id,
    phase: row.phase,
    phase_progress: row.phase_progress,
    context_summary: row.context_summary,
    key_findings: JSON.parse(row.key_findings) as string[],
    open_questions: JSON.parse(row.open_questions) as string[],
    next_action: row.next_action,
    last_event_id: row.last_event_id,
    workspace_ref: row.workspace_ref
      ? (JSON.parse(row.workspace_ref) as { branch: string; last_commit: string })
      : null,
    reason: row.reason as CheckpointReason,
    timestamp: row.timestamp,
    journal_offset: row.journal_offset,
  };
}

/** Convert a `knowledge` table row to a typed KnowledgeEntry object. */
export function rowToKnowledgeEntry(row: KnowledgeEntryRow): KnowledgeEntry {
  return {
    id: row.id,
    scope: row.scope as KnowledgeScope,
    repo_scope: row.repo_scope,
    domain: row.domain as KnowledgeDomain,
    key: row.key,
    body: row.body,
    confidence: row.confidence as KnowledgeConfidence,
    evidence: JSON.parse(row.evidence) as KnowledgeEvidence[],
    created_at: row.created_at,
    last_confirmed: row.last_confirmed,
    superseded_by: row.superseded_by,
    source_task_id: row.source_task_id,
    source_phase: row.source_phase,
  };
}
```

### 5C. `src/core/session-memory/sessions.ts`

```typescript
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { Session, SessionEndReason } from "../../schemas/session-memory.js";
import type { CreateSessionInput } from "../interfaces/session-memory.interface.js";
import { type SessionRow, rowToSession } from "./row-mappers.js";

/**
 * Session lifecycle management.
 * Sessions are linked chains for crash recovery — each session knows its predecessor.
 */
export class SessionStore {
  private readonly insertSessionStmt: Database.Statement;
  private readonly endSessionStmt: Database.Statement;
  private readonly getSessionsByTaskStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertSessionStmt = db.prepare(`
      INSERT INTO sessions (id, task_id, started_at, ended_at, end_reason, previous_session_id, resumed_from_checkpoint)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.endSessionStmt = db.prepare(
      "UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?"
    );
    this.getSessionsByTaskStmt = db.prepare(
      "SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at ASC"
    );
  }

  createSession(input: CreateSessionInput): Session {
    const id = ulid();
    const now = new Date().toISOString();
    const previousSessionId = input.previousSessionId ?? null;
    const resumedFromCheckpoint = input.resumedFromCheckpoint ?? null;

    this.insertSessionStmt.run(id, input.taskId, now, null, null, previousSessionId, resumedFromCheckpoint);

    return {
      id,
      task_id: input.taskId,
      started_at: now,
      ended_at: null,
      end_reason: null,
      previous_session_id: previousSessionId,
      resumed_from_checkpoint: resumedFromCheckpoint,
    };
  }

  endSession(id: string, reason: SessionEndReason): void {
    const now = new Date().toISOString();
    const result = this.endSessionStmt.run(now, reason, id);
    if (result.changes === 0) {
      throw new Error(`SessionMemory: session "${id}" not found`);
    }
  }

  getSessionChain(taskId: string): Session[] {
    const rows = this.getSessionsByTaskStmt.all(taskId) as SessionRow[];
    return rows.map(rowToSession);
  }
}
```

### 5D. `src/core/session-memory/journal.ts`

```typescript
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { JournalEntry } from "../../schemas/session-memory.js";
import type { AddJournalEntryInput, JournalQueryFilters } from "../interfaces/session-memory.interface.js";
import { type JournalEntryRow, rowToJournalEntry } from "./row-mappers.js";
import { sanitizeSecrets } from "../../utils/sanitize.js";

/**
 * Append-only journal for the Orchestrator's reasoning.
 *
 * Query uses dynamic SQL since filter permutations are exponential.
 * All parameters are bound — no injection risk. Tags use AND semantics.
 */
export class JournalStore {
  private readonly insertJournalStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertJournalStmt = db.prepare(`
      INSERT INTO journal_entries (
        id, session_id, task_id, timestamp, phase, type,
        summary, detail, action_type, finding_type, decision_key, error_detail, comm_target,
        tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  addJournalEntry(input: AddJournalEntryInput): JournalEntry {
    const id = ulid();
    const now = new Date().toISOString();
    const tags = input.tags ?? [];

    // Sanitize fields that may contain leaked tokens (D154)
    const summary = sanitizeSecrets(input.summary);
    const detail = input.detail ? sanitizeSecrets(input.detail) : null;
    const errorDetail = input.errorDetail ? sanitizeSecrets(input.errorDetail) : null;

    this.insertJournalStmt.run(
      id, input.sessionId, input.taskId, now, input.phase, input.type,
      summary, detail,
      input.actionType ?? null, input.findingType ?? null, input.decisionKey ?? null,
      errorDetail, input.commTarget ?? null,
      JSON.stringify(tags),
    );

    return {
      id, session_id: input.sessionId, task_id: input.taskId,
      timestamp: now, phase: input.phase, type: input.type,
      summary, detail,
      action_type: input.actionType ?? null, finding_type: input.findingType ?? null,
      decision_key: input.decisionKey ?? null, error_detail: errorDetail,
      comm_target: input.commTarget ?? null, tags,
    };
  }

  /**
   * Query journal entries for a task with optional filters.
   *
   * Builds SQL dynamically based on which filters are provided.
   * All parameters are bound (no injection risk). Tags use AND semantics:
   * the entry must contain ALL specified tags.
   */
  queryJournal(taskId: string, filters?: JournalQueryFilters): JournalEntry[] {
    const conditions: string[] = ["task_id = ?"];
    const params: unknown[] = [taskId];

    if (filters?.type) {
      conditions.push("type = ?");
      params.push(filters.type);
    }

    if (filters?.phase) {
      conditions.push("phase = ?");
      params.push(filters.phase);
    }

    if (filters?.since) {
      conditions.push("timestamp >= ?");
      params.push(filters.since);
    }

    if (filters?.tags && filters.tags.length > 0) {
      for (const tag of filters.tags) {
        conditions.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)");
        params.push(tag);
      }
    }

    const sql = `SELECT * FROM journal_entries WHERE ${conditions.join(" AND ")} ORDER BY timestamp ASC`;
    const rows = this.db.prepare(sql).all(...params) as JournalEntryRow[];
    return rows.map(rowToJournalEntry);
  }
}
```

### 5E. `src/core/session-memory/checkpoints.ts`

```typescript
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { Checkpoint } from "../../schemas/session-memory.js";
import type { CreateCheckpointInput } from "../interfaces/session-memory.interface.js";
import { type CheckpointRow, rowToCheckpoint } from "./row-mappers.js";

/**
 * Named snapshots for crash recovery and session resume.
 * Ordered by rowid (insertion order) for latest-checkpoint queries.
 */
export class CheckpointStore {
  private readonly insertCheckpointStmt: Database.Statement;
  private readonly getLatestCheckpointByTaskStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertCheckpointStmt = db.prepare(`
      INSERT INTO checkpoints (
        id, session_id, task_id, phase, phase_progress,
        context_summary, key_findings, open_questions, next_action,
        last_event_id, workspace_ref, reason, timestamp, journal_offset
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getLatestCheckpointByTaskStmt = db.prepare(
      "SELECT * FROM checkpoints WHERE task_id = ? ORDER BY rowid DESC LIMIT 1"
    );
  }

  createCheckpoint(input: CreateCheckpointInput): Checkpoint {
    const id = ulid();
    const now = new Date().toISOString();

    this.insertCheckpointStmt.run(
      id, input.sessionId, input.taskId, input.phase, input.phaseProgress,
      input.contextSummary,
      JSON.stringify(input.keyFindings), JSON.stringify(input.openQuestions),
      input.nextAction, input.lastEventId,
      input.workspaceRef ? JSON.stringify(input.workspaceRef) : null,
      input.reason, now, input.journalOffset,
    );

    return {
      id, session_id: input.sessionId, task_id: input.taskId,
      phase: input.phase, phase_progress: input.phaseProgress,
      context_summary: input.contextSummary,
      key_findings: input.keyFindings, open_questions: input.openQuestions,
      next_action: input.nextAction, last_event_id: input.lastEventId,
      workspace_ref: input.workspaceRef, reason: input.reason,
      timestamp: now, journal_offset: input.journalOffset,
    };
  }

  getLatestCheckpoint(taskId: string): Checkpoint | null {
    const row = this.getLatestCheckpointByTaskStmt.get(taskId) as CheckpointRow | undefined;
    return row ? rowToCheckpoint(row) : null;
  }
}
```

### 5F. `src/core/session-memory/knowledge.ts`

```typescript
import type Database from "better-sqlite3";
import type { KnowledgeEntry, KnowledgeScope } from "../../schemas/session-memory.js";
import { knowledgeId } from "../../schemas/session-memory.js";
import type { StoreKnowledgeInput } from "../interfaces/session-memory.interface.js";
import { type KnowledgeEntryRow, rowToKnowledgeEntry } from "./row-mappers.js";

/**
 * Persistent knowledge store: patterns and conventions learned across tasks.
 *
 * Uses content-hash IDs for idempotent upsert. Knowledge is isolated by scope
 * (repo/user) and optionally by repoScope for per-repository knowledge.
 */
export class KnowledgeStore {
  private readonly insertKnowledgeStmt: Database.Statement;
  private readonly getKnowledgeByIdStmt: Database.Statement;
  private readonly getActiveKnowledgeStmt: Database.Statement;
  private readonly getActiveKnowledgeRepoStmt: Database.Statement;
  private readonly supersedeKnowledgeStmt: Database.Statement;
  private readonly confirmKnowledgeStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.insertKnowledgeStmt = db.prepare(`
      INSERT INTO knowledge (
        id, scope, repo_scope, domain, key, body, confidence, evidence,
        created_at, last_confirmed, superseded_by, source_task_id, source_phase
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getKnowledgeByIdStmt = db.prepare("SELECT * FROM knowledge WHERE id = ?");
    this.getActiveKnowledgeStmt = db.prepare(
      "SELECT * FROM knowledge WHERE scope = ? AND superseded_by IS NULL ORDER BY created_at ASC"
    );
    this.getActiveKnowledgeRepoStmt = db.prepare(
      "SELECT * FROM knowledge WHERE scope = ? AND repo_scope = ? AND superseded_by IS NULL ORDER BY created_at ASC"
    );
    this.supersedeKnowledgeStmt = db.prepare("UPDATE knowledge SET superseded_by = ? WHERE id = ?");
    this.confirmKnowledgeStmt = db.prepare("UPDATE knowledge SET last_confirmed = ? WHERE id = ?");
  }

  storeKnowledge(input: StoreKnowledgeInput): KnowledgeEntry {
    const repoScope = input.repoScope ?? null;
    const id = knowledgeId(input.scope, repoScope, input.key, input.body);
    const now = new Date().toISOString();

    // Idempotent upsert: if content hash matches, just confirm
    const existing = this.getKnowledgeByIdStmt.get(id) as KnowledgeEntryRow | undefined;
    if (existing) {
      this.confirmKnowledgeStmt.run(now, id);
      return rowToKnowledgeEntry({ ...existing, last_confirmed: now });
    }

    this.insertKnowledgeStmt.run(
      id, input.scope, repoScope, input.domain, input.key, input.body,
      input.confidence, JSON.stringify(input.evidence),
      now, now, null, input.sourceTaskId, input.sourcePhase,
    );

    return {
      id, scope: input.scope, repo_scope: repoScope,
      domain: input.domain, key: input.key, body: input.body,
      confidence: input.confidence, evidence: input.evidence,
      created_at: now, last_confirmed: now, superseded_by: null,
      source_task_id: input.sourceTaskId, source_phase: input.sourcePhase,
    };
  }

  getKnowledge(scope: KnowledgeScope, repoScope?: string | null): KnowledgeEntry[] {
    const rows = repoScope != null
      ? (this.getActiveKnowledgeRepoStmt.all(scope, repoScope) as KnowledgeEntryRow[])
      : (this.getActiveKnowledgeStmt.all(scope) as KnowledgeEntryRow[]);
    return rows.map(rowToKnowledgeEntry);
  }

  supersedeKnowledge(oldId: string, newId: string): void {
    const result = this.supersedeKnowledgeStmt.run(newId, oldId);
    if (result.changes === 0) {
      throw new Error(`SessionMemory: knowledge entry "${oldId}" not found`);
    }
  }

  confirmKnowledge(id: string): void {
    const now = new Date().toISOString();
    const result = this.confirmKnowledgeStmt.run(now, id);
    if (result.changes === 0) {
      throw new Error(`SessionMemory: knowledge entry "${id}" not found`);
    }
  }
}
```

### 5G. `src/core/session-memory/index.ts` — Facade

```typescript
import type Database from "better-sqlite3";
import type {
  ISessionMemory, CreateSessionInput, AddJournalEntryInput,
  CreateCheckpointInput, StoreKnowledgeInput, JournalQueryFilters,
} from "../interfaces/session-memory.interface.js";
import type {
  Checkpoint, JournalEntry, KnowledgeEntry, KnowledgeScope,
  Session, SessionEndReason,
} from "../../schemas/session-memory.js";
import { SessionStore } from "./sessions.js";
import { JournalStore } from "./journal.js";
import { CheckpointStore } from "./checkpoints.js";
import { KnowledgeStore } from "./knowledge.js";

// Re-export types for backward compatibility
export type {
  CreateSessionInput, AddJournalEntryInput, CreateCheckpointInput,
  StoreKnowledgeInput, JournalQueryFilters,
} from "../interfaces/session-memory.interface.js";

// Re-export row mappers for backward compatibility
export {
  rowToSession, rowToJournalEntry, rowToCheckpoint, rowToKnowledgeEntry,
} from "./row-mappers.js";

/**
 * Persistence layer for the agent's working context and accumulated knowledge.
 *
 * Facade that delegates to four focused stores:
 * - SessionStore: session lifecycle and chain
 * - JournalStore: append-only reasoning log
 * - CheckpointStore: crash recovery snapshots
 * - KnowledgeStore: learned patterns and conventions
 */
export class SessionMemory implements ISessionMemory {
  private readonly sessions: SessionStore;
  private readonly journal: JournalStore;
  private readonly checkpoints: CheckpointStore;
  private readonly knowledge: KnowledgeStore;

  constructor(db: Database.Database) {
    this.sessions = new SessionStore(db);
    this.journal = new JournalStore(db);
    this.checkpoints = new CheckpointStore(db);
    this.knowledge = new KnowledgeStore(db);
  }

  // ── Session Lifecycle ──────────────────────────────────────────────────────
  createSession(input: CreateSessionInput): Session {
    return this.sessions.createSession(input);
  }
  endSession(id: string, reason: SessionEndReason): void {
    this.sessions.endSession(id, reason);
  }
  getSessionChain(taskId: string): Session[] {
    return this.sessions.getSessionChain(taskId);
  }

  // ── Journal ────────────────────────────────────────────────────────────────
  addJournalEntry(input: AddJournalEntryInput): JournalEntry {
    return this.journal.addJournalEntry(input);
  }
  queryJournal(taskId: string, filters?: JournalQueryFilters): JournalEntry[] {
    return this.journal.queryJournal(taskId, filters);
  }

  // ── Checkpoints ────────────────────────────────────────────────────────────
  createCheckpoint(input: CreateCheckpointInput): Checkpoint {
    return this.checkpoints.createCheckpoint(input);
  }
  getLatestCheckpoint(taskId: string): Checkpoint | null {
    return this.checkpoints.getLatestCheckpoint(taskId);
  }

  // ── Knowledge ──────────────────────────────────────────────────────────────
  storeKnowledge(input: StoreKnowledgeInput): KnowledgeEntry {
    return this.knowledge.storeKnowledge(input);
  }
  getKnowledge(scope: KnowledgeScope, repoScope?: string | null): KnowledgeEntry[] {
    return this.knowledge.getKnowledge(scope, repoScope);
  }
  supersedeKnowledge(oldId: string, newId: string): void {
    this.knowledge.supersedeKnowledge(oldId, newId);
  }
  confirmKnowledge(id: string): void {
    this.knowledge.confirmKnowledge(id);
  }
}
```

### 5H. Update Consumers

**`src/core/orchestrator/index.ts`:**
- Change `import { SessionMemory } from "../session-memory/index.js"` to use `ISessionMemory` from interfaces
- Change constructor/field type from `SessionMemory` to `ISessionMemory`

**`src/core/daemon/index.ts`:**
- Change SessionMemory import to `ISessionMemory`

**`src/cli/bootstrap.ts`:**
- No changes needed (still `new SessionMemory(...)`)

### 5I. Update Test Helper

**`test/helpers/test-session-memory.ts`:**
- Verify it still works. The `SessionMemory` constructor signature hasn't changed (just takes `db`).
- If any tests import `rowToSession` etc. directly from `session-memory/index.ts`, they still work because the facade re-exports them.

### 5J. New Test Files

Each new test file should test the sub-module in isolation by creating it directly with a test database.

**`src/core/session-memory/sessions.test.ts`:**
- Test createSession, endSession, getSessionChain
- Test session chaining (previousSessionId links)
- Test endSession on non-existent session throws

**`src/core/session-memory/journal.test.ts`:**
- Test addJournalEntry with all field combinations
- Test queryJournal with each filter type individually and combined
- Test tag AND semantics
- Test sanitizeSecrets is applied to summary, detail, errorDetail
- Test that dynamic SQL is correct for each filter permutation

**`src/core/session-memory/checkpoints.test.ts`:**
- Test createCheckpoint and getLatestCheckpoint
- Test that latest checkpoint is correctly determined by rowid ordering
- Test with multiple checkpoints for same task

**`src/core/session-memory/knowledge.test.ts`:**
- Test storeKnowledge idempotent upsert (same content hash = confirm, not duplicate)
- Test getKnowledge with and without repoScope
- Test supersedeKnowledge
- Test confirmKnowledge
- Test non-existent entry throws

Each test file needs to set up its own test database. Use `createTestDatabase()` from `test/helpers/test-database.ts` and create the sub-store directly:

```typescript
import { createTestDatabase } from "../../../test/helpers/test-database.js";
import { JournalStore } from "./journal.js";

describe("JournalStore", () => {
  let db: import("better-sqlite3").Database;
  let journal: JournalStore;
  let cleanup: () => void;

  beforeEach(() => {
    const testDb = createTestDatabase();
    db = testDb.db;
    journal = new JournalStore(db);
    cleanup = testDb.cleanup;
    // Insert a task row to satisfy FK constraints
    // (copy the pattern from test-session-memory.ts)
  });

  afterEach(() => cleanup());
  // ... tests
});
```

---

## 6. Refinement Checklist

- [ ] SessionStore has ONLY session lifecycle methods — no journal, checkpoint, or knowledge logic
- [ ] JournalStore has ONLY journal methods — no session or checkpoint logic
- [ ] CheckpointStore has ONLY checkpoint methods
- [ ] KnowledgeStore has ONLY knowledge methods
- [ ] Row mappers are in a separate file, are pure functions, have no side effects
- [ ] All row mapper exports are re-exported from index.ts for backward compat
- [ ] All input type exports are re-exported from index.ts for backward compat
- [ ] The `sanitizeSecrets` call is in JournalStore (not in the facade)
- [ ] Dynamic SQL in queryJournal uses parameterized queries (no string interpolation of values)
- [ ] No circular imports between sub-modules
- [ ] Enum constants from R0 are used where applicable (e.g., `SessionEndReasons.completed` instead of `"completed"`)

---

## 7. Verification Steps

```bash
# Type checking
npx tsc --noEmit

# All tests
pnpm test

# Run only session-memory tests
pnpm test src/core/session-memory/

# Lint
pnpm lint
```

---

## Commit

When all verification passes, run `/commit` to stage and commit your changes.
