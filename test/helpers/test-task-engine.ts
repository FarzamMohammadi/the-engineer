import { EventBus, type EventRow, rowToEvent } from "../../src/core/event-bus/index.js";
import { TaskEngine } from "../../src/core/task-engine/index.js";
import type { Event } from "../../src/schemas/events.js";
import { type TestDatabaseHandle, createTestDatabase } from "./test-database.js";
import { createTestObserverFacade } from "./test-observer-facade.js";

export interface TestTaskEngineHandle {
  engine: TaskEngine;
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
 * Creates a fresh TaskEngine backed by an in-memory database with all migrations applied.
 *
 * Used by Task Engine tests and consuming phase tests (Safety Layer, Action Pipeline, etc.)
 * to verify task operations and event emissions without managing DB lifecycle directly.
 */
export function createTestTaskEngine(): TestTaskEngineHandle {
  const testDb: TestDatabaseHandle = createTestDatabase();
  const observer = createTestObserverFacade("event-bus");
  const eventBus = new EventBus(testDb.db, { observer });
  const engine = new TaskEngine(testDb.db, eventBus, observer.child("task-engine"));

  const allEventsStmt = testDb.db.prepare("SELECT * FROM events ORDER BY sequence");
  const eventsByTypeStmt = testDb.db.prepare(
    "SELECT * FROM events WHERE type = ? ORDER BY sequence",
  );

  return {
    engine,
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
