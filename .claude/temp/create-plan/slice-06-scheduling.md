# Plan: Slice 6 — Scheduling & Dispatch

**Date**: 2026-05-23 | **Stakes**: Full (touches scheduler, state machine, retry semantics, and shutdown — the daemon's spine)
**Upstream**: `.claude/temp/research/slice-06-scheduling.md` | `docs/archived/implementation-docs/9-oss-ready/slices/06-scheduling.md`
**Status**: Panel-Reviewed (inline) — pre-mortem incorporated

## Intent

Bring the scheduling and dispatch spine to OSS standard by (a) deleting the operationally-dead
decomposition consumer surface in full, (b) replacing two parallel task-level retry tracks with a
single Core-owned retry-policy module, and (c) introducing a clean termination primitive so every
force-terminate scenario (preemption double-timeout, hard-cap, cost-limit, shutdown) routes through
one well-defined contract. The single most important reason: the daemon's spine has accumulated
silent contradictions (dead-but-wired consumer, lying field names, leaked promises, ad-hoc
force-transitions) that compound into operational fragility as the system scales. Slice 6 cleans the
spine.

## Decisions

### D1: Delete the decomposition consumer surface in full
**Choice**: Remove every part of the consumer side — task fields, sub-states, ValidTransitions,
permission table entries, the event, scheduler logic, daemon handler, data-lifecycle reference,
bundled config block, queries, schema definitions.
**Context**: The CLI-native planning phase has no producer for `decomposition_plan`. The mechanism
fires only in unit/integration tests that inject fake data. Maintaining a wired-but-unreachable
subsystem violates "honest code" and adds carrying cost for every future refactor.
**Rejected**:
- Keep consumer wired pending Slice 8 producer build — leaves dead code in Core indefinitely.
- Delete only the truly-orphan parts (cascade_policy enum's three unused values) — leaves the
  wired-but-unreachable supervising/integrating sub-states in place.
**Consequence**: Cross-slice handoffs to Slice 8 (orchestrator deletion + integration phase
re-evaluation) and Slice 15 (dashboard `SubState` UI cleanup). Restoration path is documented in
`docs/future-considerations.md`.

### D2: Single retry-policy module, per-category
**Choice**: New `src/core/retry-policy/` module. Categories `crash` and `llm_unavailable` each own
backoff schedule, ceiling, and terminal disposition. Per-category counter fields on the task row
(`consecutive_crash_count` keeps narrow meaning; new `consecutive_llm_unavailable_count` for the new
category). Backoff schedules and ceilings exposed as config under a new `retry_policy` block.
Single API: `retryPolicy.recordFailure(category, taskId)` returns the disposition. Both scheduler
and phase-runner go through this API.
**Context**: Two parallel retry tracks today share `consecutive_crash_count` (field name lies),
live in two files with a cross-boundary import (scheduler imports `MAX_LLM_UNAVAILABLE_RETRIES`
from phase-runner), and write to task-level state from inside the orchestrator (two writers).
**Rejected**:
- One counter, one backoff schedule — loses the "wait longer for external service" intent.
- Keep separate, just fix the cross-boundary import — leaves the field-name lie and two-writer smell.
**Consequence**: Adds DB column + Zod field + config schema entries. Phase-runner stops writing
task-level scheduling state directly; cross-boundary import removed.

### D3: Dispatch-tracker primitive with AbortController contract
**Choice**: New `src/core/dispatch-tracker/` module. Per-dispatch identity (`{ dispatchId, promise,
signal }` keyed by `taskId`). AbortController per dispatch; signal on the `Dispatch` object passed
to `orchestrator.executeTask`. `terminate(taskId, reason)` aborts the signal and tracks the reason.
Idempotent late callbacks (mismatched `dispatchId` → no-op). New `Outcomes.terminated` with typed
`reason` enum.
**Context**: Force-preemption today leaks the orchestrator promise; cost-limit-queue has the same
anti-pattern; `drainForShutdown` rolls its own teardown logic; preemption-manager reaches into
scheduler state via `removeActiveDispatch`. One primitive resolves all four.
**Rejected**:
- Full end-to-end AbortSignal plumbing (orchestrator + phase-runner + LLM plugins) in Slice 6 —
  bleeds into Slice 8 + Slice 16 territory, violates slice isolation.
- Idempotent late callbacks only, no primitive — Slice 13 inherits no mechanism, has to invent
  the shape later.
**Consequence**: Contract ships in Slice 6 with best-effort termination (signal set but in-flight
LLM call completes before honoring). Slice 8 plumbs signal through phase-runner → llm-caller →
LLM plugins to make termination fast.

### D4: max_active_duration_ms enforcement — terminate, fail, alert
**Choice**: Subscribe (inside Slice 6's daemon wiring) to the existing `health.stuck_detected`
event with `condition: "no_state_transition"`. Call `dispatchTracker.terminate(taskId,
"hard_cap_exceeded")`. Routes to `failed` + owner alert. Wall-clock time accounting from
`started_at` (blocked time counts). Existing stuck-staleness threshold (`stuck_threshold_ms`,
30 min) stays as warn-only.
**Context**: Today the cap is documented as a cap but implemented as a warning. Resource defense
requires actual termination.
**Rejected**:
- Terminal = `blocked` — invites repeated 8-hour cycles on the same poison task.
- Re-anchor `started_at` on unblock (count only active time) — adds state-machine complexity for
  marginal value.
- Stay warn-only, defer to Slice 13 — primitive sits unused for the hard-cap case.
**Consequence**: Health-monitor is untouched (Slice 13 boundary respected). Slice 6 just adds a
parallel subscriber.

### D5: Crash recovery unification through retry-policy
**Choice**: Both boot recovery (`rebuildStateFromTaskEngine`) and per-task crash (`handleTaskError`)
call `retryPolicy.recordFailure("crash", taskId)`. `consecutive_crash_count` carries across daemon
restarts (it's on the persistent task row). Closes the boot-loop hole — a task crashing the daemon
repeatedly under systemd auto-restart exhausts its budget and routes to `failed` + alert.
**Context**: Today boot recovery has no counter increment, no backoff, no ceiling — a poison task
can restart-loop the daemon forever.
**Rejected**:
- Boot recovery as "fresh start" (no counter touch) — leaves the boot-loop hole.
- Separate categories (`crash` vs `daemon_orphan`) — adds a category to avoid sharing a counter
  when the underlying event is the same.
**Consequence**: Counter carry-forward is the safety property. Owner alert names the poison task.

### D6: Preemption — keep, tighten three things
**Choice**: Keep preemption (it works, unlike decomposition). Three tightenings:
1. Preempter filters by eligibility before picking — uses `eligible[0]` not `queuedTasks[0]`. With
   D1 deleted, eligibility is just `not_before`.
2. Bound `priority` to `[1, 100]` in Zod schema (research correction from Q6's proposed `[0, 100]`
   — aligns with DB CHECK constraint and `event-variables.ts` comment).
3. Document one-per-tick as deliberate policy (in code comments + configuration doc).
Force-preemption uses `dispatchTracker.terminate(taskId, "preemption_timeout")` (#3). Dead
`preemption.ready` event deleted (zero subscribers).
**Context**: Preempter today picks blind, schema allows any int as priority (operator footgun),
one-per-tick is implicit not deliberate.
**Rejected**:
- Delete preemption entirely (YAGNI for v1 single-user) — unlike decomposition, preemption has a
  real producer and works today.
- Multi-per-tick — over-engineered for v1; cooperative timeouts are sequential anyway.
**Consequence**: Operators get bounded priorities and predictable preemption. Slot waste from
ineligible-candidate evictions stops.

### D7: Eligibility surfacing — minimal cleanup, no new plumbing
**Choice**: Delete vestigial parent/cascade branches in `isTaskEligible` (comes free with D1).
Document the eligibility model (slot + `not_before`, period) in a short doc paragraph. No new
events, no new query APIs.
**Context**: Post-D1, only one possible reason a queued task isn't dispatching (`not_before` in
future). Already on the task row, already visible to dashboard/CLI.
**Rejected**:
- Add a structured event when top-of-queue is skipped — pure noise when only one gate exists.
- Add a typed query for dispatch explanation — premature abstraction.
**Consequence**: Existing surfaces (dashboard, `engineer why`, debug logs) already render the data.

### D8: Phase-runner LLM-unavailable retry adopts retry-policy in Slice 6
**Choice**: Phase-runner's `LlmUnavailableError` catch path calls `retryPolicy.recordFailure(
"llm_unavailable", taskId)` instead of writing fields directly. Imports retry-policy from Core.
**Context**: Deferring to Slice 8 leaves two writers on the new per-category fields in the interim —
exactly the smell we're fixing.
**Rejected**:
- Defer to Slice 8 (same as D3 split) — leaves the field-write smell.
**Consequence**: Phase-runner change is narrow (one catch block). Cross-slice boundary respected
otherwise.

### D9: Cost-limit-queue adopts the terminate primitive in Slice 6
**Choice**: `cost-limit-queue.process()` calls `dispatchTracker.terminate(taskId,
"cost_limit_reached")`. Routes through `Outcomes.terminated` to `blocked`.
**Context**: Same anti-pattern force-preemption used to have. Adopting now means Slice 13 inherits
clean.
**Rejected**:
- Defer to Slice 13 — two teardown paths in the interim.
**Consequence**: One file change in cost-limit-queue. Cost is incurred until the in-flight LLM call
completes (best-effort, until Slice 8 lands signal honoring).

### D10: drainForShutdown adopts the terminate primitive
**Choice**: `drainForShutdown` becomes: abort all dispatch signals → wait `shutdown_timeout_ms` for
cooperative settle → terminate any still in-flight (routes to `queued` via `graceful_shutdown`
reason). Single teardown path across all force-terminate scenarios. `activeDispatches` cleanup
moves into dispatch-tracker.
**Context**: Today's bespoke `Promise.allSettled` race + manual transition logic is parallel
infrastructure to what dispatch-tracker provides.
**Rejected**:
- Keep current bespoke drain logic — two teardown paths.
**Consequence**: Shutdown is the most concurrency-sensitive change; verification is critical.

### D11: Collapse Outcomes.preempted into Outcomes.terminated
**Choice**: Drop `Outcomes.preempted`. Cooperative-vs-forced distinction captured in
`reason: "cooperative_preemption" | "preemption_timeout"`. Outcomes set shrinks from 6 to 5
(completed, review_pending, blocked, error, terminated).
**Context**: Both routed to `queued`. Reason field captures the semantic distinction.
**Rejected**:
- Keep separate — marginal observability gain for two routing paths.
**Consequence**: Phase-runner's checkpoint path emits `Outcomes.terminated` with reason
`"cooperative_preemption"` instead of `Outcomes.preempted`. One-line change in phase-runner.

### D12: engineer retry resets per-category counters and clears not_before
**Choice**: Existing reset (`consecutive_crash_count = 0`) extends to include
`consecutive_llm_unavailable_count = 0`. `not_before` already cleared (`UPDATE tasks SET ... not_before = NULL`).
**Context**: Owner-initiated retry is an explicit fresh-attempt signal. Per-category counter must
not pin the next dispatch one crash away from the ceiling.
**Rejected**:
- Preserve counters — surprising owner footgun.
- Reset only the exhausted category — more complex, requires retry.ts to reason about which
  ceiling triggered the failure.
**Consequence**: One additional `UPDATE` in `retry.ts` transaction.

### D13: Add `failed → queued` transition (research refinement)
**Choice**: Extend `ValidTransitions` with `{ from: failed, to: queued }`. Update `engineer retry`
to accept tasks in `failed` state in addition to `blocked`. Reason on the transition: `cli_retry`
(same reason today's blocked → queued uses).
**Context**: After D4, hard-cap exceeded → `failed`. `engineer retry` only works on blocked.
ValidTransitions has no `failed → queued` edge today. A task killed by hard-cap has no recovery
path — owner must start fresh. Inconsistent with D12's "owner intervention is reset point"
philosophy.
**Rejected**:
- Document hard-cap as one-shot terminal — owner UX cliff; aligns badly with the rest of the
  retry surface.
**Consequence**: `failed` is no longer strictly terminal. Behavior change in `engineer retry`.
Permission table for `failed` already allows `[communicate]` — no permission change needed.

## Scope Boundary

**Delivering**: D1–D13 — decomposition consumer deletion in full, retry-policy module + per-category
counters + phase-runner adoption + crash recovery unification, dispatch-tracker primitive +
AbortController contract + Outcomes.terminated routing + cost-limit + drain + preemption adoption,
hard-cap enforcement, eligibility cleanup + doc, priority bounds, dead `preemption.ready` deletion,
`engineer retry` per-category reset, `failed → queued` transition. Each with tests + docs.

**Deferring (designed here, executed elsewhere)**:
- Signal honoring inside the orchestrator (phase-runner → llm-caller → LLM plugins) — **Slice 8**.
  Best-effort termination is the interim state.
- Decomposition producer-side deletion (decomposition-handler.ts, planning prompt instruction,
  schema definitions) — **Slice 8**. Slice 8 should also re-evaluate whether the `integration`
  phase itself is dead.
- Dashboard UI cleanup for deleted sub-states and parent/child grouping — **Slice 15**.
- Notification-kind enumeration audit — **Slice 12**.
- Cost tracking and health-monitor internals — **Slice 13**. We only subscribe to their events.

## Task Breakdown

Sessions sized to ~250k tokens each (~400k worst case). Each session ships green at every commit.
Each ends with `pnpm run typecheck && pnpm run lint && pnpm test:all` passing.

### Session 1 — Decomposition consumer delete (D1)
*Delete the dead subsystem so subsequent sessions work on a clean spine. Largest pure-deletion session.*

- **T1.1 — Schema deletions** [~30m]. `src/schemas/task.ts`: drop `parent_id`/`children`/`cascade_policy`/`child_summaries` from `TaskSchema`. Delete `ChildEntrySchema`, `ChildCompletionSummarySchema`, `CascadePolicySchema` + `CascadePolicies`. Shrink `SubStateSchema` to `["working", "code"]`. Delete 8 `ValidTransitions` entries involving supervising/integrating. Delete supervising/integrating entries from `PermissionTable`. **Verify**: `pnpm run typecheck` — expect downstream compile errors that subsequent tasks resolve.
- **T1.2 — DB migration rewrite** [~20m]. `src/db/migrations/001_schema.sql`: drop the four columns from `tasks`, shrink CHECK constraints on `sub_state`, `from_sub`, `to_sub`. Drop `idx_tasks_parent_id`. **Verify**: fresh DB migrates clean — `rm -rf ~/.engineer-test/data && ENGINEER_HOME=~/.engineer-test pnpm dev start --help` smoke check.
- **T1.3 — Task engine cleanup** [~30m]. `queries.ts`: drop `getChildrenStmt` + `getChildren`. `row-mapper.ts`: drop the four field mappings + the schema imports. `index.ts`: drop column-type entries, INSERT columns, defaults, createTask handling. Drop `cascade_policy` from `CreateTaskInput` in `interfaces/task-engine.interface.ts`. **Verify**: typecheck.
- **T1.4 — Scheduler dead-code removal** [~30m]. `task-scheduler.ts`: shrink `isSlotConsuming` to drop integrating; gut `isTaskEligible` parent branch (now just `not_before`); drop `Outcomes.decomposed` handling in `handleTaskCompletion`; delete `checkAndEmitChildrenAllDone`; remove `checkAndEmitChildrenAllDone` from `TaskScheduler` interface and from the returned object. **Verify**: typecheck.
- **T1.5 — Daemon dead-code removal** [~25m]. `daemon/index.ts`: drop `task.children_all_done` event declaration from `EVENTS`, `daemon:children-done` subscription in `registerSubscriptions`, corresponding unsubscribe in `unregisterSubscriptions`, `handleChildrenAllDone` function (~90 lines). Adjust the `count` log in `registerSubscriptions` from `9` to `8` if hardcoded (avoid stale-counts — replace with array length if needed). Also drop the `scheduler.checkAndEmitChildrenAllDone` wiring from `reviewHandler` instantiation. **Verify**: typecheck + grep for any remaining `task.children_all_done` references.
- **T1.6 — Event schema cleanup** [~15m]. `schemas/events.ts`: drop `task.children_all_done` from `EventTypeSchema`, `EventPayloads`, `EVENT_PAYLOAD_SCHEMAS` map. Delete `TaskChildrenAllDonePayloadSchema` + the inferred type. **Verify**: typecheck.
- **T1.7 — Adjacent + dashboard cleanup** [~20m]. `data-lifecycle/index.ts:69`: drop `SubStates.supervising` from `ACTIVE_STATES` (typing bug falls out cleanly — list now contains only `TaskState` values). `cli/bundled/templates.ts`: delete `decomposition.auto_threshold_ms`/`suggest_threshold_ms` block (both the commented and active occurrences at :112-115 and :438-440). `dashboard/client/src/types/api.ts:14`: update `SubState` type literal to `"working" | "code"`. **Verify**: typecheck + bundled template renders without the dead block.
- **T1.8 — Test deletions + updates** [~75m, biggest task in Session 1]. Delete `tests/unit/core/orchestrator/decomposition-handler.test.ts` (~360 lines), `decomposition-handler.integration.test.ts`, `tests/unit/core/daemon/index.children-done.test.ts` (423 lines). **Read each before deleting**; lift any orphan coverage (e.g., behaviors that weren't really about decomposition but happened to live there) into the appropriate new home. Update the following with scoped removals (drop assertions about decomposition / supervising / integrating / cascade / `Outcomes.decomposed` only): `task-scheduler.test.ts` (1095 lines), `preemption-manager.test.ts` (310 lines — no decomposition references expected; verify), `index.test.ts` (1843 lines — scan carefully for children/cascade refs), `phase-runner.test.ts`, `orchestrator/index.test.ts`, `state-machine.test.ts`, `task-engine/{index,queries}.test.ts`, `schemas/{task,ephemeral}.test.ts`. Update test helpers (`tests/helpers/mock-factories.ts`, `test-orchestrator.ts`, `test-session-memory.ts`) to drop decomposition fields from mock task factories. **Verify**: `pnpm test:all` green.
- **T1.9 — Cross-slice handoff notes** [~10m]. Confirm `slices/06-scheduling.md` Cross-Slice Handoffs section lists the Slice 8 deletion targets (decomposition-handler.ts, planning prompt instruction, decomposition schemas, integration phase re-evaluation). Add session-1 commit hash to the slice doc when done. **Verify**: doc reads cleanly.
- **T1.10 — Commit** [~5m]. `/commit`. Single commit titled e.g. *"Slice 6 Session 1 — delete decomposition consumer in full"*.

**Session 1 verification gate**: `pnpm run typecheck && pnpm run lint && pnpm test:all` all green. Decomposition consumer surface gone. Manual dashboard smoke: load the dashboard on a fresh DB, confirm no UI crash. Historical state_transitions rows with supervising/integrating still render as raw strings (degrades gracefully).

**Session 1 sizing**: T1.1 + T1.8 dominate (~30m + ~75m = ~105m of focused work). The ~3700 lines of touched test code is the budget sink. Estimated ~250k tokens consumed.

### Session 2 — retry-policy module + phase-runner adoption + crash recovery unification (D2, D5, D8)
*One source of truth for retry semantics.*

- **T2.1 — Schema + DB additions** [~20m]. `schemas/task.ts`: add `consecutive_llm_unavailable_count: z.number().int().default(0)`. `001_schema.sql`: add `consecutive_llm_unavailable_count INTEGER NOT NULL DEFAULT 0` to `tasks`. `row-mapper.ts`: map the new field. **Verify**: typecheck + fresh DB migrates.
- **T2.2 — Config schema** [~25m]. `schemas/config.ts`: add `retry_policy` block under `DaemonConfigSchema`: per-category `{ backoff_minutes: z.array(z.number().int().positive()), max_attempts: z.number().int().positive() }` with defaults (`crash: [1,5,15,30,30]`, `llm_unavailable: [2,5,10,15,15]`, both `max_attempts: 5`). Update `cli/bundled/templates.ts` to document the new block. **Verify**: typecheck + config schema test parses defaults.
- **T2.3 — retry-policy module** [~45m]. `src/core/retry-policy/index.ts`: interface + factory. `recordFailure(category, taskId)` returns `{ disposition: "retry", not_before } | { disposition: "terminal", state: "failed" | "blocked" }`. Internal: read counter, increment, check ceiling, compute backoff, write counter + `not_before` via `taskEngine.updateTaskField`. Per-category terminal disposition (crash→failed, llm_unavailable→blocked). `recordSuccess(category, taskId)` resets the counter and clears `not_before`. **Verify**: unit tests in `tests/unit/core/retry-policy/index.test.ts` cover backoff schedule, ceiling, terminal routing, reset.
- **T2.4 — Scheduler adopts retry-policy** [~30m]. `task-scheduler.ts`: `handleTaskError` calls `retryPolicy.recordFailure("crash", taskId)` instead of computing backoff directly. `handleLlmUnavailableBlocked` calls the same with category `llm_unavailable`. `handleTaskCompletion` calls `retryPolicy.recordSuccess` for both categories on non-error outcomes. Delete the now-dead `BACKOFF_MINUTES`/`MAX_CRASH_RETRIES`/`computeBackoffMs`. Delete the import of `MAX_LLM_UNAVAILABLE_RETRIES` from phase-runner. **Verify**: typecheck + scheduler tests.
- **T2.5 — Phase-runner adopts retry-policy** [~25m]. `phase-runner.ts`: `LlmUnavailableError` catch calls `retryPolicy.recordFailure("llm_unavailable", taskId)`. Delete `LLM_RETRY_BACKOFF_MINUTES`, `MAX_LLM_UNAVAILABLE_RETRIES`, `computeLlmRetryBackoffMs`. Delete direct writes to `consecutive_crash_count` / `not_before`. **Verify**: typecheck + phase-runner tests.
- **T2.6 — Boot recovery adoption** [~20m]. `daemon/index.ts`: `rebuildStateFromTaskEngine` for each orphaned task calls `retryPolicy.recordFailure("crash", taskId)` before transitioning. If retry-policy returns terminal, transition straight to `failed` instead of queued. **Verify**: unit test for boot recovery — five orphaned tasks at crash_count=4 → after recovery, one is at count=5 and `failed`.
- **T2.7 — Docs** [~15m]. `configuration/daemon.md`: document the new `retry_policy` block. Architectural note in `architecture/overview.md` or new `architecture/scheduling-dispatch.md`: retry semantics live in one module, called by scheduler + phase-runner. **Verify**: docs render readable.
- **T2.8 — Commit** [~5m]. `/commit`. Single commit titled e.g. *"Slice 6 Session 2 — single retry-policy module, per-category"*.

**Session 2 verification gate**: typecheck + lint + tests green. Two writers on `consecutive_crash_count` are gone. Cross-boundary import scheduler ↔ phase-runner removed. Boot-loop hole closed.

### Session 3 — dispatch-tracker primitive + Outcomes.terminated + preemption tightening + drain + cost-limit (D3, D6, D9, D10, D11)
*The biggest session. Strict task ordering — primitive lands first, then every adopter follows in dependency order. Single commit at the end keeps it coherent.*

**Task ordering rationale (must execute in this sequence):**
T3.1 (Outcomes type) → T3.2 (phase-runner emits new variant — clears existing type) → T3.3 (priority schema bound — independent) → T3.4 (dispatch-tracker module — the primitive) → T3.5 (Dispatch signal contract — adapter shape) → T3.6 (scheduler adopts) → T3.7 (preemption adopts) → T3.8 (dead event delete) → T3.9 (cost-limit adopts) → T3.10 (drain rewrite) → T3.11 (docs) → T3.12 (commit).

- **T3.1 — Outcomes refactor** [~25m]. `orchestrator/types.ts`: drop `preempted` (D11 — `decomposed` already gone in Session 1). Add `terminated` variant: `{ outcome: "terminated"; reason: TerminationReason; lastPhase?: Phase; checkpointId?: string | null }`. Define `TerminationReason = z.enum(["cooperative_preemption", "preemption_timeout", "hard_cap_exceeded", "cost_limit_reached", "graceful_shutdown"])` exported as both type and `TerminationReasons` const. Update `ExecuteTaskResult` discriminated union. **Verify**: typecheck (expect compile errors in adopters — T3.2/T3.6 fix them).
- **T3.2 — Phase-runner emits terminated** [~15m]. `phase-runner.ts:344` (the cooperative checkpoint return): replace `return { outcome: "preempted", lastPhase: currentPhase, checkpointId: checkpoint.id }` with `return { outcome: "terminated", reason: "cooperative_preemption", lastPhase: currentPhase, checkpointId: checkpoint.id }`. **Verify**: typecheck + grep `Outcomes.preempted` returns nothing in src/.
- **T3.3 — Priority schema bounds** [~10m]. `schemas/task.ts:238`: `priority: z.number().int().min(1).max(100).default(50)`. Research correction: `[1, 100]` matches DB CHECK and the `event-variables.ts` comment. **Verify**: schema test asserts both rejection of out-of-bounds and acceptance of default 50.
- **T3.4 — dispatch-tracker module** [~75m, the centerpiece]. `src/core/dispatch-tracker/index.ts`: interface + factory.
  - State: `Map<string, { dispatchId: string; promise: Promise<ExecuteTaskResult>; signal: AbortSignal; controller: AbortController; terminationReason: TerminationReason | null }>` keyed by `taskId`.
  - `register(taskId, runDispatch: (signal: AbortSignal) => Promise<ExecuteTaskResult>)`: creates AbortController, captures `dispatchId = ulid()`, stores entry, calls `runDispatch(signal)`, attaches a `.then` that resolves the late callback **only if the entry's dispatchId still matches** (idempotency).
  - `terminate(taskId, reason)`: looks up entry; if none, no-op; if found, sets `terminationReason`, calls `controller.abort()`. The late callback, when it eventually resolves, sees the reason and produces an `Outcomes.terminated` result.
  - `isInFlight(taskId)`, `getActiveTaskIds()`: simple lookups.
  - `drain(timeoutMs)`: snapshot all entries, abort all signals in parallel, `Promise.allSettled(promises)` with a SHARED timeout (single `Promise.race` against one timer), then for any still-unsettled entries terminate them and clear state.
  - **Idempotency property**: if a new register happens for the same taskId after termination (e.g., the task gets re-dispatched while the old callback is still pending), the old callback's dispatchId mismatch causes it to no-op. New dispatch's lifecycle is untouched.
  - **Verify**: unit tests in `tests/unit/core/dispatch-tracker/index.test.ts` covering: register + normal completion, terminate + late settle (idempotency), terminate before settle then re-register same taskId (old callback no-ops on new entry), drain with stragglers, drain with empty map, terminate non-existent taskId.
- **T3.5 — Dispatch signal contract** [~15m]. `schemas/ephemeral.ts`: add `signal: AbortSignal` to `Dispatch` shape. `orchestrator/types.ts` + `index.ts`: `executeTask(dispatch: Dispatch)` accepts dispatch with signal — orchestrator stores it on its internal context but does not act on it yet (Slice 8 plumbs through phase-runner → llm-caller → plugins). **Verify**: typecheck + orchestrator unit test passes Dispatch with mock signal.
- **T3.6 — Scheduler adopts dispatch-tracker** [~55m]. `task-scheduler.ts`:
  - Remove local `activeDispatches: Map`; replace with `dispatchTracker` dependency injected via context.
  - `dispatchTask`: build the Dispatch object (including a fresh AbortController's signal from dispatch-tracker), call `dispatchTracker.register(taskId, (signal) => orchestrator.executeTask({ ...dispatch, signal }))`.
  - `handleTaskCompletion`: becomes the idempotent late callback. First check via `dispatchTracker.isInFlight(taskId)` whether this is still the active dispatch; if not, no-op.
  - Add `Outcomes.terminated` routing branch: switch on `result.reason`:
    - `cooperative_preemption` | `preemption_timeout` → `requestTransition(queued, reason)`
    - `hard_cap_exceeded` → `requestTransition(failed, "hard_cap_exceeded")` + alert notification
    - `cost_limit_reached` → `requestTransition(blocked, "cost_limit_reached")` (notifications already fired immediately by cost-limit-queue — see T3.9)
    - `graceful_shutdown` → `requestTransition(queued, "graceful_shutdown")`
  - `getActiveTaskIds` delegates to `dispatchTracker.getActiveTaskIds()`.
  - Remove `removeActiveDispatch` from `TaskScheduler` interface and from returned object.
  - `BACKOFF_MINUTES`, `MAX_CRASH_RETRIES`, `computeBackoffMs` — already deleted in Session 2 (moved into retry-policy). Verify they don't reappear.
  - **Verify**: `task-scheduler.test.ts` updates: existing "handleTaskCompletion on completed" + "on review_pending" + "on blocked" + "on error" tests stay; new tests cover `Outcomes.terminated` routing per reason; "idempotent late callback after re-dispatch" test added.
- **T3.7 — Preemption-manager adopts dispatch-tracker + eligible filter + abandonPending delete** [~40m]. `preemption-manager.ts`:
  - `findAndInitiatePreemption`: filter `queuedTasks` by `isTaskEligible` (exported from scheduler for reuse) before taking `[0]`. With Session 1's eligibility shrink, `isTaskEligible` is just the `not_before` check.
  - `checkPreemptionTimeout` second-timeout path: replace `requestTransition(queued, "preemption_timeout")` + `removeActiveDispatch(targetTaskId)` with `dispatchTracker.terminate(targetTaskId, "preemption_timeout")`. The terminate routing in scheduler handles the transition.
  - Delete `abandonPending` from interface, function body, and the returned object. Zero production callers (research confirmed). Drop the two `abandonPending` tests from `preemption-manager.test.ts`.
  - Drop `removeActiveDispatch` parameter from `createPreemptionManager` — no longer needed.
  - Add explicit code comment: `/** Policy: one preemption per tick — cooperative-then-forced timeout is sequential by nature. */` above `evaluate`.
  - **Verify**: existing 8 preemption tests (after dropping the 2 abandonPending ones) updated for: terminate-routing assertion in double-timeout test, eligible-filter behavior (preempter picks `eligible[0]` not `queuedTasks[0]` when top is ineligible — new test).
- **T3.8 — Dead preemption.ready event delete** [~15m]. `phase-runner.ts:333-342`: delete the entire publish block. `schemas/events.ts`: drop `preemption.ready` from `EventTypeSchema`, `EventPayloads`, `EVENT_PAYLOAD_SCHEMAS`. Delete `PreemptionReadyPayloadSchema` + the inferred type. **Verify**: `grep preemption.ready src/` returns nothing.
- **T3.9 — Cost-limit-queue adopts terminate** [~25m]. `cost-limit-queue.ts:38-63`: replace `taskEngine.requestTransition(blocked, "cost_limit_reached", "daemon")` with `dispatchTracker.terminate(taskId, "cost_limit_reached")`. **Keep both `notifications.notify` calls in cost-limit-queue (immediate)** — the owner must know the limit was hit synchronously, not when the in-flight LLM call eventually settles. The state transition is async via the terminate routing. **Verify**: `cost-limit-queue.test.ts` updates: assert `dispatchTracker.terminate` called with `("task-1", "cost_limit_reached")`; assert both notifications still fire immediately; add a separate integration-style test (or scheduler unit test) verifying the terminate routing eventually transitions the task to blocked.
- **T3.10 — drainForShutdown rewrite** [~35m]. `task-scheduler.ts:577-639`: delete the bespoke `Promise.allSettled` + manual transition logic. Replace with `await dispatchTracker.drain(config.shutdown_timeout_ms)`. The terminate routing for `graceful_shutdown` reason handles the queued transitions for stragglers. **Critical: SHARED timeout (single race against one timer), not per-dispatch multiplication.** Worst-case shutdown time stays at `shutdown_timeout_ms`, not `shutdown_timeout_ms × N`. Add an integration test in `tests/integration/daemon/shutdown.test.ts` (or extend existing) that simulates N stuck dispatches and asserts drain returns within `shutdown_timeout_ms + small buffer`.
- **T3.11 — Documentation** [~25m]. `configuration/daemon.md`: document the priority bounds, the preemption policy (one-per-tick — deliberate), the `Outcomes.terminated` reason routing table. Create `docs/architecture/scheduling-dispatch.md` (new): one-pager covering the dispatch lifecycle, the eligibility model (slot + not_before), the dispatch-tracker primitive, the reason routing. Cross-link from `architecture/overview.md`. **Verify**: docs render readable; cross-references resolve.
- **T3.12 — Commit** [~5m]. `/commit`. Single commit titled e.g. *"Slice 6 Session 3 — dispatch-tracker primitive + terminated routing + preemption tightening"*.

**Session 3 verification gate**: typecheck + lint + tests green. `grep Outcomes.preempted src/` returns nothing. `grep removeActiveDispatch src/` returns nothing. `grep abandonPending src/` returns nothing (production only — tests already pruned in T3.7). Force-preemption + cost-limit + drain all route through one primitive. Eligible filter prevents wasted evictions. Priority bounds enforced.

**Session 3 sizing**: T3.4 (~75m) + T3.6 (~55m) + T3.7 (~40m) + T3.10 (~35m) dominate. The 1095-line `task-scheduler.test.ts` and the new dispatch-tracker test file are the test surface. Estimated ~350k tokens consumed (highest of the four sessions — sits in the "if really necessary" band of the budget).

### Session 4 — hard-cap enforcement + engineer retry + failed→queued transition + final docs (D4, D7, D12, D13)
*Tie up enforcement + UX surfaces. Smallest session.*

- **T4.1 — failed → queued transition** [~10m]. `schemas/task.ts`: add `{ from: TaskStates.failed, to: TaskStates.queued }` to `ValidTransitions`. **Verify**: state-machine test for the new transition.
- **T4.2 — engineer retry per-category reset + failed support** [~25m]. `cli/commands/retry.ts`: extend the early-return check to accept both `blocked` and `failed`. Inside the transaction, add `UPDATE tasks SET consecutive_llm_unavailable_count = 0 WHERE id = ?`. Update success message to reflect the source state. **Verify**: `tests/unit/cli/commands/retry.test.ts` covers blocked and failed cases.
- **T4.3 — Hard-cap subscriber** [~20m]. `daemon/index.ts:registerSubscriptions`: add a new subscription on `health.stuck_detected` filtered by `condition === "no_state_transition"` that calls `dispatchTracker.terminate(taskId, "hard_cap_exceeded")`. The existing notification subscriber keeps firing the alert (defense in depth — owner gets the alert *and* the termination). **Verify**: integration test — task with stale `started_at` past max_active_duration_ms gets terminated and routed to failed.
- **T4.4 — Eligibility doc paragraph** [~10m]. Confirm `isTaskEligible` post-D1 is the one-liner. Add a small section in `configuration/daemon.md` or `architecture/scheduling-dispatch.md` titled "Eligibility model": *"A queued task is eligible to dispatch when (a) a slot is available, and (b) its `not_before` timestamp is past. There are no other gates."* **Verify**: doc reads cleanly.
- **T4.5 — Final doc sweep** [~25m]. `architecture/overview.md`: refresh scheduling section. `configuration/daemon.md`: confirm `retry_policy`, `max_active_duration_ms` behavior change, preemption documentation. `cli.md`: update `engineer retry` description (per-category reset, works on failed too). `bundled/templates.ts`: verify all config defaults match Zod defaults (no drift). **Verify**: read every changed doc end-to-end.
- **T4.6 — Hard-cap alert wording** [~10m]. `daemon/index.ts`: the existing `daemon:health-stuck` subscriber's message — confirm it's actionable when the task is now being terminated. New copy: *"Task \"{title}\" exceeded {threshold} minutes of total active time and was marked failed. Run `engineer retry {taskId}` after addressing the root cause."* **Verify**: tests asserting message format.
- **T4.7 — Commit** [~5m]. `/commit`. Single commit titled e.g. *"Slice 6 Session 4 — hard-cap enforcement + retry surface refresh"*.

**Session 4 verification gate**: typecheck + lint + tests green. Hard-cap actually enforces. `engineer retry` works on failed tasks. Docs reflect the slice's final shape.

### Session 5 — Closing standards sweep
*The quality gate that closes the slice. Pattern from Session 22 (Slice 5).*

- **T5.1 — File inventory** [~15m]. `git diff <slice-6-start>..HEAD` to enumerate every file Sessions 1–4 created or changed. Tier them: Tier 1 (Slice 6 core surface), Tier 2 (mechanically touched).
- **T5.2 — Line-by-line audit per file** [time depends on diff size]. Apply the principle-driven checks from `approach.md` § Closing Standards Sweep (every documented reference matches code; every manifest matches behavior; every swallowed error is logged; `manifest` is read-only to plugins; every constant lives in one place; no stale counts; no vestigial scaffolding). Also apply the standards docs (`coding-standards.md`, `anti-patterns.md`, `philosophy.md`) end-to-end.
- **T5.3 — Refactor defects** as they're found. Each fix is its own commit titled e.g. *"Slice 6 sweep — \<defect description\>"*. Mirror Session 22's approach.
- **T5.4 — Update memory** when the sweep finds something new that future sweeps should hunt for. Append to `feedback_slice_closing_standards_sweep.md`.
- **T5.5 — Close the slice**: move it from "Current" to "Completed Slices" in `active.md`. Write the closing entry one line: *"Slice 6 — Scheduling & Dispatch: dispatch-tracker primitive, retry-policy unification, decomposition consumer deleted, hard-cap enforcement, preemption tightening, dead preemption.ready removed, failed→queued transition."*

**Session 5 verification gate**: full audit complete, every defect addressed, slice marked done.

## Verification Contract

| Check | Type | Command or Observation |
|-------|------|----------------------|
| Types compile | Auto | `pnpm run typecheck` |
| Lints clean | Auto | `pnpm run lint` |
| Unit + integration + e2e | Auto | `pnpm test:all` |
| Fresh DB migrates | Manual | `rm -rf ~/.engineer-test/data && ENGINEER_HOME=~/.engineer-test pnpm dev start` (smoke) |
| Boot-loop closed | Auto | Integration test: orphaned task at crash_count=4 → after rebuildStateFromTaskEngine, count=5 + state=failed |
| Hard-cap enforces | Auto | Integration test: task with `started_at` past cap → terminated → state=failed |
| Force-preemption no leak | Auto | Unit test: terminate(taskId, preemption_timeout) → late callback fires → state already moved → no-op |
| Cost-limit termination routes correctly | Auto | Unit test: cost-limit-queue.process → terminate fires → routes to blocked |
| Drain completes within timeout | Auto | Integration test: shutdown with N active dispatches → drain returns within timeout, all transitioned to queued |
| `engineer retry` works on failed | Manual | After hard-cap kills a task: `engineer retry <id>` → state=queued, counters=0 |
| Dashboard degrades gracefully | Manual | Open dashboard with a task that had a deleted sub-state in history → renders without crash |

## Risks

| Risk | If It Happens | Mitigation |
|------|--------------|------------|
| Dashboard renders supervising/integrating from historical state_transitions | UI crash / undefined badge | Verify dashboard's SubState rendering tolerates unknown values; if not, ship a tiny defensive fallback in client (not Slice 15 work, just a one-line type-narrowing) |
| Phase-runner `Outcomes.terminated` change (T3.2) ripples to other phase-runner consumers we miss | Compile error or runtime case-miss | `grep -rn "Outcomes.preempted" src/` after T3.2 to catch every site; typecheck is the safety net |
| `drainForShutdown` rewrite introduces a shutdown hang | Daemon won't stop cleanly under `engineer stop` | Integration test asserts drain returns within timeout even when all dispatches refuse to settle (signal-only honoring via stub orchestrator). Manual smoke: `engineer start` → kick off a task → `engineer stop` → daemon exits within `shutdown_timeout_ms + 5s` |
| Cost-limit-queue adoption changes the exact timing of cost-limit notifications (was synchronous transition + notify in tick; now async terminate routing) | Owner gets two notifications or none | Test asserts exactly one `cost_limit` notification fires per termination event; verify with mock NotificationRouter |
| Failed → queued transition opens a recovery path the safety layer didn't anticipate | Owner retries a hard-cap victim, it crashes daemon, hits hard-cap again — endless cycle | crash retry policy from D5 catches it at counter=5 → failed. Owner's manual retry intentionally resets — same trade-off D12 already locked. Document in `engineer retry --help`. |
| Pre-existing test imports of deleted types fail in unrelated suites | Test files outside the obvious scope start failing | `pnpm test:all` is the dragnet; T1.8 enumeration covers the obvious; surprises get a follow-up commit during the session |
| Phase-runner change (T2.5, T3.2) crosses into Slice 8 territory | Slice 8 may want different shape later | Keep the change narrow and local (one catch block in T2.5, one return statement in T3.2). Surface the change explicitly in the cross-slice handoff list in slices/06-scheduling.md |

## Panel Review (inline stress-test)

**Panelists** (simulated): Systems Engineer, Reliability Engineer, API Designer, Operator.

**Systems Engineer — state machine invariants**
- *"After D1, every transition in ValidTransitions is reachable from the queued state via at most one dispatch cycle?"* — Yes: queued → working → {completed, blocked, review_pending.code, queued (via terminate), failed}. The integrating sub-state is gone; review_pending.code is reached directly from working. Cycle closes cleanly.
- *"D13 (failed → queued) opens a back-edge in what was a DAG. Does this break any invariant?"* — Only the "failed is terminal" invariant, which is explicitly being relaxed for owner-initiated retry. The state-machine validation already supports the new edge once added to ValidTransitions. **No structural concern.**

**Reliability Engineer — failure modes**
- *"What if `dispatchTracker.terminate` is called for a taskId not in flight?"* — Should be a no-op (the dispatch is already settled or never existed). Add this to T3.4 test coverage.
- *"What if signal.abort fires during the very narrow window between dispatchTask creating the AbortController and the orchestrator promise actually settling cleanly?"* — Late callback fires with `outcome: terminated` AND a real outcome (e.g., `completed`) could race. **Decision: dispatch-tracker treats the first settle as authoritative; subsequent ones are no-ops.** This is the idempotency property already in D3. Add to T3.4 test coverage explicitly.
- *"Boot recovery + retry-policy: what if `consecutive_crash_count` is corrupt (negative, NaN, missing)?"* — Zod schema validates on load; default is 0; corrupt rows fail row-mapper validation loud (existing behavior). **No new risk.**
- *"Hard-cap subscriber + cooldown gating: does the hard-cap terminate get gated by the same notification cooldown as the alert?"* — No, they're separate subscribers. The notification subscriber gates; the terminate subscriber is unconditional. **Good — termination should not be rate-limited.**

**API Designer — dispatch-tracker contract**
- *"Should `terminate` return a promise that resolves when the dispatch actually settles?"* — Today's plan: fire-and-forget (`void` return). For the v1 best-effort scope this is fine — callers don't need to wait. Slice 8's signal honoring will make termination fast enough that synchronous-feeling becomes the norm. **No change for v1.**
- *"Is `recordSuccess` symmetric to `recordFailure`?"* — Yes, retry-policy exposes both. Scheduler's `handleTaskCompletion` calls `recordSuccess` for both categories on non-error outcomes (already in T2.4). Documented in module surface.
- *"Should the reason enum be open (string) for plugin extensibility?"* — No. Per Plugin Blindness, the reason field is Core-internal. Plugins don't trigger terminations. Keep the Zod enum closed — additions are deliberate decisions, not plugin-author extensions.

**Operator — UX consequences**
- *"Owner sees a task in `failed` state. Today they can't do anything. After D13 they can run `engineer retry`. Is the discoverability good?"* — The alert message (T4.6) names the command explicitly: *"Run `engineer retry {taskId}` after addressing the root cause."* `engineer retry --help` should also mention it works on both `blocked` and `failed`. Add to T4.2 verification.
- *"What does `engineer status` show for a task in failed state?"* — Existing behavior unchanged. Add to T4.6 (sweep): confirm `engineer status` distinguishes failed from blocked appropriately.
- *"After cost-limit-queue adoption (D9), what's the timing? Will the owner see the cost-limit notification before or after the task actually settles?"* — `terminate` is fire-and-forget; the alert from the terminate routing fires when the late callback resolves (best-effort = whenever the in-flight LLM call finishes). For v1 this is acceptable; Slice 8's signal honoring will make it instantaneous. Document in cost-limit notification copy.

### Pre-mortem — three most likely failure scenarios

1. **Pre-mortem: Drain hangs on shutdown.** Cause: a dispatch's late callback awaits something that hangs (e.g., observer flush, evaluation manager). Mitigation: dispatch-tracker.drain uses `Promise.allSettled` with a hard shared timeout, not `Promise.all`. Stragglers get terminated regardless. Integration test (T3.10 verify) asserts drain returns within `shutdown_timeout_ms + small buffer`.
2. **Pre-mortem: A test in the unrelated `daemon/index.test.ts` suite imports a deleted decomposition type and silently no-ops in CI.** Cause: stale type re-export somewhere. Mitigation: typecheck is the hard gate (deleted types fail compilation). Lint includes `noUnusedImports`. T1.8's grep-before-delete catches the obvious cases.
3. **Pre-mortem: Two writers on `consecutive_crash_count` survive because boot recovery still increments directly via taskEngine.** Cause: T2.6 changes the wrong code path or the order of operations. Mitigation: integration test for boot recovery (T2.6 verify) asserts the counter passes through `retryPolicy.recordFailure`, not direct `updateTaskField`. Grep for `consecutive_crash_count` writers after Session 2 — only retry-policy should appear.

## References

- Requirements: `docs/archived/implementation-docs/9-oss-ready/slices/06-scheduling.md`
- Research: `.claude/temp/research/slice-06-scheduling.md`
- Approach: `docs/archived/implementation-docs/9-oss-ready/approach.md`
- Prior slice for shape: `docs/archived/implementation-docs/9-oss-ready/slices/05-trigger.md`
- Closing-sweep precedent: `docs/archived/implementation-docs/9-oss-ready/sessions/22.md`
