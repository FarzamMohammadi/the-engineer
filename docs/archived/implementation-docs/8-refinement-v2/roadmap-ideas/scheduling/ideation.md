# Scheduling & Dispatch — Ideas & Brainstorm

Runtime Phase Refinement section 3 of 9. How tasks move from waiting to working: priority queues, task eligibility, slot management, concurrency, preemption, dispatch, and shutdown.

Brainstormed in Session 081. Expert panel review applied (5 panelists: Torvalds, Hipp, Pike, Engineer Persona, Technical Architect). Findings incorporated below.

**Governing principle:** Plugin Opacity (see `docs/philosophy.md`). Core sees only adapter contracts. The scheduling system is entirely Core — no adapter or plugin references exist. Every decision below maintains this invariant.

---

# Core-Level Decisions

These changes affect Core components (daemon, task engine, scheduler, schemas). They are entirely plugin-agnostic.

---

## Queue Ordering — Confirmed Correct

**Current:** `ORDER BY priority DESC, created_at ASC` — higher number = higher priority, FIFO tiebreak within same priority.

**Decision: No change.** The ordering model is correct. Priority DESC gives explicit control, FIFO tiebreak ensures fairness among equal-priority tasks. Default priority 50 (range 1-100). Users set per-ticket priority via `@priority: <number>` in ticket body.

---

## Slot Management — Confirmed Correct

**Current:** `max_concurrent` (default 1) controls how many tasks can execute simultaneously. Only `active.working` and `active.integrating` consume slots. `active.supervising` and `review_pending` do NOT consume slots.

**Decision: Slot model is correct.** A single-slot system can have 1 task working + N tasks in review + N parents supervising. This maximizes throughput — human review and child execution don't block new work from starting.

---

## Slot Overrun — Must Fix

**Bug discovered during exploration.** When a supervising parent's children all finish, the daemon transitions the parent to `active.integrating` and re-dispatches it via `scheduler.dispatchTask()` directly (daemon/index.ts line 275). This bypasses the slot check. If all slots are full, `max_concurrent` is exceeded.

Same scenario: a `review_pending` task gets feedback and transitions for rework, but slots are full.

**Panel finding (Architect):** There is no `active.integrating → queued` transition in `ValidTransitions`. The fix requires adding this transition to the state machine.

**Decision: Slot check before dispatch, queue at existing priority.**

Before re-dispatching a parent (for integration) or re-queuing a rework task, check available slots. If full, transition the task to `queued` at its **existing priority** — no boost. The normal scheduling cycle picks it up, possibly triggering preemption if a higher-priority task is waiting.

**Panel rationale (Torvalds, unanimous):** Sunk cost is not a valid scheduling criterion. The parent had a priority when created — trust it. A p30 parent should wait behind a p70 task. If it needs to preempt, the existing preemption logic handles it. No magic numbers, no sunk cost fallacy baked into the scheduler.

**Required state machine addition:** `active.integrating → queued` to ValidTransitions. This transition fires when slot overrun is detected and the parent must wait.

The slot check must happen BEFORE the state transition to `active.integrating`, not after — otherwise the parent is stuck in `active.integrating` with no dispatch.

---

## Task Eligibility — Retry Backoff

**Current:** `isTaskEligible()` checks parent state and cascade_policy only. No guard against repeatedly failing tasks.

**Bug:** A task that crashes, gets re-queued, runs, crashes again... repeats indefinitely with no backoff. Wastes compute and LLM cost on tasks that are fundamentally broken (bad repo, corrupted worktree, incompatible tool).

**Decision: Add `not_before` timestamp + `consecutive_crash_count` on the task record.**

When a task crashes and transitions back to `queued`, increment `consecutive_crash_count` and set `not_before` to `now + backoff_for(count)`. `isTaskEligible()` checks `now >= not_before`. The task stays in the queue but is ineligible until the backoff expires.

**Backoff schedule:** 1 minute, 5 minutes, 15 minutes, 30 minutes, 30 minutes (cap). Computed from `consecutive_crash_count`.

**Panel finding (all 5 panelists):** Do NOT derive crash count from `SELECT COUNT(*) FROM state_transitions`. Reasons:
1. It's a hot-path query against an append-only audit trail (O(queued_tasks) queries per tick)
2. It doesn't count *consecutive* errors correctly (includes non-consecutive crashes separated by successful runs)
3. It couples scheduling to audit trail string format (`reason = 'crash_recovery'`)
4. If data lifecycle purges old transitions, the count resets and a broken task gets full retries

