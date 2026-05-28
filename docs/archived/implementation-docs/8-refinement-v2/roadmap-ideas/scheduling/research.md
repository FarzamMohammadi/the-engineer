# Scheduling & Dispatch — Technical Research

Implementation reference for the planning session. Every file path, schema field, code location, and architectural detail needed to build the plan from `ideation.md`.

**Important for the planning/implementation session:** This research was compiled at a point in time. Before building the plan, **re-verify all line numbers and code locations** against the current codebase — other sessions may have modified files since this was written. Read each file listed, confirm the code matches what's described here, and update any stale references. Do your own thorough review. Do not blindly trust line numbers.

---

## Project Context

- **Language:** TypeScript (ESM, strict mode)
- **Runtime:** Node.js 22 LTS
- **Database:** SQLite via better-sqlite3 (synchronous API)
- **Package manager:** pnpm
- **Lint:** Biome (all rules)
- **Test:** Vitest (forks mode)
- **Architecture:** Core / Adapter / Plugin three-tier model
- **State dir:** `~/.engineer/`
- **Deployment:** Local-only. Each user/team runs their own instance. No shared infra, no backward compatibility concerns, no production data to migrate. Schema changes are clean breaks.

---

## Current File Map

### Files to MODIFY

| File | Current Purpose | What Changes |
|------|----------------|-------------|
| `src/core/daemon/task-scheduler.ts` | Scheduling, dispatch, completion routing, priority aging | Delete `computeAgedPriority()` (L24-43), `applyPriorityAging()` (L505-521), `basePriorities` Map (L103), `trackBasePriority()` (L533-535), `initializeBasePriorities()` (L537-541), `removeBasePriority()` (L543-545). Add slot check before dispatch in relevant callers. Add info-level dispatch logging (L211). |
| `src/core/daemon/index.ts` | Daemon tick loop, subsystem coordination | Fix slot overrun in `handleChildrenAllDone()` (L275 — direct `scheduler.dispatchTask()` bypasses slot check). Delete aging step from tick loop (L453). Delete `drainNewBasePriorities` sync in tick (L444-447). Delete `initializeBasePriorities` from `rebuildStateFromTaskEngine()` (L416). Add `shutdownRequested` flag propagation in `stop()`. |
| `src/core/daemon/trigger-poller.ts` | Trigger polling, task creation, dedup | Delete `basePriorities` Map (L45), `drainNewBasePriorities()` (L195-197), `removeBasePriority()` (L199-201). |
| `src/core/daemon/preemption-manager.ts` | Priority-based preemption | Add `preemption.completed` event emission after successful preemption (after L127 or L180). |
| `src/core/daemon/health-monitor.ts` | Stuck detection, blocked escalation | No changes to health monitoring logic. Referenced for context only. |
| `src/schemas/task.ts` | Task states, transitions, permissions | Add `active.integrating → queued` to ValidTransitions (after L272). Rename `"intake"` → `"requirements_gathering"` in TaskStateSchema (L7), ValidTransitions (L255-256), PermissionTable (L302). Add `not_before` and `consecutive_crash_count` to TaskSchema. |
| `src/schemas/config.ts` | Daemon configuration | Delete aging config fields: `aging_threshold_ms` (L102-107), `aging_increment` (L108-115), `aging_interval_ms` (L116-121), `aging_cap` (L122-130). |
| `src/core/task-engine/index.ts` | Task engine implementation | Add `not_before` and `consecutive_crash_count` handling in `createTask()` (L184-285). Add `consecutive_crash_count` reset on successful phase completion. State initialized as `"intake"` at L199 — rename to `"requirements_gathering"`. |
| `src/db/migrations/001_initial.sql` | DB schema | Tasks table CHECK constraint at L13 includes `'intake'` — must update for rename. `state_transitions` CHECK at L71-72 also includes `'intake'`. Add `not_before TEXT`, `consecutive_crash_count INTEGER NOT NULL DEFAULT 0` columns. |
| `src/core/daemon/types.ts` | Daemon context types | Remove aging-related fields from `TaskSchedulerContext` if they reference aging config. |
| `src/core/orchestrator/index.ts` | Orchestrator main loop | Add `shutdownRequested` flag check between phases (follow preemption pattern at L131-141). |

### Files to CREATE

