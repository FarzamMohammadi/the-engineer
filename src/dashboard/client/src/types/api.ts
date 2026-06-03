import type { BlockCategory, BlockReason, ObservationType, Phase, TaskState } from "../lib/vocabulary";

// Re-export the vocabulary unions so consumers keep importing task contract types from one module. The
// member values live in `lib/vocabulary.ts` (the single client-side source, parity-tested against the
// Zod schemas); this module owns the record/object contracts the API returns.
export type { BlockCategory, BlockReason, ObservationType, Phase, TaskState };

// ── Task ─────────────────────────────────────────────────────────────────────

/** Task sub-state when active. */
export type SubState = "working";

/** The typed payload persisted on a blocked task — mirrors `BlockedDetailsSchema`. */
export interface BlockedDetails {
  /** Coarse routing value the daemon switches on. */
  reason: BlockReason;
  /** The complete cause behind the block. */
  category: BlockCategory;
  /** Which sub-phase the task blocked in. */
  sub_phase: string;
  /** The operator-facing next step that unblocks the task. */
  needed: string;
}

/** Lightweight task row for list views. */
export interface TaskListItem {
  id: string;
  title: string;
  state: TaskState;
  sub_state: SubState | null;
  phase: Phase | null;
  /** Sub-phase within the current phase (e.g. "verify", "create-pr"); null when not in a sub-phase. */
  sub_phase: string | null;
  /** Intra-phase repeat count for the current phase (resets on phase entry). */
  phase_iteration: number;
  /** Inter-phase backward-jump (rework) count for the current dispatch. */
  total_reworks: number;
  priority: number;
  repo: string | null;
  agent_cost_usd: number;
  agent_tokens: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_transition_at: string;
  worktree_path: string | null;
  /** The distinct real pipeline phases this task actually ran, derived from phase_transition observations. */
  phases_ran: Phase[];
  /** Free-text reason from the latest state transition (the human-readable "why"); null when none. */
  blocked_reason: string | null;
  /** The coarse BlockReason enum from the task's `blocked` payload; null unless the task is blocked. */
  block_reason: BlockReason | null;
  /** When the reaper fully reconciled this task (worktree + branch + any PR close); null until reaped. */
  reaped_at: string | null;
}

/** A cross-trace "follows-from" edge to a prior dispatch's root span — mirrors `ObservationLinkSchema`. */
export interface ObservationLink {
  trace_id: string;
  observation_id: string;
}

/** Full task record for detail views. */
export interface TaskDetail {
  id: string;
  title: string;
  state: TaskState;
  sub_state: SubState | null;
  phase: Phase | null;
  /** Sub-phase within the current phase (e.g. "verify", "create-pr"); null when not in a sub-phase. */
  sub_phase: string | null;
  /** Intra-phase repeat count for the current phase (resets on phase entry). */
  phase_iteration: number;
  /** Inter-phase backward-jump (rework) count for the current dispatch. */
  total_reworks: number;
  priority: number;
  repo: string | null;
  branch: string | null;
  agent_cost_usd: number;
  agent_tokens: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_transition_at: string;
  /**
   * When the reaper fully reconciled this task (worktree + branch + any PR close). Null until reaped — the
   * durable signal a finished task has been cleaned up. Surfaced in the overview's cleanup story (S3/S4).
   */
  reaped_at: string | null;
  acceptance_criteria: string[] | null;
  decisions: Record<string, unknown>[] | null;
  workspace: Record<string, unknown> | null;
  review: Record<string, unknown> | null;
  /** Full typed block payload (reason/category/sub_phase/needed); null when the task is not blocked. */
  blocked: BlockedDetails | null;
  external_ref: Record<string, unknown> | null;
  /** The pending external PR event type that re-enters the pipeline on the next dispatch; null when none. */
  pending_pr_event: string | null;
  last_transition_reason: string | null;
  last_transition_by: string | null;
  last_transition_from: TaskState | null;
  /** Trace-lineage link back to the previous dispatch's root span; null on a fresh task. */
  last_trace_link: ObservationLink | null;
  /**
   * OTLP trace id (32-char hex) of the task's most recent dispatch, ready to drop into the Jaeger deep-link.
   * Derived server-side from the dispatch's trace ULID via the same code the exporter uses, so the link can
   * never drift. Null when the task has not been dispatched (no trace yet).
   */
  trace_otlp_id: string | null;
}

// ── System Status ────────────────────────────────────────────────────────────

