import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { type DatabaseHandle, createInMemoryDatabase } from "../../db/database.js";
import { EventTypeSchema } from "../../schemas/events.js";
import { EventBus } from "./index.js";
import { EventTopology } from "./topology.js";
import type { EventDeclaration } from "./topology.js";

import { EVENTS as ACTION_PIPELINE_EVENTS } from "../action-pipeline/index.js";
import { EVENTS as DAEMON_EVENTS } from "../daemon/index.js";
import { EVENTS as ORCHESTRATOR_EVENTS } from "../orchestrator/index.js";
import { EVENTS as REGISTRY_EVENTS } from "../registry/index.js";
import { EVENTS as SAFETY_LAYER_EVENTS } from "../safety-layer/index.js";
import { EVENTS as TASK_ENGINE_EVENTS } from "../task-engine/index.js";
import { EVENTS as WORKSPACE_MANAGER_EVENTS } from "../workspace-manager/index.js";

// ── Test Helpers ────────────────────────────────────────────────────────────

const TestPayloadSchema = z.object({
  task_id: z.string(),
  value: z.number(),
});

function makeDeclaration(overrides: Partial<EventDeclaration> = {}): EventDeclaration {
  return {
    type: "test.event",
    description: "A test event",
    payloadSchema: TestPayloadSchema,
    publishers: ["test-component"],
    subscribers: [],
    ...overrides,
  };
}

// ── Registration ────────────────────────────────────────────────────────────

