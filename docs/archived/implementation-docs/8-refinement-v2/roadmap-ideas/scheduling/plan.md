# Scheduling & Dispatch — Implementation Plan

## Context

Layer 8 Runtime Phase Refinement for the Scheduling & Dispatch subsystem. Session 081 completed brainstorming + 5-panelist expert panel review. 11 decisions made. This plan translates `ideation.md` + `research.md` into executable implementation steps.

**Governing principles:**
1. **Plugin Opacity** — Core sees only adapters. All changes are Core-internal. No adapter or plugin references.
2. **Fresh project, local-only** — Clean breaks always. No dual-format unions, no migration scripts for old data.

**All line numbers verified against current codebase on 2026-03-31.**

**Implemented in Session 082.**

---

## Migration 1 — New Columns + State Machine Fix (additive, low risk)

### 1.1 Create migration SQL
- **Create:** `src/db/migrations/011_add_scheduling_fields.sql`
- `ALTER TABLE tasks ADD COLUMN not_before TEXT;` (ISO 8601, nullable — scheduling eligibility gate)
- `ALTER TABLE tasks ADD COLUMN consecutive_crash_count INTEGER NOT NULL DEFAULT 0;` (crash retry counter)

### 1.2 Add `active.integrating → queued` to ValidTransitions
- **File:** `src/schemas/task.ts` — after the last `active.integrating` transition
- Add: `{ from: "active", from_sub: "integrating", to: "queued" }`
- Enables slot overrun fix — parent can return to queue if no slots available

### 1.3 Add new fields to TaskSchema
- **File:** `src/schemas/task.ts`
- `not_before: z.string().datetime().nullable().default(null)`
- `consecutive_crash_count: z.number().int().default(0)`

### 1.4 Update `createTask()` to initialize new fields
- **File:** `src/core/task-engine/index.ts`
- Add columns to INSERT SQL, bind `null` and `0`
- Add both fields to the returned Task object literal

### 1.5 Add to UpdatableField + UPDATABLE_FIELDS
- **File:** `src/core/interfaces/task-engine.interface.ts` — UpdatableField union type
- **File:** `src/core/task-engine/index.ts` — UPDATABLE_FIELDS array
- Add `"not_before"` and `"consecutive_crash_count"` to both

### 1.6 Update row mapper
- **File:** `src/core/task-engine/row-mapper.ts`
- Add `not_before` and `consecutive_crash_count` to TaskRow interface and `rowToTask()` mapping

### 1.7 Update test fixtures
- `src/db/database.test.ts` — schema version 10→11, column list expectations
- `src/schemas/task.test.ts` — minimal task fixture, ValidTransitions count 28→29

**Commit:** `Add not_before + consecutive_crash_count columns, active.integrating→queued transition`

---

## Phase 1 — Delete Priority Aging (net code deletion)

Single-user system does not need starvation prevention. Major simplification.

### 1.1 Delete from `task-scheduler.ts`
- Delete `computeAgedPriority()` pure function
- Delete `basePriorities` Map (internal state)
- Delete `shouldCleanupBasePriority()` and its call in `handleTaskCompletion`
- Delete `applyPriorityAging()` function
- Delete `trackBasePriority()`, `initializeBasePriorities()`, `removeBasePriority()`
- Remove all 5 from `TaskScheduler` interface and return object

### 1.2 Delete from `trigger-poller.ts`
- Delete `basePriorities` Map
- Delete `basePriorities.set()` call during task creation
- Delete `drainNewBasePriorities()` and `removeBasePriority()`
- Remove from TriggerPoller interface and return object

### 1.3 Delete aging wiring from `daemon/index.ts`
- Delete `drainNewBasePriorities` sync in tick loop
- Delete `scheduler.applyPriorityAging()` call in tick
- Delete `scheduler.initializeBasePriorities()` in `rebuildStateFromTaskEngine()`
- Delete `triggerBasePriorities` drain block in startup
- Delete `triggerPoller.removeBasePriority()` in `handleTaskCompletion()`
- Delete `onTaskEscalated` callback (only used for aging cleanup)
- Delete `computeAgedPriority` re-export

### 1.4 Delete aging config fields from `config.ts`
- Delete `aging_threshold_ms`, `aging_increment`, `aging_interval_ms`, `aging_cap`

