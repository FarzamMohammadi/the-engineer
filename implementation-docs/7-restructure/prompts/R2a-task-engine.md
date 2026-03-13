# R2a — TaskEngine Decomposition

**Wave 2 (Parallel) — Depends on R0 (Interface Foundation) being complete.**

---

## Worktree Setup (DO THIS FIRST)

This phase runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-R2a -b layer7/R2a main
cd ../engineer-R2a
```

**Rules:**
- Work ONLY in this worktree (`../engineer-R2a/`)
- Commit your changes to the `layer7/R2a` branch
- Do NOT push — the merge prompt will collect this branch
- Do NOT modify files outside the scope listed in this prompt
- When done: commit, verify tests pass, stop. The merge wave handles the rest.

---

You are implementing a structural restructuring phase for The Engineer, an autonomous software engineering agent. This phase decomposes the TaskEngine (~642 LOC) into focused modules: state machine, queries, and permissions. It also adds optimistic locking and tagged errors. No new features, no behavior changes (except the version column addition). Every existing test must pass after.

---

## 1. Identity Preamble

Before writing any code, read these files to understand the project's identity and principles:

- `docs/persona.md` — who The Engineer is
- `docs/philosophy.md` — core beliefs driving every decision
- `implementation-docs/0-foundation/philosophy.md` — builder-specific principles

Key takeaways:
- Derive from Proven Systems: task state machine derives from OS process scheduling
- Modularity: each file should have one clear responsibility
- Isolation as Survival: tasks are isolated universes, the state machine is the security boundary

---

## 2. Architecture Catchup

Read these docs:

- `implementation-docs/1-system/task-states.md` — CPU-derived state machine (7 states, sub-states, 25 valid transitions)
- `implementation-docs/2-components/task-engine.md` — TaskEngine design
- `implementation-docs/3-interactions/protocols.md` — Protocol P2 (Task Lifecycle), Protocol P4 (Phase Transitions)
- `implementation-docs/3-interactions/event-catalog.md` — `task.created`, `task.state_changed` events
- `implementation-docs/4-implementation/schemas/` — task schema design
- `implementation-docs/7-restructure/assessment.md` — TaskEngine identified as mid-tier bloat (642 LOC, 3 mixed concerns: state machine + queries + permissions)

---

## 3. Decision Log Review

- `implementation-docs/7-restructure/decisions.md` — Layer 7 decisions
- `implementation-docs/decisions.md` — historical

Key decisions:
- D75-D79: Task schema design
- D128: Build order (TaskEngine in Phase 7)
- D143: The Engineer IS the agent
- Assessment note: optimistic locking recommended for concurrent access safety

---

## 4. Current Code Deep-Read

Read ALL of these files before making any changes:

### The file being decomposed
- `src/core/task-engine/index.ts` — the entire TaskEngine class (642 LOC)
- `src/core/task-engine/index.test.ts` — all existing tests

### Interface (created by R0)
- `src/core/interfaces/task-engine.interface.ts` — ITaskEngine contract
- `src/core/interfaces/index.ts` — barrel

### Schema (source of truth for state machine)
- `src/schemas/task.ts` — TaskStateSchema, SubStateSchema, ValidTransitions, PermissionTable, ActionClassSchema, and all task-related types. Note the `TaskStates`, `SubStates`, `ActionClasses` enum constants added by R0.
- `src/schemas/events.ts` — EventTypes, task event payloads

### Database
- `src/db/database.ts` — createDatabase, migration system
- `src/db/` — look at how migrations are structured (SQL files or inline)

### Consumers
- `src/core/action-pipeline/index.ts` — imports TaskEngine, calls checkPermission
- `src/core/orchestrator/index.ts` — imports TaskEngine, calls createTask, requestTransition, updateTaskField, updateTracking, getTask
- `src/core/daemon/index.ts` — imports TaskEngine, calls getTask, getTasksByState, getQueuedByPriority, getChildren, requestTransition, updateTaskField
- `src/core/daemon/query-handler.ts` — imports TaskEngine
- `src/cli/bootstrap.ts` — creates TaskEngine

### Test infrastructure
- `test/helpers/test-task-engine.ts` — createTestTaskEngine()
- `test/helpers/mock-factories.ts` — mock factories
- `test/helpers/integration-context.ts`

---

## 5. Exact Specifications

### 5A. New File Structure

Transform `src/core/task-engine/` from a single file to a module directory:

```
src/core/task-engine/
  index.ts              — TaskEngine class (facade, implements ITaskEngine, delegates)
  state-machine.ts      — State machine validation + transition execution
  queries.ts            — All read queries (getTask, getTasksByState, etc.)
  permissions.ts        — Permission checking (Gate 1)
  row-mapper.ts         — rowToTask, rowToStateTransition (pure functions)
  errors.ts             — Tagged error classes
  index.test.ts         — existing tests (update if needed)
  state-machine.test.ts — new tests for state machine in isolation
  queries.test.ts       — new tests for queries
  permissions.test.ts   — new tests for permissions
