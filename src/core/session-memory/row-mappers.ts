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
