import type Database from "better-sqlite3";
import { ulid } from "ulid";

import type {
  Checkpoint,
  CheckpointReason,
  JournalEntry,
  JournalEntryType,
  KnowledgeConfidence,
  KnowledgeDomain,
  KnowledgeEntry,
  KnowledgeEvidence,
  KnowledgeScope,
  Session,
  SessionEndReason,
} from "../../schemas/session-memory.js";
import { knowledgeId } from "../../schemas/session-memory.js";

// ── Input Types ──────────────────────────────────────────────────────────────

/** Input for createSession(). Only caller-provided fields. */
export interface CreateSessionInput {
  taskId: string;
  previousSessionId?: string | null;
  resumedFromCheckpoint?: string | null;
}

/** Input for addJournalEntry(). */
export interface AddJournalEntryInput {
  sessionId: string;
  taskId: string;
  phase: string;
  type: JournalEntryType;
  summary: string;
  detail?: string | null;
  actionType?: string | null;
  findingType?: string | null;
  decisionKey?: string | null;
  errorDetail?: string | null;
  commTarget?: string | null;
  tags?: string[];
}

/** Input for createCheckpoint(). */
export interface CreateCheckpointInput {
  sessionId: string;
  taskId: string;
  phase: string;
  phaseProgress: string;
  contextSummary: string;
  keyFindings: string[];
  openQuestions: string[];
  nextAction: string;
  lastEventId: string;
  workspaceRef: { branch: string; last_commit: string } | null;
  reason: CheckpointReason;
  journalOffset: number;
}

/** Input for storeKnowledge(). */
export interface StoreKnowledgeInput {
  scope: KnowledgeScope;
  repoScope?: string | null;
  domain: KnowledgeDomain;
  key: string;
  body: string;
  confidence: KnowledgeConfidence;
  evidence: KnowledgeEvidence[];
  sourceTaskId: string;
  sourcePhase: string;
}

/** Filters for queryJournal(). All fields optional — omitted fields are not filtered. */
export interface JournalQueryFilters {
  type?: JournalEntryType;
  phase?: string;
  tags?: string[];
  since?: string;
}

// ── Row Types ────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  task_id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  previous_session_id: string | null;
  resumed_from_checkpoint: string | null;
}

interface JournalEntryRow {
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

interface CheckpointRow {
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

interface KnowledgeEntryRow {
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

// ── Row Mapping ──────────────────────────────────────────────────────────────

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

// ── SessionMemory ────────────────────────────────────────────────────────────

/**
 * Persistence layer for the agent's working context and accumulated knowledge.
 *
 * Pure database-backed storage — no Event Bus dependency. Owns three concerns:
 * - **Session journal**: append-only log of the Orchestrator's reasoning
 * - **Checkpoints**: named snapshots for crash recovery and session resume
 * - **Knowledge**: patterns and conventions learned across tasks, isolated by scope
 */
export class SessionMemory {
  private readonly db: Database.Database;

  // ── Prepared statements ──────────────────────────────────────────────────

  // Sessions
  private readonly insertSessionStmt: Database.Statement;
  private readonly endSessionStmt: Database.Statement;
  private readonly getSessionsByTaskStmt: Database.Statement;

  // Journal
  private readonly insertJournalStmt: Database.Statement;

  // Checkpoints
  private readonly insertCheckpointStmt: Database.Statement;
  private readonly getLatestCheckpointByTaskStmt: Database.Statement;

  // Knowledge
  private readonly insertKnowledgeStmt: Database.Statement;
  private readonly getKnowledgeByIdStmt: Database.Statement;
  private readonly getActiveKnowledgeStmt: Database.Statement;
  private readonly getActiveKnowledgeRepoStmt: Database.Statement;
  private readonly supersedeKnowledgeStmt: Database.Statement;
  private readonly confirmKnowledgeStmt: Database.Statement;
  private readonly updateKnowledgeLastConfirmedStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;