**Correct approach:** `consecutive_crash_count INTEGER NOT NULL DEFAULT 0` column on the tasks table. Increment on crash recovery, reset to 0 on any successful phase completion. One column, one UPDATE, zero queries. The audit trail remains for forensics.

**Max retries: 5.** After 5 consecutive crash recoveries, transition to `failed` instead of `queued`. Owner notified. Task can be manually re-queued.

**Panel finding (Hipp):** When an operator manually re-queues a failed task, `consecutive_crash_count` must be reset to 0 — otherwise the task immediately hits the backoff wall.

---

## Error Routing — Two Distinct Paths

**Decision: Maintain the distinction between crashes and deliberate errors.**

- **Crash** (unhandled exception in orchestrator) → `queued` with `not_before` backoff. Retry up to 5 times. After 5 retries → `failed`.
- **Deliberate error** (orchestrator returns `{ outcome: "error" }`) → `blocked`. Needs human intervention. The orchestrator made a conscious decision that it can't proceed — this isn't a transient failure.

Two failure modes, two responses. Crashes are retried because they might be transient (rate limits, network, OOM). Deliberate errors are escalated because the LLM already determined it's stuck.

---

## Priority Aging — Delete Entirely

**Panel finding (Engineer Persona, supported by panel discussion):** Priority aging solves a multi-tenant problem that doesn't exist in this system. The Engineer is a single-user, local-only daemon. If a task is starving in the queue, the user knows — they filed the ticket. They chose to run higher-priority things first. That's correct behavior, not starvation.

**Decision: Delete priority aging entirely.**

Cascading simplification:
- Delete `applyPriorityAging()` from the scheduler
- Delete `computeAgedPriority()` pure function
- Delete all aging config params (`aging_threshold_ms`, `aging_interval_ms`, `aging_increment`, `aging_cap`)
- Delete `basePriorities` Map from scheduler + all management methods (`trackBasePriority`, `initializeBasePriorities`, `removeBasePriority`)
- Delete `basePriorities` Map + `pendingBasePriorities` buffer from trigger poller
- Delete `drainNewBasePriorities()` drain pattern between trigger poller and scheduler
- Delete `initializeBasePriorities()` crash recovery step in daemon startup
- Tick loop loses the aging step (one fewer step, one fewer DB query)
- No `base_priority` column needed (it only existed for aging)

This is significant code deletion and a major reduction in cross-subsystem coupling. The `priority` field on the task record is the only priority — set at creation, mutable by the user via dashboard or API, never auto-modified.

If aging is ever needed (multi-user, shared instance), it can be reinstated as a configurable feature. But for a single-user system, the user controls priority directly.

---

## Tick Loop — Simplified

With aging deleted, the tick loop becomes:

1. Cost limit processing
2. Trigger polling (creates new tasks)
3. Response polling (unblocks tasks)
4. **Preemption evaluation** (single query: `getQueuedByPriority()`)
5. **Schedule next** (shared query from step 4)
6. Stuck task detection
7. Blocked escalation
8. Review handling
9. Dedup key cleanup

**Panel consensus (Hipp, Pike, Torvalds):** One query shared between preemption and scheduling. No reason for two queries when aging is gone — the data doesn't change between preemption and scheduling within the same tick (single-threaded Node.js event loop).

---

## Cooperative Shutdown — Pull Model

**Current:** `drainForShutdown()` races active task promises against a 30s timeout. The orchestrator doesn't know shutdown is happening — if it's mid-LLM-call, work since the last checkpoint is lost.

**Panel finding (Engineer Persona, Hipp):** Use a pull model, not push. The orchestrator is often `await`-ing a CLI subprocess — it can't act on an EventBus event until the subprocess returns. A flag check between phases is simpler and deterministic.

**Decision: Cooperative shutdown via `shutdownRequested` flag.**

1. Daemon sets `shutdownRequested = true` on the orchestrator (or a shared flag object) before starting drain.
2. Orchestrator checks `shutdownRequested` at each phase boundary (same pattern as preemption checking). If set, checkpoint and exit cleanly.
3. Drain proceeds as before — wait for active task promises with timeout, force-transition remainders to `queued`.

This is pull-based, deterministic, requires no EventBus event, and follows the same pattern the orchestrator already uses for preemption. The flag is Core-internal (daemon → orchestrator).

---

## State Rename: `intake` → `requirements_gathering`

