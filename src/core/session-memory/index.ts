import type Database from "better-sqlite3";

import type { Checkpoint, JournalEntry, Session, SessionEndReason } from "../../schemas/session-memory.js";
import type {
  AddJournalEntryInput,
  CreateCheckpointInput,
  CreateSessionInput,
  ISessionMemory,
  JournalQueryFilters,
} from "../interfaces/session-memory.interface.js";
import { CheckpointStore } from "./checkpoints.js";
import { JournalStore } from "./journal.js";
import { SessionStore } from "./sessions.js";

/**
 * Persistence layer for the agent's working context.
 *
 * Facade that delegates to three focused stores:
 * - SessionStore: session lifecycle and chain
 * - JournalStore: append-only reasoning log
 * - CheckpointStore: crash recovery snapshots
 */
export class SessionMemory implements ISessionMemory {
  private readonly sessions: SessionStore;
  private readonly journal: JournalStore;
  private readonly checkpoints: CheckpointStore;

  constructor(db: Database.Database) {
    this.sessions = new SessionStore(db);
    this.journal = new JournalStore(db);
    this.checkpoints = new CheckpointStore(db);
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
  getLatestJournalTimestamp(taskId: string): string | null {
    return this.journal.getLatestJournalTimestamp(taskId);
  }

  // ── Checkpoints ────────────────────────────────────────────────────────────
  createCheckpoint(input: CreateCheckpointInput): Checkpoint {
    return this.checkpoints.createCheckpoint(input);
  }
  getLatestCheckpoint(taskId: string): Checkpoint | null {
    return this.checkpoints.getLatestCheckpoint(taskId);
  }
}
