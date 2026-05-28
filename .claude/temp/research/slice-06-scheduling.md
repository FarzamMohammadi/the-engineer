# Research: Slice 6 — Scheduling & Dispatch

**Date**: 2026-05-23 | **Repo**: the-engineer | **Branch**: main | **Commit**: 727e232

Scope: implementation-detail surfaces feeding the Slice 6 plan. Decisions live in
`docs/archived/implementation-docs/9-oss-ready/slices/06-scheduling.md`. Requirements gathering
(Session 24) covered scope decisions; this doc grounds every claim in source, enumerates exact
touch points per decision, and surfaces cross-cutting concerns the Q&A missed.

## What I Found

### Decomposition consumer surface — exact touch points (D1)

**Files**: `src/schemas/task.ts`, `src/db/migrations/001_schema.sql`, `src/core/task-engine/{queries,row-mapper,index}.ts`, `src/core/daemon/{task-scheduler,index}.ts`, `src/core/data-lifecycle/index.ts`, `src/schemas/events.ts`, `src/cli/bundled/templates.ts`

**Schema (`schemas/task.ts`):**
- `SubStateSchema` (:20) — drop `supervising`, `integrating`. Result: `z.enum(["working", "code"])`.
- `CascadePolicySchema` (:26-27) + `CascadePolicies` (:30) — delete entirely.
- `ChildEntrySchema` (:73-77) + type — delete entirely.
- `ChildCompletionSummarySchema` (:115+) + type — delete entirely.
- `TaskSchema` fields to drop: `parent_id` (:200), `children` (:201), `cascade_policy` (:202), `child_summaries` (:212).
- `ValidTransitions` (:275-330) — delete 8 entries: working→supervising (:289-294), supervising→working (:295-300), supervising→blocked (:301), supervising→integrating (:302-307), supervising→failed (:308), integrating→review_pending.code (:309-314), integrating→completed (:315), integrating→failed (:316), integrating→queued (:317), blocked→supervising (:319).
- `PermissionTable` (:365-369 supervising, :371-382 integrating) — delete both entries.

**DB (`migrations/001_schema.sql`):**
- `tasks.sub_state` CHECK (:14) — drop supervising, integrating: `CHECK(sub_state IN ('working','code'))`.
- `tasks.parent_id` (:18), `tasks.children` (:19), `tasks.cascade_policy` (:20), `tasks.child_summaries` (:30) — drop columns.
- `tasks.priority` (:45) already has `CHECK(priority BETWEEN 1 AND 100)` — Q6 alignment, see "Priority bounds" below.
- `idx_tasks_parent_id` (:76) — drop.
- `state_transitions.from_sub`/`to_sub` CHECK (:95-96) — drop supervising, integrating.
- The header comment: *"Single source of truth — consolidated from all prior migrations"* — the rewrite-in-place pattern applies (no new migration file). Dev DBs are wiped via `reset.sh`.

**Task engine:**
- `queries.ts:27` — drop `getChildrenStmt` + `getChildren` method (:58-61).
- `queries.ts:21` — `getTasksByStateStmt` works on any state, no change needed.
- `row-mapper.ts:7,28,38,86,87,96` — drop `ChildEntry`/`ChildCompletionSummary` imports, the `parent_id`, `children`, `child_summaries` row fields and mappings.
- `index.ts:75,103,144,146,191,214,242,259,269,366` — drop cascade_policy column type, child_summaries column type, INSERT columns, defaults, createTask handling.

**Scheduler (`task-scheduler.ts`):**
- `isSlotConsuming` (:16-18) — drop `|| subState === SubStates.integrating`.
- `isTaskEligible` parent branch (:116-153) — drop entirely; keeps only the `not_before` gate.
- `Outcomes.decomposed` handling (:405-409) — drop.
- `checkAndEmitChildrenAllDone` (:522-561) — delete entirely.
- `TaskScheduler` interface (:67-69) — drop `checkAndEmitChildrenAllDone` method.

**Daemon (`index.ts`):**
- `task.children_all_done` event declaration (:66-72) — drop.
- `handleChildrenAllDone` (:267-355) — delete entirely (~90 lines).
- `daemon:children-done` subscription (:423-426) — drop.
- `unregisterSubscriptions` (:500) — drop the corresponding `unsubscribe`.

**Events (`schemas/events.ts`):**
- `EventTypeSchema` enum entry `task.children_all_done` (~:43) — drop.
- `TaskChildrenAllDonePayloadSchema` + payload type — delete entirely.
- `EVENT_PAYLOAD_SCHEMAS` map entry (:543) — drop.
- `EventPayloads` type-map entry (:491) — drop.

