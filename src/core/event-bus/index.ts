import type Database from "better-sqlite3";
import { ulid } from "ulid";

import type { Event, EventPayloads, EventType } from "../../schemas/events.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Input for publishing a known event type (type-safe payload). */
export interface PublishInput<T extends EventType> {
  type: T;
  source: string;
  task_id: string | null;
  payload: EventPayloads[T];
}

/** Input for publishing any event type (future/plugin event types). */
export interface PublishInputGeneral {
  type: string;
  source: string;
  task_id: string | null;
  payload: Record<string, unknown>;
}

/** Subscriber callback invoked when a matching event is published or replayed. */
export type EventCallback = (event: Event) => void;

interface SubscriptionRecord {
  subscriberId: string;
  pattern: string;
  callback: EventCallback;
}

interface EventRow {
  id: string;
  sequence: number;
  type: string;
  source: string;
  task_id: string | null;
  timestamp: string;
  payload: string;
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
export class EventBus {
  private readonly db: Database.Database;
  private readonly subscriptions: SubscriptionRecord[] = [];

  private readonly insertStmt: Database.Statement;
  private readonly byTaskStmt: Database.Statement;
  private readonly sinceStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(
      "INSERT INTO events (id, type, source, task_id, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.byTaskStmt = db.prepare("SELECT * FROM events WHERE task_id = ? ORDER BY sequence");
    this.sinceStmt = db.prepare("SELECT * FROM events WHERE sequence > ? ORDER BY sequence");
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
    for (let i = this.subscriptions.length - 1; i >= 0; i--) {
      if (this.subscriptions[i]?.subscriberId === subscriberId) {
        this.subscriptions.splice(i, 1);
      }
    }
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
    const rows = this.sinceStmt.all(fromSequence) as EventRow[];
    for (const row of rows) {
      this.deliver(this.rowToEvent(row));
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  /** Get all events for a task, ordered by sequence. */
  getEventsForTask(taskId: string): Event[] {
    const rows = this.byTaskStmt.all(taskId) as EventRow[];
    return rows.map((row) => this.rowToEvent(row));
  }

  /** Get all events with sequence > the given value, ordered by sequence. */
  getEventsSince(sequence: number): Event[] {
    const rows = this.sinceStmt.all(sequence) as EventRow[];
    return rows.map((row) => this.rowToEvent(row));
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private rowToEvent(row: EventRow): Event {
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

  private deliver(event: Event): void {
    for (const sub of this.subscriptions) {
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
