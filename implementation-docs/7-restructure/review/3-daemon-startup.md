# Phase 3: Daemon Startup — Protocol P1

---

## Flow

```
daemon.start()
    │
    ├─ 1. Single-instance guard (throw if already running)
    ├─ 2. checkAndWritePidFile()
    │      ├─ Check existing PID → isProcessAlive(pid)?
    │      ├─ If alive: throw DaemonAlreadyRunningError
    │      ├─ If stale: delete old file, warn
    │      └─ Write current process.pid
    ├─ 3. registry.startHealthCheckLoop()    → setInterval(60s)
    ├─ 4. dataLifecycleManager?.start()      → periodic cleanup timer
    ├─ 5. rebuildStateFromTaskEngine()       → crash recovery
    │      ├─ Find orphaned active tasks (working/integrating)
    │      ├─ Transition each → queued ("crash_recovery")
    │      └─ Initialize base priorities for queued tasks
    ├─ 6. registerSubscriptions()            → 5 EventBus handlers
    ├─ 7. running = true, startedAt = now
    ├─ 8. Start tick interval                → setInterval(tick, tick_interval_ms)
    ├─ 9. Register SIGTERM/SIGINT handlers
    └─ 10. Log "Daemon started"
```

---

## Production Files

| # | File | Role |
|---|------|------|
| 1 | `src/core/daemon/index.ts` | `createDaemon()` factory, `start()`, `stop()`, `tick()`, exported helpers |
| 2 | `src/core/daemon/types.ts` | `DaemonContext` + 6 narrowed context type aliases |
| 3 | `src/core/daemon/errors.ts` | `DaemonAlreadyRunningError` and daemon error types |
| 4 | `src/core/daemon/query-handler.ts` | `handleQuery()` for `comm.message_received` events |
| 5 | `src/core/daemon/trigger-poller.ts` | `createTriggerPoller()` — polls trigger plugins for new events |
| 6 | `src/core/daemon/task-scheduler.ts` | `createTaskScheduler()` — active dispatch queue, completion callbacks |
| 7 | `src/core/daemon/health-monitor.ts` | `createDaemonHealthMonitor()` — cost limits, stuck tasks, blocked escalation |
| 8 | `src/core/daemon/preemption-manager.ts` | `createPreemptionManager()` — priority-based cooperative preemption |
| 9 | `src/core/daemon/notification-router.ts` | `createNotificationRouter()` — fire-and-forget Telegram + GitHub notifications |
| 10 | `src/core/daemon/review-handler.ts` | `createReviewHandler()` — PR merge/feedback polling |

---

## PID File Management

- Path: `~/.engineer/run/engineer.pid`
- On start: check existing PID for liveness via `process.kill(pid, 0)`
- If alive: throw `DaemonAlreadyRunningError(existingPid)` — prevents dual instances
- If dead: delete stale PID, write new one
- On stop: remove PID file (idempotent)

---

## Crash Recovery: `rebuildStateFromTaskEngine()`

Handles the case where daemon died mid-dispatch:

1. Query all tasks with `state = active`
2. For each where `isSlotConsuming(state, sub_state)` is true (working/integrating, excludes supervising):
   - `taskEngine.requestTransition(taskId, queued, null, "crash_recovery", "daemon")`
3. Initialize `basePriorities` for all queued tasks
4. Sync trigger poller priorities to scheduler

Tasks re-enter the queue and get re-dispatched on next tick, resuming from their last checkpoint.

---

## 5 EventBus Subscriptions

| ID | Event | Handler | Purpose |
|----|-------|---------|---------|
| `daemon:cost` | `cost.limit_reached` | `healthMonitor.addCostLimitTask(taskId)` | Track cost-breached tasks for blocking |
| `daemon:comm` | `comm.message_received` | `handleQuery(payload)` | Process incoming user commands |
| `daemon:state-sync` | `task.state_changed` | `notifications.syncStateToCommPlugin()` | GitHub label sync on state changes |
| `daemon:children-done` | `task.children_all_done` | Parent → active.integrating, re-dispatch | Resume parent after all children complete |
| `daemon:feedback` | `task.feedback_received` | `reviewHandler.handleFeedbackEvent()` | Process PR review feedback |