describe("EventTopology", () => {
  describe("registerPublisher", () => {
    it("adds declarations to the topology", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);

      expect(topology.getAllDeclarations()).toHaveLength(1);
      expect(topology.getDeclaration("test.event")).toBeDefined();
    });

    it("merges publishers for the same event type", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration({ publishers: ["comp-a"] })]);
      topology.registerPublisher("comp-b", [makeDeclaration({ publishers: ["comp-b"] })]);

      const decl = topology.getDeclaration("test.event");
      expect(decl?.publishers).toContain("comp-a");
      expect(decl?.publishers).toContain("comp-b");
    });

    it("does not duplicate publisher IDs", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);
      topology.registerPublisher("comp-a", [makeDeclaration()]);

      const decl = topology.getDeclaration("test.event");
      expect(decl?.publishers.filter((p) => p === "comp-a")).toHaveLength(1);
    });

    it("registers multiple events from one component", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [
        makeDeclaration({ type: "test.one" }),
        makeDeclaration({ type: "test.two" }),
      ]);

      expect(topology.getAllDeclarations()).toHaveLength(2);
    });
  });

  describe("registerSubscriber", () => {
    it("records subscriber for exact event type", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);
      topology.registerSubscriber("sub-1", "test.event");

      const decl = topology.getDeclaration("test.event");
      expect(decl?.subscribers).toContain("sub-1");
    });

    it("records subscriber for glob pattern", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [
        makeDeclaration({ type: "test.one" }),
        makeDeclaration({ type: "test.two" }),
        makeDeclaration({ type: "other.one" }),
      ]);
      topology.registerSubscriber("sub-1", "test.*");

      expect(topology.getDeclaration("test.one")?.subscribers).toContain("sub-1");
      expect(topology.getDeclaration("test.two")?.subscribers).toContain("sub-1");
      expect(topology.getDeclaration("other.one")?.subscribers).not.toContain("sub-1");
    });

    it("does not duplicate subscriber IDs", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);
      topology.registerSubscriber("sub-1", "test.event");
      topology.registerSubscriber("sub-1", "test.event");

      const decl = topology.getDeclaration("test.event");
      expect(decl?.subscribers.filter((s) => s === "sub-1")).toHaveLength(1);
    });
  });

  // ── Lookup ──────────────────────────────────────────────────────────────

  describe("getDeclaration", () => {
    it("returns declaration for registered type", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);

      const decl = topology.getDeclaration("test.event");
      expect(decl).toBeDefined();
      expect(decl?.type).toBe("test.event");
      expect(decl?.description).toBe("A test event");
    });

    it("returns undefined for unknown type", () => {
      const topology = new EventTopology();
      expect(topology.getDeclaration("unknown.type")).toBeUndefined();
    });
  });

  describe("getAllDeclarations", () => {
    it("returns empty array when no declarations registered", () => {
      const topology = new EventTopology();
      expect(topology.getAllDeclarations()).toEqual([]);
    });
  });

  // ── Validation ────────────────────────────────────────────────────────────

  describe("validatePayload", () => {
    it("accepts valid payload", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);

      const result = topology.validatePayload("test.event", { task_id: "t1", value: 42 });
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("rejects invalid payload", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);

      const result = topology.validatePayload("test.event", {
        task_id: "t1",
        value: "not-a-number",
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBeGreaterThan(0);
    });

    it("rejects payload with missing required fields", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);

      const result = topology.validatePayload("test.event", {});
      expect(result.valid).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(0);
    });

    it("returns valid for unknown event types (forward compatibility)", () => {
      const topology = new EventTopology();
      const result = topology.validatePayload("unknown.future.event", { anything: true });
      expect(result.valid).toBe(true);
    });
  });

  // ── Graph ─────────────────────────────────────────────────────────────────

  describe("getGraph", () => {
    it("returns correct structure with publishers and subscribers", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [
        makeDeclaration({ type: "test.one", publishers: ["comp-a"] }),
        makeDeclaration({ type: "test.two", publishers: ["comp-a"] }),
      ]);
      topology.registerSubscriber("sub-1", "test.one");

      const graph = topology.getGraph();

      expect(graph.events).toHaveLength(2);
      expect(graph.components.length).toBeGreaterThanOrEqual(1);

      const testOneEvent = graph.events.find((e) => e.type === "test.one");
      expect(testOneEvent?.publishers).toEqual(["comp-a"]);
      expect(testOneEvent?.subscribers).toEqual(["sub-1"]);

      const compA = graph.components.find((c) => c.id === "comp-a");
      expect(compA?.publishes).toContain("test.one");
      expect(compA?.publishes).toContain("test.two");

      const sub1 = graph.components.find((c) => c.id === "sub-1");
      expect(sub1?.subscribes).toContain("test.one");
    });

    it("is JSON-serializable (no functions or Zod objects)", () => {
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);
      topology.registerSubscriber("sub-1", "test.event");

      const graph = topology.getGraph();
      const serialized = JSON.stringify(graph);
      const deserialized = JSON.parse(serialized);

      expect(deserialized.events).toHaveLength(1);
      expect(deserialized.components.length).toBeGreaterThanOrEqual(1);
    });

    it("returns empty graph when no declarations", () => {
      const topology = new EventTopology();
      const graph = topology.getGraph();
      expect(graph.events).toEqual([]);
      expect(graph.components).toEqual([]);
    });
  });

  // ── EventBus Integration ──────────────────────────────────────────────────

  describe("EventBus integration", () => {
    let handle: DatabaseHandle;

    afterEach(() => {
      handle?.close();
    });

    it("throws on invalid payload when validateOnPublish=true in test env", () => {
      handle = createInMemoryDatabase();
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);
      const observer = createTestObserverFacade("event-bus");

      const bus = new EventBus(handle.db, { observer, topology, validateOnPublish: true });

      expect(() =>
        bus.publish({
          type: "test.event",
          source: "test",
          task_id: null,
          payload: { wrong: "payload" },
        }),
      ).toThrow("payload validation failed");
    });

    it("publishes valid payload without error when validateOnPublish=true", () => {
      handle = createInMemoryDatabase();
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);
      const observer = createTestObserverFacade("event-bus");

      const bus = new EventBus(handle.db, { observer, topology, validateOnPublish: true });

      const event = bus.publish({
        type: "test.event",
        source: "test",
        task_id: null,
        payload: { task_id: "t1", value: 42 },
      });
      expect(event.type).toBe("test.event");
    });

    it("warns but publishes on invalid payload when NODE_ENV is not test", () => {
      handle = createInMemoryDatabase();
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);

      const observer = createTestObserverFacade("event-bus");
      const warnSpy = vi.spyOn(observer, "warn");
      const bus = new EventBus(handle.db, { topology, validateOnPublish: true, observer });

      const originalEnv = process.env["NODE_ENV"];
      process.env["NODE_ENV"] = "production";

      try {
        const event = bus.publish({
          type: "test.event",
          source: "test",
          task_id: null,
          payload: { wrong: "payload" },
        });
        expect(event.type).toBe("test.event");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("payload validation failed"),
          expect.any(Object),
        );
      } finally {
        process.env["NODE_ENV"] = originalEnv;
      }
    });

    it("skips validation for unknown event types", () => {
      handle = createInMemoryDatabase();
      const topology = new EventTopology();
      const observer = createTestObserverFacade("event-bus");
      const bus = new EventBus(handle.db, { observer, topology, validateOnPublish: true });

      // Unknown event type should pass through without error
      const event = bus.publish({
        type: "future.plugin.event",
        source: "test",
        task_id: null,
        payload: { any: "shape" },
      });
      expect(event.type).toBe("future.plugin.event");
    });

    it("does not validate when validateOnPublish=false (default)", () => {
      handle = createInMemoryDatabase();
      const topology = new EventTopology();
      topology.registerPublisher("comp-a", [makeDeclaration()]);

      const observer = createTestObserverFacade("event-bus");
      const bus = new EventBus(handle.db, { observer, topology });

      // Invalid payload should succeed without validation
      const event = bus.publish({
        type: "test.event",
        source: "test",
        task_id: null,
        payload: { wrong: "payload" },
      });
      expect(event.type).toBe("test.event");
    });
  });

  // ── Completeness ──────────────────────────────────────────────────────────

  describe("completeness", () => {
    it("every published event type has a matching EventType in the schema", () => {
      const allEvents = [
        ...TASK_ENGINE_EVENTS,
        ...ACTION_PIPELINE_EVENTS,
        ...SAFETY_LAYER_EVENTS,
        ...WORKSPACE_MANAGER_EVENTS,
        ...REGISTRY_EVENTS,
        ...ORCHESTRATOR_EVENTS,
        ...DAEMON_EVENTS,
      ];

      const validTypes = new Set(EventTypeSchema.options);

      for (const event of allEvents) {
        expect(validTypes.has(event.type as typeof EventTypeSchema._type)).toBe(true);
      }
    });

    it("all component EVENTS arrays have non-empty publishers", () => {
      const allEvents = [
        ...TASK_ENGINE_EVENTS,
        ...ACTION_PIPELINE_EVENTS,
        ...SAFETY_LAYER_EVENTS,
        ...WORKSPACE_MANAGER_EVENTS,
        ...REGISTRY_EVENTS,
        ...ORCHESTRATOR_EVENTS,
        ...DAEMON_EVENTS,
      ];

      for (const event of allEvents) {
        expect(event.publishers.length).toBeGreaterThan(0);
      }
    });

    it("all component EVENTS have a Zod payloadSchema", () => {
      const allEvents = [
        ...TASK_ENGINE_EVENTS,
        ...ACTION_PIPELINE_EVENTS,
        ...SAFETY_LAYER_EVENTS,
        ...WORKSPACE_MANAGER_EVENTS,
        ...REGISTRY_EVENTS,
        ...ORCHESTRATOR_EVENTS,
        ...DAEMON_EVENTS,
      ];

      for (const event of allEvents) {
        expect(event.payloadSchema).toBeDefined();
        // Verify it's actually a Zod schema by checking safeParse exists
        expect(typeof event.payloadSchema.safeParse).toBe("function");
      }
    });

    it("no duplicate event types across component EVENTS arrays", () => {
      const allEvents = [
        ...TASK_ENGINE_EVENTS,
        ...ACTION_PIPELINE_EVENTS,
        ...SAFETY_LAYER_EVENTS,
        ...WORKSPACE_MANAGER_EVENTS,
        ...REGISTRY_EVENTS,
        ...ORCHESTRATOR_EVENTS,
        ...DAEMON_EVENTS,
      ];

      const seen = new Set<string>();
      for (const event of allEvents) {
        expect(seen.has(event.type)).toBe(false);
        seen.add(event.type);
      }
    });
  });
});
