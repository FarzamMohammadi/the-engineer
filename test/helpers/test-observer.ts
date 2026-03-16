/**
 * Test helper for Observer — in-memory DB + temp dir blob store.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlobStore } from "../../src/core/observability/blob-store.js";
import { type ObservationStore, createObservationStore } from "../../src/core/observer/index.js";
import { createInMemoryDatabase } from "../../src/db/database.js";
import type { DatabaseHandle } from "../../src/db/database.js";

export interface TestObserverHandle {
  observer: ObservationStore;
  db: DatabaseHandle;
  tracesDir: string;
  cleanup: () => void;
}

/** Create a test Observer backed by in-memory SQLite + temp dir. */
export function createTestObserver(): TestObserverHandle {
  const db = createInMemoryDatabase();
  const tracesDir = mkdtempSync(join(tmpdir(), "engineer-observer-test-"));
  const blobStore = new BlobStore(tracesDir);
  const observer = createObservationStore(db.db, blobStore);

  return {
    observer,
    db,
    tracesDir,
    cleanup() {
      db.close();
      rmSync(tracesDir, { recursive: true, force: true });
    },
  };
}
