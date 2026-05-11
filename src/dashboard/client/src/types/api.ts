// ── Task ─────────────────────────────────────────────────────────────────────

export type TaskState =
  | "requirements_gathering"
  | "queued"
  | "active"
  | "blocked"
  | "review_pending"
  | "completed"
  | "failed";

export type SubState = "working" | "supervising" | "integrating" | "code";

export type Phase =
  | "requirements_gathering"
  | "research"
  | "planning"
  | "execution"
  | "self_review"
  | "demo_prep"
  | "integration";

export interface TaskListItem {
  id: string;
  title: string;
  state: TaskState;
  sub_state: SubState | null;
  phase: Phase | null;
  priority: number;
  repo: string | null;
  llm_cost_usd: number;
  llm_tokens: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_transition_at: string;
  parent_id: string | null;
  children_count: number;
  worktree_path: string | null;
  phases_ran: string[];
  blocked_reason: string | null;
}

export interface TaskDetail {
  id: string;
  title: string;
  state: TaskState;
  sub_state: SubState | null;
  phase: Phase | null;
  priority: number;
  repo: string | null;
  branch: string | null;
  llm_cost_usd: number;
  llm_tokens: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_transition_at: string;
  parent_id: string | null;
  children: string[];
  acceptance_criteria: string[] | null;
  decisions: Record<string, unknown>[] | null;
  workspace: Record<string, unknown> | null;
  review: Record<string, unknown> | null;
  blocked: Record<string, unknown> | null;
  external_ref: Record<string, unknown> | null;
  last_transition_reason: string | null;
  last_transition_by: string | null;
  last_transition_from: TaskState | null;
}

// ── System Status ────────────────────────────────────────────────────────────

export interface SystemStatus {
  daemon_running: boolean;
  daemon_pid: number | null;
  llm_provider: string | null;
  total_tasks: number;
  tasks_by_state: Record<string, number>;
  total_action_traces: number;
  total_llm_traces: number;
  total_spend_usd: number | null;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface CostMetrics {
  today_spend_usd: number;
  month_spend_usd: number;
  per_task: Array<{ id: string; title: string; llm_cost_usd: number; llm_tokens: number }>;
  per_day: Array<{ day: string; spend_usd: number; duration_ms: number }>;
  per_phase: Array<{
    phase: string;
    spend_usd: number;
    duration_ms: number;
    llm_iterations: number;
    executions: number;
  }>;
  token_totals: {
    input: number;
    output: number;
    cache_read: number;
    total: number;
  };
}

export interface QuotaStatus {
  available: boolean;
  live: Record<string, unknown> | null;
  exhaustion_events: Record<string, unknown>[];
}

// ── Observations ─────────────────────────────────────────────────────────────

export type ObservationType =
  | "agent_iteration"
  | "llm_call"
  | "tool_execution"
  | "phase_transition"
  | "decision_point"
  | "safety_verdict"
  | "state_transition"
  | "workspace_op"
  | "plugin_call"
  | "error"
  | "cost_snapshot"
  | "lifecycle"
  | "config_change"
  | "quota_status";

export type ObservationLevel = "debug" | "info" | "warn" | "error";

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

export interface SseObservationEvent {
  event: "observation";
  data: Observation;
}

export interface SseDomainEvent {
  event: "event";
  data: DomainEvent;
}

export interface SseHeartbeat {
  event: "heartbeat";
  data: { lastObsRowId: number; lastEventSeq: number };
}

// ── API Responses ────────────────────────────────────────────────────────────

export interface TaskListResponse {
  tasks: TaskListItem[];
  count: number;
}

export interface TaskDetailResponse {
  task: TaskDetail;
}

export interface ObservationListResponse {
  observations: Observation[];
  count: number;
}

export interface EventListResponse {
  events: DomainEvent[];
  count: number;
}
