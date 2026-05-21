# Phase 11: Error, Preemption & Recovery

---

## Flow

```
┌─────────────────────────────────────────────────────────────┐
│ ERROR PATH                                                   │
│                                                               │
│  Phase handler throws                                        │
│    → journal entry (type: error)                             │
│    → return { outcome: "error", reason }                     │
│    → Daemon: transition active → blocked                     │
│    → notifications.sendTaskError()                           │
│                                                               │
│  Blocked escalation (periodic):                              │
│    Stage 1: send_reminder (e.g., 30min)                      │
│    Stage 2: evaluate_self_unblock (e.g., 90min)              │
│    Stage 3: escalation_alert → transition blocked → failed   │
│                                                               │
│  Self-unblock success: blocked → active.working              │
├─────────────────────────────────────────────────────────────┤
│ PREEMPTION PATH                                              │
│                                                               │
│  Higher-priority task in queue                               │
│    → preemption.evaluate() detects priority delta            │
│    → emit preemption.requested                               │
│    → Orchestrator sets flag, yields at phase boundary        │
│    → checkpoint + end session                                │
│    → emit preemption.ready                                   │
│    → Daemon: transition active → queued                      │
│    → Task re-dispatched later (from checkpoint)              │
├─────────────────────────────────────────────────────────────┤
│ CRASH RECOVERY                                               │
│                                                               │
│  Daemon restarts, finds orphaned active tasks                │
│    → rebuildStateFromTaskEngine()                            │
│    → transition active → queued ("crash_recovery")           │
│    → Next tick: dispatch with checkpoint resume              │
└─────────────────────────────────────────────────────────────┘
```

---

## Production Files

| # | File | Role |
|---|------|------|
| 1 | `src/core/daemon/health-monitor.ts` | Stuck detection, blocked escalation, cost limits, review reminders |
| 2 | `src/core/daemon/preemption-manager.ts` | Priority-based cooperative preemption |
| 3 | `src/core/daemon/index.ts` | Crash recovery (`rebuildStateFromTaskEngine`) |
| 4 | `src/core/orchestrator/index.ts` | `attemptSelfUnblock()`, preemption flag handling |
| 5 | `src/core/orchestrator/phase-runner.ts` | Preemption check at phase boundaries |

---

## Stuck Task Detection

`checkStuckTasks(now)` — runs every tick:

1. For each active task:
   - `elapsed = now - task.started_at`
   - Query latest journal entry timestamp
2. Evaluate stuckness:

| Condition | Trigger |
|-----------|---------|
| `elapsed > max_active_duration_ms` | Task exceeded max runtime |
| `elapsed > stuck_threshold_ms` AND no journal entries | No progress detected |
| `elapsed > stuck_threshold_ms` AND latest entry stale | Stalled |

3. Emit `health.stuck_detected` event → transition to blocked

Pure function: `evaluateTaskStuckness()` is exported for testing.

---

## Blocked Escalation

`checkBlockedEscalation(now)` — runs every tick for blocked tasks:

### Escalation Stages (configurable)

| Stage | Default Timing | Action |
|-------|---------------|--------|
| `send_reminder` | ~30 min | Telegram notification to owner |
| `evaluate_self_unblock` | ~90 min | LLM diagnostic (read-only) |
| `escalation_alert` | ~24 hours | Transition → failed, alert owner + reviewers |

### Stage Firing Logic

```
For each stage (in order):
  If elapsed > stage.after_ms:
    If stageIndex > lastFiredStage:  → fire (new stage reached)
    Else if stage.repeat AND (now - lastActionAt) >= repeat_interval_ms:  → fire (repeat)
```

Per-task escalation state tracks `{ lastStageIndex, lastActionAt }`.

### Self-Unblock: `attemptSelfUnblock()`

- Lightweight LLM call (read-only actions only)
- Diagnoses the block cause
- If resolved: transition `blocked → active.working` ("self_unblocked")
- If not: escalation continues

---

## Preemption

`preemption.evaluate(now)` — runs every tick:

### Detection

```
shouldPreempt(activePriority, candidatePriority, threshold): boolean
  → candidatePriority - activePriority >= threshold
```

### Flow

1. **Daemon detects**: higher-priority queued task vs lower-priority active task
2. **Emit**: `preemption.requested` event with target + replacement task IDs
3. **Orchestrator subscribes**: sets `preemptionRequested = true`
4. **Phase boundary**: between phases, Orchestrator checks flag
5. **Yield**: checkpoint → end session ("preempted") → emit `preemption.ready`
6. **Daemon**: transition `active.working → queued` (preempted task)
7. **Next tick**: higher-priority task dispatched, preempted task re-queued

### Timeout Handling

- 1st timeout: re-publish `preemption.requested` (retry)
- 2nd timeout: force-transition `active → queued` (preemption_timeout)

One preemption per tick (prevent thrashing).

---

## Crash Recovery

`rebuildStateFromTaskEngine()` — runs on daemon startup (Phase 3):

1. Query all tasks with `state = active`
2. For each with `sub_state ∈ {working, integrating}`:
   - Transition → queued ("crash_recovery")
3. Initialize base priorities for all queued tasks
4. On next tick: scheduler dispatches with `resume_from = lastCheckpoint`
5. `resolveStartState()`: skip to checkpoint phase + 1

**DB integrity**: Optimistic locking (version column) prevents stale writes. Checkpoints survive crashes (persisted in SQLite WAL).

---

## Task Error Handling

`handleTaskError()` in TaskScheduler — when Orchestrator promise rejects:

1. Remove from activeDispatches
2. Emit `health.stuck_detected` (condition: "orchestrator_crash")
3. Transition → queued ("crash_recovery")
4. Task re-dispatched on next tick with checkpoint resume

---

## State Transitions

| From | To | Reason |
|------|----|--------|
| `active.working` | `blocked` | Phase error, cost limit |
| `active.working` | `queued` | Preemption, crash recovery |
| `blocked` | `active.working` | Self-unblock successful |
| `blocked` | `failed` | Escalation timeout |

---

## Review Pending Reminders

`checkReviewPendingReminders(now)` — runs every tick:

- For each review_pending task:
  - If elapsed > `reminder_after_ms` (default 4h)
  - AND last reminder > `repeat_interval_ms` ago (default 8h)
  - → `notifications.sendReviewReminder(taskId, title, elapsed)`

---

## Test Files

| File | Type |
|------|------|
| `src/core/daemon/health-monitor.test.ts` | Unit — stuck, escalation, cost limits |
| `src/core/daemon/preemption-manager.test.ts` | Unit — preemption logic |
| `test/e2e/crash-recovery.e2e.test.ts` | E2E — orphan recovery |
