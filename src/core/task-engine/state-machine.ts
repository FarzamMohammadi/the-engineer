import type Database from "better-sqlite3";
import { ulid } from "ulid";

import { EventTypes } from "../../schemas/events.js";
import type { SubState, TaskState } from "../../schemas/task.js";
import { TaskStates, ValidTransitions, isTerminal } from "../../schemas/task.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type { TransitionResult } from "../interfaces/task-engine.interface.js";
import { VersionConflictError } from "./errors.js";
import type { TaskRow } from "./row-mapper.js";

// ── Pure Validation Functions ────────────────────────────────────────────────

/**
 * Tests whether a sub-state in a ValidTransitions entry matches an actual sub-state.
 *
 * - Property absent (undefined) in entry → actual must be null (state has no sub-state).
 * - Property present → must match exactly.
 */
export function subStateMatches(entrySub: SubState | undefined, actualSub: SubState | null): boolean {
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

// ── StateMachine Class ───────────────────────────────────────────────────────

/**
 * Executes state transitions within a database transaction.
 * Validates the transition, updates state with optimistic locking,
 * records audit trail, emits event.
 */
export class StateMachine {
  private readonly getTaskStmt: Database.Statement;
  private readonly updateStateStmt: Database.Statement;
  private readonly setStartedAtStmt: Database.Statement;
  private readonly setCompletedAtStmt: Database.Statement;
  private readonly insertTransitionStmt: Database.Statement;

  private readonly db: Database.Database;
  private readonly eventBus: IEventBus;

  constructor(db: Database.Database, eventBus: IEventBus) {
    this.db = db;
    this.eventBus = eventBus;
    this.getTaskStmt = db.prepare("SELECT * FROM tasks WHERE id = ?");

    this.updateStateStmt = db.prepare(
      "UPDATE tasks SET state = ?, sub_state = ?, last_transition_at = ?, version = version + 1 WHERE id = ? AND version = ?",
    );

    this.setStartedAtStmt = db.prepare("UPDATE tasks SET started_at = ? WHERE id = ? AND started_at IS NULL");

    this.setCompletedAtStmt = db.prepare("UPDATE tasks SET completed_at = ? WHERE id = ?");

    this.insertTransitionStmt = db.prepare(`
      INSERT INTO state_transitions (id, task_id, from_state, to_state, from_sub, to_sub, reason, timestamp, triggered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  /**
   * Request a state transition with optimistic locking.
   *
   * Validates the transition against the state machine. If valid, atomically
   * updates the task state and records the transition in the audit trail.
   * The version column prevents concurrent modifications from silently succeeding.
   * Emits a `task.state_changed` event on success.
   */
  requestTransition(
    taskId: string,
    toState: TaskState,
    toSub: SubState | null,
    reason: string,
    triggeredBy: string,
  ): TransitionResult {
    const row = this.getTaskStmt.get(taskId) as TaskRow | undefined;
    if (!row) {
      return { success: false, reason: "Task not found" };
    }

    const fromState = row.state as TaskState;
    const fromSub = row.sub_state as SubState | null;
    const currentVersion = row.version;

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
      const result = this.updateStateStmt.run(toState, toSub, now, taskId, currentVersion);
      if (result.changes === 0) {
        throw new VersionConflictError(taskId, currentVersion, -1);
      }

      if (toState === TaskStates.active) {
        this.setStartedAtStmt.run(now, taskId);
      }

      if (isTerminal(toState)) {
        this.setCompletedAtStmt.run(now, taskId);
      }

      this.insertTransitionStmt.run(transitionId, taskId, fromState, toState, fromSub, toSub, reason, now, triggeredBy);
    });

    try {
      executeTransition();
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return {
          success: false,
          reason: `Version conflict: task "${taskId}" was modified concurrently`,
        };
      }
      throw err;
    }

    this.eventBus.publish({
      type: EventTypes["task.state_changed"],
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
}
