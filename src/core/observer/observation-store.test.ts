import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type TestObserverHandle,
  createTestObserver,
} from "../../../test/helpers/test-observer.js";
import { ObservationLevels } from "../../schemas/observer.js";
import { ObserverStream } from "./stream.js";
import { ObservationTypes } from "./types.js";
import type { Observation } from "./types.js";

const ULID_PATTERN = /^[0-9A-Z]{26}$/;
const SNAKE_CASE_PATTERN = /^[a-z_]+$/;

const noop = () => {};

describe("Observer", () => {
  let handle: TestObserverHandle;

  beforeEach(() => {
    handle = createTestObserver();
  });

  afterEach(() => {
    handle.cleanup();
  });

  // ── ObservationTypes ───────────────────────────────────────────────────────

  describe("ObservationTypes", () => {
    it("has all 14 types", () => {
      expect(Object.keys(ObservationTypes)).toHaveLength(14);
    });

    it("values are lowercase_snake_case strings", () => {
      for (const value of Object.values(ObservationTypes)) {
        expect(value).toMatch(SNAKE_CASE_PATTERN);
      }
    });
  });

  // ── observe() ──────────────────────────────────────────────────────────────

  describe("observe()", () => {
    it("returns a ULID string", () => {
      const id = handle.observer.observe("lifecycle", "test", {});
      expect(id).toMatch(ULID_PATTERN);
    });

    it("persists to DB and is queryable", () => {
      handle.observer.observe("lifecycle", "test_event", { key: "value" });
      const results = handle.observer.query({ type: "lifecycle" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("test_event");
      expect(results[0]?.input).toEqual({ key: "value" });
    });

    it("sets start_time and end_time to same value (instant)", () => {
      handle.observer.observe("lifecycle", "instant", {});
      const results = handle.observer.query({});
      expect(results[0]?.start_time).toBe(results[0]?.end_time);
      expect(results[0]?.duration_ms).toBeNull();
    });

    it("defaults level to info and status to ok", () => {
      handle.observer.observe("lifecycle", "test", {});
      const results = handle.observer.query({});
      expect(results[0]?.level).toBe("info");
      expect(results[0]?.status).toBe("ok");
    });

    it("respects SpanOptions", () => {
      handle.observer.observe(
        "phase_transition",
        "start",
        { phase: "intake" },
        {
          task_id: "task-1",
          trace_id: "trace-1",
          phase: "intake_analysis",
          session_id: "session-1",
          level: ObservationLevels.debug,
        },
      );

      const results = handle.observer.query({ task_id: "task-1" });
      expect(results).toHaveLength(1);
      expect(results[0]?.trace_id).toBe("trace-1");
      expect(results[0]?.phase).toBe("intake_analysis");
      expect(results[0]?.session_id).toBe("session-1");
      expect(results[0]?.level).toBe("debug");
    });

    it("stores null for missing optional context", () => {
      handle.observer.observe("lifecycle", "test", {});
      const results = handle.observer.query({});
      expect(results[0]?.task_id).toBeNull();
      expect(results[0]?.trace_id).toBeNull();
      expect(results[0]?.parent_observation_id).toBeNull();
      expect(results[0]?.phase).toBeNull();
      expect(results[0]?.session_id).toBeNull();
    });
  });

  // ── startSpan() + end() ────────────────────────────────────────────────────

  describe("startSpan() + end()", () => {
    it("returns ObservationSpan with valid ULID id", () => {
      const span = handle.observer.startSpan("llm_call", "test");
      expect(span.id).toMatch(ULID_PATTERN);
      span.end();
    });

    it("persists initial row immediately with null end_time", () => {
      const span = handle.observer.startSpan("llm_call", "test");
      const results = handle.observer.query({ type: "llm_call" });
      expect(results).toHaveLength(1);
      expect(results[0]?.end_time).toBeNull();
      expect(results[0]?.duration_ms).toBeNull();
      span.end();
    });

    it("end() sets end_time and duration_ms", () => {
      const span = handle.observer.startSpan("llm_call", "test");
      span.end();

      const results = handle.observer.query({ type: "llm_call" });
      expect(results[0]?.end_time).not.toBeNull();
      expect(results[0]?.duration_ms).toBeTypeOf("number");
      expect(results[0]?.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it("end() stores output as JSON", () => {
      const span = handle.observer.startSpan("llm_call", "test");
      span.end({ tokens: 100, cost: 0.01 });

      const results = handle.observer.query({ type: "llm_call" });
      expect(results[0]?.output).toEqual({ tokens: 100, cost: 0.01 });
    });

    it("end() stores input from startSpan", () => {
      const span = handle.observer.startSpan("llm_call", "test", { prompt: "hello" });
      span.end();

      const results = handle.observer.query({ type: "llm_call" });
      expect(results[0]?.input).toEqual({ prompt: "hello" });
    });

    it("double end() is idempotent", () => {
      const span = handle.observer.startSpan("llm_call", "test");
      span.end({ first: true });
      span.end({ second: true });

      const results = handle.observer.query({ type: "llm_call" });
      expect(results).toHaveLength(1);
      expect(results[0]?.output).toEqual({ first: true });
    });

    it("respects SpanOptions", () => {
      const span = handle.observer.startSpan(
        "tool_execution",
        "bash",
        { cmd: "ls" },
        {
          task_id: "task-1",
          trace_id: "trace-1",
          phase: "execution",
        },
      );
      span.end();

      const results = handle.observer.query({ task_id: "task-1" });
      expect(results).toHaveLength(1);
      expect(results[0]?.trace_id).toBe("trace-1");
      expect(results[0]?.phase).toBe("execution");
    });
  });

  // ── startChild() ──────────────────────────────────────────────────────────

  describe("startChild()", () => {
    it("sets parent_observation_id to parent span id", () => {
      const parent = handle.observer.startSpan("agent_iteration", "iter-1");
      const child = parent.startChild("llm_call", "completion");
      child.end();
      parent.end();

      const results = handle.observer.query({ type: "llm_call" });
      expect(results).toHaveLength(1);
      expect(results[0]?.parent_observation_id).toBe(parent.id);
    });

    it("supports multiple children under one parent", () => {
      const parent = handle.observer.startSpan("agent_iteration", "iter-1");
      const child1 = parent.startChild("llm_call", "call-1");
      const child2 = parent.startChild("tool_execution", "bash");
      child1.end();
      child2.end();
      parent.end();

      const all = handle.observer.query({});
      const children = all.filter((o) => o.parent_observation_id === parent.id);
      expect(children).toHaveLength(2);
    });

    it("supports grandchild nesting", () => {
      const parent = handle.observer.startSpan("phase_transition", "execution");
      const child = parent.startChild("agent_iteration", "iter-1");
      const grandchild = child.startChild("llm_call", "completion");
      grandchild.end();
      child.end();
      parent.end();

      const all = handle.observer.query({});
      expect(all).toHaveLength(3);

      const gc = all.find((o) => o.name === "completion");
      expect(gc?.parent_observation_id).toBe(child.id);
    });

    it("inherits parent options", () => {
      const parent = handle.observer.startSpan("agent_iteration", "iter-1", undefined, {
        task_id: "task-1",
        trace_id: "trace-1",
      });
      const child = parent.startChild("llm_call", "completion");
      child.end();
      parent.end();

      const results = handle.observer.query({ type: "llm_call" });
      expect(results[0]?.task_id).toBe("task-1");
      expect(results[0]?.trace_id).toBe("trace-1");
    });
  });

  // ── addEvent() ─────────────────────────────────────────────────────────────

  describe("addEvent()", () => {
    it("creates an instant observation with parent_observation_id", () => {
      const span = handle.observer.startSpan("agent_iteration", "iter-1");
      span.addEvent("parsed_response", { action: "read_file" });
      span.end();

      const all = handle.observer.query({});
      const event = all.find((o) => o.name === "parsed_response");
      expect(event).toBeDefined();
      expect(event?.parent_observation_id).toBe(span.id);
    });

    it("works without data", () => {
      const span = handle.observer.startSpan("agent_iteration", "iter-1");
      span.addEvent("checkpoint");
      span.end();

      const all = handle.observer.query({});
      const event = all.find((o) => o.name === "checkpoint");
      expect(event).toBeDefined();
      expect(event?.input).toEqual({});
    });
  });

  // ── setError() ─────────────────────────────────────────────────────────────

  describe("setError()", () => {
    it("marks span as errored on end()", () => {
      const span = handle.observer.startSpan("tool_execution", "bash");
      span.setError(new Error("command failed"));
      span.end();

      const results = handle.observer.query({ type: "tool_execution" });
      expect(results[0]?.status).toBe("error");
      expect(results[0]?.error_message).toBe("command failed");
    });

    it("handles non-Error values", () => {
      const span = handle.observer.startSpan("tool_execution", "bash");
      span.setError("string error");
      span.end();

      const results = handle.observer.query({ type: "tool_execution" });
      expect(results[0]?.status).toBe("error");
      expect(results[0]?.error_message).toBe("string error");
    });
  });

  // ── recordDecision() ──────────────────────────────────────────────────────

  describe("recordDecision()", () => {
    it("creates a decision_point observation", () => {
      handle.observer.recordDecision(
        "approach_selection",
        "How to fix the bug",
        [
          { id: "a", description: "Refactor module" },
          { id: "b", description: "Patch inline" },
        ],
        "a",
        "Refactor is cleaner and prevents regression",
        0.85,
      );

      const results = handle.observer.query({ type: "decision_point" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("approach_selection");
      expect(results[0]?.input).toEqual({
        context: "How to fix the bug",
        options: [
          { id: "a", description: "Refactor module" },
          { id: "b", description: "Patch inline" },
        ],
        chosen: "a",
        reasoning: "Refactor is cleaner and prevents regression",
        confidence: 0.85,
      });
    });

    it("returns observation id", () => {
      const id = handle.observer.recordDecision("test", "ctx", [], "x", "r", 0.5);
      expect(id).toMatch(ULID_PATTERN);
    });

    it("respects SpanOptions", () => {
      handle.observer.recordDecision("test", "ctx", [], "x", "r", 0.5, {
        task_id: "task-1",
        phase: "planning",
      });

      const results = handle.observer.query({ type: "decision_point" });
      expect(results[0]?.task_id).toBe("task-1");
      expect(results[0]?.phase).toBe("planning");
    });
  });

  // ── recordError() ──────────────────────────────────────────────────────────

  describe("recordError()", () => {
    it("creates an error observation", () => {
      handle.observer.recordError(new Error("connection refused"), {
        operation: "github_api_call",
        component: "github-trigger",
      });

      const results = handle.observer.query({ type: "error" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("github_api_call");
      expect(results[0]?.status).toBe("error");
      expect(results[0]?.level).toBe("error");
      expect(results[0]?.error_message).toBe("connection refused");
      expect(results[0]?.input).toMatchObject({
        component: "github-trigger",
        error_message: "connection refused",
      });
    });

    it("handles non-Error values", () => {
      handle.observer.recordError("string error", { operation: "test", component: "test" });

      const results = handle.observer.query({ type: "error" });
      expect(results[0]?.error_message).toBe("string error");
    });

    it("includes recovery info when provided", () => {
      handle.observer.recordError(
        new Error("timeout"),
        { operation: "llm_call", component: "orchestrator" },
        { action: "retry_with_backoff", success: true },
      );

      const results = handle.observer.query({ type: "error" });
      expect(results[0]?.input).toMatchObject({
        recovery: { action: "retry_with_backoff", success: true },
      });
    });

    it("returns observation id", () => {
      const id = handle.observer.recordError(new Error("test"), {
        operation: "test",
        component: "test",
      });
      expect(id).toMatch(ULID_PATTERN);
    });
  });

  // ── Security: secret sanitization in error paths ──────────────────────────

  describe("error secret sanitization", () => {
    it("recordError sanitizes token-bearing URLs in error_message field", () => {
      handle.observer.recordError(
        new Error("request to https://ghp_abc123xyz@api.github.com/repos failed"),
        { operation: "github_api", component: "trigger" },
      );

      const results = handle.observer.query({ type: "error" });
      expect(results[0]?.error_message).not.toContain("ghp_abc123xyz");
      expect(results[0]?.error_message).toContain("https://***@api.github.com/repos failed");
    });

    it("recordError sanitizes token-bearing URLs in input.error_message", () => {
      handle.observer.recordError(
        new Error("push to https://git:secret_token@github.com/org/repo.git failed"),
        { operation: "git_push", component: "workspace-manager" },
      );

      const results = handle.observer.query({ type: "error" });
      const input = results[0]?.input as Record<string, unknown>;
      expect(input["error_message"]).not.toContain("secret_token");
      expect(input["error_message"]).toContain("https://git:***@github.com/org/repo.git");
    });

    it("setError on spans sanitizes token-bearing URLs", () => {
      const span = handle.observer.startSpan("tool_execution", "git_push");
      span.setError(new Error("https://ghp_leaked_token@github.com/org/repo.git: 403"));
      span.end();

      const results = handle.observer.query({ type: "tool_execution" });
      expect(results[0]?.error_message).not.toContain("ghp_leaked_token");
      expect(results[0]?.error_message).toContain("https://***@github.com/org/repo.git");
    });
  });

  // ── query() ────────────────────────────────────────────────────────────────

  describe("query()", () => {
    beforeEach(() => {
      handle.observer.observe(
        "lifecycle",
        "boot",
        {},
        { task_id: "task-1", trace_id: "trace-1", phase: "init" },
      );
      handle.observer.observe(
        "llm_call",
        "completion",
        {},
        { task_id: "task-1", trace_id: "trace-1", phase: "execution" },
      );
      handle.observer.observe(
        "tool_execution",
        "bash",
        {},
        { task_id: "task-2", trace_id: "trace-2", phase: "execution" },
      );
      handle.observer.observe("lifecycle", "shutdown", {}, { level: ObservationLevels.warn });
    });

    it("filters by type", () => {
      const results = handle.observer.query({ type: "lifecycle" });
      expect(results).toHaveLength(2);
    });

    it("filters by task_id", () => {
      const results = handle.observer.query({ task_id: "task-1" });
      expect(results).toHaveLength(2);
    });

    it("filters by trace_id", () => {
      const results = handle.observer.query({ trace_id: "trace-2" });
      expect(results).toHaveLength(1);
      expect(results[0]?.type).toBe("tool_execution");
    });

    it("filters by phase", () => {
      const results = handle.observer.query({ phase: "execution" });
      expect(results).toHaveLength(2);
    });

    it("filters by level", () => {
      const results = handle.observer.query({ level: ObservationLevels.warn });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("shutdown");
    });

    it("filters by since", () => {
      const results = handle.observer.query({ since: "2020-01-01T00:00:00.000Z" });
      expect(results).toHaveLength(4);

      const futureResults = handle.observer.query({ since: "2099-01-01T00:00:00.000Z" });
      expect(futureResults).toHaveLength(0);
    });

    it("applies default limit of 100", () => {
      const results = handle.observer.query({});
      expect(results.length).toBeLessThanOrEqual(100);
    });

    it("respects custom limit", () => {
      const results = handle.observer.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("combines filters", () => {
      const results = handle.observer.query({ type: "lifecycle", task_id: "task-1" });
      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe("boot");
    });

    it("returns empty array when no matches", () => {
      const results = handle.observer.query({ type: "config_change" });
      expect(results).toEqual([]);
    });
  });

  // ── subscribe() ────────────────────────────────────────────────────────────

  describe("subscribe()", () => {
    it("receives observations from observe()", () => {
      const received: Observation[] = [];
      handle.observer.subscribe((obs) => received.push(obs));

      handle.observer.observe("lifecycle", "test", {});
      expect(received).toHaveLength(1);
      expect(received[0]?.name).toBe("test");
    });

    it("receives span start and end notifications", () => {
      const received: Observation[] = [];
      handle.observer.subscribe((obs) => received.push(obs));

      const span = handle.observer.startSpan("llm_call", "test");
      expect(received).toHaveLength(1);

      span.end({ result: "ok" });
      expect(received).toHaveLength(2);
      expect(received[1]?.duration_ms).toBeTypeOf("number");
    });

    it("unsubscribe stops delivery", () => {
      const received: Observation[] = [];
      const unsub = handle.observer.subscribe((obs) => received.push(obs));

      handle.observer.observe("lifecycle", "first", {});
      expect(received).toHaveLength(1);

      unsub();
      handle.observer.observe("lifecycle", "second", {});
      expect(received).toHaveLength(1);
    });

    it("multiple subscribers all receive", () => {
      const received1: Observation[] = [];
      const received2: Observation[] = [];
      handle.observer.subscribe((obs) => received1.push(obs));
      handle.observer.subscribe((obs) => received2.push(obs));

      handle.observer.observe("lifecycle", "test", {});
      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
    });

    it("subscriber errors do not propagate to caller", () => {
      handle.observer.subscribe(() => {
        throw new Error("subscriber boom");
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(noop);
      // Should not throw
      expect(() => {
        handle.observer.observe("lifecycle", "test", {});
      }).not.toThrow();
      consoleSpy.mockRestore();
    });

    it("subscriber errors do not affect other subscribers", () => {
      const received: Observation[] = [];

      handle.observer.subscribe(() => {
        throw new Error("boom");
      });
      handle.observer.subscribe((obs) => received.push(obs));

      // Suppress console.error from fire-and-forget handler
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(noop);
      handle.observer.observe("lifecycle", "test", {});
      consoleSpy.mockRestore();

      expect(received).toHaveLength(1);
    });
  });

  // ── ObserverStream direct tests ──────────────────────────────────────────

  describe("ObserverStream", () => {
    it("clear() removes all subscribers", () => {
      const stream = new ObserverStream();
      stream.subscribe(() => {});
      stream.subscribe(() => {});
      expect(stream.subscriberCount()).toBe(2);

      stream.clear();
      expect(stream.subscriberCount()).toBe(0);
    });

    it("clear() prevents delivery to previously-registered subscribers", () => {
      const stream = new ObserverStream();
      const received: string[] = [];
      stream.subscribe((obs) => received.push(obs.name));

      stream.clear();
      stream.notify({ name: "after-clear" } as Observation);
      expect(received).toHaveLength(0);
    });

    it("auto-removes subscriber after 3 consecutive errors", () => {
      const stream = new ObserverStream();
      stream.subscribe(() => {
        throw new Error("dead subscriber");
      });
      expect(stream.subscriberCount()).toBe(1);

      // First two errors: subscriber survives
      stream.notify({ name: "1" } as Observation);
      expect(stream.subscriberCount()).toBe(1);
      stream.notify({ name: "2" } as Observation);
      expect(stream.subscriberCount()).toBe(1);

      // Third consecutive error: auto-removed
      stream.notify({ name: "3" } as Observation);
      expect(stream.subscriberCount()).toBe(0);
    });

    it("resets error count on successful delivery", () => {
      const stream = new ObserverStream();
      let shouldThrow = true;
      stream.subscribe(() => {
        if (shouldThrow) {
          throw new Error("intermittent");
        }
      });

      // Two errors
      stream.notify({ name: "1" } as Observation);
      stream.notify({ name: "2" } as Observation);
      expect(stream.subscriberCount()).toBe(1);

      // One success resets the counter
      shouldThrow = false;
      stream.notify({ name: "3" } as Observation);
      expect(stream.subscriberCount()).toBe(1);

      // Two more errors: still alive (counter was reset)
      shouldThrow = true;
      stream.notify({ name: "4" } as Observation);
      stream.notify({ name: "5" } as Observation);
      expect(stream.subscriberCount()).toBe(1);
    });

    it("auto-removal does not affect healthy subscribers", () => {
      const stream = new ObserverStream();
      const received: string[] = [];

      stream.subscribe(() => {
        throw new Error("dead");
      });
      stream.subscribe((obs) => received.push(obs.name));

      // Trigger auto-removal of the failing subscriber
      stream.notify({ name: "a" } as Observation);
      stream.notify({ name: "b" } as Observation);
      stream.notify({ name: "c" } as Observation);

      expect(stream.subscriberCount()).toBe(1);
      expect(received).toEqual(["a", "b", "c"]);
    });
  });

  // ── storeBlob() / readBlob() ──────────────────────────────────────────────

  describe("storeBlob() / readBlob()", () => {
    it("round-trips content", () => {
      const content = "Hello, this is a long LLM prompt...";
      const ref = handle.observer.storeBlob(content);
      expect(ref).not.toBe("");

      const read = handle.observer.readBlob(ref);
      expect(read).toBe(content);
    });

    it("readBlob returns null for unknown hash", () => {
      const result = handle.observer.readBlob("nonexistent/hash");
      expect(result).toBeNull();
    });

    it("works without blobStore (graceful degradation)", async () => {
      const { createObservationStore } = await import("./index.js");
      const noBlobObserver = createObservationStore(handle.db.db, null);

      expect(noBlobObserver.storeBlob("content")).toBe("");
      expect(noBlobObserver.readBlob("ref")).toBeNull();
    });
  });
});