**Naming inconsistency discovered.** The task state machine uses `"intake"` as a state value (task.ts line 7), but the phase is conceptually "requirements gathering" — it reads the ticket, assesses clarity, and blocks with outreach if information is missing.

**Panel finding (all 5 panelists):** All panelists recommended against this rename. Reasons: terrible cost-benefit (25+ files, ~99 occurrences), states should be terse nouns not verb phrases, CHECK constraint requires table recreation, and it's a one-way door.

**Co-founder override: Include the rename.** Before making the project public, naming should be correct everywhere. This is a fresh project with zero backward compatibility concerns. The cost is mechanical work, not design risk.

**Panel-informed constraints:**
- Separate migration from schema additions (`not_before`, `consecutive_crash_count`). Different risk profiles deserve different change boundaries.
- Grep-based audit of every occurrence BEFORE implementation.
- Run all tests after rename to catch any missed references.
- CHECK constraints in SQLite require table recreation (CREATE new table → INSERT SELECT → DROP old → RENAME new → recreate indexes).

---

## Preemption — Confirmed Correct

**Current:** Threshold 20 priority points. Two-strike timeout (1 minute each): first timeout re-requests, second timeout force-transitions. One preemption per tick max.

**Decision: No change.** 20 points is a meaningful gap — a p70 task preempts p50, but a p55 does not. The two-strike timeout gives the orchestrator a fair chance to checkpoint. One preemption per tick prevents scheduling thrash.

---

## Rework Flow — Confirmed Correct

**Current:** When a task has unapplied feedback from review, the checkpoint is cleared and the task restarts from intake (requirements gathering).

**Decision: No change to the rework flow.** Requirements gathering is the gatekeeper — it assesses whether the task has enough information to proceed. After receiving reviewer feedback, the LLM might determine it needs more human input before reworking. Starting from requirements gathering ensures that gate is re-evaluated. This is intentional, not wasteful.

---

## Observability Improvements

Three additions for scheduling visibility:

### 1. Dispatch Logging
`dispatchTask()` currently logs at debug level. Add an **info-level** log for task dispatch:
```
info: Dispatching task {id} "{title}" at priority {priority} (slot {n}/{max})
```
This is a key lifecycle event — dispatching a task is the moment work begins. Should be visible without debug mode.

### 2. Preemption Completion Event
Currently, `preemption.requested` is emitted when preemption starts, but there's no event when it completes. Add `preemption.completed` with `{ targetTaskId, replacementTaskId, method: "cooperative" | "forced" }`. Useful for War Room dashboard and debugging.

### 3. Slot Utilization in Daemon State
Expose `{ activeSlots, maxSlots, supervisingCount, reviewPendingCount }` in `getState()`. The War Room dashboard can show slot utilization as a gauge. Currently only `activeTaskIds` is exposed — the dashboard has to count and doesn't know about non-slot-consuming states.

---

# Deferred Items

## Deferred: Priority Aging

**Trigger:** When The Engineer operates in a shared/multi-user environment where tasks can be genuinely forgotten.

Deleted in this session because starvation is not a real problem in a single-user system. The user controls priority directly. If aging is reinstated, it should use queue entry time (not `created_at`), store `base_priority` as a DB column, and cap below the manual urgency range.

## Deferred: Cost-Aware Eligibility

**Trigger:** When tasks regularly exceed cost budgets and get re-scheduled, burning more money on repeated failures.

A task that already burned $5 and errored gets re-scheduled with no consideration of accumulated cost. The retry backoff + max retry limit prevents unbounded cost for now.

## Deferred: Task Dependency Graph Beyond Parent-Child

**Trigger:** When users need "do X after Y" relationships between unrelated tasks.

Current eligibility only checks parent-child relationships. A general dependency graph would require a dependency table and topological sort. Over-engineering for v1.

## Deferred: Progress-Aware Preemption

**Trigger:** When preemption frequently wastes significant compute by interrupting tasks near completion.

Phase-aware preemption could restrict preemption to early phases. Deferred because preemption is rare (20-point threshold) and the cooperative shutdown minimizes waste.

## Deferred: Dynamic Slot Scaling

**Trigger:** When users need `max_concurrent` to change based on system load or time of day.

Static config value for v1.

## Deferred: `queued → failed` Transition (Task Cancellation)

**Trigger (Torvalds):** When users need to cancel queued tasks. Currently no path from `queued` to `failed` in ValidTransitions. A task sitting in the queue cannot be cancelled. Related to the deferred "trigger ticket closure as cancellation" feature.