---

## Tick Loop (9 Steps)

Runs every `config.tick_interval_ms` (default ~5s):

| Step | Action | Phase Reference |
|------|--------|----------------|
| 1 | `healthMonitor.processCostLimits()` | Phase 12 |
| 2 | `triggerPoller.poll(now)` | Phase 4 |
| 3 | Sync base priorities poller → scheduler | Phase 4/5 |
| 4 | `preemption.evaluate(now)` | Phase 11 |
| 5 | `scheduler.scheduleNext()` | Phase 5 |
| 6 | `scheduler.applyPriorityAging(now)` | Phase 5 |
| 7 | `healthMonitor.checkStuckTasks(now)` + `checkBlockedEscalation(now)` + `checkReviewPendingReminders(now)` | Phase 11/12 |
| 8 | `reviewHandler.checkMerges()` + `checkFeedback()` | Phase 8/9 |
| 9 | `triggerPoller.cleanupExpiredKeys(now)` | Phase 4 |

---

## Shutdown: Protocol P15 (`stop()`)

1. Set `shuttingDown = true`
2. Clear tick interval
3. Stop data lifecycle manager
4. Drain active dispatches (wait up to 30s, then force → queued)
5. `registry.shutdownAll()` (reverse init order) + stop health check loop
6. Unsubscribe all 5 event handlers
7. Remove SIGTERM/SIGINT handlers
8. Remove PID file
9. `running = false`

---

## Daemon Internal Subsystems

Created inside `createDaemon()`:

| Subsystem | Factory | File |
|-----------|---------|------|
| NotificationRouter | `createNotificationRouter()` | `notification-router.ts` |
| TaskScheduler | `createTaskScheduler()` | `task-scheduler.ts` |
| PreemptionManager | `createPreemptionManager()` | `preemption-manager.ts` |
| TriggerPoller | `createTriggerPoller()` | `trigger-poller.ts` |
| ReviewHandler | `createReviewHandler()` | `review-handler.ts` |
| DaemonHealthMonitor | `createDaemonHealthMonitor()` | `health-monitor.ts` |

---

## Observable State: `getState()`

```typescript
{
  running: boolean,
  shuttingDown: boolean,
  startedAt: string | null,
  maxConcurrent: number,
  activeTaskIds: string[],
  pendingPreemption: { targetTaskId, replacementTaskId, requestedAt, retried } | null,
  tasksCompleted: number,
  seenKeyCount: number,
  triggerFailures: Record<string, number>
}
```

---

## Test Files

| File | Type |
|------|------|
| `src/core/daemon/index.test.ts` | Unit — start/stop/tick, subscriptions, `isSlotConsuming` |
| `src/core/daemon/task-scheduler.test.ts` | Unit — scheduling, dispatch, aging, completion |
| `src/core/daemon/health-monitor.test.ts` | Unit — cost limits, stuck tasks, blocked escalation |
| `src/core/daemon/preemption-manager.test.ts` | Unit — cooperative preemption |
| `src/core/daemon/notification-router.test.ts` | Unit — Telegram + GitHub notification routing |
| `src/core/daemon/review-handler.test.ts` | Unit — PR merge/feedback polling |
| `src/core/daemon/query-handler.test.ts` | Unit — comm message handling |
| `src/core/daemon/trigger-poller.test.ts` | Unit — trigger polling, dedup, cleanup |
| `src/core/daemon/decomposition.test.ts` | Unit — task decomposition handling |
| `src/core/daemon/notifications.test.ts` | Unit — notification helpers |
| `test/integration/daemon-trigger-polling.integration.test.ts` | Integration — trigger polling flow |
| `test/e2e/daemon-lifecycle.e2e.test.ts` | E2E — full lifecycle |
| `test/e2e/crash-recovery.e2e.test.ts` | E2E — orphan recovery |