**Data lifecycle (`data-lifecycle/index.ts:62-70`):**
- `ACTIVE_STATES` array contains `SubStates.supervising` (:69) — pre-existing typing bug (mixing a sub-state into a list of task states). With deletion, the offending entry falls out cleanly; the list now contains only `TaskState` values.

**Bundled templates (`cli/bundled/templates.ts`):**
- Dead config block (:112-115 in commented form, :438-440 active) — `decomposition.auto_threshold_ms` / `suggest_threshold_ms`. Never read in `src/`. Delete both occurrences.

**Cross-slice (handed to Slice 8):**
- `src/core/orchestrator/decomposition-handler.ts` — delete entire file.
- `src/core/orchestrator/phase-runner.ts:699-716` — remove the `handleDecomposition` call site.
- `src/core/orchestrator/index.ts:19,224` — drop `DecompositionHandler` import + factory + ctx wiring.
- `src/core/orchestrator/types.ts:80-87` — drop `Outcomes.decomposed`; (:96-99) drop the decomposed variant from `ExecuteTaskResult`.
- `src/schemas/orchestrator.ts:103` — drop `decomposition_plan` from `PlanningOutputSchema`; (:185-214) delete `DecompositionChildSchema`/`DecompositionPlanSchema`/`LLMDecompositionPlanSchema` entirely.
- `src/core/orchestrator/prompts/planning.ts:100` — drop the decomposition instruction.
- `src/core/orchestrator/prompts/integration.ts:71` and `prompts/demo-prep.ts:112` — both reference "decomposition" as the reason `integration` phase exists. Slice 8 should re-evaluate whether the entire `integration` phase is dead now.

**Cross-slice (handed to Slice 15 — Dashboard):**
- `src/dashboard/client/src/types/api.ts:14` — `SubState` type drops `supervising` and `integrating`.
- Any UI rendering of parent/child grouping or supervising/integrating sub-states — to be enumerated by Slice 15 directly.

### Retry-policy module surface (D2, D8)

**Files**: `src/core/daemon/task-scheduler.ts:20-32,353-390,434-518`, `src/core/orchestrator/phase-runner.ts:31-41,957-1009`, `src/schemas/config.ts:36`, `src/schemas/task.ts:250-251`

**Current state:**
- Scheduler holds `BACKOFF_MINUTES = [1, 5, 15, 30, 30]` (:23) → `MAX_CRASH_RETRIES = BACKOFF_MINUTES.length` (:26) + `computeBackoffMs(crashCount)` (:29-32). Fires on orchestrator promise rejection (`handleTaskError` :434-518).
- Phase-runner holds `LLM_RETRY_BACKOFF_MINUTES = [2, 5, 10, 15, 15]` (:32) → `MAX_LLM_UNAVAILABLE_RETRIES = LLM_RETRY_BACKOFF_MINUTES.length` (:35) + `computeLlmRetryBackoffMs` (:38-41). Fires on `LlmUnavailableError` (:961-1008). Writes directly to `consecutive_crash_count` and `not_before` on the task row.
- Scheduler imports `MAX_LLM_UNAVAILABLE_RETRIES` from phase-runner (:9). Cross-boundary import smell.
- `handleLlmUnavailableBlocked` (:353-390) is scheduler-side counter management for LLM-unavailable retries — reads `consecutive_crash_count`, decides re-queue vs alert, transitions blocked→queued.
- Task schema field `consecutive_crash_count` (:251) and DB column (`001_schema.sql:69`) — the only counter today, shared by both tracks.
- `not_before` field (:250) — the only backoff timestamp, shared by both tracks.

**Config schema (`config.ts`):**
- `DaemonConfigSchema` starts at :36, includes 14+ knobs but no `retry_policy` block. New section needed.

**What survives in the new module:**
- Same algorithm shape (array of minutes → backoff schedule, ceiling = length).
- Same persistence pattern (task field for counter, `not_before` for backoff timestamp) — but per-category fields.
- Same terminal decisions: crash exhausted → `failed`; llm_unavailable exhausted → permanent `blocked`.

### Dispatch-tracker primitive surface (D3, D9, D10, D11)

**Files**: `src/core/daemon/task-scheduler.ts:84,177-248,393-432,434-518,577-639`, `src/core/daemon/preemption-manager.ts:119-179`, `src/core/daemon/cost-limit-queue.ts:32-65`, `src/core/orchestrator/types.ts:80-102`, `src/schemas/ephemeral.ts` (Dispatch shape)

