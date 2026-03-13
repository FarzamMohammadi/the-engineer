import type {
  ActionClass,
  CascadePolicy,
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
  /** Who created this task: "github-trigger", "manual", "decomposition", etc. */
  source: string;
  external_ref?: ExternalRef | null;
  parent_id?: string | null;
  description?: string;
  source_text?: string;
  acceptance_criteria?: string[];
  priority?: number;
  cascade_policy?: CascadePolicy;
  /** Git clone URL for the target repo (D148). */
  clone_url?: string | null;
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
  | "cascade_policy"
  | "session_id"
  | "description"
  | "source_text"
  | "external_ref"
  | "workspace"
  | "review"
  | "blocked"
  | "children"
  | "team"
  | "related"
  | "decisions"
  | "child_summaries"
  | "acceptance_criteria"
  | "priority"
  | "repo"
  | "clone_url";

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
  getQueuedByPriority(): Task[];
  getChildren(parentId: string): Task[];
  getStateHistory(taskId: string): StateTransition[];
  updateTaskField(taskId: string, field: UpdatableField, value: unknown): void;
  updateTracking(taskId: string, tokens: number, costUsd: number, computeMs: number): void;
}