### 1.5 Remove `HealthMonitorCallbacks` interface
- **File:** `src/core/daemon/health-monitor.ts`
- Delete the `HealthMonitorCallbacks` interface and `callbacks` parameter
- Remove `callbacks?.onTaskEscalated()` call in escalation path

### 1.6 Clean up remaining references
- Remove aging config from template configs (`src/cli/templates.ts`)
- Remove aging doctor check (`src/cli/commands/doctor.ts`)
- Remove aging config from all test `makeDaemonConfig` helpers (6 test files + integration context)

### 1.7 Grep audit
- `aging|basePriori` in `src/` and `test/` → zero results

**Commit:** `Delete priority aging system (single-user, no starvation risk)`

---

## Phase 2 — Retry Backoff

Crashes retry with exponential backoff. Deliberate errors go to `blocked`.

### 2.1 Add backoff constants + pure function
- **File:** `src/core/daemon/task-scheduler.ts`
- `BACKOFF_MINUTES = [1, 5, 15, 30, 30]` — 5 entries = max 5 retries
- `MAX_CRASH_RETRIES = BACKOFF_MINUTES.length`
- `computeBackoffMs(crashCount)` — exported pure function

### 2.2 Add `clock` to `TaskSchedulerContext`
- **File:** `src/core/daemon/types.ts`
- Add `"clock"` to the Pick type for testable time in backoff computation

### 2.3 Add `not_before` check to `isTaskEligible()`
- Widen parameter type from `{ id, parent_id }` to full `Task`
- At the start, before parent_id check: if `not_before` is in the future, return false

### 2.4 Rewrite `handleTaskError()` with backoff
- Increment `consecutive_crash_count` via `taskEngine.updateTaskField`
- If `count >= MAX_CRASH_RETRIES` → transition to `failed`, notify owner, return
- Else: compute backoff, set `not_before`, transition to `queued` with `"crash_recovery_with_backoff"`
- Keep existing health event emission

### 2.5 Reset crash count on successful completion
- In `handleTaskCompletion()`: reset `consecutive_crash_count` to 0 and `not_before` to null

### 2.6 New tests
- `computeBackoffMs()` returns correct values for counts 1-5+, clamps beyond schedule
- `isTaskEligible` returns false when `not_before` in future, true when past/null
- `handleTaskError` increments crash count and sets `not_before` (mock clock)
- `handleTaskError` transitions to failed after 5 crashes, notifies
- `handleTaskCompletion` resets crash count and `not_before`

**Commit:** `Add retry backoff for crash recovery (1/5/15/30/30 min, max 5 retries)`

---

## Phase 3 — Slot Overrun Fix

### 3.1 Add slot check in `handleChildrenAllDone()`
- **File:** `src/core/daemon/index.ts`
- Populate `child_summaries` BEFORE any state transition (needed in both paths)
- Check `config.max_concurrent - scheduler.getActiveTaskIds().length`
- If no slots: transition parent to `queued` with reason `"slot_unavailable_after_children_done"`
- If slots available: existing path (transition to `active.integrating` and dispatch)
- Key: slot check happens BEFORE state transition, not after

### 3.2 Verify rework path
- `scheduleNext()` already calls `getAvailableSlots()` — no change needed

### 3.3 New test
- Parent re-queues when all slots full after children complete (fill slot with hanging dispatch, fire children_all_done event, verify parent transitions to queued not integrating)

**Commit:** `Fix slot overrun: check availability before parent dispatch`

---

## Phase 4 — Cooperative Shutdown

Pull-based `shutdownRequested` flag — same pattern as preemption.

### 4.1 Add shutdown interface to `PhaseRunnerDeps`
- **File:** `src/core/orchestrator/phase-runner.ts`
- Add `shutdown?: { isRequested(): boolean }` to `PhaseRunnerDeps`

### 4.2 Add shutdown flag to Orchestrator class
- **File:** `src/core/orchestrator/index.ts`
- Private field: `shutdownRequested = false`
- Public method: `requestShutdown()` sets the flag
- Pass to `runPhasePipeline` deps: `shutdown: { isRequested: () => this.shutdownRequested }`

### 4.3 Check shutdown between phases in phase-runner
- Before phase start (after preemption check): if `deps.shutdown?.isRequested()`, call `handlePreemption()` with `"shutdown"` as preemptingId — creates checkpoint, returns preempted outcome
- After phase completion (after preemption check): same pattern for between-phase boundary

