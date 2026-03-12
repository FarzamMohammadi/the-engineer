import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type TestObservabilityHandle,
  createTestObservabilityStore,
  insertTestSession,
  insertTestTask,
} from "../../../test/helpers/test-observability.js";
import { truncate } from "./index.js";

const BLOB_REF_PATTERN = /^[a-f0-9]{2}\/[a-f0-9]{64}$/;

describe("ObservabilityStore", () => {
  let handle: TestObservabilityHandle;
  const TASK_ID = "TASK_01";
  const SESSION_ID = "SESS_01";
  const TRACE_ID = "TRACE_01";

  beforeEach(() => {
    handle = createTestObservabilityStore();
    insertTestTask(handle.db, TASK_ID);
    insertTestSession(handle.db, SESSION_ID, TASK_ID);
  });

  afterEach(() => {
    handle.cleanup();
  });

  describe("truncate (pure function)", () => {
    it("returns null for null input", () => {
      expect(truncate(null, 100)).toBeNull();
    });

    it("returns string unchanged if within limit", () => {
      expect(truncate("short", 100)).toBe("short");
    });

    it("truncates long strings", () => {
      const long = "a".repeat(200);
      const result = truncate(long, 50);
      expect(result).not.toBeNull();
      expect(result?.length).toBeLessThanOrEqual(50);
      expect(result).toContain("[truncated]");
    });
  });

  describe("insertActionTrace + getActionTraces", () => {
    it("inserts and retrieves an action trace", () => {
      handle.store.insertActionTrace({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "research",
        iteration: 1,
        action_type: "read_file",
        action_params: '{"path":"src/index.ts"}',
        result_success: true,
        result_output: "file contents...",
        result_error: null,
        duration_ms: 42,
      });

      const traces = handle.store.getActionTraces(TASK_ID);
      expect(traces).toHaveLength(1);
      expect(traces[0]?.action_type).toBe("read_file");
      expect(traces[0]?.result_success).toBe(true);
      expect(traces[0]?.duration_ms).toBe(42);
      expect(traces[0]?.trace_id).toBe(TRACE_ID);
    });

    it("filters by phase", () => {
      handle.store.insertActionTrace({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "research",
        iteration: 1,
        action_type: "read_file",
        action_params: null,
        result_success: true,
        result_output: "ok",
        result_error: null,
        duration_ms: 10,
      });
      handle.store.insertActionTrace({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "execution",
        iteration: 1,
        action_type: "write_file",
        action_params: null,
        result_success: true,
        result_output: "ok",
        result_error: null,
        duration_ms: 20,
      });

      expect(handle.store.getActionTraces(TASK_ID, "research")).toHaveLength(1);
      expect(handle.store.getActionTraces(TASK_ID, "execution")).toHaveLength(1);
      expect(handle.store.getActionTraces(TASK_ID)).toHaveLength(2);
    });

    it("truncates long action_params", () => {
      const longParams = "x".repeat(5000);
      handle.store.insertActionTrace({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "execution",
        iteration: 1,
        action_type: "run_command",
        action_params: longParams,
        result_success: true,
        result_output: null,
        result_error: null,
        duration_ms: 100,
      });

      const traces = handle.store.getActionTraces(TASK_ID);
      expect(traces[0]?.action_params?.length).toBeLessThanOrEqual(4096);
    });

    it("truncates long result_output", () => {
      const longOutput = "y".repeat(3000);
      handle.store.insertActionTrace({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "execution",
        iteration: 1,
        action_type: "run_command",
        action_params: null,
        result_success: true,
        result_output: longOutput,
        result_error: null,
        duration_ms: 50,
      });

      const traces = handle.store.getActionTraces(TASK_ID);
      expect(traces[0]?.result_output?.length).toBeLessThanOrEqual(2048);
    });
  });

  describe("getRecentActionTraces", () => {
    it("returns most recent traces across all tasks", () => {
      for (let i = 0; i < 5; i++) {
        handle.store.insertActionTrace({
          task_id: TASK_ID,
          session_id: SESSION_ID,
          trace_id: TRACE_ID,
          phase: "execution",
          iteration: i + 1,
          action_type: "read_file",
          action_params: null,
          result_success: true,
          result_output: null,
          result_error: null,
          duration_ms: i * 10,
        });
      }

      const recent = handle.store.getRecentActionTraces(3);
      expect(recent).toHaveLength(3);
    });
  });

  describe("phase metrics lifecycle", () => {
    it("creates and completes phase metrics", () => {
      const id = handle.store.createPhaseMetrics({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "research",
      });

      handle.store.completePhaseMetrics(id, {
        duration_ms: 5000,
        llm_iterations: 3,
        tokens_in: 1000,
        tokens_out: 500,
        spend_usd: 0.05,
        actions_executed: 5,
        actions_failed: 1,
        outcome: "completed",
      });

      const metrics = handle.store.getPhaseMetrics(TASK_ID);
      expect(metrics).toHaveLength(1);
      expect(metrics[0]?.phase).toBe("research");
      expect(metrics[0]?.duration_ms).toBe(5000);
      expect(metrics[0]?.llm_iterations).toBe(3);
      expect(metrics[0]?.tokens_in).toBe(1000);
      expect(metrics[0]?.outcome).toBe("completed");
      expect(metrics[0]?.ended_at).not.toBeNull();
    });

    it("getPhaseMetricsByTrace returns matching traces", () => {
      handle.store.createPhaseMetrics({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "intake_analysis",
      });
      handle.store.createPhaseMetrics({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "research",
      });
      handle.store.createPhaseMetrics({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: "OTHER_TRACE",
        phase: "planning",
      });

      expect(handle.store.getPhaseMetricsByTrace(TRACE_ID)).toHaveLength(2);
      expect(handle.store.getPhaseMetricsByTrace("OTHER_TRACE")).toHaveLength(1);
    });
  });

  describe("LLM traces", () => {
    it("inserts and retrieves LLM trace", () => {
      handle.store.insertLlmTrace({
        task_id: TASK_ID,
        trace_id: TRACE_ID,
        phase: "research",
        iteration: 1,
        prompt_length: 5000,
        response_length: 2000,
        tokens_in: 1200,
        tokens_out: 600,
        spend_usd: 0.03,
        latency_ms: 1500,
        provider_id: "claude-code-llm",
        model_id: "claude-sonnet-4-6",
        finish_reason: "end_turn",
        prompt_ref: "ab/abc123",
        response_ref: "cd/def456",
      });

      const traces = handle.store.getLlmTraces(TASK_ID);
      expect(traces).toHaveLength(1);
      expect(traces[0]?.prompt_length).toBe(5000);
      expect(traces[0]?.latency_ms).toBe(1500);
      expect(traces[0]?.prompt_ref).toBe("ab/abc123");
      expect(traces[0]?.response_ref).toBe("cd/def456");
      expect(traces[0]?.provider_id).toBe("claude-code-llm");
    });

    it("filters by phase", () => {
      handle.store.insertLlmTrace({
        task_id: TASK_ID,
        trace_id: TRACE_ID,
        phase: "research",
        iteration: 1,
        prompt_length: 100,
        response_length: 50,
        tokens_in: 10,
        tokens_out: 5,
        spend_usd: null,
        latency_ms: 100,
        provider_id: "llm",
        model_id: null,
        finish_reason: null,
        prompt_ref: null,
        response_ref: null,
      });
      handle.store.insertLlmTrace({
        task_id: TASK_ID,
        trace_id: TRACE_ID,
        phase: "planning",
        iteration: 1,
        prompt_length: 200,
        response_length: 100,
        tokens_in: 20,
        tokens_out: 10,
        spend_usd: null,
        latency_ms: 200,
        provider_id: "llm",
        model_id: null,
        finish_reason: null,
        prompt_ref: null,
        response_ref: null,
      });

      expect(handle.store.getLlmTraces(TASK_ID, "research")).toHaveLength(1);
      expect(handle.store.getLlmTraces(TASK_ID)).toHaveLength(2);
    });
  });

  describe("cost breakdown", () => {
    it("aggregates cost by phase", () => {
      const id1 = handle.store.createPhaseMetrics({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "research",
      });
      handle.store.completePhaseMetrics(id1, {
        duration_ms: 3000,
        llm_iterations: 2,
        tokens_in: 500,
        tokens_out: 200,
        spend_usd: 0.02,
        actions_executed: 3,
        actions_failed: 0,
        outcome: "completed",
      });

      const id2 = handle.store.createPhaseMetrics({
        task_id: TASK_ID,
        session_id: SESSION_ID,
        trace_id: TRACE_ID,
        phase: "execution",
      });
      handle.store.completePhaseMetrics(id2, {
        duration_ms: 8000,
        llm_iterations: 5,
        tokens_in: 1500,
        tokens_out: 800,
        spend_usd: 0.08,
        actions_executed: 10,
        actions_failed: 2,
        outcome: "completed",
      });

      const breakdown = handle.store.getTaskCostByPhase(TASK_ID);
      expect(breakdown).toHaveLength(2);
      const byPhase = new Map(breakdown.map((b) => [b.phase, b]));
      expect(byPhase.get("research")?.spend_usd).toBe(0.02);
      expect(byPhase.get("execution")?.spend_usd).toBe(0.08);
    });
  });

  describe("blob store integration", () => {
    it("storeBlob stores content and returns ref", () => {
      const ref = handle.store.storeBlob("test prompt content");
      expect(ref).not.toBeNull();
      expect(ref).toMatch(BLOB_REF_PATTERN);
    });

    it("readBlob retrieves stored content", () => {
      const ref = handle.store.storeBlob("hello from blob");
      expect(ref).not.toBeNull();
      if (ref === null) {
        return;
      }
      expect(handle.store.readBlob(ref)).toBe("hello from blob");
    });

    it("readBlob returns null for missing ref", () => {
      expect(handle.store.readBlob("ff/nonexistent")).toBeNull();
    });
  });

  describe("system stats", () => {
    it("returns aggregate stats", () => {
      // Insert some action traces
      for (let i = 0; i < 3; i++) {
        handle.store.insertActionTrace({
          task_id: TASK_ID,
          session_id: SESSION_ID,
          trace_id: TRACE_ID,
          phase: "execution",
          iteration: i + 1,
          action_type: "read_file",
          action_params: null,
          result_success: true,
          result_output: null,
          result_error: null,
          duration_ms: 10,
        });
      }

      // Insert an LLM trace
      handle.store.insertLlmTrace({
        task_id: TASK_ID,
        trace_id: TRACE_ID,
        phase: "research",
        iteration: 1,
        prompt_length: 100,
        response_length: 50,
        tokens_in: 10,
        tokens_out: 5,
        spend_usd: null,
        latency_ms: 100,
        provider_id: "llm",
        model_id: null,
        finish_reason: null,
        prompt_ref: null,
        response_ref: null,
      });

      const stats = handle.store.getSystemStats();
      expect(stats.total_tasks).toBe(1);
      expect(stats.tasks_by_state["active"]).toBe(1);
      expect(stats.total_action_traces).toBe(3);
      expect(stats.total_llm_traces).toBe(1);
    });
  });
});
