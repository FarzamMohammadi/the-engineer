import type { Phase } from "../../schemas/orchestrator.js";
import type {
  BlockedDetails,
  CascadePolicy,
  ChildCompletionSummary,
  ChildEntry,
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
  state: string;
  sub_state: string | null;
  phase: string | null;
  parent_id: string | null;
  children: string;
  cascade_policy: string;
  title: string;
  description: string;
  source_text: string;
  acceptance_criteria: string;
  team: string;
  related: string;
  decisions: string;
  child_summaries: string;
  repo: string | null;
  clone_url: string | null;
  thoughts_id: string | null;
  workspace: string | null;
  review: string | null;
  blocked: string | null;
  return_to_phase: string | null;
  loopback_count: number;
  requirements_loop_count: number;
  priority: number;
  llm_tokens: number;
  llm_cost_usd: number;
  compute_time_ms: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_transition_at: string;
  not_before: string | null;
  consecutive_crash_count: number;
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
    external_ref: row.external_ref ? (JSON.parse(row.external_ref) as ExternalRef) : null,
    state: row.state as TaskState,
    sub_state: row.sub_state as SubState | null,
    phase: row.phase,
    parent_id: row.parent_id,
    children: JSON.parse(row.children) as ChildEntry[],
    cascade_policy: row.cascade_policy as CascadePolicy,
    title: row.title,
    description: row.description,
    source_text: row.source_text,
    acceptance_criteria: JSON.parse(row.acceptance_criteria) as string[],
    team: JSON.parse(row.team) as TeamMember[],
    related: JSON.parse(row.related) as RelatedItem[],
    decisions: JSON.parse(row.decisions) as TaskDecision[],
    child_summaries: JSON.parse(row.child_summaries) as ChildCompletionSummary[],
    repo: row.repo,
    clone_url: row.clone_url,
    thoughts_id: row.thoughts_id,
    workspace: row.workspace ? (JSON.parse(row.workspace) as TaskWorkspace) : null,
    review: row.review ? (JSON.parse(row.review) as ReviewState) : null,
    blocked: row.blocked ? (JSON.parse(row.blocked) as BlockedDetails) : null,
    return_to_phase: row.return_to_phase as Phase | null,
    loopback_count: row.loopback_count,
    requirements_loop_count: row.requirements_loop_count,
    priority: row.priority,
    llm_tokens: row.llm_tokens,
    llm_cost_usd: row.llm_cost_usd,
    compute_time_ms: row.compute_time_ms,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    last_transition_at: row.last_transition_at,
    not_before: row.not_before,
    consecutive_crash_count: row.consecutive_crash_count,
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
