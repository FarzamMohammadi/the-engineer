// ── Task ─────────────────────────────────────────────────────────────────────

/** Valid task lifecycle states. */
export type TaskState =
  | "requirements_gathering"
  | "queued"
  | "active"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

/** Task sub-state when active. */
export type SubState = "working";

/** RRPIR pipeline phase. */
export type Phase = "requirements_gathering" | "research" | "planning" | "execution" | "self_review" | "demo_prep";

/** Lightweight task row for list views. */
export interface TaskListItem {
  id: string;
  title: string;
  state: TaskState;
  sub_state: SubState | null;
  phase: Phase | null;
  priority: number;
  repo: string | null;
  agent_cost_usd: number;
  agent_tokens: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_transition_at: string;
  worktree_path: string | null;
  phases_ran: string[];
  blocked_reason: string | null;
}

/** Full task record for detail views. */
export interface TaskDetail {
  id: string;
  title: string;
  state: TaskState;
  sub_state: SubState | null;
  phase: Phase | null;
  priority: number;
  repo: string | null;
  branch: string | null;
  agent_cost_usd: number;
  agent_tokens: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_transition_at: string;
  acceptance_criteria: string[] | null;
  decisions: Record<string, unknown>[] | null;
  workspace: Record<string, unknown> | null;
  review: Record<string, unknown> | null;
  blocked: Record<string, unknown> | null;
  external_ref: Record<string, unknown> | null;
  last_transition_reason: string | null;
  last_transition_by: string | null;
  last_transition_from: TaskState | null;
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

/** Observation types recorded by the observer. */
export type ObservationType =
  | "task_execution"
  | "agent_call"
  | "tool_execution"
  | "phase_transition"
  | "decision_point"
  | "safety_verdict"
  | "state_transition"
  | "workspace_op"
  | "plugin_call"
  | "error"
  | "lifecycle"
  | "quota_status";

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
  metadata: Record<string, unknown> | null;
  level: ObservationLevel;
  status: "ok" | "error";
  error_message: string | null;
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
