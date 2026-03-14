import type Database from "better-sqlite3";
import { ulid } from "ulid";

import type { Event, EventType } from "../../schemas/events.js";
import type {
  EventCallback,
  IEventBus,
  PublishInput,
  PublishInputGeneral,
} from "../interfaces/event-bus.interface.js";
import type { EventTopology } from "./topology.js";

// Re-export interface types so existing consumers don't break
export type {
  EventCallback,
  PublishInput,
  PublishInputGeneral,
} from "../interfaces/event-bus.interface.js";

interface SubscriptionRecord {
  subscriberId: string;
  pattern: string;
  callback: EventCallback;
}

/** Shape of a row read from the `events` table. Exported for test helpers. */
export interface EventRow {
  id: string;
  sequence: number;
  type: string;
  source: string;
  task_id: string | null;
  timestamp: string;
  payload: string;
}

// ── Row Mapping ──────────────────────────────────────────────────────────────

/** Convert an `events` table row to an `Event` object (parses JSON payload). */
export function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    sequence: row.sequence,
    type: row.type,
    source: row.source,
    task_id: row.task_id,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

// ── Pattern Matching ──────────────────────────────────────────────────────────

/**
 * Tests whether an event type matches a subscription pattern.
 *
 * - `"*"` matches any event type
 * - `"task.*"` matches `"task.created"`, `"task.state_changed"` (one segment after dot)
 * - `"task.*"` does NOT match `"task.state.deep"` (segment count must match)
 * - `"*.created"` matches `"task.created"` but not `"task.state_changed"`
 */
export function matchesPattern(pattern: string, eventType: string): boolean {
  if (pattern === "*") {
    return true;
  }
  const patternParts = pattern.split(".");
  const typeParts = eventType.split(".");
  if (patternParts.length !== typeParts.length) {
    return false;
  }
  return patternParts.every((p, i) => p === "*" || p === typeParts[i]);
}

// ── EventBus ──────────────────────────────────────────────────────────────────

/**
 * In-process pub/sub with SQLite persistence.
 *
 * The Event Bus is Core (structural) — the event stream IS the audit trail.
 * Every event is persisted before delivery. Subscribers execute synchronously.
 * If a subscriber throws, the error is logged and delivery continues to
 * remaining subscribers. DB failures propagate (Event Bus down = system halt).
 */
/** Options for EventBus construction. */
export interface EventBusOptions {
  /** Event topology for runtime payload validation. */
  topology?: EventTopology;
  /** When true, validate payloads against topology schemas on publish. Default: false. */
  validateOnPublish?: boolean;
}

export class EventBus implements IEventBus {
  private readonly db: Database.Database;
  private subscriptions: SubscriptionRecord[] = [];
  private readonly topology: EventTopology | undefined;
  private readonly validateOnPublish: boolean;

  private readonly insertStmt: Database.Statement;
  private readonly byTaskStmt: Database.Statement;
  private readonly sinceStmt: Database.Statement;
  private readonly sinceLimitStmt: Database.Statement;

  constructor(db: Database.Database, options?: EventBusOptions) {
    this.db = db;
    this.topology = options?.topology;
    this.validateOnPublish = options?.validateOnPublish ?? false;
    this.insertStmt = db.prepare(
      "INSERT INTO events (id, type, source, task_id, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.byTaskStmt = db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY sequence");
    this.sinceStmt = db.prepare("SELECT * FROM events WHERE sequence > ? ORDER BY sequence");
    this.sinceLimitStmt = db.prepare(
      "SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?",
    );
  }

  // ── Publishing ──────────────────────────────────────────────────────────────

  /**
   * Publish a typed event (known EventType — compile-time payload safety).
   */
  publish<T extends EventType>(input: PublishInput<T>): Event;
  /**
   * Publish a general event (unknown/future event types from plugins).
   */
  publish(input: PublishInputGeneral): Event;
  publish(input: PublishInputGeneral): Event {
    if (this.validateOnPublish && this.topology) {
      const validation = this.topology.validatePayload(
        input.type,
        input.payload as Record<string, unknown>,
      );
      if (!validation.valid) {
        const msg = `EventBus: payload validation failed for "${input.type}": ${validation.errors?.join(", ")}`;
        if (process.env["NODE_ENV"] === "test") {
          throw new Error(msg);
        }
        console.warn(msg);
      }
    }

    const id = ulid();
    const timestamp = new Date().toISOString();
    const payloadJson = JSON.stringify(input.payload);

    const result = this.insertStmt.run(
      id,
      input.type,
      input.source,
      input.task_id,
      timestamp,
      payloadJson,
    );

    const sequence = Number(result.lastInsertRowid);

    const event: Event = {
      id,
      sequence,
      type: input.type,
      source: input.source,
      task_id: input.task_id,
      timestamp,
      payload: input.payload as Record<string, unknown>,
    };

    this.deliver(event);

    return event;
  }

  // ── Subscribing ─────────────────────────────────────────────────────────────

  /**
   * Register a subscriber for events matching the given pattern.
   *
   * Patterns: exact type (`"task.created"`), glob (`"task.*"`), or `"*"` for all.
   * A subscriber can have multiple subscriptions (different patterns).
   */
  subscribe(subscriberId: string, eventType: string, callback: EventCallback): void {
    this.subscriptions.push({ subscriberId, pattern: eventType, callback });
  }

  /**
   * Remove all subscriptions for the given subscriber.
   * No-op if the subscriber has no subscriptions.
   */
  unsubscribe(subscriberId: string): void {
    this.subscriptions = this.subscriptions.filter((s) => s.subscriberId !== subscriberId);
  }

  // ── Replay ──────────────────────────────────────────────────────────────────

  /**
   * Replay persisted events to current subscribers for state reconstruction.
   *
   * Reads events with sequence > fromSequence from the DB and delivers them
   * to matching subscribers in sequence order. Used on startup by components
   * that rebuild state from the event log (e.g., Safety Layer cost accumulators).
   */
  replay(fromSequence: number): void {
    for (const row of this.sinceStmt.iterate(fromSequence) as IterableIterator<EventRow>) {
      this.deliver(rowToEvent(row));
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  /** Get all events for a task, ordered by sequence. */
  getEventsForTask(taskId: string): Event[] {
    const rows = this.byTaskStmt.all(taskId) as EventRow[];
    return rows.map(rowToEvent);
  }

  /** Get all events with sequence > the given value, ordered by sequence. */
  getEventsSince(sequence: number, limit?: number): Event[] {
    const rows =
      limit != null
        ? (this.sinceLimitStmt.all(sequence, limit) as EventRow[])
        : (this.sinceStmt.all(sequence) as EventRow[]);
    return rows.map(rowToEvent);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private deliver(event: Event): void {
    // Snapshot: safe if a callback calls subscribe() or unsubscribe() mid-delivery
    const snapshot = this.subscriptions;
    for (const sub of snapshot) {
      if (matchesPattern(sub.pattern, event.type)) {
        try {
          sub.callback(event);
        } catch (error) {
          console.error(
            `EventBus: subscriber "${sub.subscriberId}" threw on event "${event.type}":`,
            error,
          );
        }
      }
    }
  }
}
