import type { z } from "zod";

import { EventBus, type EventRow, rowToEvent } from "../../src/core/event-bus/index.js";
import { SafetyLayer } from "../../src/core/safety-layer/index.js";
import { SafetyConfigSchema } from "../../src/schemas/config.js";
import type { CostIncurredPayload } from "../../src/schemas/events.js";
import type { Event } from "../../src/schemas/events.js";
import { type TestDatabaseHandle, createTestDatabase } from "./test-database.js";
import { createTestObserverFacade } from "./test-observer-facade.js";

/** Zod input type — allows partial nested objects that get filled by defaults. */
type SafetyConfigInput = z.input<typeof SafetyConfigSchema>;

export interface TestSafetyLayerHandle {
  safetyLayer: SafetyLayer;
  eventBus: EventBus;
  db: import("better-sqlite3").Database;

  /** Get all emitted events, optionally filtered by type. Reads from DB. */
  getEmittedEvents(type?: string): Event[];

  /** Assert that at least one event of the given type was emitted. */
  assertEventEmitted(
    type: string,
    payloadMatcher?: (payload: Record<string, unknown>) => boolean,
  ): void;

  /** Convenience: publish a cost.incurred event with sensible defaults. */
  simulateCostEvent(overrides?: Partial<CostIncurredPayload>): Event;

  /** Close the database. Call in afterEach. */
  cleanup(): void;
}

/**
 * Creates a fresh SafetyLayer backed by an in-memory database.
 *
 * Accepts partial SafetyConfig overrides — missing fields use schema defaults.
 */
export function createTestSafetyLayer(configOverrides?: SafetyConfigInput): TestSafetyLayerHandle {
  const testDb: TestDatabaseHandle = createTestDatabase();
  const observer = createTestObserverFacade("event-bus");
  const eventBus = new EventBus(testDb.db, { observer });

  const config = SafetyConfigSchema.parse(configOverrides ?? {});
  const safetyLayer = new SafetyLayer(
    testDb.db,
    eventBus,
    config,
    createTestObserverFacade("safety-layer"),
  );

  const allEventsStmt = testDb.db.prepare("SELECT * FROM events ORDER BY sequence");
  const eventsByTypeStmt = testDb.db.prepare(
    "SELECT * FROM events WHERE type = ? ORDER BY sequence",
  );

  return {
    safetyLayer,
    eventBus,
    db: testDb.db,

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

    simulateCostEvent(overrides?: Partial<CostIncurredPayload>): Event {
      const defaults: CostIncurredPayload = {
        task_id: "task-1",
        repo: "owner/repo",
        provider_id: "claude-api",
        operation: "llm_call",
        spend_usd: 0.01,
        duration_ms: null,
      };
      const payload = { ...defaults, ...overrides };

      return eventBus.publish({
        type: "cost.incurred" as const,
        source: "test",
        task_id: payload.task_id,
        payload,
      });
    },

    cleanup() {
      testDb.cleanup();
    },
  };
}