| File | Purpose |
|------|---------|
| `src/db/migrations/NNN_add_scheduling_fields.sql` | Add `not_before TEXT`, `consecutive_crash_count INTEGER NOT NULL DEFAULT 0` columns to tasks table. |
| `src/db/migrations/NNN+1_rename_intake_state.sql` | Rename `intake` → `requirements_gathering` in tasks + state_transitions CHECK constraints. Requires table recreation for SQLite CHECK constraint changes. |

### Files to DELETE

| File | Reason |
|------|--------|
| None | No files deleted — code is removed from existing files |

### Files REFERENCED but not modified

| File | Why Referenced |
|------|---------------|
| `src/core/daemon/health-monitor.ts` | `checkStuckTasks()` (L74-104), `checkBlockedEscalation()` (L135-184) — verify no aging dependencies |
| `src/core/orchestrator/phase-runner.ts` | Preemption check pattern (L793-803, L685-698) — model for shutdown flag check |
| `src/core/daemon/notification-router.ts` | Notification on crash max retries → failed |
| `src/core/interfaces/task-engine.interface.ts` | Interface updates for new task fields |
| `src/dashboard/static/index.html` | Contains 4 "intake" references — rename needed |

---

## Schema References

### Tasks Table — New Columns

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `not_before` | `TEXT` (ISO 8601, nullable) | `NULL` | Backoff timestamp. Task ineligible for scheduling until `now >= not_before`. Set on crash recovery, cleared on manual re-queue. |
| `consecutive_crash_count` | `INTEGER NOT NULL` | `0` | Consecutive orchestrator crashes. Incremented on crash recovery, reset to 0 on successful phase completion. Used to compute backoff delay and enforce max retries. |

### Tasks Table — Deleted Columns (via aging removal)

No columns to delete — aging used in-memory Maps, not DB columns. The `priority` column remains (set at creation, mutable by user).

### ValidTransitions — New Entry

```typescript
{ from: "active", from_sub: "integrating", to: "queued" },
```

This enables the slot overrun fix: when a parent finishes supervision but all slots are full, it transitions to `queued` instead of force-dispatching.

### Config Schema — Deleted Fields

| Field | Current Default | Reason for Deletion |
|-------|-----------------|---------------------|
| `aging_threshold_ms` | 86,400,000 | Aging deleted entirely |
| `aging_interval_ms` | 86,400,000 | Aging deleted entirely |
| `aging_increment` | 5 | Aging deleted entirely |
| `aging_cap` | 75 | Aging deleted entirely |

### Events — New Schema

| Event Type | Payload Fields | Emitted By |
|------------|---------------|------------|
| `preemption.completed` | `{ targetTaskId, replacementTaskId, method: "cooperative" \| "forced" }` | PreemptionManager |

No new event for shutdown — shutdown uses a pull-based flag, not an EventBus event.

---

## Specific Code Locations for Changes

### 1. Fix Slot Overrun in `handleChildrenAllDone`

**File:** `src/core/daemon/index.ts`

**Current code (L260-275):**
```typescript
taskEngine.requestTransition(
  parent.id,
  TaskStates.active,
  SubStates.integrating,
  "children_all_done",
  "daemon",
);
// ... update child_summaries ...
scheduler.dispatchTask(updatedParent);
```

**Fix:** Before transitioning to `active.integrating`, check available slots:
```typescript
const available = scheduler.getAvailableSlots();
if (available > 0) {
  // Current path: transition to active.integrating and dispatch
  taskEngine.requestTransition(parent.id, TaskStates.active, SubStates.integrating, ...);
  // ... update child_summaries ...
  scheduler.dispatchTask(updatedParent);
} else {
  // Slot overrun: queue at existing priority, let normal scheduling handle it
  taskEngine.requestTransition(parent.id, TaskStates.queued, null, "slot_unavailable", "daemon");
  // ... update child_summaries on the queued task ...
  observer.info("Parent task queued (slot unavailable), will be scheduled normally", { ... });
}
```

**Requires:** `getAvailableSlots()` exposed on scheduler interface (already exists at L108-110 of task-scheduler.ts). New `active.integrating → queued` transition in ValidTransitions.

### 2. Delete Priority Aging from Scheduler

**File:** `src/core/daemon/task-scheduler.ts`

