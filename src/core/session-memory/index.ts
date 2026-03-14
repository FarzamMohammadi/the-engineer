import type Database from "better-sqlite3";

import type {
  Checkpoint,
  JournalEntry,
  KnowledgeEntry,
  KnowledgeScope,
  Session,
  SessionEndReason,
} from "../../schemas/session-memory.js";
import type {
  AddJournalEntryInput,
  CreateCheckpointInput,
  CreateSessionInput,
  ISessionMemory,
  JournalQueryFilters,
  StoreKnowledgeInput,
} from "../interfaces/session-memory.interface.js";
import { CheckpointStore } from "./checkpoints.js";
import { JournalStore } from "./journal.js";
import { KnowledgeStore } from "./knowledge.js";
import { SessionStore } from "./sessions.js";

// Re-export interface types so existing consumers don't break
export type {
  AddJournalEntryInput,
  CreateCheckpointInput,
  CreateSessionInput,
  JournalQueryFilters,
  StoreKnowledgeInput,
} from "../interfaces/session-memory.interface.js";

// Re-export row mappers for backward compatibility
export {
  rowToCheckpoint,
  rowToJournalEntry,
  rowToKnowledgeEntry,
  rowToSession,
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
