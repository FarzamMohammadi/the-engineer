/**
 * Observer schemas — Zod schemas for the centralized Observer (Phase R-0).
 *
 * Observation types, query filters, span options, and row mappers.
 * Follows the same pattern as events.ts and observability.ts.
 */
import { z } from "zod";
import { fromSqliteJson } from "../db/serialize.js";

// ── Observation Type Enum ─────────────────────────────────────────────────────

export const ObservationTypeSchema = z.enum([
  "task_execution",
  "agent_call",
  "tool_execution",
  "phase_transition",
  "decision_point",
  "safety_verdict",
  "state_transition",
  "workspace_op",
  "plugin_call",
  "error",
  "lifecycle",
  "quota_status",
]);
export type ObservationTypeValue = z.infer<typeof ObservationTypeSchema>;

/** Constant enum values for ObservationType. Use instead of raw strings. */
export const ObservationTypes = ObservationTypeSchema.enum;

// ── Level & Status ────────────────────────────────────────────────────────────

export const ObservationLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type ObservationLevel = z.infer<typeof ObservationLevelSchema>;

/** Constant enum values for ObservationLevel. Use instead of raw strings. */
export const ObservationLevels = ObservationLevelSchema.enum;

export const ObservationStatusSchema = z.enum(["ok", "error"]);
export type ObservationStatus = z.infer<typeof ObservationStatusSchema>;

/** Constant enum values for ObservationStatus. Use instead of raw strings. */
export const ObservationStatuses = ObservationStatusSchema.enum;

// ── Span Options ──────────────────────────────────────────────────────────────

export const SpanOptionsSchema = z.object({
  task_id: z.string().optional(),
  trace_id: z.string().optional(),
  parent_observation_id: z.string().optional(),
  phase: z.string().optional(),
  session_id: z.string().optional(),
  level: ObservationLevelSchema.optional(),
});
export type SpanOptions = z.infer<typeof SpanOptionsSchema>;

// ── Observation ───────────────────────────────────────────────────────────────

export const ObservationSchema = z.object({
  id: z.string(),
  trace_id: z.string().nullable(),
  parent_observation_id: z.string().nullable(),
  type: ObservationTypeSchema,
  name: z.string(),
  task_id: z.string().nullable(),
  phase: z.string().nullable(),
  session_id: z.string().nullable(),
  start_time: z.string(),
  end_time: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  input: z.record(z.unknown()).nullable(),
  output: z.record(z.unknown()).nullable(),
  metadata: z.record(z.unknown()).nullable(),
  level: ObservationLevelSchema,
  status: ObservationStatusSchema,
  error_message: z.string().nullable(),
});
export type Observation = z.infer<typeof ObservationSchema>;

// ── Query Filters ─────────────────────────────────────────────────────────────

export const ObservationQuerySchema = z.object({
  type: ObservationTypeSchema.optional(),
  task_id: z.string().optional(),
  trace_id: z.string().optional(),
  phase: z.string().optional(),
  since: z.string().optional(),
  level: ObservationLevelSchema.optional(),
  limit: z.number().int().positive().optional(),
});
export type ObservationQuery = z.infer<typeof ObservationQuerySchema>;

// ── Row Mapper ────────────────────────────────────────────────────────────────

interface ObservationRow {
  id: string;
  trace_id: string | null;
  parent_observation_id: string | null;
  type: string;
  name: string;
  task_id: string | null;
  phase: string | null;
  session_id: string | null;
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
  input: string | null;
  output: string | null;
  metadata: string | null;
  level: string;
  status: string;
  error_message: string | null;
}

/** Map a raw SQLite row to an Observation. */
export function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    trace_id: row.trace_id,
    parent_observation_id: row.parent_observation_id,
    type: row.type as ObservationTypeValue,
    name: row.name,
    task_id: row.task_id,
    phase: row.phase,
    session_id: row.session_id,
    start_time: row.start_time,
    end_time: row.end_time,
    duration_ms: row.duration_ms,
    input: fromSqliteJson<Record<string, unknown>>(row.input),
    output: fromSqliteJson<Record<string, unknown>>(row.output),
    metadata: fromSqliteJson<Record<string, unknown>>(row.metadata),
    level: row.level as ObservationLevel,
    status: row.status as ObservationStatus,
    error_message: row.error_message,
  };
}