```

### 5B. `src/core/task-engine/errors.ts`

```typescript
/** Base class for all task-engine errors. */
export abstract class TaskEngineError extends Error {
  abstract readonly tag: string;
}

/** Task was not found by ID. */
export class TaskNotFoundError extends TaskEngineError {
  readonly tag = "TaskNotFound" as const;
  constructor(readonly taskId: string) {
    super(`Task "${taskId}" not found`);
    this.name = "TaskNotFoundError";
  }
}

/** State transition is not valid per the state machine. */
export class InvalidTransitionError extends TaskEngineError {
  readonly tag = "InvalidTransition" as const;
  constructor(
    readonly taskId: string,
    readonly fromLabel: string,
    readonly toLabel: string,
  ) {
    super(`Invalid transition from ${fromLabel} to ${toLabel} for task "${taskId}"`);
    this.name = "InvalidTransitionError";
  }
}

/** Optimistic locking conflict — task was modified by another writer. */
export class VersionConflictError extends TaskEngineError {
  readonly tag = "VersionConflict" as const;
  constructor(
    readonly taskId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`Version conflict on task "${taskId}": expected ${expectedVersion}, got ${actualVersion}`);
    this.name = "VersionConflictError";
  }
}

/** Unknown field passed to updateTaskField. */
export class UnknownFieldError extends TaskEngineError {
  readonly tag = "UnknownField" as const;
  constructor(readonly field: string) {
    super(`Unknown updatable field "${field}"`);
    this.name = "UnknownFieldError";
  }
}
```

### 5C. `src/core/task-engine/row-mapper.ts`

Move the pure functions out of the main file:

```typescript
import type {
  BlockedDetails, CascadePolicy, ChildEntry, ExternalRef, RelatedItem,
  ReviewState, SubState, Task, TaskDecision, TaskState, TaskWorkspace,
  TeamMember, ChildCompletionSummary, StateTransition,
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
  version: number; // NEW: optimistic locking
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
  // Same implementation as current, but using the TaskRow with version field
  // (version is NOT part of the Task schema — it's internal to the engine)
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
export function rowToStateTransition(row: StateTransitionRow): StateTransition {
  // Same implementation as current
}
```

### 5D. `src/core/task-engine/state-machine.ts`

Extract state machine validation and transition execution:

```typescript
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { SubState, TaskState } from "../../schemas/task.js";
import { ValidTransitions, TaskStates } from "../../schemas/task.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type { TransitionResult } from "../interfaces/task-engine.interface.js";
import type { TaskRow } from "./row-mapper.js";
import { VersionConflictError, InvalidTransitionError, TaskNotFoundError } from "./errors.js";

/**
 * Tests whether a sub-state in a ValidTransitions entry matches an actual sub-state.
 * Exported for direct use in tests.
 */
export function subStateMatches(entrySub: SubState | undefined, actualSub: SubState | null): boolean {
  if (entrySub === undefined) return actualSub === null;
  return entrySub === actualSub;
}

/**
 * Tests whether a state transition is valid according to the ValidTransitions table.
 * Exported for direct use in tests and by other components.
 */
export function isValidTransition(
  fromState: TaskState, fromSub: SubState | null,
  toState: TaskState, toSub: SubState | null,
): boolean {
  return ValidTransitions.some((entry) => {
    if (entry.from !== fromState || entry.to !== toState) return false;
    const entryFromSub = "from_sub" in entry ? entry.from_sub : undefined;
    const entryToSub = "to_sub" in entry ? entry.to_sub : undefined;
    return subStateMatches(entryFromSub, fromSub) && subStateMatches(entryToSub, toSub);
  });
}

/**
 * Executes state transitions within a database transaction.
 * Validates the transition, updates state, records audit trail, emits event.
 */
export class StateMachine {
  private readonly updateStateStmt: Database.Statement;
  private readonly setStartedAtStmt: Database.Statement;
  private readonly setCompletedAtStmt: Database.Statement;
  private readonly insertTransitionStmt: Database.Statement;
  private readonly getTaskStmt: Database.Statement;

  constructor(private readonly db: Database.Database, private readonly eventBus: IEventBus) {
    this.updateStateStmt = db.prepare(
      "UPDATE tasks SET state = ?, sub_state = ?, last_transition_at = ?, version = version + 1 WHERE id = ? AND version = ?"
    );
    this.setStartedAtStmt = db.prepare(
      "UPDATE tasks SET started_at = ? WHERE id = ? AND started_at IS NULL"
    );
    this.setCompletedAtStmt = db.prepare(
      "UPDATE tasks SET completed_at = ? WHERE id = ?"
    );
    this.insertTransitionStmt = db.prepare(`
      INSERT INTO state_transitions (id, task_id, from_state, to_state, from_sub, to_sub, reason, timestamp, triggered_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getTaskStmt = db.prepare("SELECT * FROM tasks WHERE id = ?");
  }

  /**
   * Request a state transition with optimistic locking.
   * The version column prevents concurrent modifications from silently succeeding.
   */
  requestTransition(
    taskId: string, toState: TaskState, toSub: SubState | null,
    reason: string, triggeredBy: string,
  ): TransitionResult {
    const row = this.getTaskStmt.get(taskId) as TaskRow | undefined;
    if (!row) return { success: false, reason: "Task not found" };

    const fromState = row.state as TaskState;
    const fromSub = row.sub_state as SubState | null;
    const currentVersion = row.version;

    if (!isValidTransition(fromState, fromSub, toState, toSub)) {
      const fromLabel = fromSub ? `${fromState}.${fromSub}` : fromState;
      const toLabel = toSub ? `${toState}.${toSub}` : toState;
      return { success: false, reason: `Invalid transition from ${fromLabel} to ${toLabel}` };
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
      if (toState === TaskStates.completed || toState === TaskStates.failed) {
        this.setCompletedAtStmt.run(now, taskId);
      }

      this.insertTransitionStmt.run(
        transitionId, taskId, fromState, toState, fromSub, toSub, reason, now, triggeredBy,
      );
    });

    try {
      executeTransition();
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return { success: false, reason: `Version conflict: task "${taskId}" was modified concurrently` };
      }
      throw err;
    }

    this.eventBus.publish({
      type: "task.state_changed",
      source: "task_engine",
      task_id: taskId,
      payload: {
        task_id: taskId, from_state: fromState, from_sub: fromSub,
        to_state: toState, to_sub: toSub, reason, triggered_by: triggeredBy,
      },
    } satisfies PublishInput<"task.state_changed">);

    return { success: true };
  }
}
```

### 5E. `src/core/task-engine/queries.ts`

Extract all read queries:

```typescript
import type Database from "better-sqlite3";
import type { StateTransition, SubState, Task, TaskState } from "../../schemas/task.js";
import { type TaskRow, type StateTransitionRow, rowToTask, rowToStateTransition } from "./row-mapper.js";

/**
 * Read-only query methods for tasks.
 * All queries return typed domain objects via row mappers.
 */
export class TaskQueries {
  private readonly getTaskStmt: Database.Statement;
  private readonly getTasksByStateStmt: Database.Statement;
  private readonly getQueuedStmt: Database.Statement;
  private readonly getChildrenStmt: Database.Statement;
  private readonly getStateHistoryStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.getTaskStmt = db.prepare("SELECT * FROM tasks WHERE id = ?");
    this.getTasksByStateStmt = db.prepare(
      "SELECT * FROM tasks WHERE state = ? ORDER BY priority DESC, created_at ASC"
    );
    this.getQueuedStmt = db.prepare(
      "SELECT * FROM tasks WHERE state = 'queued' ORDER BY priority DESC, created_at ASC"
    );
    this.getChildrenStmt = db.prepare(
      "SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC"
    );
    this.getStateHistoryStmt = db.prepare(
      "SELECT * FROM state_transitions WHERE task_id = ? ORDER BY timestamp ASC"
    );
  }

  getTask(id: string): Task | null {
    const row = this.getTaskStmt.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  getTasksByState(state: TaskState): Task[] {
    const rows = this.getTasksByStateStmt.all(state) as TaskRow[];
    return rows.map(rowToTask);
  }

  getQueuedByPriority(): Task[] {
    const rows = this.getQueuedStmt.all() as TaskRow[];
    return rows.map(rowToTask);
  }

  getChildren(parentId: string): Task[] {
    const rows = this.getChildrenStmt.all(parentId) as TaskRow[];
    return rows.map(rowToTask);
  }

  getStateHistory(taskId: string): StateTransition[] {
    const rows = this.getStateHistoryStmt.all(taskId) as StateTransitionRow[];
    return rows.map(rowToStateTransition);
  }

  /** Get raw task row (includes version). Used internally by StateMachine. */
  getTaskRow(id: string): TaskRow | undefined {
    return this.getTaskStmt.get(id) as TaskRow | undefined;
  }
}
```

### 5F. `src/core/task-engine/permissions.ts`

Extract permission checking:

```typescript
import type { ActionClass, TaskState, SubState } from "../../schemas/task.js";
import { PermissionTable } from "../../schemas/task.js";
import type { PermissionResult } from "../interfaces/task-engine.interface.js";

/**
 * Gate 1 of the Action Pipeline: checks whether an action class is
 * permitted in the task's current state/sub_state.
 *
 * Pure function — no database, no side effects.
 */
export function checkPermission(
  state: TaskState,
  subState: SubState | null,
  actionClass: ActionClass,
): PermissionResult {
  const entry = PermissionTable.find(
    (e) => e.state === state && e.sub_state === subState,
  );

  if (!entry) {
    return {
      allowed: false,
      reason: `No permission entry for state ${state}.${subState ?? "null"}`,
    };
  }

  if ((entry.allowed as readonly string[]).includes(actionClass)) {
    return { allowed: true };
  }

  if (entry.conditional) {
    const condition = (entry.conditional as Partial<Record<string, string>>)[actionClass];
    if (condition) {
      return { allowed: true, conditional: condition };
    }
  }

  const stateLabel = subState ? `${state}.${subState}` : state;
  return {
    allowed: false,
    reason: `Action "${actionClass}" not permitted in state ${stateLabel}`,
  };
}
```

### 5G. `src/core/task-engine/index.ts` — Facade

The TaskEngine class becomes a facade:

```typescript
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { ActionClass, SubState, Task, TaskState, StateTransition } from "../../schemas/task.js";
import { TaskStates } from "../../schemas/task.js";
import type { IEventBus, PublishInput } from "../interfaces/event-bus.interface.js";
import type {
  ITaskEngine, CreateTaskInput, TransitionResult, PermissionResult, UpdatableField,
} from "../interfaces/task-engine.interface.js";
import { StateMachine, isValidTransition, subStateMatches } from "./state-machine.js";
import { TaskQueries } from "./queries.js";
import { checkPermission } from "./permissions.js";
import { rowToTask } from "./row-mapper.js";

// Re-export for backward compatibility
export type { CreateTaskInput, TransitionResult, PermissionResult, UpdatableField } from "../interfaces/task-engine.interface.js";
export { isValidTransition, subStateMatches } from "./state-machine.js";
export { rowToTask } from "./row-mapper.js";
export { checkPermission } from "./permissions.js";

// ... UPDATABLE_FIELDS and JSON_FIELDS stay here (used by updateTaskField)

export class TaskEngine implements ITaskEngine {
  private readonly db: Database.Database;
  private readonly eventBus: IEventBus;
  private readonly stateMachine: StateMachine;
  private readonly queries: TaskQueries;

  // Field update statements (kept here — updateTaskField is TaskEngine's own concern)
  private readonly insertTaskStmt: Database.Statement;
  private readonly updateTrackingStmt: Database.Statement;
  private readonly updateFieldStmts: Map<UpdatableField, Database.Statement>;

  constructor(db: Database.Database, eventBus: IEventBus) {
    this.db = db;
    this.eventBus = eventBus;
    this.stateMachine = new StateMachine(db, eventBus);
    this.queries = new TaskQueries(db);

    // Prepared statements for create + update (not delegated)
    this.insertTaskStmt = db.prepare(`...`); // same as current, add version column
    this.updateTrackingStmt = db.prepare(`...`); // same as current
    this.updateFieldStmts = new Map();
    for (const field of UPDATABLE_FIELDS) {
      this.updateFieldStmts.set(field, db.prepare(`UPDATE tasks SET ${field} = ? WHERE id = ?`));
    }
  }

  createTask(input: CreateTaskInput): Task { /* same as current, add version = 1 to INSERT */ }

  requestTransition(taskId: string, toState: TaskState, toSub: SubState | null, reason: string, triggeredBy: string): TransitionResult {
    return this.stateMachine.requestTransition(taskId, toState, toSub, reason, triggeredBy);
  }

  checkPermission(taskId: string, actionClass: ActionClass): PermissionResult {
    const task = this.queries.getTask(taskId);
    if (!task) return { allowed: false, reason: "Task not found" };
    return checkPermission(task.state, task.sub_state, actionClass);
  }

  getTask(id: string): Task | null { return this.queries.getTask(id); }
  getTasksByState(state: TaskState): Task[] { return this.queries.getTasksByState(state); }
  getQueuedByPriority(): Task[] { return this.queries.getQueuedByPriority(); }
  getChildren(parentId: string): Task[] { return this.queries.getChildren(parentId); }
  getStateHistory(taskId: string): StateTransition[] { return this.queries.getStateHistory(taskId); }

  updateTaskField(taskId: string, field: UpdatableField, value: unknown): void { /* same as current */ }
  updateTracking(taskId: string, tokens: number, costUsd: number, computeMs: number): void { /* same as current */ }
}
```

### 5H. Database Migration: Add `version` Column

Add a new migration to add the `version` column to the `tasks` table. Look at how existing migrations are structured in `src/db/` and follow the same pattern.

The migration SQL:

```sql
ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
```

**Important:** This must be backward-compatible. Existing rows get `DEFAULT 1`. The `INSERT` in `createTask` must include `version` with value `1`. The `UPDATE` in `requestTransition` must include `WHERE version = ?` and `SET version = version + 1`.

### 5I. Update Consumers

**`src/core/action-pipeline/index.ts`:**
- Change `import type { TaskEngine } from "../task-engine/index.js"` to use `ITaskEngine` from interfaces

**`src/core/orchestrator/index.ts`:**
- Change TaskEngine import to `ITaskEngine`

**`src/core/daemon/index.ts`:**
- Change TaskEngine import to `ITaskEngine`

**`src/cli/bootstrap.ts`:**
- No changes needed (still `new TaskEngine(...)`)

### 5J. Update Test Helper

**`test/helpers/test-task-engine.ts`:**
- No structural changes needed, but verify it still works with the new migration (version column)

---

## 6. Refinement Checklist

- [ ] `state-machine.ts` handles optimistic locking via `version` column
- [ ] `queries.ts` has ONLY read operations — no mutations
- [ ] `permissions.ts` is a pure function — no class, no DB, no side effects
- [ ] `row-mapper.ts` has ONLY pure mapping functions
- [ ] `errors.ts` has tagged errors with `readonly tag` discriminant
- [ ] `isValidTransition` and `subStateMatches` are re-exported from index.ts for backward compat
- [ ] `rowToTask` is re-exported from index.ts for backward compat
- [ ] `checkPermission` as a standalone function is re-exported
- [ ] Migration adds `version` column with DEFAULT 1
- [ ] `createTask` inserts `version = 1`
- [ ] `requestTransition` uses `WHERE version = ?` and `SET version = version + 1`
- [ ] VersionConflictError is caught and returned as `{ success: false }` (not thrown to caller)
- [ ] Enum constants (TaskStates, etc.) used throughout instead of raw strings

---

## 7. Verification Steps

```bash
# Type checking
npx tsc --noEmit

# All tests
pnpm test

# Run only task-engine tests
pnpm test src/core/task-engine/

# Lint
pnpm lint

# Verify migration applies cleanly to a fresh DB
# (the test helpers create fresh in-memory DBs, so if tests pass, migrations work)
```

---

## Commit

When all verification passes, run `/commit` to stage and commit your changes.
