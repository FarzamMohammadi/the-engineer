/**
 * Observability schemas — action traces, phase metrics, LLM traces.
 * Zod schemas + TypeScript types for the three observability tables.
 */
import { z } from "zod";

// ── Action Traces ────────────────────────────────────────────────────────────

/** Schema for a persisted action trace row. */
export const ActionTraceSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  session_id: z.string(),
  trace_id: z.string(),
  phase: z.string(),
  iteration: z.number().int().positive(),
  action_type: z.string(),
  action_params: z.string().nullable(),
  result_success: z.boolean(),
  result_output: z.string().nullable(),
  result_error: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  timestamp: z.string(),
});

export type ActionTrace = z.infer<typeof ActionTraceSchema>;

/** Input for inserting an action trace (id and timestamp auto-generated). */
export interface ActionTraceInput {
  task_id: string;
  session_id: string;
  trace_id: string;
  phase: string;
  iteration: number;
  action_type: string;
  action_params: string | null;
  result_success: boolean;
  result_output: string | null;
  result_error: string | null;
  duration_ms: number | null;
}

/** Record passed to agent loop callback. */
export interface ActionTraceRecord {
  action_type: string;
  action_params: string | null;
  result_success: boolean;
  result_output: string | null;
  result_error: string | null;
  duration_ms: number;
  iteration: number;
}

// ── Phase Metrics ────────────────────────────────────────────────────────────

/** Schema for a persisted phase metrics row. */
export const PhaseMetricSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  session_id: z.string(),
  trace_id: z.string(),
  phase: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  llm_iterations: z.number().int(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  spend_usd: z.number().nullable(),
  actions_executed: z.number().int(),
  actions_failed: z.number().int(),
  outcome: z.string().nullable(),
});

export type PhaseMetric = z.infer<typeof PhaseMetricSchema>;

/** Input for creating a phase metrics row (started, not yet completed). */
export interface PhaseMetricsInput {
  task_id: string;
  session_id: string;
  trace_id: string;
  phase: string;
}

/** Result for completing a phase metrics row. */
export interface PhaseMetricsResult {
  duration_ms: number;
  llm_iterations: number;
  tokens_in: number;
  tokens_out: number;
  spend_usd: number | null;
  actions_executed: number;
  actions_failed: number;
  outcome: string;
}

// ── LLM Traces ───────────────────────────────────────────────────────────────

/** Schema for a persisted LLM trace row. */
export const LlmTraceSchema = z.object({
  id: z.string(),
  task_id: z.string(),
  trace_id: z.string(),
  phase: z.string(),
  iteration: z.number().int(),
  prompt_length: z.number().int(),
  response_length: z.number().int(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  spend_usd: z.number().nullable(),
  latency_ms: z.number().int(),
  provider_id: z.string(),
  model_id: z.string().nullable(),
  finish_reason: z.string().nullable(),
  prompt_ref: z.string().nullable(),
  response_ref: z.string().nullable(),
  timestamp: z.string(),
});

export type LlmTrace = z.infer<typeof LlmTraceSchema>;

/** Input for inserting an LLM trace. */
export interface LlmTraceInput {
  task_id: string;
  trace_id: string;
  phase: string;
  iteration: number;
  prompt_length: number;
  response_length: number;
  tokens_in: number;
  tokens_out: number;
  spend_usd: number | null;
  latency_ms: number;
  provider_id: string;
  model_id: string | null;
  finish_reason: string | null;
  prompt_ref: string | null;
  response_ref: string | null;
}

/** Record passed to agent loop LLM callback. */
export interface LlmTraceRecord {
  prompt_length: number;
  response_length: number;
  tokens_in: number;
  tokens_out: number;
  spend_usd: number | null;
  latency_ms: number;
  iteration: number;
  prompt_ref: string | null;
  response_ref: string | null;
  /** Raw prompt content for blob storage (not persisted in DB). */
  prompt_content?: string;
  /** Raw response content for blob storage (not persisted in DB). */
  response_content?: string;
}

// ── Cost Breakdown ───────────────────────────────────────────────────────────

/** Per-phase cost breakdown for a task. */
export interface PhaseCostBreakdown {
  phase: string;
  tokens_in: number;
  tokens_out: number;
  spend_usd: number | null;
  llm_iterations: number;
  duration_ms: number | null;
}

/** System-level stats for dashboard overview. */
export interface SystemStats {
  total_tasks: number;
  tasks_by_state: Record<string, number>;
  total_action_traces: number;
  total_llm_traces: number;
  total_spend_usd: number | null;
}

// ── Row Mappers ──────────────────────────────────────────────────────────────

/** Map a SQLite row to an ActionTrace. */
export function rowToActionTrace(row: Record<string, unknown>): ActionTrace {
  return {
    id: row["id"] as string,
    task_id: row["task_id"] as string,
    session_id: row["session_id"] as string,
    trace_id: row["trace_id"] as string,
    phase: row["phase"] as string,
    iteration: row["iteration"] as number,
    action_type: row["action_type"] as string,
    action_params: (row["action_params"] as string) ?? null,
    result_success: (row["result_success"] as number) === 1,
    result_output: (row["result_output"] as string) ?? null,
    result_error: (row["result_error"] as string) ?? null,
    duration_ms: (row["duration_ms"] as number) ?? null,
    timestamp: row["timestamp"] as string,
  };
}

/** Map a SQLite row to a PhaseMetric. */
export function rowToPhaseMetric(row: Record<string, unknown>): PhaseMetric {
  return {
    id: row["id"] as string,
    task_id: row["task_id"] as string,
    session_id: row["session_id"] as string,
    trace_id: row["trace_id"] as string,
    phase: row["phase"] as string,
    started_at: row["started_at"] as string,
    ended_at: (row["ended_at"] as string) ?? null,
    duration_ms: (row["duration_ms"] as number) ?? null,
    llm_iterations: row["llm_iterations"] as number,
    tokens_in: row["tokens_in"] as number,
    tokens_out: row["tokens_out"] as number,
    spend_usd: (row["spend_usd"] as number) ?? null,
    actions_executed: row["actions_executed"] as number,
    actions_failed: row["actions_failed"] as number,
    outcome: (row["outcome"] as string) ?? null,
  };
}

/** Map a SQLite row to an LlmTrace. */
export function rowToLlmTrace(row: Record<string, unknown>): LlmTrace {
  return {
    id: row["id"] as string,
    task_id: row["task_id"] as string,
    trace_id: row["trace_id"] as string,
    phase: row["phase"] as string,
    iteration: row["iteration"] as number,
    prompt_length: row["prompt_length"] as number,
    response_length: row["response_length"] as number,
    tokens_in: row["tokens_in"] as number,
    tokens_out: row["tokens_out"] as number,
    spend_usd: (row["spend_usd"] as number) ?? null,
    latency_ms: row["latency_ms"] as number,
    provider_id: row["provider_id"] as string,
    model_id: (row["model_id"] as string) ?? null,
    finish_reason: (row["finish_reason"] as string) ?? null,
    prompt_ref: (row["prompt_ref"] as string) ?? null,
    response_ref: (row["response_ref"] as string) ?? null,
    timestamp: row["timestamp"] as string,
  };
}
