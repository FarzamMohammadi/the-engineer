import type Database from "better-sqlite3";
import { ulid } from "ulid";

import {
  EventTypes,
  TaskCreatedPayloadSchema,
  TaskStateChangedPayloadSchema,
} from "../../schemas/events.js";
import type {
  ActionClass,
  StateTransition,
  SubState,
  Task,
  TaskState,
} from "../../schemas/task.js";
import { CascadePolicies, TaskStates } from "../../schemas/task.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type {
  CreateTaskInput,
  ITaskEngine,
  PermissionResult,
  TransitionResult,
  UpdatableField,
} from "../interfaces/task-engine.interface.js";

// Import EventBus class for constructor injection
import type { EventBus } from "../event-bus/index.js";
import type { IObserver } from "../observer/facade.js";

// Internal modules
import { UnknownFieldError } from "./errors.js";
import { checkPermission as checkPermissionPure } from "./permissions.js";
import { TaskQueries } from "./queries.js";
import { StateMachine } from "./state-machine.js";

// Re-export interface types so existing consumers don't break
export type {
  CreateTaskInput,
  TransitionResult,
  PermissionResult,
  UpdatableField,
} from "../interfaces/task-engine.interface.js";

// Re-export extracted modules for backward compatibility
export { isValidTransition, subStateMatches } from "./state-machine.js";
export { rowToTask } from "./row-mapper.js";
export { checkPermission } from "./permissions.js";

// ── Event Declarations ──────────────────────────────────────────────────────

export const EVENTS: EventDeclaration[] = [
  {
    type: "task.created",
    description: "Emitted when a new task is created in the system",
    payloadSchema: TaskCreatedPayloadSchema,
    publishers: ["task-engine"],
    subscribers: [],
  },
  {
    type: "task.state_changed",
    description: "Emitted when a task transitions between states",
    payloadSchema: TaskStateChangedPayloadSchema,
    publishers: ["task-engine"],
    subscribers: [],
  },
];

// ── Constants ────────────────────────────────────────────────────────────────

/** All fields updatable via updateTaskField(). Single source of truth — type derived from this. */
const UPDATABLE_FIELDS: readonly UpdatableField[] = [
  "phase",
  "cascade_policy",
  "session_id",
  "description",
  "source_text",
  "external_ref",
  "workspace",
  "review",
  "blocked",
  "children",
  "team",
  "related",
  "decisions",
  "child_summaries",
  "acceptance_criteria",
  "priority",
  "repo",
  "clone_url",
];

const JSON_FIELDS: ReadonlySet<UpdatableField> = new Set([
  "external_ref",
  "workspace",
  "review",
  "blocked",
  "children",
  "team",
  "related",
  "decisions",
  "child_summaries",
  "acceptance_criteria",
]);

// ── TaskEngine ──────────────────────────────────────────────────────────────

/**
 * State authority for all tasks in the system.
 *
 * Facade that delegates to focused modules:
 * - StateMachine: state transition validation + execution with optimistic locking
 * - TaskQueries: read-only queries
 * - checkPermission: Gate 1 pure function
 *
 * Owns directly: task creation, field updates, cost tracking.
 * Emits events on creation and state changes.
 */
export class TaskEngine implements ITaskEngine {
  private readonly eventBus: EventBus;
  private readonly observer: IObserver;
  private readonly stateMachine: StateMachine;
  private readonly queries: TaskQueries;

  // ── Prepared statements (creation + field updates) ────────────────────────

  private readonly insertTaskStmt: Database.Statement;
  private readonly updateTrackingStmt: Database.Statement;
  private readonly updateFieldStmts: Map<UpdatableField, Database.Statement>;

  constructor(db: Database.Database, eventBus: EventBus, observer: IObserver) {
    this.eventBus = eventBus;
    this.observer = observer;
    this.stateMachine = new StateMachine(db, eventBus);
    this.queries = new TaskQueries(db);

    this.insertTaskStmt = db.prepare(`
      INSERT INTO tasks (
        id, external_ref, state, sub_state, phase,
        parent_id, children, cascade_policy,
        title, description, source_text, acceptance_criteria,
        team, related, decisions, child_summaries,
        repo, clone_url, workspace, review, blocked,
        priority, llm_tokens, llm_cost_usd, compute_time_ms,
        created_at, started_at, completed_at, last_transition_at,
        session_id, version
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?
      )
    `);

    this.updateTrackingStmt = db.prepare(
      "UPDATE tasks SET llm_tokens = llm_tokens + ?, llm_cost_usd = llm_cost_usd + ?, compute_time_ms = compute_time_ms + ? WHERE id = ?",
    );

    // Per-field update statements
    this.updateFieldStmts = new Map();
    for (const field of UPDATABLE_FIELDS) {
      this.updateFieldStmts.set(field, db.prepare(`UPDATE tasks SET ${field} = ? WHERE id = ?`));
    }
  }

  // ── Task Creation ───────────────────────────────────────────────────────────