**Current state:**
- `activeDispatches: Map<string, Promise<ExecuteTaskResult>>` (:84) — owned by scheduler. Only keys: taskId. No dispatch identity beyond the promise reference.
- `dispatchTask` (:177-248) — wires the promise: `activeDispatches.set(task.id, promise)` then `.then(result → onTaskCompleted, error → onTaskError)`. No signal, no cancellation surface.
- `handleTaskCompletion`/`handleTaskError` (:393-432, :434-518) — late callbacks. Both call `activeDispatches.delete(taskId)` at the top, then transition. **Not idempotent**: if a new dispatch happened for the same taskId between the original and the late callback, the new dispatch's entry could be deleted by an old callback.
- `removeActiveDispatch` (:573-575) — exposed on TaskScheduler interface (:54). Called by `preemption-manager.abandonPending` (:208) and `checkPreemptionTimeout` (:157) — i.e., outside callers mutating scheduler's private state.
- Preemption-manager force-transition (:131-158): `requestTransition(queued, "preemption_timeout")` + `removeActiveDispatch(targetTaskId)` + emit `preemption.completed`. Underlying orchestrator promise still runs — late callback fires on already-moved task, transitions fail validation, noise.
- Cost-limit-queue (`cost-limit-queue.ts:38-63`): same anti-pattern — `requestTransition(blocked, "cost_limit_reached")` directly, no awareness of in-flight dispatch.
- `drainForShutdown` (:577-639) — bespoke `Promise.allSettled` race with timeout, manual `requestTransition(queued, "graceful_shutdown")` for each surviving active task, manual `activeDispatches.clear()`.

**Outcomes (`orchestrator/types.ts:80-102`):**
- Current set: `completed`, `review_pending`, `decomposed`, `preempted`, `blocked`, `error`.
- After D1+D11: `completed`, `review_pending`, `blocked`, `error`, `terminated`. The `terminated` variant carries a `reason` field of a Zod enum.
- Cooperative preemption today: phase-runner returns `{ outcome: "preempted", lastPhase, checkpointId }` (`phase-runner.ts` checkpoint path). After D11: returns `{ outcome: "terminated", reason: "cooperative_preemption", lastPhase, checkpointId }`.

**Dispatch shape (`ephemeral.ts`):**
- Current Dispatch carries `task`, `resume_from` (checkpoint), `knowledge`. No `signal` field. Adding `signal: AbortSignal` is the contract change.

**AbortController availability:** zero usage anywhere in `src/` (verified by grep). Pure Node.js standard, no install needed.

**Per-dispatch identity:** today there is none — the promise reference IS the identity. For idempotent late callbacks, dispatch-tracker stores `{ dispatchId: ulid(), promise, signal }` keyed by taskId. Late callbacks compare `dispatchId` against current entry; mismatched → no-op (a new dispatch superseded).

### Hard-cap enforcement wiring (D4)

**Files**: `src/core/daemon/health-monitor.ts:11-37,72-114`, `src/core/daemon/index.ts:456-467`

- `evaluateTaskStuckness` (:11-37) returns `{ condition: "no_state_transition", elapsedMs }` when `activeElapsedMs > maxActiveDurationMs`.
- `checkSingleTaskStuck` (:72-94) computes `activeElapsed = now - Date.parse(task.started_at)` for each in-flight dispatch's task, calls evaluateTaskStuckness, emits `health.stuck_detected` on a hit.
- Daemon subscribes (:456-467) and turns the event into a cooldown-gated owner notification. **No termination happens.**
- `started_at` is set once on first active transition (`state-machine.ts:78-79` — only if `started_at IS NULL`). Wall-clock semantics preserved across blocked/queued cycles.
- Slice 6 work: add a parallel subscriber that filters `condition === "no_state_transition"` and calls `dispatchTracker.terminate(taskId, "hard_cap_exceeded")`. The existing notification subscriber keeps firing the alert. Health-monitor itself is untouched.

### Crash recovery surface (D5)

**Files**: `src/core/daemon/index.ts:510-540,617`, `src/core/daemon/task-scheduler.ts:434-518`

- Boot recovery `rebuildStateFromTaskEngine` (:510-540): iterates `getTasksByState(active)`, finds slot-consumers (`isSlotConsuming`), transitions to queued with reason `"crash_recovery"`. **No counter increment, no backoff, no ceiling.**
- Per-task crash `handleTaskError` (:434-518): increments `consecutive_crash_count`, emits `health.stuck_detected` with `condition: "orchestrator_crash"`, computes backoff via `computeBackoffMs`, sets `not_before`, transitions to queued OR failed when `crashCount >= MAX_CRASH_RETRIES`.
- Graceful shutdown reason is `"graceful_shutdown"` (task-scheduler.ts:625) — distinguishable from `"crash_recovery"`. Only hard-shutdown orphans hit boot recovery.
- After D5: both paths call `retryPolicy.recordFailure("crash", taskId)`. The boot-loop hole closes — repeated daemon crashes from a single poison task exhaust its budget and route to `failed` + alert.

### Preemption tightening surface (D6)

