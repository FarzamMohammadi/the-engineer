import { EventBus, type EventRow, rowToEvent } from "../../src/core/event-bus/index.js";
import type { Event } from "../../src/schemas/events.js";
import { type TestDatabaseHandle, createTestDatabase } from "./test-database.js";

export interface TestEventBusHandle {
  eventBus: EventBus;

  /** Get all emitted events, optionally filtered by type. Reads from DB (source of truth). */
  getEmittedEvents(type?: string): Event[];

  /**
   * Assert that at least one event of the given type was emitted.
   * Optionally checks that at least one event's payload matches the predicate.
   * Throws a clear error if no matching event is found.
   */
  assertEventEmitted(
    type: string,
    payloadMatcher?: (payload: Record<string, unknown>) => boolean,
  ): void;

  /** Close the database. Call in afterEach. */
  cleanup(): void;
}

/**
 * Creates a fresh EventBus backed by an in-memory database with all migrations applied.
 *
 * Used by consuming phase tests (Task Engine, Safety Layer, etc.) to verify
 * event emissions without managing DB lifecycle directly.
 */
export function createTestEventBus(): TestEventBusHandle {
  const testDb: TestDatabaseHandle = createTestDatabase();
  const eventBus = new EventBus(testDb.db);

  const allEventsStmt = testDb.db.prepare("SELECT * FROM events ORDER BY sequence");
  const eventsByTypeStmt = testDb.db.prepare(
    "SELECT * FROM events WHERE type = ? ORDER BY sequence",
  );

  return {
    eventBus,

    getEmittedEvents(type?: string): Event[] {
      const rows = (type ? eventsByTypeStmt.all(type) : allEventsStmt.all()) as EventRow[];
      return rows.map(rowToEvent);
    },

    assertEventEmitted(
      type: string,
      payloadMatcher?: (payload: Record<string, unknown>) => boolean,
    ): void {
      const events = this.getEmittedEvents(type);
      if (events.length === 0) {
        throw new Error(`Expected event "${type}" to be emitted, but none were found`);
      }
      if (payloadMatcher) {
        const match = events.some((e) => payloadMatcher(e.payload));
        if (!match) {
          throw new Error(
            `Event "${type}" was emitted ${events.length} time(s), but none matched the payload predicate`,
          );
        }
      }
    },

    cleanup() {
      testDb.cleanup();
    },
  };
}
