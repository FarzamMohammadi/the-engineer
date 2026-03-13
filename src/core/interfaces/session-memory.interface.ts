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

export interface ISessionMemory {
  createSession(input: CreateSessionInput): Session;
  endSession(id: string, reason: SessionEndReason): void;
  addJournalEntry(input: AddJournalEntryInput): JournalEntry;
  queryJournal(taskId: string, filters?: JournalQueryFilters): JournalEntry[];
  createCheckpoint(input: CreateCheckpointInput): Checkpoint;
  getLatestCheckpoint(taskId: string): Checkpoint | null;
  storeKnowledge(input: StoreKnowledgeInput): KnowledgeEntry;
  getKnowledge(scope: KnowledgeScope, repoScope?: string | null): KnowledgeEntry[];
  supersedeKnowledge(oldId: string, newId: string): void;
  confirmKnowledge(id: string): void;
  getSessionChain(taskId: string): Session[];
}
