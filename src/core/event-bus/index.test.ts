import { afterEach, describe, expect, it, vi } from "vitest";

import type Database from "better-sqlite3";

import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { createInMemoryDatabase } from "../../db/database.js";
import type { Event } from "../../schemas/events.js";
import { EventBus, type EventRow, matchesPattern, rowToEvent } from "./index.js";

const ULID_PATTERN = /^[0-9A-Z]{26}$/;
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ── rowToEvent ────────────────────────────────────────────────────────────────

describe("rowToEvent", () => {
  const baseRow: EventRow = {
    id: "01ABC",
    sequence: 1,
    type: "task.created",
    source: "test",
    task_id: "task-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: '{"key":"value"}',
  };

  it("parses valid JSON payload", () => {
    const event = rowToEvent(baseRow);
    expect(event.payload).toEqual({ key: "value" });
    expect(event.id).toBe("01ABC");
    expect(event.type).toBe("task.created");
  });

  it("returns fallback payload for corrupted JSON", () => {
    const row = { ...baseRow, payload: "{not valid json" };
    const event = rowToEvent(row);
    expect(event.payload).toEqual({
      _parse_error: true,
      _raw: "{not valid json",
    });
    expect(event.id).toBe("01ABC");
    expect(event.type).toBe("task.created");
  });

  it("returns fallback payload for empty string", () => {
    const row = { ...baseRow, payload: "" };
    const event = rowToEvent(row);
    expect(event.payload).toEqual({
      _parse_error: true,
      _raw: "",
    });
  });

  it("truncates raw payload in fallback to 200 characters", () => {
    const longPayload = "x".repeat(300);
    const row = { ...baseRow, payload: longPayload };
    const event = rowToEvent(row);
    expect(event.payload["_raw"]).toHaveLength(200);
  });
});

// ── matchesPattern ────────────────────────────────────────────────────────────

describe("matchesPattern", () => {
  it("matches exact event type", () => {
    expect(matchesPattern("task.created", "task.created")).toBe(true);
  });

  it("does not match different exact type", () => {
    expect(matchesPattern("task.created", "git.pushed")).toBe(false);
  });

  it("matches glob with wildcard segment", () => {
    expect(matchesPattern("task.*", "task.created")).toBe(true);
    expect(matchesPattern("task.*", "task.state_changed")).toBe(true);
  });

  it("does not match glob across different groups", () => {
    expect(matchesPattern("task.*", "git.pushed")).toBe(false);
  });

  it("does not match glob with wrong segment count", () => {
    expect(matchesPattern("task.*", "task.state.deep")).toBe(false);
  });

  it("matches wildcard in first segment", () => {
    expect(matchesPattern("*.created", "task.created")).toBe(true);
    expect(matchesPattern("*.created", "workspace.created")).toBe(true);
  });

  it("does not match wildcard first segment with wrong second segment", () => {
    expect(matchesPattern("*.created", "task.state_changed")).toBe(false);
  });

  it("matches universal wildcard *", () => {
    expect(matchesPattern("*", "task.created")).toBe(true);
    expect(matchesPattern("*", "git.pushed")).toBe(true);
    expect(matchesPattern("*", "anything")).toBe(true);
  });
});

// ── EventBus ──────────────────────────────────────────────────────────────────