**Delete these functions/state:**
- `computeAgedPriority()` (L24-43) — pure function
- `basePriorities: Map<string, number>` (L103) — internal state
- `applyPriorityAging()` (L505-521) — tick-called function
- `trackBasePriority()` (L533-535)
- `initializeBasePriorities()` (L537-541)
- `removeBasePriority()` (L543-545)
- `shouldCleanupBasePriority()` (L250-260) — references basePriority cleanup

**Update `handleTaskCompletion()` (L380-412):** Remove the `shouldCleanupBasePriority` check and `removeBasePriority` call at L385-387.

**Update exported interface:** Remove `trackBasePriority`, `initializeBasePriorities`, `removeBasePriority`, `applyPriorityAging` from the returned object.

### 3. Delete Base Priority Tracking from Trigger Poller

**File:** `src/core/daemon/trigger-poller.ts`

**Delete:**
- `basePriorities` Map (L45)
- `basePriorities.set(task.id, priority)` in task creation (L149)
- `drainNewBasePriorities()` function (L195-197)
- `removeBasePriority()` function (L199-201)

### 4. Delete Aging from Daemon Tick Loop

**File:** `src/core/daemon/index.ts`

**Delete from tick() (L427-470):**
- `drainNewBasePriorities` sync (L444-447):
  ```typescript
  const newBasePriorities = triggerPoller.drainNewBasePriorities();
  for (const [taskId, priority] of newBasePriorities) {
    scheduler.trackBasePriority(taskId, priority);
  }
  ```
- `scheduler.applyPriorityAging(now, queuedTasks)` call (L453)

**Delete from `rebuildStateFromTaskEngine()` (L377-423):**
- `scheduler.initializeBasePriorities(queuedTasks)` (L416)
- The `drainNewBasePriorities` block (L419-422)

**Delete from `handleTaskCompletion()` (L192-209):**
- `triggerPoller.removeBasePriority(taskId)` call

### 5. Delete Aging Config Fields

**File:** `src/schemas/config.ts`

**Delete lines 101-130:**
```typescript
// Priority aging (starvation prevention)
aging_threshold_ms: z.number()...
aging_increment: z.number()...
aging_interval_ms: z.number()...
aging_cap: z.number()...
```

### 6. Add Retry Backoff Fields to Task Schema

**File:** `src/schemas/task.ts`

**Add to TaskSchema (around L220):**
```typescript
not_before: z.string().nullable().default(null),
consecutive_crash_count: z.number().int().default(0),
```

**File:** `src/core/task-engine/index.ts`

**Update `createTask()` (L184-285):**
- Set `not_before: null` and `consecutive_crash_count: 0` at creation

**File:** `src/core/daemon/task-scheduler.ts`

**Update `handleTaskError()` (L414-455):**
```typescript
// Increment crash count
const task = taskEngine.getTask(taskId);
const newCount = (task?.consecutive_crash_count ?? 0) + 1;
const MAX_RETRIES = 5;

if (newCount >= MAX_RETRIES) {
  // Transition to failed — max retries exhausted
  taskEngine.requestTransition(taskId, TaskStates.failed, null, `max_retries_exhausted_${newCount}`, "daemon");
  // Notify owner
  return;
}

// Compute backoff: [60s, 300s, 900s, 1800s, 1800s]
const BACKOFF_SCHEDULE = [60_000, 300_000, 900_000, 1_800_000, 1_800_000];
const delayMs = BACKOFF_SCHEDULE[Math.min(newCount - 1, BACKOFF_SCHEDULE.length - 1)];
const notBefore = new Date(Date.now() + delayMs).toISOString();

taskEngine.updateTaskField(taskId, "consecutive_crash_count", newCount);
taskEngine.updateTaskField(taskId, "not_before", notBefore);
taskEngine.requestTransition(taskId, TaskStates.queued, null, "crash_recovery", "daemon");
```

**Update `isTaskEligible()` (L112-150):**
```typescript
// Add at the start of eligibility checks:
if (task.not_before && new Date(task.not_before).getTime() > Date.now()) {
  return false; // Still in backoff period
}
```

### 7. Add Cooperative Shutdown Flag

**File:** `src/core/orchestrator/index.ts`

**Add shutdown flag (follow preemption pattern at L131-141):**

The orchestrator already checks for preemption between phases. Add a `shutdownRequested` check using the same pattern:
```typescript
// Between phases, after preemption check:
if (shutdownRequested) {
  // Checkpoint current progress
  sessionMemory.createCheckpoint(task.id, { phase: currentPhase, ... });
  return { outcome: "preempted", last_phase: currentPhase };
}
```

