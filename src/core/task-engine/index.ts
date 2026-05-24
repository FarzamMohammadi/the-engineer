import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { type SqliteColumnType, toSqlite, toSqliteJson } from "../../db/serialize.js";

import { EventTypes, TaskCreatedPayloadSchema, TaskStateChangedPayloadSchema } from "../../schemas/events.js";
import type { ActionClass, StateTransition, SubState, Task, TaskState } from "../../schemas/task.js";
import { TaskStates } from "../../schemas/task.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type {
  CreateTaskInput,
  ITaskEngine,
  PermissionResult,
  TransitionResult,
  UpdatableField,
} from "../interfaces/task-engine.interface.js";

import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { IObserver } from "../observer/index.js";

import { UnknownFieldError } from "./errors.js";
import { checkPermission as checkPermissionPure } from "./permissions.js";
import { TaskQueries } from "./queries.js";
import { StateMachine } from "./state-machine.js";

// Public API of the task-engine module, re-exported through this barrel. The types
// live in the interface file and the functions in internal modules; consumers import
// them from here so the module has a single entry point.
export type {
  CreateTaskInput,
  TransitionResult,
  PermissionResult,
  UpdatableField,
} from "../interfaces/task-engine.interface.js";

export { isValidTransition, subStateMatches } from "./state-machine.js";
export { rowToTask } from "./row-mapper.js";
export { checkPermission } from "./permissions.js";

// ── Event Declarations ──────────────────────────────────────────────────────

export const EVENTS: EventDeclaration[] = [
  {
    type: EventTypes["task.created"],
    description: "Emitted when a new task is created in the system",
    payloadSchema: TaskCreatedPayloadSchema,
    publishers: ["task-engine"],
    subscribers: [],
  },
  {
    type: EventTypes["task.state_changed"],
    description: "Emitted when a task transitions between states",
    payloadSchema: TaskStateChangedPayloadSchema,
    publishers: ["task-engine"],
    subscribers: [],
  },
];

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Column type classification for updateTaskField serialization.
 *
 * - "text": stored as-is (string | null). SQLite TEXT columns.
 * - "integer": coerced to number (booleans → 0/1). SQLite INTEGER columns.
 * - "real": stored as-is (number | null). SQLite REAL columns.
 * - "json": JSON.stringify'd before storage. SQLite TEXT columns holding JSON.
 *
 * Single source of truth — UPDATABLE_FIELDS and JSON_FIELDS are derived from this.
 * Adding a new field? Add it here with the correct type.
 */
const FIELD_TYPES: Record<UpdatableField, SqliteColumnType> = {
  // TEXT columns
  phase: "text",
  session_id: "text",
  description: "text",
  source_text: "text",
  repo: "text",
  clone_url: "text",
  return_to_phase: "text",
  not_before: "text",

  // INTEGER columns (includes boolean-as-integer)
  priority: "integer",
  loopback_count: "integer",
  requirements_loop_count: "integer",
  skip_research: "boolean",
  consecutive_crash_count: "integer",

  // REAL columns
  // (none currently — cost fields are updated via updateTracking, not updateTaskField)

  // JSON columns (TEXT holding JSON.stringify'd objects/arrays)
  external_ref: "json",
  workspace: "json",
  review: "json",
  blocked: "json",
  team: "json",
  related: "json",
  decisions: "json",
  acceptance_criteria: "json",
};