  /**
   * Create a new task in Intake state.
   *
   * The task is returned in `intake` state. The caller is responsible for
   * transitioning to `queued` via `requestTransition()` when ready.
   * Emits a `task.created` event.
   */
  createTask(input: CreateTaskInput): Task {
    const id = ulid();
    const now = new Date().toISOString();
    const priority = input.priority ?? 50;
    const parentId = input.parent_id ?? null;
    const cascadePolicy = input.cascade_policy ?? CascadePolicies.pause_siblings;
    const description = input.description ?? "";
    const sourceText = input.source_text ?? "";
    const acceptanceCriteria = input.acceptance_criteria ?? [];
    const externalRef = input.external_ref ?? null;
    const externalRefJson = externalRef ? JSON.stringify(externalRef) : null;

    this.insertTaskStmt.run(
      id,
      externalRefJson,
      TaskStates.intake,
      null, // sub_state
      null, // phase
      parentId,
      "[]", // children
      cascadePolicy,
      input.title,
      description,
      sourceText,
      JSON.stringify(acceptanceCriteria),
      "[]", // team
      "[]", // related
      "[]", // decisions
      "[]", // child_summaries
      input.repo, // repo
      input.clone_url ?? null, // clone_url
      null, // workspace
      null, // review
      null, // blocked
      priority,
      0, // llm_tokens
      0.0, // llm_cost_usd
      0, // compute_time_ms
      now, // created_at
      null, // started_at
      null, // completed_at
      now, // last_transition_at
      null, // session_id
      1, // version
    );

    this.eventBus.publish({
      type: EventTypes["task.created"],
      source: "task_engine",
      task_id: id,
      payload: {
        task_id: id,
        parent_id: parentId,
        title: input.title,
        external_ref: externalRefJson,
        source: input.source,
        priority,
        repo: input.repo,
      },
    } satisfies PublishInput<"task.created">);

    const task: Task = {
      id,
      external_ref: externalRef,
      state: TaskStates.intake,
      sub_state: null,
      phase: null,
      parent_id: parentId,
      children: [],
      cascade_policy: cascadePolicy,
      title: input.title,
      description,
      source_text: sourceText,
      acceptance_criteria: acceptanceCriteria,
      team: [],
      related: [],
      decisions: [],
      child_summaries: [],
      repo: input.repo,
      clone_url: input.clone_url ?? null,
      workspace: null,
      review: null,
      blocked: null,
      priority,
      llm_tokens: 0,
      llm_cost_usd: 0,
      compute_time_ms: 0,
      created_at: now,
      started_at: null,
      completed_at: null,
      last_transition_at: now,
      session_id: null,
    };

    return task;
  }

  // ── State Transitions ──────────────────────────────────────────────────────

  /**
   * Request a state transition for a task.
   *
   * Validates the transition against the state machine. If valid, atomically
   * updates the task state and records the transition in the audit trail.
   * Uses optimistic locking to detect concurrent modifications.
   * Emits a `task.state_changed` event on success.
   */
  requestTransition(
    taskId: string,
    toState: TaskState,
    toSub: SubState | null,
    reason: string,
    triggeredBy: string,
  ): TransitionResult {
    return this.stateMachine.requestTransition(taskId, toState, toSub, reason, triggeredBy);
  }

  // ── Permission Check ──────────────────────────────────────────────────────

  /**
   * Check whether an action class is permitted in the task's current state.
   *
   * This is Gate 1 of the Action Pipeline. Returns whether the action is
   * allowed, denied, or conditionally allowed (caller must evaluate the condition).
   */
  checkPermission(taskId: string, actionClass: ActionClass): PermissionResult {
    const task = this.queries.getTask(taskId);
    if (!task) {
      return { allowed: false, reason: "Task not found" };
    }
    return checkPermissionPure(task.state, task.sub_state, actionClass);
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /** Get a task by ID. Returns null if not found. */
  getTask(id: string): Task | null {
    return this.queries.getTask(id);
  }

  /** Get all tasks in a given state, ordered by priority DESC, created_at ASC. */
  getTasksByState(state: TaskState): Task[] {
    return this.queries.getTasksByState(state);
  }

  /** Get all queued tasks, ordered by priority DESC, created_at ASC. */
  getQueuedByPriority(): Task[] {
    return this.queries.getQueuedByPriority();
  }

  /** Get all children of a parent task, ordered by created_at ASC. */
  getChildren(parentId: string): Task[] {
    return this.queries.getChildren(parentId);
  }

  /** Get the full state transition history for a task, ordered by timestamp ASC. */
  getStateHistory(taskId: string): StateTransition[] {
    return this.queries.getStateHistory(taskId);
  }

  // ── Field Updates ──────────────────────────────────────────────────────────

  /**
   * Update a single field on a task.
   *
   * JSON fields (workspace, review, blocked, children, team, related, decisions,
   * child_summaries, acceptance_criteria, external_ref) are automatically serialized.
   * Scalar fields (phase, cascade_policy, session_id, description, source_text)
   * are written directly.
   */
  updateTaskField(taskId: string, field: UpdatableField, value: unknown): void {
    const stmt = this.updateFieldStmts.get(field);
    if (!stmt) {
      throw new UnknownFieldError(field);
    }

    const serialized = JSON_FIELDS.has(field)
      ? value === null
        ? null
        : JSON.stringify(value)
      : value;
    const result = stmt.run(serialized, taskId);

    if (result.changes === 0) {
      this.observer.warn("updateTaskField — task not found", { taskId });
    }
  }

  // ── Cost Tracking ──────────────────────────────────────────────────────────

  /**
   * Increment cost tracking counters on a task.
   *
   * Uses SQL `SET x = x + ?` for atomic accumulation. Does not throw on
   * missing task — logs a warning instead (fire-and-forget accumulator).
   */
  updateTracking(taskId: string, tokens: number, costUsd: number, computeMs: number): void {
    const result = this.updateTrackingStmt.run(tokens, costUsd, computeMs, taskId);
    if (result.changes === 0) {
      this.observer.warn("updateTracking — task not found", { taskId });
    }
  }
}
