import type { CheckpointReason, JournalEntryType } from "../../schemas/session-memory.js";

/** Input for journal.addEntry(). */
export interface AddJournalEntryInput {
  sessionId: string;
  taskId: string;
  phase: string;
  type: JournalEntryType;
  summary: string;
  detail?: string | null;
  errorDetail?: string | null;
  tags?: string[];
}

/** Input for checkpoints.create(). */
export interface CreateCheckpointInput {
  sessionId: string;
  taskId: string;
  phase: string;
  subPhase: string | null;
  phaseIteration: number;
  totalReworks: number;
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