**File:** `src/core/daemon/index.ts`

**Update `stop()` (L523-560):**
```typescript
// Before drain, signal the orchestrator:
orchestrator.requestShutdown(); // Sets the shutdownRequested flag
// Then proceed with existing drain logic
```

### 8. Add `preemption.completed` Event

**File:** `src/core/daemon/preemption-manager.ts`

**After `clearPending()` is called (when preemption succeeds), emit:**
```typescript
eventBus.publish({
  type: "preemption.completed",
  task_id: pending.targetTaskId,
  payload: {
    targetTaskId: pending.targetTaskId,
    replacementTaskId: pending.replacementTaskId,
    method: "cooperative",
  },
});
```

**After force-transition timeout (L147-153), emit with `method: "forced"`.**

**File:** `src/schemas/events.ts`

Add `PreemptionCompletedPayloadSchema`:
```typescript
export const PreemptionCompletedPayloadSchema = z.object({
  targetTaskId: z.string(),
  replacementTaskId: z.string(),
  method: z.enum(["cooperative", "forced"]),
});
```

### 9. Add Slot Utilization to Daemon State

**File:** `src/core/daemon/index.ts`

**Update `getState()` (L564-576):**
```typescript
function getState(): DaemonState {
  return {
    ...existing fields,
    activeSlots: scheduler.getActiveTaskIds().length,
    maxSlots: config.max_concurrent,
    supervisingCount: taskEngine.getTasksByState(TaskStates.active)
      .filter(t => t.sub_state === SubStates.supervising).length,
    reviewPendingCount: taskEngine.getTasksByState(TaskStates.review_pending).length,
  };
}
```

### 10. State Rename: `intake` → `requirements_gathering`

**Scope:** 99 occurrences across 25 files.

**Phase 1: Source code rename (mechanical, use find-and-replace):**

Files with occurrences (by count):
- `src/core/task-engine/index.test.ts` — 24 occurrences
- `src/db/database.test.ts` — 12 occurrences
- `src/core/task-engine/state-machine.test.ts` — 9 occurrences
- `src/schemas/task.test.ts` — 6 occurrences
- `src/core/task-engine/queries.test.ts` — 5 occurrences
- `src/schemas/task.ts` — 4 occurrences (enum, transitions, permissions)
- `src/dashboard/static/index.html` — 4 occurrences
- `src/core/orchestrator/decomposition-handler.integration.test.ts` — 4 occurrences
- `src/core/orchestrator/index.test.ts` — 4 occurrences
- `src/core/task-engine/permissions.test.ts` — 3 occurrences
- `src/cli/commands/why.test.ts` — 3 occurrences
- `src/core/observer/observation-store.test.ts` — 3 occurrences
- `src/db/migrations/001_initial.sql` — 3 occurrences (CHECK constraints)
- `src/core/session-memory/journal.test.ts` — 2 occurrences
- `src/core/task-engine/index.ts` — 3 occurrences
- `src/core/daemon/trigger-poller.ts` — 1 occurrence
- `src/core/daemon/task-scheduler.ts` — 1 occurrence
- `src/core/daemon/query-handler.ts` — 1 occurrence
- `src/core/orchestrator/index.ts` — 1 occurrence
- `src/core/data-lifecycle/index.ts` — 1 occurrence
- `src/core/event-bus/index.test.ts` — 1 occurrence
- `src/core/session-memory/sessions.test.ts` — 1 occurrence
- `src/core/session-memory/checkpoints.test.ts` — 1 occurrence
- `src/schemas/orchestrator.test.ts` — 1 occurrence
- `src/schemas/events.test.ts` — 1 occurrence

**Phase 2: DB migration (separate file):**

SQLite CHECK constraints cannot be altered. The migration must:
1. Create `tasks_new` with updated CHECK constraint (replacing `'intake'` with `'requirements_gathering'`)
2. `INSERT INTO tasks_new SELECT * FROM tasks` — no data transformation needed (fresh project, table is empty at migration time)
3. `DROP TABLE tasks`
4. `ALTER TABLE tasks_new RENAME TO tasks`
5. Recreate all indexes

Same pattern for `state_transitions` table (CHECK constraints on `from_state` and `to_state`).

---

## Implementation Ordering