/** All fields updatable via updateTaskField(). Derived from FIELD_TYPES. */
const UPDATABLE_FIELDS: readonly UpdatableField[] = Object.keys(FIELD_TYPES) as UpdatableField[];

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
  private readonly eventBus: IEventBus;
  private readonly observer: IObserver;
  private readonly stateMachine: StateMachine;
  private readonly queries: TaskQueries;

  // ── Prepared statements (creation + field updates) ────────────────────────

  private readonly insertTaskStmt: Database.Statement;
  private readonly updateTrackingStmt: Database.Statement;
  private readonly updateFieldStmts: Map<UpdatableField, Database.Statement>;

  constructor(db: Database.Database, eventBus: IEventBus, observer: IObserver) {
    this.eventBus = eventBus;
    this.observer = observer;
    this.stateMachine = new StateMachine(db, eventBus);
    this.queries = new TaskQueries(db);

    this.insertTaskStmt = db.prepare(`
      INSERT INTO tasks (
        id, external_ref, idempotency_key, state, sub_state, phase,
        title, description, source_text, acceptance_criteria,
        team, related, decisions,
        repo, clone_url, thoughts_id, workspace, review, blocked,
        return_to_phase,
        priority, llm_tokens, llm_cost_usd, compute_time_ms,
        created_at, started_at, completed_at, last_transition_at,
        not_before, consecutive_crash_count,
        session_id, version
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
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
    const description = input.description ?? "";
    const sourceText = input.source_text ?? "";
    const acceptanceCriteria = input.acceptance_criteria ?? [];
    const externalRef = input.external_ref ?? null;
    this.insertTaskStmt.run(
      id,
      toSqliteJson(externalRef),
      input.idempotency_key,
      TaskStates.requirements_gathering,
      null, // sub_state
      null, // phase
      input.title,
      description,
      sourceText,
      toSqliteJson(acceptanceCriteria),
      "[]", // team
      "[]", // related
      "[]", // decisions
      input.repo, // repo
      input.clone_url ?? null, // clone_url
      input.thoughts_id ?? null, // thoughts_id
      null, // workspace
      null, // review
      null, // blocked
      null, // return_to_phase
      priority,
      0, // llm_tokens
      0.0, // llm_cost_usd
      0, // compute_time_ms
      now, // created_at
      null, // started_at
      null, // completed_at
      now, // last_transition_at
      null, // not_before
      0, // consecutive_crash_count
      null, // session_id
      1, // version
    );

    this.eventBus.publish({
      type: EventTypes["task.created"],
      source: "task_engine",
      task_id: id,
      payload: {
        task_id: id,
        title: input.title,
        external_ref: externalRef,
        idempotency_key: input.idempotency_key,
        source: input.source,
        priority,
        repo: input.repo,
      },
    } satisfies PublishInput<"task.created">);

    const task: Task = {
      id,
      external_ref: externalRef,
      idempotency_key: input.idempotency_key,
      state: TaskStates.requirements_gathering,
      sub_state: null,
      phase: null,
      title: input.title,
      description,
      source_text: sourceText,
      acceptance_criteria: acceptanceCriteria,
      team: [],
      related: [],
      decisions: [],
      repo: input.repo,
      clone_url: input.clone_url ?? null,
      thoughts_id: input.thoughts_id ?? null,
      workspace: null,
      review: null,
      blocked: null,
      return_to_phase: null,
      loopback_count: 0,
      requirements_loop_count: 0,
      skip_research: false,
      priority,
      llm_tokens: 0,
      llm_cost_usd: 0,
      compute_time_ms: 0,
      created_at: now,
      started_at: null,
      completed_at: null,
      last_transition_at: now,
      not_before: null,
      consecutive_crash_count: 0,
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

  /** Get the full state transition history for a task, ordered by timestamp ASC. */
  getStateHistory(taskId: string): StateTransition[] {
    return this.queries.getStateHistory(taskId);
  }

  // ── Field Updates ──────────────────────────────────────────────────────────

  /**
   * Update a single field on a task.
   *
   * JSON fields (workspace, review, blocked, team, related, decisions,
   * acceptance_criteria, external_ref) are automatically serialized.
   * Scalar fields (phase, session_id, description, source_text) are written directly.
   */
  updateTaskField(taskId: string, field: UpdatableField, value: unknown): void {
    const stmt = this.updateFieldStmts.get(field);
    if (!stmt) {
      throw new UnknownFieldError(field);
    }

    const serialized = toSqlite(FIELD_TYPES[field], value);
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

  /** Check if a non-terminal task exists with the given idempotency key (durable dedup). */
  findByIdempotencyKey(key: string): boolean {
    return this.queries.findByIdempotencyKey(key);
  }
}