### 4.4 Wire daemon `stop()` to orchestrator shutdown
- **File:** `src/core/daemon/index.ts`
- Before `scheduler.drainForShutdown()`, call `ctx.orchestrator.requestShutdown()`

### 4.5 Update test mock
- Add `requestShutdown: vi.fn()` to orchestrator mock in `test/helpers/test-daemon.ts`

**Commit:** `Fix slot overrun and add cooperative shutdown`

---

## Phase 5 — Observability

### 5.1 Dispatch logging — already info level
- `dispatchTask()` already uses `observer.info`. No change needed.

### 5.2 Add `preemption.completed` event schema
- **File:** `src/schemas/events.ts`
- Add `"preemption.completed"` to EventTypeSchema enum
- Add `PreemptionCompletedPayloadSchema`: `{ target_task_id, preempting_task_id, method: "cooperative" | "forced" }`
- Add to `EventPayloads` type map and `eventPayloadSchemas` registry

### 5.3 Emit `preemption.completed` in preemption-manager.ts
- In `clearPending()`: emit with `method: "cooperative"` before clearing
- After force-transition timeout: emit with `method: "forced"` before clearing

### 5.4 Add slot utilization to `getState()`
- **File:** `src/core/daemon/index.ts`
- Add `slotUtilization: { active: number; max: number }` to `DaemonState` interface
- Populate from `scheduler.getActiveTaskIds().length` and `config.max_concurrent`

### 5.5 Add event declaration
- Add `preemption.completed` entry to daemon EVENTS array

**Commit:** `Add preemption.completed event and slot utilization`

---

## Migration 2 — State Rename: intake → requirements_gathering (separate)

**Intentionally last** — touches ~25 files, ~67 occurrences. After all functional changes to minimize conflicts.

### 2.1 Create migration SQL
- **Create:** `src/db/migrations/012_rename_intake_state.sql`
- SQLite CHECK constraints require table recreation:
  1. `CREATE TABLE tasks_new (...)` with `'requirements_gathering'` in CHECK constraint
  2. `INSERT INTO tasks_new SELECT * FROM tasks`
  3. `DROP TABLE tasks`
  4. `ALTER TABLE tasks_new RENAME TO tasks`
  5. Recreate all indexes on tasks table
  6. Same process for `state_transitions` table

### 2.2 Update initial migration for fresh installs
- **File:** `src/db/migrations/001_initial.sql` — 3 CHECK constraint occurrences

### 2.3 Rename in source code
- `src/schemas/task.ts` — TaskStateSchema, ValidTransitions, PermissionTable
- `src/core/task-engine/index.ts` — `TaskStates.intake` references
- `src/core/daemon/query-handler.ts` — 1 occurrence
- `src/core/data-lifecycle/index.ts` — ACTIVE_STATES array
- `src/dashboard/static/index.html` — KANBAN_STATES, STATE_LABELS (→ "Req. Gathering"), STATE_COLORS, badge map

### 2.4 Rename in test files (~15 files)
- `src/core/task-engine/` (4 test files), `src/db/database.test.ts`, `src/schemas/` (2 files), `src/core/session-memory/` (3 files), `src/cli/`, `src/core/orchestrator/`, `src/core/event-bus/`, `test/helpers/` (4 files), `test/integration/` (2 files)

### 2.5 Grep audit
- `"intake"` / `'intake'` / `TaskStates.intake` in `src/` and `test/` → zero results (except migration SQL comment and observation-store phase filter which is not a task state)

**Commit:** `Rename state 'intake' to 'requirements_gathering'`

---

## Verification Plan

### Automated
- `pnpm test` — 2,305 tests pass (96 files)
- `pnpm exec tsc --noEmit` — zero TypeScript errors (both configs)
- `pnpm exec biome check src/ test/` — zero lint errors
- Pre-commit hooks pass (biome, knip, madge circular, tsc)

### Grep Audits
- `aging|basePriori` in `src/` and `test/` → zero results
- `"intake"` / `TaskStates.intake` in `src/` → zero results (except migration comment)
- `aging_cap|aging_increment|aging_threshold|aging_interval` → zero results

### Test Delta
- Started: 2,309 tests
- Aging tests deleted: -11
- New backoff/slot/observability tests: +8
- Aging doctor test deleted: -1
- Final: 2,305 tests
