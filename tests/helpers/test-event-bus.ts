import { EventBus, type EventRow, rowToEvent } from "../../src/core/event-bus/index.js";
import { EventTopology } from "../../src/core/event-bus/topology.js";
import type { Event } from "../../src/schemas/events.js";

import { EVENTS as ACTION_PIPELINE_EVENTS } from "../../src/core/action-pipeline/index.js";
import { EVENTS as DAEMON_EVENTS } from "../../src/core/daemon/index.js";
import { EVENTS as ORCHESTRATOR_EVENTS } from "../../src/core/orchestrator/index.js";
import { EVENTS as REGISTRY_EVENTS } from "../../src/core/registry/index.js";
import { EVENTS as SAFETY_LAYER_EVENTS } from "../../src/core/safety-layer/index.js";
import { EVENTS as TASK_ENGINE_EVENTS } from "../../src/core/task-engine/index.js";
import { EVENTS as WORKSPACE_MANAGER_EVENTS } from "../../src/core/workspace-manager/index.js";
import { type TestDatabaseHandle, createTestDatabase } from "./test-database.js";
import { createTestObserverFacade } from "./test-observer-facade.js";

/** Create an EventTopology pre-loaded with all component event declarations. */
export function createTestTopology(): EventTopology {
  const topology = new EventTopology();
  topology.registerPublisher("task-engine", TASK_ENGINE_EVENTS);
  topology.registerPublisher("action-pipeline", ACTION_PIPELINE_EVENTS);
  topology.registerPublisher("safety-layer", SAFETY_LAYER_EVENTS);
  topology.registerPublisher("workspace-manager", WORKSPACE_MANAGER_EVENTS);
  topology.registerPublisher("registry", REGISTRY_EVENTS);
  topology.registerPublisher("orchestrator", ORCHESTRATOR_EVENTS);
  topology.registerPublisher("daemon", DAEMON_EVENTS);
  return topology;
}

export interface TestEventBusHandle {
  eventBus: EventBus;
  topology: EventTopology;

  /** Get all emitted events, optionally filtered by type. Reads from DB (source of truth). */
  getEmittedEvents(type?: string): Event[];

  /**
   * Assert that at least one event of the given type was emitted.
   * Optionally checks that at least one event's payload matches the predicate.
   * Throws a clear error if no matching event is found.
   */
  assertEventEmitted(type: string, payloadMatcher?: (payload: Record<string, unknown>) => boolean): void;

  /** Close the database. Call in afterEach. */
  cleanup(): void;
}

/**
 * Creates a fresh EventBus backed by an in-memory database with all migrations applied.
 *
 * Used by consuming phase tests (Task Engine, Safety Layer, etc.) to verify
 * event emissions without managing DB lifecycle directly.
 *
 * Includes a fully-loaded EventTopology with validateOnPublish enabled,
 * so any invalid payloads are caught immediately in tests.
 */
export function createTestEventBus(): TestEventBusHandle {
  const testDb: TestDatabaseHandle = createTestDatabase();
  const topology = createTestTopology();
  const observer = createTestObserverFacade("event-bus");
  const eventBus = new EventBus(testDb.db, { observer, topology, validateOnPublish: true });

  const allEventsStmt = testDb.db.prepare("SELECT * FROM events ORDER BY sequence");
  const eventsByTypeStmt = testDb.db.prepare("SELECT * FROM events WHERE type = ? ORDER BY sequence");

  return {
    eventBus,
    topology,

    getEmittedEvents(type?: string): Event[] {
      const rows = (type ? eventsByTypeStmt.all(type) : allEventsStmt.all()) as EventRow[];
      return rows.map(rowToEvent);
    },

    assertEventEmitted(type: string, payloadMatcher?: (payload: Record<string, unknown>) => boolean): void {
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
