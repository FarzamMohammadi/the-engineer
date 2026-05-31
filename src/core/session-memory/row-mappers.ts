import { fromSqliteJson } from "../../db/serialize.js";
import type { Checkpoint, CheckpointReason, JournalEntry, JournalEntryType } from "../../schemas/session-memory.js";

// ── Row Types ────────────────────────────────────────────────────────────────

export interface JournalEntryRow {
  id: string;
  session_id: string;
  task_id: string;
  timestamp: string;
  phase: string;
  type: string;
  summary: string;
  detail: string | null;
  error_detail: string | null;
  tags: string;
}

export interface CheckpointRow {
  id: string;
  session_id: string;
  task_id: string;
  phase: string;
  sub_phase: string | null;
  phase_iteration: number;
  total_reworks: number;
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

// ── Mappers (pure functions) ─────────────────────────────────────────────────

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
    error_detail: row.error_detail,
    tags: fromSqliteJson<string[]>(row.tags) ?? [],
  };
}

/** Convert a `checkpoints` table row to a typed Checkpoint object. */
export function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    session_id: row.session_id,
    task_id: row.task_id,
    phase: row.phase,
    sub_phase: row.sub_phase,
    phase_iteration: row.phase_iteration,
    total_reworks: row.total_reworks,
    phase_progress: row.phase_progress,
    context_summary: row.context_summary,
    key_findings: fromSqliteJson<string[]>(row.key_findings) ?? [],
    open_questions: fromSqliteJson<string[]>(row.open_questions) ?? [],
    next_action: row.next_action,
    last_event_id: row.last_event_id,
    workspace_ref: fromSqliteJson<{ branch: string; last_commit: string }>(row.workspace_ref),
    reason: row.reason as CheckpointReason,
    timestamp: row.timestamp,
    journal_offset: row.journal_offset,
  };
}
