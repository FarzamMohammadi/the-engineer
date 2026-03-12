/**
 * Test helper for ObservabilityStore — in-memory DB + temp dir blob store.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlobStore } from "../../src/core/observability/blob-store.js";
import { ObservabilityStore } from "../../src/core/observability/index.js";
import { createInMemoryDatabase } from "../../src/db/database.js";
import type { DatabaseHandle } from "../../src/db/database.js";

export interface TestObservabilityHandle {
  store: ObservabilityStore;
  blobStore: BlobStore;
  db: DatabaseHandle;
  tracesDir: string;
  cleanup: () => void;
}

/** Create a test ObservabilityStore backed by in-memory SQLite + temp dir. */
export function createTestObservabilityStore(): TestObservabilityHandle {
  const db = createInMemoryDatabase();
  const tracesDir = mkdtempSync(join(tmpdir(), "engineer-traces-test-"));
  const blobStore = new BlobStore(tracesDir);
  const store = new ObservabilityStore(db.db, blobStore);

  return {
    store,
    blobStore,
    db,
    tracesDir,
    cleanup() {
      db.close();
      rmSync(tracesDir, { recursive: true, force: true });
    },
  };
}

/** Insert a minimal task row so FK constraints pass. */
export function insertTestTask(db: DatabaseHandle, taskId: string): void {
  const now = new Date().toISOString();
  db.db
    .prepare(
      `INSERT INTO tasks (id, state, title, children, cascade_policy, description, source_text,
        acceptance_criteria, team, related, decisions, child_summaries, created_at, last_transition_at)
       VALUES (?, 'active', 'Test Task', '[]', 'pause_siblings', '', '', '[]', '[]', '[]', '[]', '[]', ?, ?)`,
    )
    .run(taskId, now, now);
}

/** Insert a minimal session row so FK constraints pass. */
export function insertTestSession(db: DatabaseHandle, sessionId: string, taskId: string): void {
  db.db
    .prepare(
      `INSERT INTO sessions (id, task_id, started_at)
       VALUES (?, ?, ?)`,
    )
    .run(sessionId, taskId, new Date().toISOString());
}
