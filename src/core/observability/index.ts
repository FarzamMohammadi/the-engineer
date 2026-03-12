/**
 * Observability store — persists action traces, phase metrics, and LLM traces.
 *
 * Pattern follows SessionMemory: prepared statements, row mappers, constructor
 * takes Database. BlobStore is optional — when provided, LLM prompts/responses
 * are stored as content-addressable files on disk.
 */
import type Database from "better-sqlite3";
import { ulid } from "ulid";

import type {
  ActionTrace,
  ActionTraceInput,
  LlmTrace,
  LlmTraceInput,
  PhaseCostBreakdown,
  PhaseMetric,
  PhaseMetricsInput,
  PhaseMetricsResult,
  SystemStats,
} from "../../schemas/observability.js";
import { rowToActionTrace, rowToLlmTrace, rowToPhaseMetric } from "../../schemas/observability.js";
import type { BlobStore } from "./blob-store.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Max size for action_params JSON stored in DB. */
const MAX_ACTION_PARAMS_LENGTH = 4096;

/** Max size for result_output stored in DB. */
const MAX_RESULT_OUTPUT_LENGTH = 2048;

// ── Pure Helpers ─────────────────────────────────────────────────────────────

/** Truncate a string to maxLength, appending "[truncated]" if needed. */
export function truncate(value: string | null, maxLength: number): string | null {
  if (value === null) {
    return null;
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 12)}[truncated]`;
}

// ── ObservabilityStore ───────────────────────────────────────────────────────

export class ObservabilityStore {
  private readonly db: Database.Database;
  private readonly blobStore: BlobStore | null;

  // Prepared statements
  private readonly stmtInsertActionTrace: Database.Statement;
  private readonly stmtInsertPhaseMetrics: Database.Statement;
  private readonly stmtCompletePhaseMetrics: Database.Statement;
  private readonly stmtInsertLlmTrace: Database.Statement;
  private readonly stmtGetActionTraces: Database.Statement;
  private readonly stmtGetActionTracesByPhase: Database.Statement;
  private readonly stmtGetLlmTraces: Database.Statement;
  private readonly stmtGetLlmTracesByPhase: Database.Statement;
  private readonly stmtGetPhaseMetrics: Database.Statement;
  private readonly stmtGetPhaseMetricsByTrace: Database.Statement;
  private readonly stmtGetRecentActionTraces: Database.Statement;
  private readonly stmtGetCostByPhase: Database.Statement;

  constructor(db: Database.Database, blobStore?: BlobStore | null) {
    this.db = db;
    this.blobStore = blobStore ?? null;

    // ── Insert statements ──────────────────────────────────────────────────

    this.stmtInsertActionTrace = db.prepare(`
      INSERT INTO action_traces (id, task_id, session_id, trace_id, phase, iteration,
        action_type, action_params, result_success, result_output, result_error, duration_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertPhaseMetrics = db.prepare(`
      INSERT INTO phase_metrics (id, task_id, session_id, trace_id, phase, started_at,
        llm_iterations, tokens_in, tokens_out, actions_executed, actions_failed)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0)
    `);

    this.stmtCompletePhaseMetrics = db.prepare(`
      UPDATE phase_metrics
      SET ended_at = ?, duration_ms = ?, llm_iterations = ?, tokens_in = ?, tokens_out = ?,
          spend_usd = ?, actions_executed = ?, actions_failed = ?, outcome = ?
      WHERE id = ?
    `);

    this.stmtInsertLlmTrace = db.prepare(`
      INSERT INTO llm_traces (id, task_id, trace_id, phase, iteration,
        prompt_length, response_length, tokens_in, tokens_out, spend_usd,
        latency_ms, provider_id, model_id, finish_reason, prompt_ref, response_ref, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // ── Query statements ───────────────────────────────────────────────────

    this.stmtGetActionTraces = db.prepare(`
      SELECT * FROM action_traces WHERE task_id = ? ORDER BY timestamp ASC
    `);

    this.stmtGetActionTracesByPhase = db.prepare(`
      SELECT * FROM action_traces WHERE task_id = ? AND phase = ? ORDER BY timestamp ASC
    `);

    this.stmtGetLlmTraces = db.prepare(`
      SELECT * FROM llm_traces WHERE task_id = ? ORDER BY timestamp ASC
    `);

    this.stmtGetLlmTracesByPhase = db.prepare(`
      SELECT * FROM llm_traces WHERE task_id = ? AND phase = ? ORDER BY timestamp ASC
    `);

    this.stmtGetPhaseMetrics = db.prepare(`
      SELECT * FROM phase_metrics WHERE task_id = ? ORDER BY started_at ASC
    `);

    this.stmtGetPhaseMetricsByTrace = db.prepare(`
      SELECT * FROM phase_metrics WHERE trace_id = ? ORDER BY started_at ASC
    `);

    this.stmtGetRecentActionTraces = db.prepare(`
      SELECT * FROM action_traces ORDER BY timestamp DESC LIMIT ?
    `);

    this.stmtGetCostByPhase = db.prepare(`
      SELECT phase, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out,
             SUM(spend_usd) as spend_usd, SUM(llm_iterations) as llm_iterations,
             SUM(duration_ms) as duration_ms
      FROM phase_metrics WHERE task_id = ? GROUP BY phase ORDER BY MIN(started_at) ASC
    `);
  }

  // ── Write Methods ──────────────────────────────────────────────────────────

  /** Persist a single action trace. */
  insertActionTrace(input: ActionTraceInput): void {
    const id = ulid();
    const timestamp = new Date().toISOString();
    this.stmtInsertActionTrace.run(
      id,
      input.task_id,
      input.session_id,
      input.trace_id,
      input.phase,
      input.iteration,
      input.action_type,
      truncate(input.action_params, MAX_ACTION_PARAMS_LENGTH),
      input.result_success ? 1 : 0,
      truncate(input.result_output, MAX_RESULT_OUTPUT_LENGTH),
      input.result_error,
      input.duration_ms,
      timestamp,
    );
  }

  /** Create a phase metrics row when a phase starts. Returns the row ID. */
  createPhaseMetrics(input: PhaseMetricsInput): string {
    const id = ulid();
    const startedAt = new Date().toISOString();
    this.stmtInsertPhaseMetrics.run(
      id,
      input.task_id,
      input.session_id,
      input.trace_id,
      input.phase,
      startedAt,
    );
    return id;
  }

  /** Complete a phase metrics row when a phase finishes. */
  completePhaseMetrics(id: string, result: PhaseMetricsResult): void {
    const endedAt = new Date().toISOString();
    this.stmtCompletePhaseMetrics.run(
      endedAt,
      result.duration_ms,
      result.llm_iterations,
      result.tokens_in,
      result.tokens_out,
      result.spend_usd,
      result.actions_executed,
      result.actions_failed,
      result.outcome,
      id,
    );
  }

  /** Persist an LLM trace. Stores prompt/response in blob store if available. */
  insertLlmTrace(input: LlmTraceInput): void {
    const id = ulid();
    const timestamp = new Date().toISOString();
    this.stmtInsertLlmTrace.run(
      id,
      input.task_id,
      input.trace_id,
      input.phase,
      input.iteration,
      input.prompt_length,
      input.response_length,
      input.tokens_in,
      input.tokens_out,
      input.spend_usd,
      input.latency_ms,
      input.provider_id,
      input.model_id,
      input.finish_reason,
      input.prompt_ref,
      input.response_ref,
      timestamp,
    );
  }

  /**
   * Store content in the blob store and return a reference.
   * Returns null if no blob store is configured.
   */
  storeBlob(content: string): string | null {
    return this.blobStore?.store(content) ?? null;
  }

  /**
   * Read content from the blob store by reference.
   * Returns null if no blob store or blob not found.
   */
  readBlob(ref: string): string | null {
    return this.blobStore?.read(ref) ?? null;
  }

  // ── Read Methods ───────────────────────────────────────────────────────────

  /** Get all action traces for a task, optionally filtered by phase. */
  getActionTraces(taskId: string, phase?: string): ActionTrace[] {
    const rows = phase
      ? (this.stmtGetActionTracesByPhase.all(taskId, phase) as Record<string, unknown>[])
      : (this.stmtGetActionTraces.all(taskId) as Record<string, unknown>[]);
    return rows.map(rowToActionTrace);
  }

  /** Get all LLM traces for a task, optionally filtered by phase. */
  getLlmTraces(taskId: string, phase?: string): LlmTrace[] {
    const rows = phase
      ? (this.stmtGetLlmTracesByPhase.all(taskId, phase) as Record<string, unknown>[])
      : (this.stmtGetLlmTraces.all(taskId) as Record<string, unknown>[]);
    return rows.map(rowToLlmTrace);
  }

  /** Get all phase metrics for a task. */
  getPhaseMetrics(taskId: string): PhaseMetric[] {
    const rows = this.stmtGetPhaseMetrics.all(taskId) as Record<string, unknown>[];
    return rows.map(rowToPhaseMetric);
  }

  /** Get phase metrics by trace ID. */
  getPhaseMetricsByTrace(traceId: string): PhaseMetric[] {
    const rows = this.stmtGetPhaseMetricsByTrace.all(traceId) as Record<string, unknown>[];
    return rows.map(rowToPhaseMetric);
  }

  /** Get the N most recent action traces across all tasks. */
  getRecentActionTraces(limit: number): ActionTrace[] {
    const rows = this.stmtGetRecentActionTraces.all(limit) as Record<string, unknown>[];
    return rows.map(rowToActionTrace);
  }

  /** Get cost breakdown by phase for a task. */
  getTaskCostByPhase(taskId: string): PhaseCostBreakdown[] {
    const rows = this.stmtGetCostByPhase.all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      phase: row["phase"] as string,
      tokens_in: (row["tokens_in"] as number) ?? 0,
      tokens_out: (row["tokens_out"] as number) ?? 0,
      spend_usd: (row["spend_usd"] as number) ?? null,
      llm_iterations: (row["llm_iterations"] as number) ?? 0,
      duration_ms: (row["duration_ms"] as number) ?? null,
    }));
  }

  /** Get system-level stats for dashboard overview. */
  getSystemStats(): SystemStats {
    const tasksByState = this.db
      .prepare("SELECT state, COUNT(*) as count FROM tasks GROUP BY state")
      .all() as Array<{ state: string; count: number }>;

    const stateMap: Record<string, number> = {};
    let totalTasks = 0;
    for (const row of tasksByState) {
      stateMap[row.state] = row.count;
      totalTasks += row.count;
    }

    const actionCount = this.db.prepare("SELECT COUNT(*) as count FROM action_traces").get() as {
      count: number;
    };

    const llmCount = this.db.prepare("SELECT COUNT(*) as count FROM llm_traces").get() as {
      count: number;
    };

    const totalSpend = this.db
      .prepare("SELECT SUM(spend_usd) as total FROM phase_metrics")
      .get() as { total: number | null };

    return {
      total_tasks: totalTasks,
      tasks_by_state: stateMap,
      total_action_traces: actionCount.count,
      total_llm_traces: llmCount.count,
      total_spend_usd: totalSpend.total,
    };
  }
}
