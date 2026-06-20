import type {
  ActionClass,
  BlockReason,
  ExternalRef,
  StateTransition,
  SubState,
  Task,
  TaskState,
} from "../../schemas/task.js";

/** Input for createTask(). Only caller-provided fields. */
export interface CreateTaskInput {
  title: string;
  /** Repository identifier (e.g. "owner/repo"). Stored on the task for workspace creation. */
  repo: string;
  /** Who created this task: "github-trigger", "manual", etc. */
  source: string;
  /** Stable dedup identity (e.g. "github:issue:owner/repo:42"). Required — every task
   *  carries one. Uniqueness is enforced among non-terminal tasks. */
  idempotency_key: string;
  external_ref?: ExternalRef | null;
  description?: string;
  source_text?: string;
  acceptance_criteria?: string[];
  priority?: number;
  /** Git clone URL for the target repo (D148). */
  clone_url?: string | null;
  /** Trigger-provided identifier for the thoughts/ directory (e.g., "issue-42"). */
  thoughts_id?: string | null;
}

/** Result of requestTransition(). */
export interface TransitionResult {
  success: boolean;
  reason?: string;
}

/** Result of checkPermission(). */
export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  /** Condition the caller must evaluate (e.g., "auto_merge configured for repo"). */
  conditional?: string;
}

/** Fields that can be updated via updateTaskField(). */
export type UpdatableField =
  | "phase"
  | "sub_phase"
  | "session_id"
  | "last_trace_link"
  | "description"
  | "source_text"
  | "external_ref"
  | "workspace"
  | "review"
  | "blocked"
  | "pending_pr_event"
  | "pending_response"
  | "team"
  | "related"
  | "decisions"
  | "acceptance_criteria"
  | "priority"
  | "repo"
  | "clone_url"
  | "phase_iteration"
  | "total_reworks"
  | "not_before"
  | "reaped_at"
  | "consecutive_crash_count"
  | "consecutive_agent_unavailable_count";

export interface ITaskEngine {
  createTask(input: CreateTaskInput): Task;
  requestTransition(
    taskId: string,
    toState: TaskState,
    toSub: SubState | null,
    reason: string,
    triggeredBy: string,
  ): TransitionResult;
  checkPermission(taskId: string, actionClass: ActionClass): PermissionResult;
  getTask(id: string): Task | null;
  getTasksByState(state: TaskState): Task[];
  getBlockedTasksByReason(reason: BlockReason): Task[];
  getQueuedByPriority(): Task[];
  /** Terminal tasks the reaper has not yet reconciled: completed/cancelled (not failed) with reaped_at NULL. */
  getUnreapedTerminalTasks(): Task[];
  getStateHistory(taskId: string): StateTransition[];
  updateTaskField(taskId: string, field: UpdatableField, value: unknown): void;
  updateTracking(taskId: string, tokens: number, costUsd: number, computeMs: number): void;
  /** Check if a non-terminal task exists with the given idempotency key (durable dedup). */
  findByIdempotencyKey(key: string): boolean;
  /** The task holding an idempotency key (id + state), or null. Explains a suppressed re-trigger. */
  findKeyHolder(key: string): { id: string; state: TaskState } | null;
}