/** Daemon health and aggregate task counts. */
export interface SystemStatus {
  daemon_running: boolean;
  daemon_pid: number | null;
  agent_provider: string | null;
  total_tasks: number;
  tasks_by_state: Record<string, number>;
  total_action_traces: number;
  total_agent_traces: number;
  total_spend_usd: number | null;
  /** Whether trace export is on — gates the task page's "View trace in Jaeger" link. */
  telemetry_enabled: boolean;
  /** Jaeger v2 web-UI base the trace link points at (distinct from the OTLP ingest endpoint). */
  telemetry_ui_base: string;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

/** Cost and token aggregations for the metrics page. */
export interface CostMetrics {
  today_spend_usd: number;
  month_spend_usd: number;
  per_task: Array<{ id: string; title: string; agent_cost_usd: number; agent_tokens: number }>;
  per_day: Array<{ day: string; spend_usd: number }>;
  per_phase: Array<{
    phase: string;
    spend_usd: number;
    duration_ms: number;
    agent_calls: number;
  }>;
  token_totals: {
    input: number;
    output: number;
    cache_read: number;
    total: number;
  };
}

/** Agent provider quota status and exhaustion history. */
export interface QuotaStatus {
  available: boolean;
  live: Record<string, unknown> | null;
  exhaustion_events: Record<string, unknown>[];
}

// ── Observations ─────────────────────────────────────────────────────────────
// `ObservationType` is sourced from `lib/vocabulary.ts` and re-exported at the top of this module.

/** Log severity level for observations. */
export type ObservationLevel = "debug" | "info" | "warn" | "error";

/** Single observation row from the SQLite observations table. */
export interface Observation {
  id: string;
  trace_id: string | null;
  parent_observation_id: string | null;
  type: ObservationType;
  name: string;
  task_id: string | null;
  phase: string | null;
  session_id: string | null;
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  /** Always null in practice — the observer never writes span metadata. Cost/tokens live in `output`. */
  metadata: Record<string, unknown> | null;
  level: ObservationLevel;
  status: "ok" | "error";
  error_message: string | null;
  /** Cross-trace continuity edges (lineage); null when the observation has none (the common case). */
  links: ObservationLink[] | null;
}

// ── Events ───────────────────────────────────────────────────────────────────

/** Event bus domain event row from the SQLite events table. */
export interface DomainEvent {
  id: string;
  sequence: number;
  type: string;
  source: string;
  task_id: string | null;
  timestamp: string;
  payload: Record<string, unknown>;
}

// ── SSE ──────────────────────────────────────────────────────────────────────

/** SSE message carrying a new observation. */
export interface SseObservationEvent {
  event: "observation";
  data: Observation;
}

/** SSE message carrying a new domain event. */
export interface SseDomainEvent {
  event: "event";
  data: DomainEvent;
}

/** SSE heartbeat with cursor positions. */
export interface SseHeartbeat {
  event: "heartbeat";
  data: { lastObsRowId: number; lastEventSeq: number };
}

// ── Timeline ─────────────────────────────────────────────────────────────────

/** Unified timeline entry combining state-change events, journal entries, and rich observations. */
export interface TimelineItem {
  kind: "event" | "journal" | "observation";
  timestamp: string;
  data: Record<string, unknown>;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** Source category of an error entry. */
export type ErrorKind = "task_failure" | "observation" | "event";

/** Normalized error from any of the 3 error sources. */
export interface ErrorEntry {
  kind: ErrorKind;
  id: string;
  task_id: string | null;
  task_title: string | null;
  message: string;
  detail: string | null;
  timestamp: string;
  level: "error" | "warn";
}

/** Response shape for GET /api/errors. */
export interface ErrorListResponse {
  errors: ErrorEntry[];
  count: number;
}

// ── Activity ────────────────────────────────────────────────────────────────

/** Discriminated union of observations and events for the activity feed. */
export type ActivityItem = { source: "observation"; data: Observation } | { source: "event"; data: DomainEvent };

// ── API Responses ────────────────────────────────────────────────────────────

/** Response shape for GET /api/tasks. */
export interface TaskListResponse {
  tasks: TaskListItem[];
  count: number;
}

/** Response shape for GET /api/tasks/:id. */
export interface TaskDetailResponse {
  task: TaskDetail;
}

/** Response shape for GET /api/tasks/:id/timeline. */
export interface TimelineResponse {
  timeline: TimelineItem[];
}

/** Response shape for GET /api/observations. */
export interface ObservationListResponse {
  observations: Observation[];
  count: number;
}

/** Response shape for GET /api/events. */
export interface EventListResponse {
  events: DomainEvent[];
  count: number;
}
