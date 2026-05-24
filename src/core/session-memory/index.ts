import type Database from "better-sqlite3";

import { CheckpointStore } from "./checkpoints.js";
import { JournalStore } from "./journal.js";
import { SessionStore } from "./sessions.js";

/**
 * Persistence layer for the agent's working context.
 *
 * Namespace grouping three focused stores that share a database and lifetime:
 * - sessions: session lifecycle (create, end)
 * - journal: append-only reasoning log
 * - checkpoints: crash recovery snapshots
 */
export class SessionMemory {
  readonly sessions: SessionStore;
  readonly journal: JournalStore;
  readonly checkpoints: CheckpointStore;

  constructor(db: Database.Database) {
    this.sessions = new SessionStore(db);
    this.journal = new JournalStore(db);
    this.checkpoints = new CheckpointStore(db);
  }
}