**Files**: `src/core/daemon/preemption-manager.ts:1-219`, `src/schemas/task.ts:238`, `src/db/migrations/001_schema.sql:45`, `src/core/daemon/event-variables.ts:6`, `src/schemas/events.ts:41,498,550`, `src/core/orchestrator/phase-runner.ts:333-342`

**Priority bounds reconciliation:**
- DB CHECK: `priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 1 AND 100)` (:45).
- Zod schema: `priority: z.number().int()` (:238) — **no bounds**.
- Comment in `event-variables.ts:6`: `"Currently extracts @priority: <number> (range 1-100)"`.
- **Q6 said `[0, 100]` but DB enforces `[1, 100]`. Align Zod to `[1, 100]` to match DB and comment.** (Research catches a small Q6 error.)

**Ineligibility filter:**
- `findAndInitiatePreemption` (`preemption-manager.ts:72-89`) takes `queuedTasks[0]` as the candidate. After D1, eligibility is just `not_before`. Filter happens in scheduler today, not in preemption-manager. The fix: preempter filters by eligibility before picking — either by calling `isTaskEligible` directly or by accepting pre-filtered list from the tick caller.

**One-per-tick:**
- `evaluate` (:53-70) returns early if `pendingPreemption` is set — no new candidate considered until current cycle completes (cooperative settle OR double-timeout force). This is the deliberate policy to document.

**Dead `preemption.ready` event:**
- Published by `phase-runner.ts:333-342` on cooperative checkpoint.
- Declared in `events.ts:41` (enum), `:498` (type map), `:550` (schema map).
- **Zero subscribers in `src/`** (verified by grep). Pure dead infrastructure. Delete the publisher + the event type declarations.

**Force-preemption uses terminate:**
- Replace `preemption-manager.ts:131-158` (force-transition + removeActiveDispatch + emit completed) with `dispatchTracker.terminate(targetTaskId, "preemption_timeout")` + emit `preemption.completed`. Routing happens via the new Outcomes.terminated path.

### Eligibility surfacing (D7)

**Files**: `src/core/daemon/task-scheduler.ts:106-153`

Post-D1, `isTaskEligible` collapses to a single check:
```ts
function isTaskEligible(task: Task): boolean {
  if (task.not_before && new Date(task.not_before).getTime() > clock.now()) {
    observer.debug("Task not eligible: not_before gate", { taskId: task.id, notBefore: task.not_before });
    return false;
  }
  return true;
}
```

No new API, no new event. Doc paragraph in `configuration/daemon.md` or a new `architecture/scheduling-dispatch.md` lists the two gates (slot availability + `not_before`).

### `engineer retry` command (D12)

**Files**: `src/cli/commands/retry.ts:1-126`

- Already resets `consecutive_crash_count` to 0 (:107-108) inside the transaction.
- Direct DB access (no daemon dependency) — keeps it usable when daemon is stopped.
- Only works on tasks in `blocked` state (:63-66). **Failed tasks have no recovery path.**
- After D2 introduces `consecutive_llm_unavailable_count`, retry.ts adds one more `UPDATE tasks SET consecutive_llm_unavailable_count = 0` inside the same transaction.

### Test surface (deletions and additions)

**Existing tests that get deleted:**
- `tests/unit/core/orchestrator/decomposition-handler.test.ts` — entire file (~360 lines).
- `tests/unit/core/orchestrator/decomposition-handler.integration.test.ts` — entire file.
- `tests/unit/core/daemon/index.children-done.test.ts` — entire file.
- Scenarios in `tests/unit/core/daemon/task-scheduler.test.ts` for parent-state gating, cascade `pause_siblings`, sibling check, `Outcomes.decomposed` routing, `checkAndEmitChildrenAllDone`.
- Scenarios in `tests/unit/core/daemon/preemption-manager.test.ts` covering force-transition (replaced by terminate-routing tests).
- Scenarios in `tests/unit/core/task-engine/state-machine.test.ts` covering supervising/integrating transitions.
- Scenarios in `tests/unit/schemas/task.test.ts` (or wherever) covering `cascade_policy`, `ChildEntrySchema`, etc.

