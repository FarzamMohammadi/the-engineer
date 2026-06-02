import { fromSqliteJson } from "../../db/serialize.js";
import type { PrEventType } from "../../schemas/git-hosting-event-types.js";
import type {
  BlockedDetails,
  ExternalRef,
  RelatedItem,
  ReviewState,
  StateTransition,
  SubState,
  Task,
  TaskDecision,
  TaskState,
  TaskWorkspace,
  TeamMember,
} from "../../schemas/task.js";

/** Shape of a row read from the `tasks` table. */
export interface TaskRow {
  id: string;
  external_ref: string | null;
  idempotency_key: string;
  state: string;
  sub_state: string | null;
  phase: string | null;
  sub_phase: string | null;
  title: string;
  description: string;
  source_text: string;
  acceptance_criteria: string;
  team: string;
  related: string;
  decisions: string;
  repo: string | null;
  clone_url: string | null;
  thoughts_id: string | null;
  workspace: string | null;
  review: string | null;
  blocked: string | null;
  pending_pr_event: string | null;
  phase_iteration: number;
  total_reworks: number;
  priority: number;
  agent_tokens: number;
  agent_cost_usd: number;
  compute_time_ms: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  reaped_at: string | null;
  last_transition_at: string;
  not_before: string | null;
  consecutive_crash_count: number;
  consecutive_agent_unavailable_count: number;
  session_id: string | null;
  /** Optimistic locking — incremented on every state transition. */
  version: number;
}

/** Shape of a row read from the `state_transitions` table. */
export interface StateTransitionRow {
  id: string;
  task_id: string;
  from_state: string;
  to_state: string;
  from_sub: string | null;
  to_sub: string | null;
  reason: string;
  timestamp: string;
  triggered_by: string;
}

/** Convert a `tasks` table row to a typed Task object (parses JSON columns). */
export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    external_ref: fromSqliteJson<ExternalRef>(row.external_ref),
    idempotency_key: row.idempotency_key,
    state: row.state as TaskState,
    sub_state: row.sub_state as SubState | null,
    phase: row.phase,
    sub_phase: row.sub_phase,
    title: row.title,
    description: row.description,
    source_text: row.source_text,
    acceptance_criteria: fromSqliteJson<string[]>(row.acceptance_criteria) ?? [],
    team: fromSqliteJson<TeamMember[]>(row.team) ?? [],
    related: fromSqliteJson<RelatedItem[]>(row.related) ?? [],
    decisions: fromSqliteJson<TaskDecision[]>(row.decisions) ?? [],
    repo: row.repo,
    clone_url: row.clone_url,
    thoughts_id: row.thoughts_id,
    workspace: fromSqliteJson<TaskWorkspace>(row.workspace),
    review: fromSqliteJson<ReviewState>(row.review),
    blocked: fromSqliteJson<BlockedDetails>(row.blocked),
    pending_pr_event: row.pending_pr_event as PrEventType | null,
    phase_iteration: row.phase_iteration,
    total_reworks: row.total_reworks,
    priority: row.priority,
    agent_tokens: row.agent_tokens,
    agent_cost_usd: row.agent_cost_usd,
    compute_time_ms: row.compute_time_ms,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    reaped_at: row.reaped_at,
    last_transition_at: row.last_transition_at,
    not_before: row.not_before,
    consecutive_crash_count: row.consecutive_crash_count,
    consecutive_agent_unavailable_count: row.consecutive_agent_unavailable_count,
    session_id: row.session_id,
  };
}

/** Convert a `state_transitions` table row to a typed StateTransition object. */
export function rowToStateTransition(row: StateTransitionRow): StateTransition {
  return {
    id: row.id,
    task_id: row.task_id,
    from_state: row.from_state as TaskState,
    to_state: row.to_state as TaskState,
    from_sub: row.from_sub as SubState | null,
    to_sub: row.to_sub as SubState | null,
    reason: row.reason,
    timestamp: row.timestamp,
    triggered_by: row.triggered_by,
  };
}