**Governing principle:** Core changes speak through adapter contracts. No step introduces knowledge of specific plugins into Core. Plugin Opacity test passes at every step.

**Migration 1 — New columns (additive, low risk)**
1. Add `not_before TEXT` column to tasks table (nullable, default NULL)
2. Add `consecutive_crash_count INTEGER NOT NULL DEFAULT 0` column to tasks table
3. Add `active.integrating → queued` to ValidTransitions (task.ts L272)
4. Update TaskSchema with new fields
5. Update `createTask()` to initialize new fields
6. Update all test fixtures that construct Task objects

**Migration 2 — State rename (destructive, separate from Migration 1)**
7. Rename `"intake"` → `"requirements_gathering"` across all 25 source files
8. Create migration SQL for tasks + state_transitions table recreation (CHECK constraint changes)
9. Run full test suite to verify no missed references

**Phase 1 — Delete Priority Aging (net code deletion)**
10. Delete `computeAgedPriority()`, `applyPriorityAging()`, `basePriorities` Map from scheduler
11. Delete `trackBasePriority`, `initializeBasePriorities`, `removeBasePriority` from scheduler interface
12. Delete `basePriorities` Map, `drainNewBasePriorities()`, `removeBasePriority()` from trigger poller
13. Delete aging config fields from config schema (`aging_threshold_ms`, `aging_interval_ms`, `aging_increment`, `aging_cap`)
14. Delete aging step from tick loop, drain sync in tick, init in `rebuildStateFromTaskEngine()`
15. Delete `triggerPoller.removeBasePriority()` from `handleTaskCompletion()`
16. Remove aging-related tests

**Phase 2 — Retry Backoff**
17. Add `not_before` check to `isTaskEligible()` (scheduler)
18. Add crash count increment + backoff computation to `handleTaskError()` (scheduler)
19. Add max retry (5) check — transition to `failed` instead of `queued` when exhausted
20. Add crash count reset on successful phase completion
21. Add crash count reset on manual re-queue

**Phase 3 — Slot Overrun Fix**
22. Add slot check before dispatch in `handleChildrenAllDone()` — use `getAvailableSlots()`, queue if full
23. Verify rework path (review_pending feedback) also respects slots (check `reviewHandler` dispatch path)
24. Add test: two children completing simultaneously with one slot available

**Phase 4 — Cooperative Shutdown**
25. Add `shutdownRequested` flag/method to orchestrator interface
26. Add shutdown check between phases in orchestrator (follow preemption pattern)
27. Wire `stop()` in daemon to call `orchestrator.requestShutdown()` before drain

**Phase 5 — Observability**
28. Promote dispatch logging from debug to info level (task-scheduler.ts)
29. Add `preemption.completed` event schema + emission
30. Add slot utilization fields to `getState()`

---

## Testing Strategy

### Pure Function Tests (Deletion)

| Function | Action | Notes |
|----------|--------|-------|
| `computeAgedPriority()` | DELETE tests | Function deleted |
| `isSlotConsuming()` | KEEP | Still used for crash recovery |
| `shouldPreempt()` | KEEP | Unchanged |

### New Unit Tests

| Scenario | What to Verify |
|----------|----------------|
| `isTaskEligible` with `not_before` in future | Returns false |
| `isTaskEligible` with `not_before` in past | Returns true |
| `isTaskEligible` with `not_before` null | Returns true (default) |
| `handleTaskError` first crash | Sets `consecutive_crash_count = 1`, `not_before = now + 60s` |
| `handleTaskError` third crash | Sets `consecutive_crash_count = 3`, `not_before = now + 900s` |
| `handleTaskError` fifth crash | Transitions to `failed`, not `queued` |
| Crash count reset on success | After successful completion, `consecutive_crash_count = 0` |
| Crash count reset on manual re-queue | After manual re-queue from `failed`, count resets |
| Slot overrun: parent dispatch with no slots | Parent transitions to `queued`, not `active.integrating` |
| Slot overrun: parent dispatch with slots available | Parent transitions normally to `active.integrating` |
| Shutdown flag: orchestrator checks between phases | Orchestrator checkpoints and exits cleanly |
| `preemption.completed` event | Emitted with correct payload after cooperative/forced preemption |
| State rename: all transitions with new state name | Every ValidTransition involving the renamed state works |

### Integration Tests

