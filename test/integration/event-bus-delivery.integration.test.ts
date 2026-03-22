import { afterEach, describe, expect, it } from "vitest";

import { EventBus, matchesPattern } from "../../src/core/event-bus/index.js";
import type { Event } from "../../src/schemas/events.js";
import { type TestDatabaseHandle, createTestDatabase } from "../helpers/test-database.js";
import { createTestObserverFacade } from "../helpers/test-observer-facade.js";

describe("EventBus delivery (integration)", () => {
  let dbHandle: TestDatabaseHandle;
  let bus: EventBus;

  function setup(): void {
    dbHandle = createTestDatabase();
    const observer = createTestObserverFacade("event-bus");
    bus = new EventBus(dbHandle.db, { observer });
  }

  afterEach(() => {
    dbHandle?.cleanup();
  });

  describe("multi-subscriber delivery", () => {
    it("delivers to multiple subscribers on the same event type", () => {
      setup();
      const received1: Event[] = [];
      const received2: Event[] = [];

      bus.subscribe("sub-1", "task.created", (e) => received1.push(e));
      bus.subscribe("sub-2", "task.created", (e) => received2.push(e));

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "t1",
        payload: {
          task_id: "t1",
          title: "Test task",
          source: "test",
          priority: 50,
          repo: null,
          parent_id: null,
        },
      });

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received1[0]?.id).toBe(received2[0]?.id);
    });

    it("delivers to glob pattern subscribers", () => {
      setup();
      const received: Event[] = [];
      bus.subscribe("glob-sub", "task.*", (e) => received.push(e));

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "t1",
        payload: {
          task_id: "t1",
          title: "Test",
          source: "test",
          priority: 50,
          repo: null,
          parent_id: null,
        },
      });

      bus.publish({
        type: "task.state_changed",
        source: "test",
        task_id: "t1",
        payload: {
          task_id: "t1",
          from_state: "intake",
          from_sub: null,
          to_state: "queued",
          to_sub: null,
          reason: "test",
          triggered_by: "test",
        },
      });

      expect(received).toHaveLength(2);
      expect(received[0]?.type).toBe("task.created");
      expect(received[1]?.type).toBe("task.state_changed");
    });

    it("delivers to wildcard (*) subscriber for all events", () => {
      setup();
      const received: Event[] = [];
      bus.subscribe("wildcard", "*", (e) => received.push(e));

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "t1",
        payload: {
          task_id: "t1",
          title: "Test",
          source: "test",
          priority: 50,
          repo: null,
          parent_id: null,
        },
      });

      bus.publish({
        type: "cost.incurred",
        source: "test",
        task_id: "t1",
        payload: {
          task_id: "t1",
          repo: "",
          provider_id: "llm",
          operation: "test",
          spend_usd: 0.01,
          duration_ms: 150,
        },
      });

      expect(received).toHaveLength(2);
    });
  });

  describe("ordering guarantees", () => {
    it("delivers events in publish order (by sequence)", () => {
      setup();
      const received: Event[] = [];
      bus.subscribe("order-sub", "task.*", (e) => received.push(e));

      for (let i = 0; i < 5; i++) {
        bus.publish({
          type: "task.created",
          source: "test",
          task_id: `t${String(i)}`,
          payload: {
            task_id: `t${String(i)}`,
            title: `Task ${String(i)}`,
            source: "test",
            priority: 50,
            repo: null,
            parent_id: null,
          },
        });
      }

      expect(received).toHaveLength(5);
      for (let i = 1; i < received.length; i++) {
        expect(received[i]!.sequence).toBeGreaterThan(received[i - 1]!.sequence);
      }
    });
  });

  describe("error isolation", () => {
    it("continues delivery to other subscribers when one throws", () => {
      setup();
      const received: Event[] = [];

      bus.subscribe("thrower", "task.created", () => {
        throw new Error("Subscriber error");
      });
      bus.subscribe("receiver", "task.created", (e) => received.push(e));

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "t1",
        payload: {
          task_id: "t1",
          title: "Test",
          source: "test",
          priority: 50,
          repo: null,
          parent_id: null,
        },
      });

      expect(received).toHaveLength(1);
    });
  });

  describe("unsubscribe", () => {
    it("stops delivery after unsubscribe", () => {
      setup();
      const received: Event[] = [];
      bus.subscribe("unsub-test", "task.created", (e) => received.push(e));

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "t1",
        payload: {
          task_id: "t1",
          title: "First",
          source: "test",
          priority: 50,
          repo: null,
          parent_id: null,
        },
      });

      bus.unsubscribe("unsub-test");

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "t2",
        payload: {
          task_id: "t2",
          title: "Second",
          source: "test",
          priority: 50,
          repo: null,
          parent_id: null,
        },
      });

      expect(received).toHaveLength(1);
    });
  });

  describe("replay", () => {
    it("replays historical events to current subscribers in sequence order", () => {
      setup();

      // Publish some events without a subscriber
      for (let i = 0; i < 3; i++) {
        bus.publish({
          type: "task.created",
          source: "test",
          task_id: `t${String(i)}`,
          payload: {
            task_id: `t${String(i)}`,
            title: `Task ${String(i)}`,
            source: "test",
            priority: 50,
            repo: null,
            parent_id: null,
          },
        });
      }

      // Subscribe AFTER publishing, then replay
      const replayed: Event[] = [];
      bus.subscribe("replay-sub", "task.created", (e) => replayed.push(e));
      bus.replay(0);

      expect(replayed).toHaveLength(3);
      for (let i = 1; i < replayed.length; i++) {
        expect(replayed[i]!.sequence).toBeGreaterThan(replayed[i - 1]!.sequence);
      }
    });
  });

  describe("query methods", () => {
    it("getEventsForTask filters by task_id", () => {
      setup();

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "t1",
        payload: {
          task_id: "t1",
          title: "Task 1",
          source: "test",
          priority: 50,
          repo: null,
          parent_id: null,
        },
      });
      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "t2",
        payload: {
          task_id: "t2",
          title: "Task 2",
          source: "test",
          priority: 50,
          repo: null,
          parent_id: null,
        },
      });

      const t1Events = bus.getEventsForTask("t1");
      expect(t1Events).toHaveLength(1);
      expect(t1Events[0]?.task_id).toBe("t1");
    });

    it("getEventsSince returns events after a sequence number", () => {
      setup();

      const e1 = bus.publish({
        type: "task.created",
        source: "test",
        task_id: "t1",
        payload: {
          task_id: "t1",
          title: "First",
          source: "test",
          priority: 50,
          repo: null,
          parent_id: null,
        },
      });

      bus.publish({
        type: "task.created",
        source: "test",
        task_id: "t2",
        payload: {
          task_id: "t2",
          title: "Second",
          source: "test",
          priority: 50,
          repo: null,
          parent_id: null,
        },
      });

      const since = bus.getEventsSince(e1.sequence);
      expect(since).toHaveLength(1);
      expect(since[0]?.task_id).toBe("t2");
    });
  });

  describe("matchesPattern (pure function)", () => {
    it("matches exact event types", () => {
      expect(matchesPattern("task.created", "task.created")).toBe(true);
      expect(matchesPattern("task.created", "task.state_changed")).toBe(false);
    });

    it("matches glob patterns", () => {
      expect(matchesPattern("task.*", "task.created")).toBe(true);
      expect(matchesPattern("task.*", "cost.incurred")).toBe(false);
    });

    it("matches wildcard", () => {
      expect(matchesPattern("*", "task.created")).toBe(true);
      expect(matchesPattern("*", "anything.at.all")).toBe(true);
    });
  });
});