**New tests:**
- `tests/unit/core/retry-policy/index.test.ts` — per-category backoff computation, ceiling enforcement, terminal-state routing, counter increment + reset, `recordFailure` API.
- `tests/unit/core/dispatch-tracker/index.test.ts` — terminate, signal abort, idempotent late callbacks (old-dispatch callback doesn't clobber new dispatch state), in-flight tracking, drain.
- Scenarios in `tests/unit/core/daemon/task-scheduler.test.ts` — terminate routing per reason (preemption→queued, hard_cap→failed, cost_limit→blocked, shutdown→queued).
- Scenarios in `tests/unit/core/daemon/preemption-manager.test.ts` — eligible filter (preempter picks `eligible[0]` not `queuedTasks[0]`), priority bound enforcement via schema.

**Modified tests:**
- `tests/unit/core/daemon/cost-limit-queue.test.ts` — adopt terminate primitive in assertions.
- `tests/unit/core/daemon/health-monitor.test.ts` — verify new hard-cap subscriber wiring (no health-monitor internal change).
- `tests/unit/core/daemon/index.test.ts` — drain rewrite, hard-cap subscription wiring.
- E2E: confirm decomposition path absence does not break the happy path; verify terminate routing in a smoke test.

**Test count direction:** net DOWN. Aligned with testing philosophy (delete bullshit, keep behavior tests).

### Doc surface

**Files**: `docs/architecture/overview.md`, `docs/configuration/daemon.md`, `docs/cli.md`, plus possibly a new `docs/architecture/scheduling-dispatch.md`.

**Updates needed:**
- `architecture/overview.md`: scheduling section refresh — describe the queue → eligibility → dispatch → outcome flow without supervising/integrating sub-states. Plugin Opacity re-emphasis on retry-policy and dispatch-tracker (both pure Core).
- `configuration/daemon.md`: new `retry_policy` config block (per-category backoff schedules and ceilings, defaults); `max_active_duration_ms` behavior change (was warn, now terminate + fail); preemption documentation including bounded priority and the explicit one-per-tick policy.
- `cli.md`: `engineer retry` documentation refresh to mention per-category counter reset.
- Possibly a new `docs/architecture/scheduling-dispatch.md` if the overview section grows large — captures the eligibility model (slot + `not_before`), the retry-policy concept, the dispatch-tracker primitive, and the Outcomes.terminated reason routing table.
- Bundled docs: `cli/bundled/templates.ts` template comments need to match new config shape; `cli/bundled/plugin-docs.ts` doesn't reference decomposition/cascade/scheduling internals (verified — Slice 5 closing sweep already aligned it).

## What It Means

### Patterns to follow

- **Migration rewrite**, not new file. `001_schema.sql` header explicitly says single source of truth. New columns / drops happen in place. Dev DBs are wiped via `reset.sh`; pre-v1, no backward-compat path needed.
- **Adapter-side interface, Core-side impl** for retry-policy and dispatch-tracker — same pattern as Slice 5's `StateStore`/PluginContext. Pure Core today (no plugin contact), but the discipline keeps the door open for future SDK extraction.
- **Per-plugin / per-category fields on the task row** — the pattern matches Slice 5's clean naming (`consecutive_crash_count` keeps its narrow meaning; new `consecutive_llm_unavailable_count` for the new category). Future categories add their own field.
- **Late-callback idempotency via dispatch identity** — `dispatchId: ulid()` per dispatch, callbacks check identity against current. ULID is already in the codebase (`state-machine.ts:3` imports `ulid`).
- **Subscribe to existing events, don't add new ones for derived signals.** Hard-cap enforcement uses the existing `health.stuck_detected` event; no new event needed. Aligned with "design every output for its consumer" — the consumer here is daemon-internal routing, no new declaration earns its place.

### Risks

- **Priority bounds discrepancy.** Q6 said `[0, 100]`; DB enforces `[1, 100]`. Align Zod to `[1, 100]` to match DB and the `event-variables.ts` comment — `0` would crash on insert. Plan must surface this correction explicitly.
- **`failed` is terminal with no recovery path.** After D4, hard-cap exceeded → `failed`. `engineer retry` only works on `blocked`. ValidTransitions has no `failed → queued` edge. **A task killed by hard-cap cannot be retried — owner has to start fresh.** Surface in the plan: either add `failed → queued` transition (opens retry for hard-cap victims; aligned with D12's "owner intervention is reset point" philosophy) OR document that hard-cap is intentionally one-shot terminal. Recommend the former.
- **`ACTIVE_STATES` in `data-lifecycle/index.ts:62-70` mixes a sub-state into a task-state list.** Pre-existing typing bug. With D1's deletion of `SubStates.supervising`, the bad entry falls out — but the list still includes only task states. Verify the type narrows correctly after deletion.
- **Phase-runner adoption of retry-policy (D8) is technically cross-slice.** Phase-runner is Slice 8 territory. Adopting now means Slice 6 touches a file Slice 8 will redesign. Risk: Slice 8 may want a different shape. Mitigation: keep the change narrow — only the `LlmUnavailableError` catch block; signal the change to Slice 8 via the slice doc.
- **Cost-limit-queue adoption (D9) requires the terminate primitive to be ready first.** Within Slice 6 implementation order, the dispatch-tracker module must land before cost-limit-queue can adopt it. Plan must sequence Session 3 (dispatch-tracker + adoptions) deliberately.
- **`drainForShutdown` rewrite (D10) is the most concurrency-sensitive change.** Shutdown ordering matters: signal abort → wait cooperative → terminate → unsubscribe → close DB. Existing drain has tested edge cases (timeout per task in parallel via `Promise.allSettled`). The rewrite must preserve this — single timeout across all, not per-task multiplication.
- **Outcomes.preempted → terminated collapse (D11) ripples through phase-runner.** Phase-runner's checkpoint path (`phase-runner.ts:298-342`) emits `Outcomes.preempted`. Updating it to emit `Outcomes.terminated` with reason `"cooperative_preemption"` is a Slice 8-territory change. Same risk class as D8. Slice 6 ships the new outcome variant + scheduler routing; phase-runner update is a one-line return change that we can land cleanly inside Slice 6 (small, local, well-scoped).
- **Test deletions are large.** Substantial test files (decomposition-handler + integration + children-done = several hundred lines). Risk: an in-passing test for some unrelated behavior was buried in one of them. Mitigation: read each test file before deleting; lift any orphan coverage into the appropriate new home.
- **Dashboard breakage if SubState changes ship before Slice 15.** Backend deletion of supervising/integrating sub-states may cause the dashboard client to render undefined badges or filter mismatches. Mitigation: either (a) coordinate with Slice 15 to land the UI cleanup in the same window, or (b) verify dashboard tolerates unknown sub-state values gracefully. Recommend (b) for v1 — confirm via manual test during plan implementation.

### Open questions (for the plan / Farzam)

- **`failed → queued` transition for hard-cap victims** (risk above) — add the edge so `engineer retry` works on failed tasks, or document hard-cap as intentionally one-shot terminal?
- **Single `retry_policy` config block shape** — `retry_policy: { crash: { backoff_minutes: [...], max_attempts: N }, llm_unavailable: { ... } }` vs flat `retry.crash_backoff_minutes` / `retry.llm_unavailable_backoff_minutes`? Nested is more legible; flat is more conventional for Zod/YAML. Plan should pick.
- **Should `engineer retry` reset `not_before` too?** Today it does (`retry.ts:77`). New per-category counter resets need to preserve this. Verify in the plan that `not_before` is part of the reset set.
- **Hard-cap alert UX** — what does the owner-facing message say after a hard-cap fail? "Task X exceeded 8-hour cap, marked failed. Run `engineer retry X` to start fresh (after fixing the root cause)." Plan should specify exact wording — aligns with "universal audience" philosophy.

---

## Round 2 Grounding (deeper code reads after initial draft)

Initial research draft was thinner than this slice deserves. Round 2 surfaced concrete refinements that shape the implementation plan substantively.

### `abandonPending` is dead in production (refines D3)

**Files**: `src/core/daemon/preemption-manager.ts:39,202-211,217`

`abandonPending` is declared on the `PreemptionManager` interface (:39), implemented (:202-211), and returned (:217). Production callers: **zero** (`grep abandonPending src/` confirms). Only `tests/unit/core/daemon/preemption-manager.test.ts:263,277,290` references it. Pre-existing dead infrastructure that has nothing to do with Slice 6's main thrust — but since we're already touching preemption-manager, delete the method + interface entry + its two tests in Slice 6. Pure cleanup.

### Cost-limit-queue notification timing changes under D9 (refines D9)

**Files**: `src/core/daemon/cost-limit-queue.ts:32-65`, `tests/unit/core/daemon/cost-limit-queue.test.ts:32-66`

Today's flow inside `process()` is strictly synchronous: `requestTransition(blocked)` succeeds → `notifications.notify(cost_limit)` fires → `notifications.notify(ticket_comment)` fires. The test asserts this sequence (`expect.toHaveBeenCalledWith(...)` for the transition AND both notifications).

Under D9 with the terminate primitive, the transition becomes **async** (via the late callback routing through `Outcomes.terminated` reason `cost_limit_reached`). Two design choices:

- **Option A (recommended): Keep notifications IN `cost-limit-queue.process()`, immediate.** `dispatchTracker.terminate()` is fire-and-forget. The notifications fire right after (sync). Owner gets "cost limit hit, task being terminated" *now* — they need this signal independent of when the in-flight LLM call actually settles. State transition happens later via the late callback's routing.
- Option B: Move notifications into the `Outcomes.terminated` reason routing in scheduler. Notifications fire when the transition completes — but the owner is left in the dark for however long the in-flight LLM call takes to finish (potentially minutes).

Plan adopts Option A. Test assertion changes: `dispatchTracker.terminate` is called with the right reason, notifications fire immediately, and the state transition is verified via a separate path (the terminate routing's late callback or an integration test).

### Outcomes.preempted has exactly three production sites (refines D11)

**Files**: `src/core/orchestrator/types.ts:84,100`, `src/core/orchestrator/phase-runner.ts:344`, `src/core/daemon/task-scheduler.ts:410`, `src/core/daemon/index.ts:256`

Tight, well-bounded change:
- Type definition + variant: `types.ts:84` enum entry, `:100` discriminated union arm.
- Production: `phase-runner.ts:344` returns `{ outcome: "preempted", lastPhase, checkpointId }` from the cooperative checkpoint path. After D11: `{ outcome: "terminated", reason: "cooperative_preemption", lastPhase, checkpointId }`.
- Consumer: `task-scheduler.ts:410` `handlePreemptedOutcome`. After D11: routed via the new `Outcomes.terminated` reason switch.
- Coordination: `daemon/index.ts:256` clears pending preemption on `Outcomes.preempted`. After D11: triggers on `Outcomes.terminated` AND reason is `cooperative_preemption` OR `preemption_timeout`.

### Dual preemption mechanism — PreemptionGate (orchestrator) coexists with AbortSignal (dispatch-tracker)

**Files**: `src/core/orchestrator/index.ts:122-130`, `src/core/orchestrator/phase-runner.ts:797-820,918+`

The orchestrator already has its own `PreemptionGate` — a state container subscribed to the `preemption.requested` event, checked by the phase-runner between phase boundaries. This is the **cooperative path**: orchestrator yields at safe checkpoints.

Dispatch-tracker's `AbortSignal` is the **forced path**: when cooperation times out (double-timeout), `dispatchTracker.terminate(taskId, "preemption_timeout")` aborts the signal. Slice 6 ships best-effort here (signal set, no honoring yet). Slice 8 plumbs the signal through phase-runner → llm-caller → LLM plugins so the in-flight LLM call gets killed promptly.

**The two mechanisms work at different timescales and are complementary, not redundant:**
- PreemptionGate granularity: phase boundary (seconds to minutes between phases).
- AbortSignal granularity: mid-LLM-call (sub-second to seconds, once Slice 8 lands).

Both stay. PreemptionGate is untouched in Slice 6.

### Dashboard SubState surface — narrower than initially flagged (refines Slice 15 handoff)

**Files**: `src/dashboard/client/src/types/api.ts:14,31,53`, `src/dashboard/client/src/pages/tasks/task-overview-tab.tsx:23`, `src/dashboard/api/tasks.ts:19,27,46,77,341,365,370,377`

- **Client type literal** (`api.ts:14`): `export type SubState = "working" | "supervising" | "integrating" | "code"`. This is compile-time only. Update to `"working" | "code"` to match the post-Slice-6 enum. Trivial, can land in Slice 6 (the file is part of the source surface we're auditing).
- **Client rendering** (`task-overview-tab.tsx:23`): `{task.sub_state && <DetailRow label="Sub-state" value={task.sub_state} />}` — renders the raw string from the API. Will show `"supervising"` or `"integrating"` from any pre-deletion historical row, but does NOT crash. Defensive enough as-is; visual cleanup is Slice 15.
- **Server API** (`dashboard/api/tasks.ts`): treats `sub_state` as a `string | null` passthrough. No CHECK on read. No client-side filter on enum values. Server is agnostic to which sub_state values exist.

**Narrow Slice 6 work**: just update the client type literal in `api.ts:14`. No UI changes, no API changes. The "dashboard cleanup" handoff to Slice 15 stays — for visual treatment of the simplified state machine.

### Pre-existing dashboard bug (out of scope, flag only)

**Files**: `src/dashboard/api/tasks.ts:370-377`

The dashboard INSERTs into `state_transitions` using columns `from_sub_state, to_sub_state`. The migration declares the columns as `from_sub, to_sub`. **This INSERT would fail at runtime** (no such column). Either the path is unreachable or there's a wrapping `try { ... } catch {}` that swallows it. Not Slice 6 scope — flag for whoever owns dashboard cleanup (likely Slice 15).

### Test surface — concrete file list

**Files referencing symbols we're changing** (22 test files):

Full deletes (Session 1, T1.8):
- `tests/unit/core/orchestrator/decomposition-handler.test.ts` (~360 lines)
- `tests/unit/core/orchestrator/decomposition-handler.integration.test.ts`
- `tests/unit/core/daemon/index.children-done.test.ts` (423 lines)

Partial updates (Session 1 + Session 3):
- `tests/unit/core/daemon/task-scheduler.test.ts` (1095 lines — biggest update surface)
- `tests/unit/core/daemon/preemption-manager.test.ts` (310 lines)
- `tests/unit/core/daemon/index.test.ts` (1843 lines — biggest test file in the repo; broad scan needed)
- `tests/unit/core/daemon/cost-limit-queue.test.ts` (110 lines)
- `tests/unit/core/orchestrator/phase-runner.test.ts`
- `tests/unit/core/orchestrator/index.test.ts`
- `tests/unit/core/task-engine/state-machine.test.ts`
- `tests/unit/core/task-engine/index.test.ts`
- `tests/unit/core/task-engine/queries.test.ts`
- `tests/unit/schemas/task.test.ts`
- `tests/unit/schemas/ephemeral.test.ts`

Test helpers (Session 1):
- `tests/helpers/mock-factories.ts` — likely contains `makeMockTask` with decomposition fields.
- `tests/helpers/test-orchestrator.ts` — orchestrator scaffolding referencing decomposition.
- `tests/helpers/test-session-memory.ts` — possibly fixtures.

Lower-priority adjacent updates:
- `tests/unit/core/session-memory/{checkpoints,journal,sessions}.test.ts` — likely use sub_state/cascade in fixtures only.
- `tests/unit/db/database.test.ts` — possibly schema-validation checks.

Total surface: 3 full deletes (~1000 lines) + 19 partial updates (scoped — drop assertions about decomposition / supervising / integrating / cascade / preempted outcome).

### Test config exercises preemption (informs verification)

**Files**: `tests/unit/core/daemon/{task-scheduler,preemption-manager}.test.ts:19,11`

Both daemon test config helpers default `max_concurrent: 2` — preemption actually fires in tests, even though production default is 1. **The preemption tests aren't dead in test scope**; they exercise the real path. After D6's eligible-filter change, the existing 10 preemption tests need scoped updates (not deletes).

### Boot-loop scenario concreteness (informs D5)

**Files**: `src/core/daemon/index.ts:510-540,617`, `src/core/daemon/task-scheduler.ts:434-518`

Production deployment under systemd (or Docker/PM2/similar) auto-restarts the daemon on crash. Today's boot recovery transitions orphaned active tasks → queued *without backoff*. So:

1. Daemon dispatches Task A → Task A's orchestrator crashes the daemon (e.g., OOM in an LLM call).
2. systemd auto-restarts daemon.
3. Boot recovery finds Task A in active state → transitions to queued immediately.
4. Next tick dispatches Task A → crashes daemon again.
5. Loop infinitely until manual intervention.

D5 closes this hole: boot recovery calls `retryPolicy.recordFailure("crash", taskId)`, which increments `consecutive_crash_count` and applies backoff. After 5 crashes, the task is marked failed + alert. The owner is the circuit breaker, not infinite restarts.

Verification: integration test simulates 5 consecutive boot-recoveries on the same task → counter reaches 5 → task is failed.

### `taskEngine.updateTaskField` is generic — retry-policy uses it (informs D2)

**Files**: `src/core/task-engine/index.ts:365`

Comment: *"Scalar fields (phase, cascade_policy, session_id, description, source_text) are automatically serialized."* The `updateTaskField` method already handles arbitrary scalar fields. Adding `consecutive_llm_unavailable_count` as a new scalar field works through this existing API — no schema-mapper changes needed beyond the row-mapper entry. Cheap addition.

## Plan Implications (refining the initial draft)

1. **Session 3 sequence matters strictly.** Dispatch-tracker MUST land before any adopter (preemption, cost-limit, drain). Within Session 3, the task ordering is: T3.1 (Outcomes type) → T3.2 (phase-runner emits new variant) → T3.3 (priority bounds) → T3.4 (dispatch-tracker module) → T3.5 (Dispatch signal) → T3.6 (scheduler adopts) → T3.7 (preemption adopts + abandonPending delete) → T3.8 (preemption.ready delete) → T3.9 (cost-limit adopts, with notifications staying immediate) → T3.10 (drain rewrite) → T3.11 (docs) → T3.12 (commit).
2. **Session 1's T1.8 is larger than initially estimated.** Reading + updating ~3700 lines of test code carefully (and lifting any buried orphan coverage from the 3 full-deletes) is substantial. Bump estimate to ~75-90m for T1.8 alone.
3. **`abandonPending` delete added to Session 3 (T3.7)**. Trivial — drop interface entry, function body, two test cases.
4. **Dashboard client `SubState` type update added to Session 1 (T1.7)**. One-line type literal change. Slice 15 handoff narrows to just visual treatment.
5. **Cost-limit-queue test (D9 in T3.9) needs notification-timing assertion shift**. Test asserts `dispatchTracker.terminate` is called immediately, notifications fire immediately, state transition is verified via the terminate routing (separate code path, separate test).
6. **`task.children_all_done` event subscriber and handler delete (Session 1, T1.5)** removes ~90 lines from `daemon/index.ts`. Confirm grep finds no other subscribers before delete.
