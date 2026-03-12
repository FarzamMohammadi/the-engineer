import { Hono } from "hono";
import { cors } from "hono/cors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type TestObservabilityHandle,
  createTestObservabilityStore,
  insertTestSession,
  insertTestTask,
} from "../../../test/helpers/test-observability.js";
import { eventRoutes } from "./events.js";
import { metricsRoutes } from "./metrics.js";
import { systemRoutes } from "./system.js";
import { taskRoutes } from "./tasks.js";
import { blobRoutes, traceRoutes } from "./traces.js";

// ── Test Helpers ──────────────────────────────────────────────────────────────

const TASK_ID = "TASK_DASH_01";
const SESSION_ID = "SESS_DASH_01";
const TRACE_ID = "TRACE_DASH_01";

let handle: TestObservabilityHandle;
let app: Hono;

function seedEvent(db: TestObservabilityHandle["db"], overrides: Record<string, unknown> = {}) {
  const defaults = {
    id: `EVT_${Math.random().toString(36).slice(2, 8)}`,
    type: "task.created",
    source: "test",
    task_id: TASK_ID,
    timestamp: new Date().toISOString(),
    payload: "{}",
  };
  const row = { ...defaults, ...overrides };
  db.db
    .prepare(
      `INSERT INTO events (id, type, source, task_id, timestamp, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.type, row.source, row.task_id, row.timestamp, row.payload);
}

async function req(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

async function reqText(path: string): Promise<{ status: number; body: string }> {
  const res = await app.request(path);
  const body = await res.text();
  return { status: res.status, body };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  handle = createTestObservabilityStore();
  insertTestTask(handle.db, TASK_ID);
  insertTestSession(handle.db, SESSION_ID, TASK_ID);

  const testApp = new Hono();
  testApp.use("/*", cors());

  const deps = {
    db: handle.db.db,
    observability: handle.store,
    runDir: handle.tracesDir,
  };

  testApp.route("/api/system", systemRoutes(deps));
  testApp.route("/api/tasks", taskRoutes(deps));
  testApp.route("/api/events", eventRoutes({ db: deps.db }));
  testApp.route("/api/metrics", metricsRoutes(deps));
  testApp.route("/api/traces", traceRoutes({ observability: deps.observability }));
  testApp.route("/api/blob", blobRoutes({ observability: deps.observability }));

  app = testApp;
});

afterEach(() => {
  handle.cleanup();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Dashboard API", () => {
  describe("GET /api/system/status", () => {
    it("returns system stats", async () => {
      const { status, body } = await req("/api/system/status");
      expect(status).toBe(200);
      expect(body).toHaveProperty("daemon_running");
      expect(body).toHaveProperty("total_tasks");
      expect(body).toHaveProperty("tasks_by_state");
      expect(body).toHaveProperty("total_action_traces");
      expect(body).toHaveProperty("total_llm_traces");
    });

    it("counts tasks by state", async () => {
      const { body } = await req("/api/system/status");
      const byState = body["tasks_by_state"] as Record<string, number>;
      expect(byState["active"]).toBe(1); // from insertTestTask
    });
  });

  describe("GET /api/system/health", () => {
    it("returns health events", async () => {
      const { status, body } = await req("/api/system/health");
      expect(status).toBe(200);
      expect(body).toHaveProperty("events");
      expect(Array.isArray(body["events"])).toBe(true);
    });
  });

  describe("GET /api/tasks", () => {
    it("lists tasks", async () => {
      const { status, body } = await req("/api/tasks");
      expect(status).toBe(200);
      const tasks = body["tasks"] as unknown[];
      expect(tasks.length).toBeGreaterThanOrEqual(1);
    });

    it("filters by state", async () => {
      const { body } = await req("/api/tasks?state=active");
      const tasks = body["tasks"] as unknown[];
      expect(tasks.length).toBe(1);
    });

    it("returns empty for non-existent state", async () => {
      const { body } = await req("/api/tasks?state=completed");
      const tasks = body["tasks"] as unknown[];
      expect(tasks).toHaveLength(0);
    });

    it("includes children_count", async () => {
      const { body } = await req("/api/tasks");
      const tasks = body["tasks"] as Record<string, unknown>[];
      expect(tasks[0]).toHaveProperty("children_count");
    });
  });

  describe("GET /api/tasks/:id", () => {
    it("returns full task detail", async () => {
      const { status, body } = await req(`/api/tasks/${TASK_ID}`);
      expect(status).toBe(200);
      const task = body["task"] as Record<string, unknown>;
      expect(task["id"]).toBe(TASK_ID);
      expect(task["title"]).toBe("Test Task");
    });

    it("returns 404 for missing task", async () => {
      const { status, body } = await req("/api/tasks/NONEXISTENT");
      expect(status).toBe(404);
      expect(body).toHaveProperty("error");
    });
  });

  describe("GET /api/tasks/:id/timeline", () => {
    it("returns timeline items", async () => {
      // Seed an event for the task
      seedEvent(handle.db, {
        type: "task.created",
        payload: JSON.stringify({ task_id: TASK_ID }),
      });

      const { status, body } = await req(`/api/tasks/${TASK_ID}/timeline`);
      expect(status).toBe(200);
      const timeline = body["timeline"] as unknown[];
      expect(timeline.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /api/tasks/:id/phases", () => {
    it("returns phase metrics", async () => {
      handle.store.createPhaseMetrics({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "research",
      });

      const { status, body } = await req(`/api/tasks/${TASK_ID}/phases`);
      expect(status).toBe(200);
      const phases = body["phases"] as unknown[];
      expect(phases).toHaveLength(1);
    });
  });

  describe("GET /api/tasks/:id/traces", () => {
    it("returns action traces", async () => {
      handle.store.insertActionTrace({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "execution",
        iteration: 1,
        action_type: "read_file",
        action_params: null,
        result_success: true,
        result_output: "ok",
        result_error: null,
        duration_ms: 10,
      });

      const { status, body } = await req(`/api/tasks/${TASK_ID}/traces`);
      expect(status).toBe(200);
      const traces = body["traces"] as unknown[];
      expect(traces).toHaveLength(1);
    });

    it("filters by phase", async () => {
      handle.store.insertActionTrace({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "research",
        iteration: 1,
        action_type: "read_file",
        action_params: null,
        result_success: true,
        result_output: null,
        result_error: null,
        duration_ms: 5,
      });

      const { body: all } = await req(`/api/tasks/${TASK_ID}/traces`);
      const { body: filtered } = await req(`/api/tasks/${TASK_ID}/traces?phase=research`);

      expect((all["traces"] as unknown[]).length).toBeGreaterThanOrEqual(1);
      expect((filtered["traces"] as unknown[]).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("GET /api/tasks/:id/llm-traces", () => {
    it("returns LLM traces", async () => {
      handle.store.insertLlmTrace({
        task_id: TASK_ID,
        trace_id: TRACE_ID,
        phase: "research",
        iteration: 1,
        prompt_length: 100,
        response_length: 50,
        tokens_in: 10,
        tokens_out: 5,
        spend_usd: 0.01,
        latency_ms: 200,
        provider_id: "test-llm",
        model_id: "test-model",
        finish_reason: "end_turn",
        prompt_ref: null,
        response_ref: null,
      });

      const { status, body } = await req(`/api/tasks/${TASK_ID}/llm-traces`);
      expect(status).toBe(200);
      const traces = body["traces"] as unknown[];
      expect(traces).toHaveLength(1);
    });
  });

  describe("GET /api/events", () => {
    it("returns events", async () => {
      seedEvent(handle.db);

      const { status, body } = await req("/api/events");
      expect(status).toBe(200);
      expect((body["events"] as unknown[]).length).toBeGreaterThanOrEqual(1);
    });

    it("supports since parameter for incremental polling", async () => {
      seedEvent(handle.db, { id: "EVT_001" });
      seedEvent(handle.db, { id: "EVT_002" });

      const { body: all } = await req("/api/events?since=0");
      const allEvents = all["events"] as Record<string, unknown>[];
      expect(allEvents.length).toBe(2);

      // Get the max sequence
      const maxSeq = Math.max(...allEvents.map((e) => e["sequence"] as number));

      // Should return no new events
      const { body: newer } = await req(`/api/events?since=${maxSeq}`);
      expect(newer["events"] as unknown[]).toHaveLength(0);
    });

    it("filters by type", async () => {
      seedEvent(handle.db, { type: "task.created" });
      seedEvent(handle.db, { type: "cost.incurred" });

      const { body } = await req("/api/events?type=task.created");
      const events = body["events"] as Record<string, unknown>[];
      for (const e of events) {
        expect(e["type"]).toBe("task.created");
      }
    });
  });

  describe("GET /api/metrics/cost", () => {
    it("returns cost breakdown", async () => {
      const { status, body } = await req("/api/metrics/cost");
      expect(status).toBe(200);
      expect(body).toHaveProperty("today_spend_usd");
      expect(body).toHaveProperty("month_spend_usd");
      expect(body).toHaveProperty("per_task");
      expect(body).toHaveProperty("per_day");
      expect(body).toHaveProperty("per_phase");
    });
  });

  describe("GET /api/metrics/phases", () => {
    it("returns phase metrics", async () => {
      const { status, body } = await req("/api/metrics/phases");
      expect(status).toBe(200);
      expect(body).toHaveProperty("phases");
    });

    it("filters by task_id", async () => {
      handle.store.createPhaseMetrics({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "planning",
      });

      const { body } = await req(`/api/metrics/phases?task_id=${TASK_ID}`);
      expect((body["phases"] as unknown[]).length).toBe(1);
    });
  });

  describe("GET /api/traces/:taskId", () => {
    it("returns traces for a task", async () => {
      handle.store.insertActionTrace({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "execution",
        iteration: 1,
        action_type: "write_file",
        action_params: '{"path":"test.ts"}',
        result_success: true,
        result_output: "written",
        result_error: null,
        duration_ms: 15,
      });

      const { status, body } = await req(`/api/traces/${TASK_ID}`);
      expect(status).toBe(200);
      expect((body["traces"] as unknown[]).length).toBe(1);
    });
  });

  describe("GET /api/traces/:taskId/:phase", () => {
    it("returns both action and LLM traces for a phase", async () => {
      handle.store.insertActionTrace({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "research",
        iteration: 1,
        action_type: "read_file",
        action_params: null,
        result_success: true,
        result_output: null,
        result_error: null,
        duration_ms: 5,
      });

      handle.store.insertLlmTrace({
        task_id: TASK_ID,
        trace_id: TRACE_ID,
        phase: "research",
        iteration: 1,
        prompt_length: 50,
        response_length: 25,
        tokens_in: 5,
        tokens_out: 3,
        spend_usd: null,
        latency_ms: 100,
        provider_id: "llm",
        model_id: null,
        finish_reason: null,
        prompt_ref: null,
        response_ref: null,
      });

      const { status, body } = await req(`/api/traces/${TASK_ID}/research`);
      expect(status).toBe(200);
      expect(body).toHaveProperty("action_traces");
      expect(body).toHaveProperty("llm_traces");
      expect(body["action_traces"] as unknown[]).toHaveLength(1);
      expect(body["llm_traces"] as unknown[]).toHaveLength(1);
    });
  });

  describe("GET /api/blob/:prefix/:hash", () => {
    it("returns blob content", async () => {
      const ref = handle.store.storeBlob("test blob content");
      expect(ref).not.toBeNull();
      if (ref === null) {
        return;
      }

      const { status, body } = await reqText(`/api/blob/${ref}`);
      expect(status).toBe(200);
      expect(body).toBe("test blob content");
    });

    it("returns 404 for missing blob", async () => {
      const { status } = await req("/api/blob/ff/nonexistent");
      expect(status).toBe(404);
    });
  });
});
