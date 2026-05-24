# Slice 6: Scheduling & Dispatch

## Requirements

Gathered through Q&A (Session 24). Code reality verified through direct grounding of every
related flow; deep research saved to `.claude/temp/research/slice-06-scheduling.md` with
exact file paths and line numbers per decision area. Implementation plan saved to
`.claude/temp/create-plan/slice-06-scheduling.md`.

### Scope Framing

This is an **audit / refactor / complete + delete** slice. The scheduling and dispatch
flow exists, runs in production, and is exercised by the e2e suite. Slice 6 hunts dead
code, fixes structural smells (cross-boundary imports, two writers on one field,
silent state mutations), unifies two parallel retry tracks, builds a clean termination
primitive, and removes the operationally-dead decomposition subsystem.

Two halves:

1. **The scheduler and dispatch surface** — `task-scheduler.ts`, `preemption-manager.ts`,
   the daemon tick wiring, the retry/backoff policy, the dispatch-promise lifecycle, and
   crash recovery.
2. **The decomposition consumer surface** — operationally dead because the producer was
   never built. Removed in full from v1. See `docs/future-considerations.md`.

Out of scope (handed off to other slices):

- Workspace lifecycle, cleanup, evaluation triggering → Slices 7 / 11 / 13
- Phase pipeline mechanics, signal honoring inside the orchestrator → Slice 8
- PR / review / feedback handlers → Slices 9 / 10
- Notification routing, response polling, query handling → Slice 12
- Health monitor internals, cost tracking internals → Slice 13
- Dashboard UI cleanup for deleted sub-states / parent-child views → Slice 15

### Goals (priority order)

1. **Honest code.** Delete the operationally-dead decomposition consumer in full,
   including its blast radius across schemas, state machine, events, permissions,
   queries, migration, and bundled templates.
2. **Single retry policy.** Replace two parallel task-level retry tracks
   (`BACKOFF_MINUTES` in scheduler, `LLM_RETRY_BACKOFF_MINUTES` in phase-runner) with
   one per-category policy module owned by Core. Per-category counter fields. Config-
   driven backoffs and ceilings. One writer per field.
3. **Clean termination primitive.** Replace ad-hoc force-transition + leaked-promise
   patterns with a dispatch-tracker that owns active-dispatch lifecycle, exposes a
   single `terminate(taskId, reason)`, and makes late callbacks idempotent. The
   AbortController contract is plumbed at the daemon and Dispatch boundary; signal
   honoring inside the orchestrator and plugins is Slice 8.
4. **Resource-defending enforcement.** Make `max_active_duration_ms` a real hard cap
   that terminates and fails the task, not a warn-only signal. Close the boot-loop hole
   in crash recovery so a poison task can't restart-loop the daemon forever.
5. **Tightened preemption.** Filter ineligible candidates before picking. Bound
   `priority` to a stated range so operator-supplied values are validated. Document
   one-per-tick as deliberate policy.
6. **Docs and tests in sync.** Every changed surface gets corresponding docs. Tests for
   dead code get deleted. New tests for new modules.

## Decisions

### #1 — Delete the decomposition consumer surface in full

Decomposition is operationally dead. The CLI-native planning phase has no producer for
the structured `decomposition_plan` the consumer expects, so `handleDecomposition()`
returns `null` on every real task. The mechanism only ever fired in unit and integration
tests that injected fake data. Rather than maintain a wired-but-unreachable subsystem,
delete the whole consumer side. Future restoration roadmap is documented in
`docs/future-considerations.md` § "Task Decomposition (Parent → Children)".

**Blast radius inside Slice 6:**

- **Task schema** — delete `parent_id`, `children`, `cascade_policy`, `child_summaries`
  fields. Delete `ChildEntrySchema`, `ChildCompletionSummarySchema`, `CascadePolicySchema`.
  `SubStateSchema` shrinks from `working | supervising | integrating | code` to
  `working | code`.
- **ValidTransitions** — delete every entry involving `supervising` or `integrating`
  sub-states.