    // ── Session statements ────────────────────────────────────────────────
    this.insertSessionStmt = db.prepare(`
      INSERT INTO sessions (id, task_id, started_at, ended_at, end_reason, previous_session_id, resumed_from_checkpoint)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.endSessionStmt = db.prepare(
      "UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?",
    );

    this.getSessionsByTaskStmt = db.prepare(
      "SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at ASC",
    );

    // ── Journal statements ────────────────────────────────────────────────
    this.insertJournalStmt = db.prepare(`
      INSERT INTO journal_entries (
        id, session_id, task_id, timestamp, phase, type,
        summary, detail, action_type, finding_type, decision_key, error_detail, comm_target,
        tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // ── Checkpoint statements ─────────────────────────────────────────────
    this.insertCheckpointStmt = db.prepare(`
      INSERT INTO checkpoints (
        id, session_id, task_id, phase, phase_progress,
        context_summary, key_findings, open_questions, next_action,
        last_event_id, workspace_ref, reason, timestamp, journal_offset
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getLatestCheckpointByTaskStmt = db.prepare(
      "SELECT * FROM checkpoints WHERE task_id = ? ORDER BY rowid DESC LIMIT 1",
    );

    // ── Knowledge statements ──────────────────────────────────────────────
    this.insertKnowledgeStmt = db.prepare(`
      INSERT INTO knowledge (
        id, scope, repo_scope, domain, key, body, confidence, evidence,
        created_at, last_confirmed, superseded_by, source_task_id, source_phase
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getKnowledgeByIdStmt = db.prepare("SELECT * FROM knowledge WHERE id = ?");

    this.getActiveKnowledgeStmt = db.prepare(
      "SELECT * FROM knowledge WHERE scope = ? AND superseded_by IS NULL ORDER BY created_at ASC",
    );

    this.getActiveKnowledgeRepoStmt = db.prepare(
      "SELECT * FROM knowledge WHERE scope = ? AND repo_scope = ? AND superseded_by IS NULL ORDER BY created_at ASC",
    );

    this.supersedeKnowledgeStmt = db.prepare("UPDATE knowledge SET superseded_by = ? WHERE id = ?");

    this.confirmKnowledgeStmt = db.prepare("UPDATE knowledge SET last_confirmed = ? WHERE id = ?");

    this.updateKnowledgeLastConfirmedStmt = db.prepare(
      "UPDATE knowledge SET last_confirmed = ? WHERE id = ?",
    );
  }

  // ── Session Lifecycle ──────────────────────────────────────────────────────

  /**
   * Create a new session for a task.
   * Generates a ULID for the session ID and records the start time.
   */
  createSession(input: CreateSessionInput): Session {
    const id = ulid();
    const now = new Date().toISOString();
    const previousSessionId = input.previousSessionId ?? null;
    const resumedFromCheckpoint = input.resumedFromCheckpoint ?? null;

    this.insertSessionStmt.run(
      id,
      input.taskId,
      now,
      null, // ended_at
      null, // end_reason
      previousSessionId,
      resumedFromCheckpoint,
    );

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

  /**
   * End a session with a reason.
   * Throws if the session is not found.
   */
  endSession(id: string, reason: SessionEndReason): void {
    const now = new Date().toISOString();
    const result = this.endSessionStmt.run(now, reason, id);
    if (result.changes === 0) {
      throw new Error(`SessionMemory: session "${id}" not found`);
    }
  }

  // ── Journal ────────────────────────────────────────────────────────────────

  /**
   * Append a journal entry to a session.
   * Generates a ULID for the entry ID and records the current timestamp.
   */
  addJournalEntry(input: AddJournalEntryInput): JournalEntry {
    const id = ulid();
    const now = new Date().toISOString();
    const tags = input.tags ?? [];

    this.insertJournalStmt.run(
      id,
      input.sessionId,
      input.taskId,
      now,
      input.phase,
      input.type,
      input.summary,
      input.detail ?? null,
      input.actionType ?? null,
      input.findingType ?? null,
      input.decisionKey ?? null,
      input.errorDetail ?? null,
      input.commTarget ?? null,
      JSON.stringify(tags),
    );

    return {
      id,
      session_id: input.sessionId,
      task_id: input.taskId,
      timestamp: now,
      phase: input.phase,
      type: input.type,
      summary: input.summary,
      detail: input.detail ?? null,
      action_type: input.actionType ?? null,
      finding_type: input.findingType ?? null,
      decision_key: input.decisionKey ?? null,
      error_detail: input.errorDetail ?? null,
      comm_target: input.commTarget ?? null,
      tags,
    };
  }

  /**
   * Query journal entries for a task with optional filters.
   *
   * Uses dynamic SQL since filter permutations are exponential. All parameters
   * are bound — no injection risk. Tags use AND semantics: the entry must
   * contain all specified tags.
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

  // ── Checkpoints ────────────────────────────────────────────────────────────

  /**
   * Create a checkpoint — a named snapshot for crash recovery and session resume.
   * Generates a ULID for the checkpoint ID and records the current timestamp.
   */
  createCheckpoint(input: CreateCheckpointInput): Checkpoint {
    const id = ulid();
    const now = new Date().toISOString();

    this.insertCheckpointStmt.run(
      id,
      input.sessionId,
      input.taskId,
      input.phase,
      input.phaseProgress,
      input.contextSummary,
      JSON.stringify(input.keyFindings),
      JSON.stringify(input.openQuestions),
      input.nextAction,
      input.lastEventId,
      input.workspaceRef ? JSON.stringify(input.workspaceRef) : null,
      input.reason,
      now,
      input.journalOffset,
    );

    return {
      id,
      session_id: input.sessionId,
      task_id: input.taskId,
      phase: input.phase,
      phase_progress: input.phaseProgress,
      context_summary: input.contextSummary,
      key_findings: input.keyFindings,
      open_questions: input.openQuestions,
      next_action: input.nextAction,
      last_event_id: input.lastEventId,
      workspace_ref: input.workspaceRef,
      reason: input.reason,
      timestamp: now,
      journal_offset: input.journalOffset,
    };
  }

  /**
   * Get the most recent checkpoint for a task (across all sessions).
   * Returns null if no checkpoints exist.
   */
  getLatestCheckpoint(taskId: string): Checkpoint | null {
    const row = this.getLatestCheckpointByTaskStmt.get(taskId) as CheckpointRow | undefined;
    if (!row) {
      return null;
    }
    return rowToCheckpoint(row);
  }

  // ── Knowledge ──────────────────────────────────────────────────────────────

  /**
   * Store a knowledge entry.
   *
   * Generates a content-hash ID. If an entry with the same hash already exists,
   * updates `last_confirmed` instead of inserting a duplicate. Returns the entry.
   */
  storeKnowledge(input: StoreKnowledgeInput): KnowledgeEntry {
    const repoScope = input.repoScope ?? null;
    const id = knowledgeId(input.scope, repoScope, input.key, input.body);
    const now = new Date().toISOString();

    // Check if entry already exists (idempotent upsert)
    const existing = this.getKnowledgeByIdStmt.get(id) as KnowledgeEntryRow | undefined;
    if (existing) {
      this.updateKnowledgeLastConfirmedStmt.run(now, id);
      return rowToKnowledgeEntry({ ...existing, last_confirmed: now });
    }

    this.insertKnowledgeStmt.run(
      id,
      input.scope,
      repoScope,
      input.domain,
      input.key,
      input.body,
      input.confidence,
      JSON.stringify(input.evidence),
      now, // created_at
      now, // last_confirmed
      null, // superseded_by
      input.sourceTaskId,
      input.sourcePhase,
    );

    return {
      id,
      scope: input.scope,
      repo_scope: repoScope,
      domain: input.domain,
      key: input.key,
      body: input.body,
      confidence: input.confidence,
      evidence: input.evidence,
      created_at: now,
      last_confirmed: now,
      superseded_by: null,
      source_task_id: input.sourceTaskId,
      source_phase: input.sourcePhase,
    };
  }

  /**
   * Get active knowledge entries (not superseded) for a scope.
   * When repoScope is provided, filters to that specific repository.
   */
  getKnowledge(scope: KnowledgeScope, repoScope?: string | null): KnowledgeEntry[] {
    const rows =
      repoScope != null
        ? (this.getActiveKnowledgeRepoStmt.all(scope, repoScope) as KnowledgeEntryRow[])
        : (this.getActiveKnowledgeStmt.all(scope) as KnowledgeEntryRow[]);
    return rows.map(rowToKnowledgeEntry);
  }

  /**
   * Mark an old knowledge entry as superseded by a new one.
   * Throws if the old entry is not found.
   */
  supersedeKnowledge(oldId: string, newId: string): void {
    const result = this.supersedeKnowledgeStmt.run(newId, oldId);
    if (result.changes === 0) {
      throw new Error(`SessionMemory: knowledge entry "${oldId}" not found`);
    }
  }

  /**
   * Update the last_confirmed timestamp on a knowledge entry.
   * Throws if the entry is not found.
   */
  confirmKnowledge(id: string): void {
    const now = new Date().toISOString();
    const result = this.confirmKnowledgeStmt.run(now, id);
    if (result.changes === 0) {
      throw new Error(`SessionMemory: knowledge entry "${id}" not found`);
    }
  }

  // ── Session Chain ──────────────────────────────────────────────────────────

  /**
   * Get all sessions for a task, ordered by start time.
   * The chain linkage (previous_session_id) is available in the returned data.
   */
  getSessionChain(taskId: string): Session[] {
    const rows = this.getSessionsByTaskStmt.all(taskId) as SessionRow[];
    return rows.map(rowToSession);
  }
}
