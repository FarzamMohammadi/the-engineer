import { afterEach, describe, expect, it } from "vitest";

import { EventBus } from "../../src/core/event-bus/index.js";
import { EventTypes } from "../../src/schemas/events.js";
import { type TestEventBusHandle, createTestEventBus } from "./test-event-bus.js";

describe("createTestEventBus", () => {
  let handle: TestEventBusHandle;

  afterEach(() => {
    handle?.cleanup();
  });

  it("returns handle with expected shape", () => {
    handle = createTestEventBus();
    expect(handle.eventBus).toBeInstanceOf(EventBus);
    expect(typeof handle.getEmittedEvents).toBe("function");
    expect(typeof handle.assertEventEmitted).toBe("function");
    expect(typeof handle.cleanup).toBe("function");
  });

  it("getEmittedEvents returns all events when no type filter", () => {
    handle = createTestEventBus();
    handle.eventBus.publish({
      type: EventTypes["task.created"],
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
    handle.eventBus.publish({
      type: EventTypes["git.pushed"],
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

    const all = handle.getEmittedEvents();
    expect(all).toHaveLength(2);
  });

  it("getEmittedEvents filters by type", () => {
    handle = createTestEventBus();
    handle.eventBus.publish({
      type: EventTypes["task.created"],
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
    handle.eventBus.publish({
      type: EventTypes["git.pushed"],
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

    const taskEvents = handle.getEmittedEvents("task.created");
    expect(taskEvents).toHaveLength(1);
    expect(taskEvents[0]?.type).toBe(EventTypes["task.created"]);
  });

  it("assertEventEmitted passes when event exists", () => {
    handle = createTestEventBus();
    handle.eventBus.publish({
      type: EventTypes["task.created"],
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

    expect(() => handle.assertEventEmitted("task.created")).not.toThrow();
  });

  it("assertEventEmitted throws when event not found", () => {
    handle = createTestEventBus();

    expect(() => handle.assertEventEmitted("task.created")).toThrow('Expected event "task.created" to be emitted');
  });

  it("assertEventEmitted with payloadMatcher works", () => {
    handle = createTestEventBus();
    handle.eventBus.publish({
      type: EventTypes["task.created"],
      source: "test",
      task_id: null,
      payload: {
        task_id: "task-42",
        parent_id: null,
        title: "specific",
        external_ref: null,
        source: "manual",
        priority: 50,
        repo: "r",
      },
    });

    expect(() => handle.assertEventEmitted("task.created", (p) => p["title"] === "specific")).not.toThrow();

    expect(() => handle.assertEventEmitted("task.created", (p) => p["title"] === "nonexistent")).toThrow(
      "none matched the payload predicate",
    );
  });
});