| Scenario | What to Verify |
|----------|----------------|
| Crash → backoff → retry → success | Task crashes, waits backoff, retries, completes. Count resets. |
| Crash → max retries → failed | Task crashes 5 times, transitions to failed, owner notified |
| Slot overrun → normal scheduling | Parent queued when slots full, scheduled on next tick when slot frees |
| Cooperative shutdown mid-task | Shutdown signal → orchestrator checkpoints → clean exit → restart resumes |

### Failure Tests

| Scenario | What to Verify |
|----------|----------------|
| `not_before` with clock skew | Task with `not_before` far in future — becomes ineligible but doesn't crash |
| Slot overrun race: two parents finishing same tick | Both check slots, only one gets the slot, other queues correctly |
| Crash count on corrupted task | Task with null/invalid `consecutive_crash_count` — defaults to 0 safely |
| Shutdown during subprocess await | Orchestrator can't act immediately — drain timeout handles it |

### Existing Test Impact

| Test File | Impact |
|-----------|--------|
| `src/core/daemon/task-scheduler.test.ts` | Major: delete aging tests, add backoff tests, add slot overrun tests |
| `src/core/daemon/trigger-poller.test.ts` | Minor: remove basePriorities tests |
| `src/core/daemon/preemption-manager.test.ts` | Minor: add `preemption.completed` event tests |
| `src/core/daemon/index.test.ts` | Moderate: update tick loop tests (no aging step), add shutdown flag tests |
| `src/schemas/config.test.ts` | Minor: remove aging config validation tests |
| All 25 files with "intake" references | Mechanical: replace string literal |

---

## Key Dependencies

| Package | Version | Used For |
|---------|---------|----------|
| `better-sqlite3` | existing | Task queries, migrations |
| `pino` | existing | Info-level dispatch logging |

No new dependencies required.

---

## Event Flow After Changes

Core components in **bold**. Adapter contracts in *italics*.

```
External Event (any platform)
        │
        ▼
*TriggerAdapter.poll()* → TriggerEvent[]
        │
        ▼
**TriggerPoller.processNewTriggerEvent()**
  ├─ Dedup (in-memory + DB)
  ├─ Ticket variable extraction (@priority from body)
  ├─ **taskEngine.createTask**({priority, not_before: null, consecutive_crash_count: 0})
  └─ Transition requirements_gathering → queued
        │
        ▼
**Daemon Tick Loop** (every 5s)
  ├─ Cost limit processing
  ├─ Trigger polling
  ├─ Response polling
  ├─ **Preemption evaluation** (single getQueuedByPriority query)
  ├─ **Schedule next** (shared query)
  │     ├─ getAvailableSlots()
  │     ├─ Filter: isTaskEligible(task) — includes not_before check
  │     ├─ Dispatch top N eligible
  │     └─ Transition queued → active.working
  ├─ Stuck task detection
  ├─ Blocked escalation
  ├─ Review handling
  └─ Dedup key cleanup
        │
        ▼
**Orchestrator.executeTask(dispatch)**
  ├─ Check shutdownRequested flag between phases
  ├─ Check preemption flag between phases
  └─ Execute phases: requirements_gathering → research → planning → execution → self_review → demo_prep → integration
        │
        ▼
Task completes → **handleTaskCompletion()**
  ├─ completed → cleanup, notify
  ├─ review_pending → wait for feedback
  ├─ preempted → queued (emit preemption.completed)
  ├─ blocked → already transitioned
  ├─ error → blocked (deliberate)
  ├─ decomposed → children queued
  └─ CRASH → queued with not_before backoff
              ├─ consecutive_crash_count++
              ├─ not_before = now + backoff_schedule[count]
              └─ If count >= 5 → failed (max retries)
```

**Slot Overrun Path (parent integration):**
```
All children complete
        │
        ▼
**handleChildrenAllDone()**
  ├─ Check getAvailableSlots()
  ├─ [Slots available] → active.integrating → dispatch parent
  └─ [No slots] → queued at existing priority → scheduled normally next tick
```

**Cooperative Shutdown Path:**
```
engineer stop
        │
        ▼
**Daemon.stop()**
  ├─ Set shutdownRequested on orchestrator
  ├─ Wait for active tasks (drain with timeout)
  │   ├─ Orchestrator checks flag between phases → checkpoint → exit
  │   └─ If subprocess blocks → timeout → force-transition to queued
  ├─ Shutdown plugins
  └─ Remove PID file
```