describe("EventBus", () => {
  let db: Database.Database;
  let bus: EventBus;

  afterEach(() => {
    db?.close();
  });

  function setup(): void {
    const handle = createInMemoryDatabase();
    db = handle.db;
    const observer = createTestObserverFacade("event-bus");
    bus = new EventBus(db, { observer });
  }

  // ── Publish & persist ───────────────────────────────────────────────────────

  describe("publish", () => {
    it("persists event to database with correct fields", () => {
      setup();
      const event = bus.publish({
        type: "task.created",
        source: "task_engine",
        task_id: "task-1",
        payload: {
          task_id: "task-1",
          parent_id: null,
          title: "Test task",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "owner/repo",
        },
      });

      expect(event.type).toBe("task.created");
      expect(event.source).toBe("task_engine");
      expect(event.task_id).toBe("task-1");
      expect(event.payload).toEqual({
        task_id: "task-1",
        parent_id: null,
        title: "Test task",
        external_ref: null,
        source: "manual",
        priority: 50,
        repo: "owner/repo",
      });

      // Verify it's in the DB
      const row = db.prepare("SELECT * FROM events WHERE id = ?").get(event.id) as {
        payload: string;
      };
      expect(row).toBeDefined();
      expect(JSON.parse(row.payload)).toEqual(event.payload);
    });

    it("assigns a ULID id", () => {
      setup();
      const event = bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      // ULID is 26 chars, uppercase alphanumeric
      expect(event.id).toMatch(ULID_PATTERN);
    });

    it("assigns auto-incremented sequence starting at 1", () => {
      setup();
      const e1 = bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });
      expect(e1.sequence).toBe(1);
    });

    it("assigns ISO 8601 timestamp", () => {
      setup();
      const event = bus.publish({
        type: "git.pushed",
        source: "workspace_manager",
        task_id: "task-1",
        payload: {
          task_id: "task-1",
          repo: "owner/repo",
          branch: "main",
          remote: "origin",
          commits: 1,
          head_sha: "abc123",
        },
      });

      // ISO 8601 datetime string
      expect(() => new Date(event.timestamp)).not.toThrow();
      expect(event.timestamp).toMatch(ISO_8601_PATTERN);
    });

    it("handles system events with null task_id", () => {
      setup();
      const event = bus.publish({
        type: "trigger.new_event",
        source: "daemon",
        task_id: null,
        payload: {
          idempotency_key: "github:issue:42",
          source: "github_issues",
          event_type: "issue_opened",
          external_ref: "https://github.com/owner/repo/issues/42",
          title: "Fix bug",
          body: null,
          repo: "owner/repo",
          metadata: null,
        },
      });

      expect(event.task_id).toBeNull();

      const row = db.prepare("SELECT task_id FROM events WHERE id = ?").get(event.id) as {
        task_id: string | null;
      };
      expect(row.task_id).toBeNull();
    });

    it("accepts general (untyped) event types for future plugin events", () => {
      setup();
      const event = bus.publish({
        type: "custom.plugin_event",
        source: "my_plugin",
        task_id: null,
        payload: { foo: "bar", count: 42 },
      });

      expect(event.type).toBe("custom.plugin_event");
      expect(event.payload).toEqual({ foo: "bar", count: 42 });
    });
  });

  // ── Sequence ordering ───────────────────────────────────────────────────────

  describe("sequence ordering", () => {
    it("assigns monotonically increasing sequences", () => {
      setup();
      const events: Event[] = [];
      for (let i = 0; i < 5; i++) {
        events.push(
          bus.publish({
            type: "git.committed",
            source: "workspace_manager",
            task_id: "task-1",
            payload: {
              task_id: "task-1",
              repo: "owner/repo",
              sha: `sha-${i}`,
              message: `commit ${i}`,
              files_changed: 1,
            },
          }),
        );
      }

      for (let i = 1; i < events.length; i++) {
        const prev = events[i - 1];
        const curr = events[i];
        if (prev && curr) {
          expect(curr.sequence).toBeGreaterThan(prev.sequence);
        }
      }
    });

    it("sequences are unique", () => {
      setup();
      const sequences = new Set<number>();
      for (let i = 0; i < 10; i++) {
        const event = bus.publish({
          type: "git.committed",
          source: "test",
          task_id: "task-1",
          payload: {
            task_id: "task-1",
            repo: "r",
            sha: `s${i}`,
            message: `m${i}`,
            files_changed: 1,
          },
        });
        sequences.add(event.sequence);
      }
      expect(sequences.size).toBe(10);
    });
  });

  // ── Subscriber delivery ─────────────────────────────────────────────────────

  describe("subscriber delivery", () => {
    it("delivers event to matching subscriber", () => {
      setup();
      const received: Event[] = [];
      bus.subscribe("test-sub", "task.created", (e) => received.push(e));

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "task-1",
        payload: {
          task_id: "task-1",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe("task.created");
    });

    it("delivers to multiple subscribers", () => {
      setup();
      const received1: Event[] = [];
      const received2: Event[] = [];
      bus.subscribe("sub-1", "task.created", (e) => received1.push(e));
      bus.subscribe("sub-2", "task.created", (e) => received2.push(e));

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
    });

    it("does not deliver to non-matching subscriber", () => {
      setup();
      const received: Event[] = [];
      bus.subscribe("test-sub", "git.pushed", (e) => received.push(e));

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      expect(received).toHaveLength(0);
    });

    it("delivers synchronously (before publish returns)", () => {
      setup();
      let delivered = false;
      bus.subscribe("test-sub", "task.created", () => {
        delivered = true;
      });

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      // If delivery were async, this would be false
      expect(delivered).toBe(true);
    });

    it("is safe when a subscriber unsubscribes during delivery", () => {
      setup();
      const received: Event[] = [];
      bus.subscribe("self-unsub", "task.created", () => {
        bus.unsubscribe("self-unsub");
      });
      bus.subscribe("after-sub", "task.created", (e) => received.push(e));

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      // "after-sub" must still receive the event despite "self-unsub" mutating the array
      expect(received).toHaveLength(1);
    });
  });

  // ── Unsubscribe ─────────────────────────────────────────────────────────────

  describe("unsubscribe", () => {
    it("stops delivery after unsubscribe", () => {
      setup();
      const received: Event[] = [];
      bus.subscribe("test-sub", "task.created", (e) => received.push(e));

      bus.unsubscribe("test-sub");

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      expect(received).toHaveLength(0);
    });

    it("removes all subscriptions for a subscriber", () => {
      setup();
      const received: Event[] = [];
      bus.subscribe("test-sub", "task.created", (e) => received.push(e));
      bus.subscribe("test-sub", "git.pushed", (e) => received.push(e));

      bus.unsubscribe("test-sub");

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });
      bus.publish({
        type: "git.pushed",
        source: "test",
        task_id: "task-1",
        payload: {
          task_id: "task-1",
          repo: "r",
          branch: "main",
          remote: "origin",
          commits: 1,
          head_sha: "abc",
        },
      });

      expect(received).toHaveLength(0);
    });

    it("is a no-op for unknown subscriber", () => {
      setup();
      expect(() => bus.unsubscribe("nonexistent")).not.toThrow();
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  describe("error handling", () => {
    it("continues delivery to remaining subscribers when one throws", () => {
      const handle = createInMemoryDatabase();
      db = handle.db;
      const observer = createTestObserverFacade("event-bus");
      const errorSpy = vi.spyOn(observer, "error");
      bus = new EventBus(db, { observer });
      const received: Event[] = [];

      bus.subscribe("bad-sub", "task.created", () => {
        throw new Error("subscriber failed");
      });
      bus.subscribe("good-sub", "task.created", (e) => received.push(e));

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      expect(received).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledOnce();
    });

    it("still returns the event when a subscriber throws", () => {
      const handle = createInMemoryDatabase();
      db = handle.db;
      const observer = createTestObserverFacade("event-bus");
      bus = new EventBus(db, { observer });

      bus.subscribe("bad-sub", "task.created", () => {
        throw new Error("fail");
      });

      const event = bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      expect(event.id).toBeDefined();
      expect(event.sequence).toBeGreaterThan(0);
    });

    it("persists event even when subscriber throws", () => {
      const handle = createInMemoryDatabase();
      db = handle.db;
      const observer = createTestObserverFacade("event-bus");
      bus = new EventBus(db, { observer });

      bus.subscribe("bad-sub", "task.created", () => {
        throw new Error("fail");
      });

      const event = bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      const row = db.prepare("SELECT * FROM events WHERE id = ?").get(event.id);
      expect(row).toBeDefined();
    });

    it("sanitizes subscriber error messages before logging", () => {
      const handle = createInMemoryDatabase();
      db = handle.db;
      const observer = createTestObserverFacade("event-bus");
      const errorSpy = vi.spyOn(observer, "error");
      bus = new EventBus(db, { observer });

      const fakeToken = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
      bus.subscribe("leaky-sub", "task.created", () => {
        throw new Error(`Auth failed for https://git:${fakeToken}@github.com`);
      });

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      expect(errorSpy).toHaveBeenCalledOnce();
      const loggedErr = errorSpy.mock.calls[0]?.[1]?.["err"] as string;
      expect(loggedErr).not.toContain(fakeToken);
      expect(loggedErr).toContain("https://git:***@");
    });

    it("propagates DB INSERT failure (system halt)", () => {
      setup();
      // Close the DB to force an error
      db.close();

      expect(() =>
        bus.publish({
          type: "task.created",
          source: "test",
          task_id: null,
          payload: {
            task_id: "t",
            parent_id: null,
            title: "t",
            external_ref: null,
            source: "manual",
            priority: 50,
            repo: "r",
          },
        }),
      ).toThrow();
    });
  });

  // ── Replay ──────────────────────────────────────────────────────────────────

  describe("replay", () => {
    it("delivers persisted events to current subscribers in sequence order", () => {
      setup();
      // Publish 3 events without subscribers
      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "task-1",
        payload: {
          task_id: "task-1",
          parent_id: null,
          title: "first",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });
      bus.publish({
        type: "task.state_changed",
        source: "test",
        task_id: "task-1",
        payload: {
          task_id: "task-1",
          from_state: "intake",
          from_sub: null,
          to_state: "queued",
          to_sub: null,
          reason: "scheduled",
          triggered_by: "daemon",
        },
      });
      bus.publish({
        type: "git.committed",
        source: "test",
        task_id: "task-1",
        payload: {
          task_id: "task-1",
          repo: "r",
          sha: "abc",
          message: "fix",
          files_changed: 1,
        },
      });

      // Now subscribe and replay
      const received: Event[] = [];
      bus.subscribe("replay-sub", "task.*", (e) => received.push(e));
      bus.replay(0);

      // Should get the 2 task.* events in order
      expect(received).toHaveLength(2);
      expect(received[0]?.type).toBe("task.created");
      expect(received[1]?.type).toBe("task.state_changed");
    });

    it("only replays events after fromSequence", () => {
      setup();
      const e1 = bus.publish({
        type: "task.created",
        source: "test",
        task_id: "task-1",
        payload: {
          task_id: "task-1",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });
      bus.publish({
        type: "git.committed",
        source: "test",
        task_id: "task-1",
        payload: { task_id: "task-1", repo: "r", sha: "abc", message: "fix", files_changed: 1 },
      });

      const received: Event[] = [];
      bus.subscribe("replay-sub", "*", (e) => received.push(e));
      bus.replay(e1.sequence);

      // Should only get the second event (sequence > e1.sequence)
      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe("git.committed");
    });

    it("is a no-op when no events match", () => {
      setup();
      const received: Event[] = [];
      bus.subscribe("replay-sub", "*", (e) => received.push(e));
      bus.replay(0);

      expect(received).toHaveLength(0);
    });

    it("catches subscriber errors during replay (same as publish)", () => {
      const handle = createInMemoryDatabase();
      db = handle.db;
      const observer = createTestObserverFacade("event-bus");
      bus = new EventBus(db, { observer });

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      bus.subscribe("bad-sub", "*", () => {
        throw new Error("replay fail");
      });

      expect(() => bus.replay(0)).not.toThrow();
    });
  });

  // ── Query methods ───────────────────────────────────────────────────────────

  describe("getEventsForTask", () => {
    it("returns events for the given task_id ordered by sequence", () => {
      setup();
      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "task-1",
        payload: {
          task_id: "task-1",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });
      bus.publish({
        type: "git.committed",
        source: "test",
        task_id: "task-1",
        payload: { task_id: "task-1", repo: "r", sha: "abc", message: "fix", files_changed: 1 },
      });
      // Different task
      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "task-2",
        payload: {
          task_id: "task-2",
          parent_id: null,
          title: "t2",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      const events = bus.getEventsForTask("task-1");
      expect(events).toHaveLength(2);
      expect(events[0]?.type).toBe("task.created");
      expect(events[1]?.type).toBe("git.committed");
    });

    it("returns empty array for unknown task_id", () => {
      setup();
      const events = bus.getEventsForTask("nonexistent");
      expect(events).toHaveLength(0);
    });
  });

  describe("getEventsSince", () => {
    it("returns events after the given sequence", () => {
      setup();
      const e1 = bus.publish({
        type: "task.created",
        source: "test",
        task_id: "task-1",
        payload: {
          task_id: "task-1",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });
      bus.publish({
        type: "git.pushed",
        source: "test",
        task_id: "task-1",
        payload: {
          task_id: "task-1",
          repo: "r",
          branch: "main",
          remote: "origin",
          commits: 1,
          head_sha: "abc",
        },
      });

      const events = bus.getEventsSince(e1.sequence);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("git.pushed");
    });

    it("returns empty array when no events exist after sequence", () => {
      setup();
      const e = bus.publish({
        type: "task.created",
        source: "test",
        task_id: null,
        payload: {
          task_id: "t",
          parent_id: null,
          title: "t",
          external_ref: null,
          source: "manual",
          priority: 50,
          repo: "r",
        },
      });

      const events = bus.getEventsSince(e.sequence);
      expect(events).toHaveLength(0);
    });
  });
});