- **Permission table** — delete entries for `supervising` and `integrating`.
- **Database migration** — rewrite `001_schema.sql` to drop the dead columns and the
  removed sub-state values from CHECK constraints (per universal rule "consolidate
  migrations").
- **Task engine** — delete the `getChildren` query method and its prepared statement.
  Remove parent/children/cascade handling from `createTask`.
- **Scheduler** — drop parent-state and cascade branches from `isTaskEligible`. Drop
  the `integrating` branch from `isSlotConsuming`. Delete `checkAndEmitChildrenAllDone`.
  Remove the `Outcomes.decomposed` branch in `handleTaskCompletion`.
- **Daemon** — remove the `task.children_all_done` event declaration, the
  `daemon:children-done` subscription, and the `handleChildrenAllDone` function.
- **Events** — delete `task.children_all_done` from the event type enum, payload schemas,
  and registration map.
- **Data lifecycle** — remove the `SubStates.supervising` reference in
  `data-lifecycle/index.ts` (small exclusion list cleanup).
- **Bundled templates** — delete the `decomposition.auto_threshold_ms` /
  `suggest_threshold_ms` config block (already unread).

**Cross-slice handoffs created by this deletion:**

- **→ Slice 8 (RRPIR phases):**
  - Strip the decomposition instruction from the planning prompt
    (`prompts/planning.ts`) — cosmetic prose, separate from the schema deletion.
  - Re-evaluate whether the `integration` phase itself is dead — its prompt
    (`prompts/integration.ts`) and `prompts/demo-prep.ts` still cite decomposition as
    its reason to exist; both references are prose only after Session 1.
  - Re-evaluate `IntegrationOutputSchema` (`schemas/orchestrator.ts`) if the
    integration phase is dropped.
  - Re-evaluate `sessions.end_reason = 'decomposed'` (DB CHECK in `001_schema.sql`)
    and `SessionEndReasons.decomposed` (`schemas/session-memory.ts`). After
    `decomposition-handler.ts` was deleted in Session 1 these became unused — left in
    place this session because no producer is left writing them and the call site is
    gone, but they fail the no-vestigial-scaffolding check.
  - Re-evaluate `Phases.integration` enum entry once the phase itself is dropped.
- **→ Slice 15 (dashboard revisit):** the dashboard client `SubState` type now
  matches the Core enum (`"working" | "code"`), the server stops sending
  `parent_id`/`children`/`child_summaries`, and `task-overview-tab.tsx` no longer
  renders Parent Task. Remaining UI cleanup for visual treatment of the simplified
  state machine (badges, filters, parent/child grouping) stays in Slice 15.

**Session 1 deviation from this list (recorded for the next session to absorb):**

The plan deferred all orchestrator-side decomposition deletions to Slice 8, but
typecheck against the deleted Task schema fields forced Session 1 to pull the
mechanical deletions in: `decomposition-handler.ts` (entire file),
`handleDecomposition` call site in `phase-runner.ts`, `DecompositionHandler` wiring
in `orchestrator/index.ts`, `Outcomes.decomposed` enum entry + `ExecuteTaskResult`
variant in `orchestrator/types.ts`, `decomposition_plan` in `PlanningOutputSchema`,
and the `DecompositionChildSchema` / `DecompositionPlanSchema` /
`LLMDecompositionPlanSchema` definitions in `schemas/orchestrator.ts`. The
remaining Slice 8 items above (prompt prose, integration phase re-evaluation,
session-end reason cleanup) stayed out of scope. The "8 ValidTransitions" count in
D1's first paragraph also undercounted by two — the actual delete set was 10, all
genuinely involving supervising/integrating.

### #2 — Single retry-policy module, per-category

Two task-level retry tracks coexist today with three structural smells: they share one
counter field (`consecutive_crash_count`) which makes the field name lie; they live in
two files that import across the daemon ↔ orchestrator boundary; and they write to
task-level scheduling state from inside the orchestrator. Replace both with a single
policy module in Core.

- **Location:** `src/core/retry-policy/`.
- **Categories (today):** `crash`, `llm_unavailable`. Each category owns its backoff
  schedule (array of minutes), ceiling, and terminal disposition (`failed` for crash,
  permanent `blocked` for llm_unavailable).
- **Counter storage:** per-category fields on the task row. `consecutive_crash_count`
  keeps its name (semantics narrow to crash-only); new
  `consecutive_llm_unavailable_count` field for the other track.
- **Config:** backoff schedules and ceilings move into `daemon.yaml` under a new
  `retry_policy` block. Defaults preserve today's behavior
  (crash `[1, 5, 15, 30, 30]`, llm_unavailable `[2, 5, 10, 15, 15]`, both five-retry
  ceilings).
- **API:** `retryPolicy.recordFailure(category, taskId)` returns the disposition
  (retry with `not_before` set, or terminal with the routed state). Scheduler and
  phase-runner both go through this API — no direct field writes from outside the
  module.
- **Future-proof:** new retry categories (rate-limit, network-error, etc.) slot in by
  adding a category entry, with no changes to scheduler or phase-runner.

### #3 — Dispatch-tracker primitive with AbortController contract

Today's force-transition path in preemption leaks the underlying orchestrator promise:
the task state is mutated, the dispatch is removed from the active map, but the promise
keeps running and its late callback fires on a task whose state has already moved.
Cost-limit-queue and any future force-terminate path would inherit the same anti-
pattern. Build a primitive that owns dispatch lifecycle and exposes clean termination.

- **Location:** `src/core/dispatch-tracker/`.
- **Per-dispatch identity:** `{ dispatchId, promise, signal }` keyed by `taskId`. The
  `dispatchId` ensures a late callback for an old dispatch can't fire on a new one for
  the same task.
- **Cancellation surface:** an `AbortController` is created per dispatch in the
  daemon. The `signal` lives on the `Dispatch` object passed to
  `orchestrator.executeTask`. `dispatchTracker.terminate(taskId, reason)` aborts the
  signal and tracks the termination reason.
- **Idempotent late callbacks:** `handleTaskCompletion` / `handleTaskError` check the
  current dispatch identity before acting; mismatched dispatches no-op.
- **New outcome:** `Outcomes.terminated` with a typed `reason` field. Replaces
  `Outcomes.preempted` (see #11 — collapse). Reason enum: `cooperative_preemption`,
  `preemption_timeout`, `hard_cap_exceeded`, `cost_limit_reached`, `graceful_shutdown`.
- **Routing table** in scheduler:
  - `cooperative_preemption` / `preemption_timeout` → `queued`
  - `hard_cap_exceeded` → `failed` + alert
  - `cost_limit_reached` → `blocked` (recoverable via owner unblock)
  - `graceful_shutdown` → `queued` (resume on next start)

**Scope split (cross-slice):**

- **Slice 6 ships the contract:** `dispatch-tracker` module, AbortController per
  dispatch, `signal` on Dispatch, `terminate()`, idempotent callbacks,
  `Outcomes.terminated` routing.
- **Slice 8 ships the honoring:** `signal` plumbed through phase-runner →
  llm-caller → LLM plugins. Until then, force-termination is best-effort — the
  signal is set but the in-flight LLM call completes before honoring.

Best-effort is acceptable for v1's real force-terminate scenarios (preemption double-
timeout, hard-cap, shutdown). Cost-limit-queue (#9) inherits clean termination as soon
as Slice 8 lands.

### #4 — `max_active_duration_ms` enforcement: terminate + fail + alert

Today the hard cap is documented as a cap but implemented as a warning notification.
Make it a real cap: when the threshold is exceeded, the task is terminated, marked
failed, and the owner is alerted.

- **Trigger:** subscribe (inside Slice 6's daemon wiring) to the existing
  `health.stuck_detected` event with `condition: "no_state_transition"`. Health monitor
  already detects and emits this; no changes to health monitor are needed.
- **Action:** call `dispatchTracker.terminate(taskId, "hard_cap_exceeded")`. Routes to
  `failed` + alert via the standard outcome path.
- **Time accounting:** wall-clock from `started_at`. Blocked time counts. Simpler than
  re-anchoring on unblock; aligned with the field's name.
- **Stuck-staleness threshold (`stuck_threshold_ms`, 30 min) stays separate.** Warn-only,
  as today. Two different signals: staleness is "phase might be running long, check in";
  hard cap is "this task has used its entire budget."

### #5 — Crash recovery unification

Both crash recovery paths flow through `retryPolicy.recordFailure("crash", taskId)`:

- **Boot recovery** (`rebuildStateFromTaskEngine`): for each orphaned active task at
  startup, record a crash failure. The policy module applies backoff, checks the
  ceiling, and routes to `failed` if exhausted. Closes the boot-loop hole that
  systemd-restarted daemons can hit with a poison task.
- **Per-task crash** (`handleTaskError`): same code path.

`consecutive_crash_count` carries across daemon restarts (it's persistent on the task
row). A task that crashed four times before the daemon died is correctly one crash
away from failed at boot — history is meaningful.

Graceful shutdown (`drainForShutdown`) already transitions active → queued with reason
`graceful_shutdown` and isn't orphaned; only hard-shutdown orphans hit boot recovery.

### #6 — Preemption: keep + tighten

Preemption is a real working capability (unlike decomposition, it has a producer — the
queue + active tasks) but rarely activates at default `max_concurrent: 1`. Keep it.
Three tightenings:

- **Filter eligible candidates first.** Today the preempter uses `queuedTasks[0]`
  blind. If that candidate has `not_before` in the future, the preemption is wasted —
  evict an active task, candidate can't dispatch, slot sits empty. Fix: filter by
  eligibility before picking. (With #1 deleted, eligibility simplifies to just
  `not_before`.)
- **Bound `priority` to `[1, 100]`** in `TaskSchema` (research correction — DB CHECK
  already enforces this range, the `event-variables.ts` comment says "range 1-100", and
  `priority: 0` would crash on insert). Prevents operator footguns (negative, billions).
  Default 50 stays (midpoint).
- **Document one-per-tick as deliberate.** Cooperative-then-forced timeout is
  inherently sequential. Multi-per-tick would either parallelize cooperation (complex)
  or queue multiple pending preemptions (changes `pendingPreemption` from singleton to
  map). v1 does not need this.

Force-preemption uses `dispatchTracker.terminate(taskId, "preemption_timeout")` (#3).
The `preemption.ready` event is dead — published by phase-runner with zero subscribers —
delete it as part of preemption tidying.

### #7 — Eligibility surfacing: minimal cleanup, no new plumbing

With #1 deleted, `isTaskEligible` collapses to the single `not_before` gate. The
information is already on the task row and visible to anything that queries the task
(dashboard, `engineer why`, debug logs). Adding events or query APIs for "why didn't
this dispatch?" is premature when there's exactly one possible reason.

- Delete the vestigial parent and cascade branches in `isTaskEligible`.
- Add a short documentation paragraph naming the eligibility model: a queued task is
  eligible to dispatch when (a) a slot is available, and (b) its `not_before`
  timestamp is past. There are no other gates.
- No new events, no new query methods, no new observation surface.

### #8 — Phase-runner LLM-unavailable retry adopts retry-policy in Slice 6

The phase-runner's `LlmUnavailableError` catch path writes directly to task fields
(`consecutive_crash_count`, `not_before`). With #2 introducing per-category counters,
deferring this refactor to Slice 8 would leave two writers on the new fields in the
interim — exactly the smell we're fixing. Adopt the API call now:
`retryPolicy.recordFailure("llm_unavailable", taskId)` replaces the direct field
writes. Phase-runner imports from `retry-policy`, not the other way around. Closes the
cross-boundary import smell at the same time.

### #9 — Cost-limit-queue adopts the terminate primitive in Slice 6

`cost-limit-queue.ts` currently calls `taskEngine.requestTransition(blocked)` directly,
which is the same direct-mutation anti-pattern force-preemption used to have. Adopt
the primitive: `dispatchTracker.terminate(taskId, "cost_limit_reached")`. Routes
through `Outcomes.terminated` to `blocked`. Tiny change in cost-limit-queue. Slice 13
inherits a single teardown path instead of having two parallel ones.

### #10 — `drainForShutdown` adopts the terminate primitive

Today `drainForShutdown` runs a bespoke `Promise.race` + manual back-to-queued
transition. With the primitive, it becomes: signal abort all dispatches → wait
`shutdown_timeout_ms` for cooperative settle → terminate any still in-flight (routes
to `queued` via `graceful_shutdown` reason). Single teardown path across all
force-terminate scenarios. The cleanup of `activeDispatches` moves into the
dispatch-tracker.

### #11 — Collapse `Outcomes.preempted` into `Outcomes.terminated`

Both outcomes route to `queued`. The cooperative-vs-forced distinction is captured by
the reason field (`cooperative_preemption` vs `preemption_timeout`). Collapsing
shrinks the outcomes surface and simplifies routing. `Outcomes.error` stays separate
because its semantics are genuinely different (unintentional crash vs intentional
termination).

### #12 — `engineer retry <task-id>` resets per-category counters

Owner-initiated retry is an explicit "try fresh" signal. The retry-policy ceiling
exists to limit *automatic* retries; owner intervention is the natural reset point.
Reset both `consecutive_crash_count` and `consecutive_llm_unavailable_count`, and
clear `not_before`. The state-transitions audit log preserves the full history
regardless.

## Cross-Slice Handoffs

- **Slice 7 (Workspace & Session):** no changes from us. Scheduler stays a consumer of
  `workspaceManager` — boundary intact.
- **Slice 8 (RRPIR phases):**
  - Plumb the `AbortSignal` from #3 through phase-runner → llm-caller → LLM plugins so
    cancellation becomes fast (LLM plugins kill their child process on
    `signal.aborted`). Today's best-effort termination is the interim state.
  - Delete `decomposition-handler.ts` and its call site in `phase-runner.ts` (#1).
  - Remove `decomposition_plan` from `PlanningOutputSchema` and delete all decomposition
    schemas (#1).
  - Strip the decomposition instruction from the planning prompt (#1).
  - Re-evaluate the `integration` phase itself — its prompt cites decomposed-child
    integration as its reason to exist; with #1, it may be dead.
- **Slice 12 (Communication):** notification-kind enumeration. Slice 12 already owns
  the routing surface; they'll audit producers (scheduler, cost-limit-queue,
  health-monitor) when they get there.
- **Slice 13 (Background Services):** cost-limit-queue cleanup is done in Slice 6 (#9),
  but cost tracking, data lifecycle internals, and health-monitor internals remain
  Slice 13 work. We just subscribe to the events they emit.
- **Slice 15 (Dashboard revisit):** dashboard UI cleanup for deleted `SubState` values
  and parent/child grouping. Backend ships the data deletion in Slice 6; UI follows
  in Slice 15.

## Research Refinements (Session 24)

Research surfaced two corrections / additions to the original Q&A decisions:

- **Priority bounds: `[1, 100]` not `[0, 100]`** (correction to #6). The DB already enforces
  `priority INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 1 AND 100)`, and the
  `event-variables.ts` comment already says "range 1-100." Q6 proposed `[0, 100]`; aligning
  Zod to `[1, 100]` matches the DB constraint and avoids a guaranteed insert crash on
  `priority: 0`.
- **`failed → queued` transition recommended** (addition to #4). After `max_active_duration_ms`
  enforcement routes to `failed`, the task has no recovery path: `engineer retry` only works
  on `blocked`, and ValidTransitions has no `failed → queued` edge. Adding that edge lets the
  owner retry a hard-cap victim after fixing the root cause, consistent with #12's "owner
  intervention is the reset point" philosophy. Plan adopts this; alternative (hard-cap as
  intentionally one-shot terminal) is explicitly rejected.

## Findings (no decision needed — captured here for the plan to address)

- **Decomposition delete blast radius is wider than the top-level decision implies.**
  Full enumeration is in #1; the plan session must walk every surface (schema fields,
  permission table entries, ValidTransitions entries, migration, queries, data
  lifecycle, bundled templates) and ensure none rot.
- **`preemption.ready` event is dead.** Published by phase-runner with zero subscribers.
  Delete from event type enum, payload schemas, and the publisher in phase-runner.
- **Pre-v1 DB migration handling.** Per universal rule, consolidate migrations: rewrite
  `db/migrations/001_schema.sql` to reflect the post-Slice-6 shape rather than adding
  a new migration file. Document "delete `~/.engineer/data.db` before running this
  version" in the slice's session log.
- **Test surface changes substantially.** Many tests get deleted (decomposition
  handler, children-all-done, cascade-policy enforcement, supervising/integrating
  transitions, parent eligibility gating). New tests are added (retry-policy per
  category, dispatch-tracker termination + idempotent late callbacks, terminate
  routing per reason, eligibility filter in preemption). Net count is expected to
  drop, aligned with the testing philosophy.
- **Documentation surface to update.** `docs/architecture/overview.md` (scheduling
  section), `docs/configuration/daemon.md` (new `retry_policy` config block,
  `max_active_duration_ms` behavior change, preemption documentation including
  bounded priority and one-per-tick policy), possibly a new
  `docs/architecture/scheduling-dispatch.md` if the overview section grows too large.

## Future Considerations

Captured in `docs/future-considerations.md`:

- **Task Decomposition (Parent → Children)** — the full v1 deletion context plus a
  high-level restoration roadmap (producer side, consumer side, state machine,
  workspace boundary, cascade policy, trigger thresholds).

## Session Breakdown

Finalized in `.claude/temp/create-plan/slice-06-scheduling.md` (Session 24). Sized so each
session finishes completely (code + tests + docs + green gates) within ~250k tokens, with
Session 3 sitting in the larger band (~350k — the centerpiece dispatch-tracker work). Five
implementation sessions plus the closing sweep:

1. **Session 1 — Decomposition consumer delete.** Schema, ValidTransitions, permission
   table, migration rewrite, queries, scheduler/daemon dead-code removal, data lifecycle
   reference, bundled template cleanup, dashboard client `SubState` type narrowing, test
   deletions and scoped updates (~3700 lines of test surface). Cross-slice handoff list
   for Slice 8 confirmed.
2. **Session 2 — retry-policy module + phase-runner adoption + crash recovery
   unification.** New `src/core/retry-policy/` module, per-category counter fields,
   `retry_policy` config block, both crash paths through the module, phase-runner's
   `LlmUnavailableError` catch refactored, cross-boundary import removed, boot-loop
   hole closed.
3. **Session 3 — dispatch-tracker primitive + Outcomes.terminated + preemption +
   drain + cost-limit.** New `src/core/dispatch-tracker/` module with per-dispatch
   identity for idempotent late callbacks, AbortController per dispatch, `signal` on
   the `Dispatch` shape, `Outcomes.terminated` reason routing in scheduler, preemption
   uses eligible filter + terminate primitive, dead `preemption.ready` event deleted,
   `cost-limit-queue` adopts terminate (notifications stay immediate), `drainForShutdown`
   rewritten on the primitive with single shared timeout, `abandonPending` (dead infra)
   deleted, priority bounds `[1, 100]` enforced in schema. Strict task ordering — primitive
   lands first, every adopter follows.
4. **Session 4 — hard-cap enforcement + engineer retry + failed→queued transition +
   final docs.** New `ValidTransitions` entry for `failed → queued`. `engineer retry`
   accepts failed tasks and resets both per-category counters. Daemon subscriber for
   `health.stuck_detected` (`condition: "no_state_transition"`) → `terminate`. Hard-cap
   alert message naming `engineer retry`. Architecture + configuration + CLI docs
   updated.
5. **Session 5 — Closing standards sweep.** Line-by-line audit of every file Sessions
   1–4 created or changed, against `docs/coding-standards.md`, `docs/anti-patterns.md`,
   `docs/philosophy.md`. Defects fixed in focused commits. Slice marked done in
   `active.md`.

Full task-level breakdown, sequencing rationale, verification gates, risk register,
inline expert-panel review, and pre-mortem live in
`.claude/temp/create-plan/slice-06-scheduling.md`.

## Closing Standards Sweep

Detailed scope (file inventory, tier of attention, carried findings) is finalized in the
plan (Session 5 section). Mirrors the Slice 5 closing pattern (Session 22) — read every
touched file line-by-line, apply the principle-driven checks from `approach.md` § Closing
Standards Sweep (every documented reference matches code; every manifest matches behavior;
every swallowed error is logged; every constant lives in one place; no stale counts; no
vestigial scaffolding), refactor where it falls short. Update
`feedback_slice_closing_standards_sweep.md` if the sweep finds a new class of defect.
