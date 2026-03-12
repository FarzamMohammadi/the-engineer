import { describe, expect, it } from "vitest";

import {
  ActionTraceSchema,
  LlmTraceSchema,
  PhaseMetricSchema,
  rowToActionTrace,
  rowToLlmTrace,
  rowToPhaseMetric,
} from "./observability.js";

describe("Observability schemas", () => {
  describe("ActionTraceSchema", () => {
    it("validates a complete action trace", () => {
      const result = ActionTraceSchema.safeParse({
        id: "01ABC",
        task_id: "TASK_01",
        session_id: "SESS_01",
        trace_id: "TRACE_01",
        phase: "research",
        iteration: 1,
        action_type: "read_file",
        action_params: '{"path":"src/index.ts"}',
        result_success: true,
        result_output: "file contents",
        result_error: null,
        duration_ms: 42,
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(result.success).toBe(true);
    });

    it("requires positive iteration", () => {
      const result = ActionTraceSchema.safeParse({
        id: "01ABC",
        task_id: "TASK_01",
        session_id: "SESS_01",
        trace_id: "TRACE_01",
        phase: "research",
        iteration: 0,
        action_type: "read_file",
        action_params: null,
        result_success: false,
        result_output: null,
        result_error: null,
        duration_ms: null,
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("PhaseMetricSchema", () => {
    it("validates a complete phase metric", () => {
      const result = PhaseMetricSchema.safeParse({
        id: "01XYZ",
        task_id: "TASK_01",
        session_id: "SESS_01",
        trace_id: "TRACE_01",
        phase: "execution",
        started_at: "2026-01-01T00:00:00.000Z",
        ended_at: "2026-01-01T00:05:00.000Z",
        duration_ms: 300000,
        llm_iterations: 5,
        tokens_in: 5000,
        tokens_out: 2000,
        spend_usd: 0.15,
        actions_executed: 10,
        actions_failed: 1,
        outcome: "completed",
      });
      expect(result.success).toBe(true);
    });

    it("allows null ended_at for in-progress phases", () => {
      const result = PhaseMetricSchema.safeParse({
        id: "01XYZ",
        task_id: "TASK_01",
        session_id: "SESS_01",
        trace_id: "TRACE_01",
        phase: "research",
        started_at: "2026-01-01T00:00:00.000Z",
        ended_at: null,
        duration_ms: null,
        llm_iterations: 0,
        tokens_in: 0,
        tokens_out: 0,
        spend_usd: null,
        actions_executed: 0,
        actions_failed: 0,
        outcome: null,
      });
      expect(result.success).toBe(true);
    });
  });

  describe("LlmTraceSchema", () => {
    it("validates a complete LLM trace", () => {
      const result = LlmTraceSchema.safeParse({
        id: "01LLM",
        task_id: "TASK_01",
        trace_id: "TRACE_01",
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
        prompt_ref: "ab/abc123def",
        response_ref: "cd/def456ghi",
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(result.success).toBe(true);
    });

    it("allows null refs for traces without blob store", () => {
      const result = LlmTraceSchema.safeParse({
        id: "01LLM",
        task_id: "TASK_01",
        trace_id: "TRACE_01",
        phase: "planning",
        iteration: 2,
        prompt_length: 100,
        response_length: 50,
        tokens_in: 10,
        tokens_out: 5,
        spend_usd: null,
        latency_ms: 200,
        provider_id: "llm",
        model_id: null,
        finish_reason: null,
        prompt_ref: null,
        response_ref: null,
        timestamp: "2026-01-01T00:00:00.000Z",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("row mappers", () => {
    it("rowToActionTrace maps SQLite row correctly", () => {
      const row = {
        id: "01ABC",
        task_id: "TASK_01",
        session_id: "SESS_01",
        trace_id: "TRACE_01",
        phase: "research",
        iteration: 1,
        action_type: "read_file",
        action_params: '{"path":"test.ts"}',
        result_success: 1,
        result_output: "contents",
        result_error: null,
        duration_ms: 42,
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      const trace = rowToActionTrace(row);
      expect(trace.result_success).toBe(true); // maps 1 → true
      expect(trace.action_params).toBe('{"path":"test.ts"}');
    });

    it("rowToActionTrace maps result_success 0 to false", () => {
      const row = {
        id: "01ABC",
        task_id: "TASK_01",
        session_id: "SESS_01",
        trace_id: "TRACE_01",
        phase: "execution",
        iteration: 1,
        action_type: "write_file",
        action_params: null,
        result_success: 0,
        result_output: null,
        result_error: "permission denied",
        duration_ms: 5,
        timestamp: "2026-01-01T00:00:00.000Z",
      };
      const trace = rowToActionTrace(row);
      expect(trace.result_success).toBe(false);
      expect(trace.result_error).toBe("permission denied");
    });

    it("rowToPhaseMetric maps correctly", () => {
      const row = {
        id: "01XYZ",
        task_id: "TASK_01",
        session_id: "SESS_01",
        trace_id: "TRACE_01",
        phase: "execution",
        started_at: "2026-01-01T00:00:00Z",
        ended_at: "2026-01-01T00:05:00Z",
        duration_ms: 300000,
        llm_iterations: 5,
        tokens_in: 5000,
        tokens_out: 2000,
        spend_usd: 0.15,
        actions_executed: 10,
        actions_failed: 1,
        outcome: "completed",
      };
      const metric = rowToPhaseMetric(row);
      expect(metric.duration_ms).toBe(300000);
      expect(metric.outcome).toBe("completed");
    });

    it("rowToLlmTrace maps correctly", () => {
      const row = {
        id: "01LLM",
        task_id: "TASK_01",
        trace_id: "TRACE_01",
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
        timestamp: "2026-01-01T00:00:00Z",
      };
      const trace = rowToLlmTrace(row);
      expect(trace.prompt_ref).toBe("ab/abc123");
      expect(trace.latency_ms).toBe(1500);
    });
  });
});
