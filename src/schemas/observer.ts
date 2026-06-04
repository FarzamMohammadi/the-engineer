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
  // One element of an agent's live conversation inside a single `agent_call`: an assistant message,
  // a thinking block, a tool the agent invoked, or that tool's result. Children of the open `agent_call`
  // span, written instant. DISTINCT from `tool_execution`, which is an external action the engine itself
  // takes (a git push, a verify gate) — `agent_activity` is what the agent did, observed from its stream.
  "agent_activity",
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

// ── Observation Link ──────────────────────────────────────────────────────────

/**
 * A cross-trace "follows-from" edge: a reference to another observation (by its
 * id, in its own `trace_id`) that this one continues from. Used for trace
 * continuity — a resumed/reworked dispatch's root span links back to the prior
 * dispatch's root, so the whole task lifecycle is one navigable chain of bounded
 * traces rather than a single idle-gap-dominated mega-trace.
 */
export const ObservationLinkSchema = z.object({
  trace_id: z.string(),
  observation_id: z.string(),
});
export type ObservationLink = z.infer<typeof ObservationLinkSchema>;

// ── Span Options ──────────────────────────────────────────────────────────────

export const SpanOptionsSchema = z.object({
  task_id: z.string().optional(),
  trace_id: z.string().optional(),
  parent_observation_id: z.string().optional(),
  phase: z.string().optional(),
  session_id: z.string().optional(),
  level: ObservationLevelSchema.optional(),
  /** Cross-trace continuity edges (see {@link ObservationLinkSchema}). */
  links: z.array(ObservationLinkSchema).optional(),
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
  /** Cross-trace continuity edges; null when the observation has none (the common case). */
  links: z.array(ObservationLinkSchema).nullable(),
});
export type Observation = z.infer<typeof ObservationSchema>;

// ── Query Filters ─────────────────────────────────────────────────────────────

export const ObservationQuerySchema = z.object({
  type: ObservationTypeSchema.optional(),
  task_id: z.string().optional(),
  trace_id: z.string().optional(),
  /** Narrow to the direct children of one observation — e.g. the `agent_activity` rows under an `agent_call`. */
  parent_observation_id: z.string().optional(),
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
  links: string | null;
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
    links: fromSqliteJson<ObservationLink[]>(row.links),
  };
}
