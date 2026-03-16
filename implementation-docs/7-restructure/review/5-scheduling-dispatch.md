# Phase 5: Task Scheduling & Dispatch

---

## Flow

```
scheduler.scheduleNext()                    ← tick loop step 5
    │
    ├─ availableSlots = max_concurrent - activeDispatches.size
    ├─ candidates = taskEngine.getQueuedByPriority()
    │
    ▼
For each candidate (up to availableSlots):
    │
    ├─ isTaskEligible(task)?
    │   ├─ No parent → eligible
    │   ├─ Parent in active.supervising → eligible
    │   └─ cascade_policy=pause_siblings + sibling active → NOT eligible
    │
    ▼
dispatchTask(candidate)
    ├─ checkpoint = sessionMemory.getLatestCheckpoint(taskId)
    ├─ If unapplied feedback → clear checkpoint (restart from intake)
    ├─ Load knowledge: repo-scoped + user-scoped
    ├─ Build Dispatch { task, resume_from, knowledge }
    ├─ requestTransition(queued → active.working)
    └─ orchestrator.executeTask(dispatch)    → fire-and-forget
         ├─ .then(handleTaskCompletion)
         └─ .catch(handleTaskError)
```

---

## Production Files

| # | File | Role |
|---|------|------|
| 1 | `src/core/daemon/task-scheduler.ts` | Scheduling, dispatch, completion, priority aging |
| 2 | `src/schemas/ephemeral.ts` | Dispatch type definition |

---

## Dispatch Object

```typescript
type Dispatch = {
  task: Task,                     // Full task record from DB
  resume_from: Checkpoint | null, // For resumed/crashed tasks
  knowledge: {
    repo: KnowledgeEntry[],       // Repository-scoped patterns
    user: KnowledgeEntry[]        // User-scoped patterns
  }
}
```

---

## Eligibility Rules

| Condition | Result |
|-----------|--------|
| Task has no parent | Always eligible |
| Parent exists, in `active.supervising` | Eligible |
| Parent exists, NOT supervising | Not eligible (parent still working) |
| `cascade_policy = "pause_siblings"` + any sibling active | Not eligible (sequential execution) |

---

## Rework Detection

When a task has unapplied feedback rounds (`task.review.feedback_rounds.some(r => !r.applied)`):
- Checkpoint is **cleared** (set to null)
- Task restarts from intake phase instead of resuming
- LLM sees reviewer comments injected into the intake prompt
- This ensures the rework addresses the actual feedback

---

## Priority Aging: `applyPriorityAging()`

Runs every tick. Prevents task starvation for long-waiting queued tasks.

```
For each queued task:
  basePriority = stored base OR current priority
  elapsed = now - task.created_at
  newPriority = computeAgedPriority(base, elapsed, config)
  If newPriority > task.priority → update in DB
```

Formula: `base + (elapsed / aging_interval) * aging_increment`, capped at `aging_cap`.

---

## Completion Handling: `handleTaskCompletion()`

| Outcome | State Transition | Actions |
|---------|-----------------|---------|
| `completed` | active → completed | Cleanup workspace, send notifications, check children done |
| `review_pending` | active → review_pending.demo | Send review notification, comment on issue |
| `decomposed` | (no transition, children already queued) | Log |
| `preempted` | active → queued | Log, ready for rescheduling |
| `error` | active → blocked | Send error notification, check children done |

---

## Error Handling: `handleTaskError()`

When Orchestrator throws (crash):
1. Remove from activeDispatches
2. Emit `health.stuck_detected` (condition: orchestrator_crash)
3. Transition → queued ("crash_recovery")
4. Task re-dispatched on next tick with checkpoint resume

---

## Child Completion: `checkAndEmitChildrenAllDone()`

Called after any child reaches a terminal state (completed/failed):
1. Fetch all siblings of the child
2. If ALL siblings are terminal → emit `task.children_all_done`
3. Daemon subscriber handles: parent transitions to `active.integrating`, re-dispatched

---

## Test Files

| File | Type |
|------|------|
| `src/core/daemon/task-scheduler.test.ts` | Unit |
| `test/integration/daemon-trigger-polling.integration.test.ts` | Integration |
