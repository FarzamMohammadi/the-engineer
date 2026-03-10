import type Database from "better-sqlite3";
import { createInMemoryDatabase } from "../../src/db/database.js";

export interface TestDatabaseHandle {
  db: Database.Database;
  cleanup(): void;
}

/**
 * Creates a fresh in-memory database with all migrations applied.
 * Call `cleanup()` when done to close the connection.
 */
export function createTestDatabase(): TestDatabaseHandle {
  const handle = createInMemoryDatabase();
  return {
    db: handle.db,
    cleanup() {
      handle.close();
    },
  };
}
