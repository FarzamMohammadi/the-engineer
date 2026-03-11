import type Database from "better-sqlite3";
import { ulid } from "ulid";

import type {
  ActionClass,
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
import { PermissionTable, ValidTransitions } from "../../schemas/task.js";
import type { EventBus, PublishInput } from "../event-bus/index.js";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Input for createTask(). Only caller-provided fields. */
export interface CreateTaskInput {
  title: string;
  /** Repo context for the event payload (not stored as a task column). */
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

/** All fields updatable via updateTaskField(). Single source of truth — type derived from this. */
const UPDATABLE_FIELDS = [
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
] as const;

/** Fields that can be updated via updateTaskField(). */
export type UpdatableField = (typeof UPDATABLE_FIELDS)[number];

/** Shape of a row read from the `tasks` table. */
interface TaskRow {
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
  workspace: string | null;
  review: string | null;
  blocked: string | null;
  priority: number;
  llm_tokens: number;
  llm_cost_usd: number;
  compute_time_ms: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_transition_at: string;
  session_id: string | null;
}

/** Shape of a row read from the `state_transitions` table. */
interface StateTransitionRow {
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

// ── Row Mapping ──────────────────────────────────────────────────────────────

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
    workspace: row.workspace ? (JSON.parse(row.workspace) as TaskWorkspace) : null,
    review: row.review ? (JSON.parse(row.review) as ReviewState) : null,
    blocked: row.blocked ? (JSON.parse(row.blocked) as BlockedDetails) : null,
    priority: row.priority,
    llm_tokens: row.llm_tokens,
    llm_cost_usd: row.llm_cost_usd,
    compute_time_ms: row.compute_time_ms,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    last_transition_at: row.last_transition_at,
    session_id: row.session_id,
  };
}

/** Convert a `state_transitions` table row to a typed StateTransition object. */
function rowToStateTransition(row: StateTransitionRow): StateTransition {
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

// ── State Machine Validation ─────────────────────────────────────────────────

/**
 * Tests whether a sub-state in a ValidTransitions entry matches an actual sub-state.
 *
 * - Property absent (undefined) in entry → actual must be null (state has no sub-state).
 * - Property present → must match exactly.
 */
function subStateMatches(entrySub: SubState | undefined, actualSub: SubState | null): boolean {
  if (entrySub === undefined) {
    return actualSub === null;
  }
  return entrySub === actualSub;
}

/**
 * Tests whether a state transition is valid according to the ValidTransitions table.
 *
 * - Absent `from_sub` in a transition entry means the source state must have null sub_state.
 * - Absent `to_sub` in a transition entry means the target sub_state must be null.
 */
export function isValidTransition(
  fromState: TaskState,
  fromSub: SubState | null,
  toState: TaskState,
  toSub: SubState | null,
): boolean {
  return ValidTransitions.some((entry) => {
    if (entry.from !== fromState || entry.to !== toState) {
      return false;
    }

    const entryFromSub = "from_sub" in entry ? entry.from_sub : undefined;
    const entryToSub = "to_sub" in entry ? entry.to_sub : undefined;

    return subStateMatches(entryFromSub, fromSub) && subStateMatches(entryToSub, toSub);
  });
}

// ── JSON fields set ──────────────────────────────────────────────────────────

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
 * Owns the task lifecycle: creation, state transitions (validated against the
 * state machine), permission enforcement (Gate 1 of the Action Pipeline),
 * field updates, and cost tracking. Emits events on creation and state changes.
 */
export class TaskEngine {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;

  // ── Prepared statements ──────────────────────────────────────────────────

  private readonly insertTaskStmt: Database.Statement;
  private readonly getTaskStmt: Database.Statement;
  private readonly getTasksByStateStmt: Database.Statement;
  private readonly getQueuedStmt: Database.Statement;
  private readonly getChildrenStmt: Database.Statement;
  private readonly updateStateStmt: Database.Statement;
  private readonly setStartedAtStmt: Database.Statement;
  private readonly setCompletedAtStmt: Database.Statement;
  private readonly insertTransitionStmt: Database.Statement;
  private readonly updateTrackingStmt: Database.Statement;
  private readonly getStateHistoryStmt: Database.Statement;
  private readonly updateFieldStmts: Map<UpdatableField, Database.Statement>;

  constructor(db: Database.Database, eventBus: EventBus) {
    this.db = db;
    this.eventBus = eventBus;

    this.insertTaskStmt = db.prepare(`
      INSERT INTO tasks (
        id, external_ref, state, sub_state, phase,
        parent_id, children, cascade_policy,
        title, description, source_text, acceptance_criteria,
        team, related, decisions, child_summaries,
        workspace, review, blocked,
        priority, llm_tokens, llm_cost_usd, compute_time_ms,
        created_at, started_at, completed_at, last_transition_at,
        session_id
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?
      )
    `);

    this.getTaskStmt = db.prepare("SELECT * FROM tasks WHERE id = ?");

    this.getTasksByStateStmt = db.prepare(
      "SELECT * FROM tasks WHERE state = ? ORDER BY priority DESC, created_at ASC",
    );

    this.getQueuedStmt = db.prepare(
      "SELECT * FROM tasks WHERE state = 'queued' ORDER BY priority DESC, created_at ASC",
    );

    this.getChildrenStmt = db.prepare(
      "SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC",
    );

    this.updateStateStmt = db.prepare(
      "UPDATE tasks SET state = ?, sub_state = ?, last_transition_at = ? WHERE id = ?",
    );

    this.setStartedAtStmt = db.prepare(
      "UPDATE tasks SET started_at = ? WHERE id = ? AND started_at IS NULL",
    );

    this.setCompletedAtStmt = db.prepare("UPDATE tasks SET completed_at = ? WHERE id = ?");

    this.insertTransitionStmt = db.prepare(`
      INSERT INTO state_transitions (id, task_id, from_state, to_state, from_sub, to_sub, reason, timestamp, triggered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.updateTrackingStmt = db.prepare(
      "UPDATE tasks SET llm_tokens = llm_tokens + ?, llm_cost_usd = llm_cost_usd + ?, compute_time_ms = compute_time_ms + ? WHERE id = ?",
    );

    this.getStateHistoryStmt = db.prepare(
      "SELECT * FROM state_transitions WHERE task_id = ? ORDER BY timestamp ASC",
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
    const cascadePolicy = input.cascade_policy ?? "pause_siblings";
    const description = input.description ?? "";
    const sourceText = input.source_text ?? "";
    const acceptanceCriteria = input.acceptance_criteria ?? [];
    const externalRef = input.external_ref ?? null;
    const externalRefJson = externalRef ? JSON.stringify(externalRef) : null;

    this.insertTaskStmt.run(
      id,
      externalRefJson,
      "intake",
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
    );

    this.eventBus.publish({
      type: "task.created",
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
      state: "intake",
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
   * Emits a `task.state_changed` event on success.
   */
  requestTransition(
    taskId: string,
    toState: TaskState,
    toSub: SubState | null,
    reason: string,
    triggeredBy: string,
  ): TransitionResult {
    const task = this.getTask(taskId);
    if (!task) {
      return { success: false, reason: "Task not found" };
    }

    const fromState = task.state;
    const fromSub = task.sub_state;

    if (!isValidTransition(fromState, fromSub, toState, toSub)) {
      const fromLabel = fromSub ? `${fromState}.${fromSub}` : fromState;
      const toLabel = toSub ? `${toState}.${toSub}` : toState;
      return {
        success: false,
        reason: `Invalid transition from ${fromLabel} to ${toLabel}`,
      };
    }

    const now = new Date().toISOString();
    const transitionId = ulid();

    const executeTransition = this.db.transaction(() => {
      this.updateStateStmt.run(toState, toSub, now, taskId);

      if (toState === "active") {
        this.setStartedAtStmt.run(now, taskId);
      }

      if (toState === "completed" || toState === "failed") {
        this.setCompletedAtStmt.run(now, taskId);
      }

      this.insertTransitionStmt.run(
        transitionId,
        taskId,
        fromState,
        toState,
        fromSub,
        toSub,
        reason,
        now,
        triggeredBy,
      );
    });

    executeTransition();

    this.eventBus.publish({
      type: "task.state_changed",
      source: "task_engine",
      task_id: taskId,
      payload: {
        task_id: taskId,
        from_state: fromState,
        from_sub: fromSub,
        to_state: toState,
        to_sub: toSub,
        reason,
        triggered_by: triggeredBy,
      },
    } satisfies PublishInput<"task.state_changed">);

    return { success: true };
  }

  // ── Permission Check ──────────────────────────────────────────────────────

  /**
   * Check whether an action class is permitted in the task's current state.
   *
   * This is Gate 1 of the Action Pipeline. Returns whether the action is
   * allowed, denied, or conditionally allowed (caller must evaluate the condition).
   */
  checkPermission(taskId: string, actionClass: ActionClass): PermissionResult {
    const task = this.getTask(taskId);
    if (!task) {
      return { allowed: false, reason: "Task not found" };
    }

    const entry = PermissionTable.find(
      (e) => e.state === task.state && e.sub_state === task.sub_state,
    );

    if (!entry) {
      return {
        allowed: false,
        reason: `No permission entry for state ${task.state}.${task.sub_state ?? "null"}`,
      };
    }

    // Check if action is in the allowed list
    if ((entry.allowed as readonly string[]).includes(actionClass)) {
      return { allowed: true };
    }

    // Check conditional permissions
    if (entry.conditional) {
      const condition = (entry.conditional as Partial<Record<string, string>>)[actionClass];
      if (condition) {
        return { allowed: true, conditional: condition };
      }
    }

    const stateLabel = task.sub_state ? `${task.state}.${task.sub_state}` : task.state;
    return {
      allowed: false,
      reason: `Action "${actionClass}" not permitted in state ${stateLabel}`,
    };
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /** Get a task by ID. Returns null if not found. */
  getTask(id: string): Task | null {
    const row = this.getTaskStmt.get(id) as TaskRow | undefined;
    if (!row) {
      return null;
    }
    return rowToTask(row);
  }

  /** Get all tasks in a given state, ordered by priority DESC, created_at ASC. */
  getTasksByState(state: TaskState): Task[] {
    const rows = this.getTasksByStateStmt.all(state) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Get all queued tasks, ordered by priority DESC, created_at ASC. */
  getQueuedByPriority(): Task[] {
    const rows = this.getQueuedStmt.all() as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Get all children of a parent task, ordered by created_at ASC. */
  getChildren(parentId: string): Task[] {
    const rows = this.getChildrenStmt.all(parentId) as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Get the full state transition history for a task, ordered by timestamp ASC. */
  getStateHistory(taskId: string): StateTransition[] {
    const rows = this.getStateHistoryStmt.all(taskId) as StateTransitionRow[];
    return rows.map(rowToStateTransition);
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
      throw new Error(`TaskEngine: unknown updatable field "${field}"`);
    }

    const serialized = JSON_FIELDS.has(field)
      ? value === null
        ? null
        : JSON.stringify(value)
      : value;
    const result = stmt.run(serialized, taskId);

    if (result.changes === 0) {
      console.warn(`TaskEngine: updateTaskField — task ${taskId} not found`);
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
      console.warn(`TaskEngine: updateTracking — task ${taskId} not found`);
    }
  }
}
