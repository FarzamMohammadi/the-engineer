# Plan: Slice 9 — Completion & Cleanup (the reaper)

**Date**: 2026-06-01 | **Stakes**: Full (touches the state machine, daemon lifecycle, delivery pipeline)
**Upstream**: `.claude/temp/research/slice-09-completion-cleanup.md` | `.claude/temp/requirements-gathering/slice-09-completion-cleanup.md`
**Status**: Panel-Reviewed (4-panelist stress test incorporated — see Panel Review + Pre-Mortem)

## Intent

Add the one missing owner of terminal-task cleanup — a daemon-resident, idempotent **reconciliation
reaper** — and make **cancel** a first-class, effective state. Every terminal path (self-merged,
externally-merged, push-only, failed, cancelled) converges to a correct, observable end-state through
one reconciler instead of scattered, incomplete, in-the-moment cleanup. Reserved/dead surface
(`branch_retention_days`, `closePR`) is wired; dead config (`CleanupConfig`) is cut.

## Decisions

(Full rationale in the upstream docs; recorded here as the locked record.)

### D1: Reconciliation reaper (not event-driven, not minimal-cut)
**Choice**: A daemon-resident periodic sweep reconciles every terminal task's workspace+branch to its
desired state. **Context**: cross-process cancel + inherently-timer-based retention both demand
daemon-side async cleanup; reconciliation is idempotent/crash-safe (the stateless philosophy Slice 8
established). **Consequence**: a lost cleanup is caught next sweep; no fast-path that can silently miss.

### D2: Reaper is the sole owner of branch deletion
**Choice**: `auto-merge` stops deleting branches; it only *records* the merge (`git.pr_merged` +
milestone + `merged_at`). The reaper deletes. **Rejected**: split (auto-merge instant + reaper backstop)
— duplicates deletion logic across two modules for instant-UX a single-user tool doesn't need.
**Consequence**: one deletion policy in one place; deletion lags up to one sweep interval (invisible).

### D3: Single `branch_retention_days` field
**Choice**: `branch_retention_days` alone governs merged-branch deletion: `null` = keep forever,
`0` = delete on the next sweep, `N` = after N days. Default `0`. `.positive()` → `.nonnegative()`.
**Delete** `delete_branch_after_merge`. **Rejected**: two composed fields (allows a contradictory
`false`+`N`); tagged union (heaviest reshape). **Consequence**: no contradictory combo representable.
**Honest behavior-change note** (panel): default `0` is NOT equivalent to today's `delete_branch_after_merge:
true` — today deletes *immediately* on merge; `0` deletes on the next reaper sweep (≤ `interval_ms`, default
1h). Acceptable for a single-user tool (nobody waits on branch deletion), but it is a real change, not equivalence.

### D4: Reaper never touches failed tasks
**Choice**: failed = preserved (debug evidence + retry source). **Context**: retry reuses the workspace;
cancel/retry are the resolution verbs (no dead-end leak). **Consequence**: no retry-hardening needed;
`preserve_branch_on_failure` becomes always-true → cut.

### D5: Distinct `cancelled` terminal state
**Choice**: first-class `cancelled` (≠ `failed`). **Rejected**: typed marker on `failed` (soft signal);
reason-string match (fragile). **Consequence**: reaper trivially distinguishes; dashboard/CLI truthful;
ripples through the schema + ~6 consumers (contained by D13).

### D6: Effective active-cancel via `user_cancelled` termination
**Choice**: the daemon detects the cross-process `cancelled` flip on its tick and aborts the dispatch
through Slice 6's terminate machinery (new `user_cancelled` reason). The tick step is a ~3-line loop next
to the existing hard-cap loop (`daemon/index.ts`): `for id of dispatchTracker.getActiveTaskIds(): if
getTask(id).state === cancelled → terminate(id, "user_cancelled")`. **Consequence**: agent stops promptly
(no runaway cost). **Panel-hardened mechanics**: (a) `dispatchTracker.terminate` is idempotent
(dispatch-tracker.ts:169 "keeping first reason"), so the per-tick re-detection until the agent dies is a
safe no-op — no de-dup needed. (b) `handleTerminatedOutcome` MUST handle `user_cancelled` in an **early-return
branch placed before the `routeForReason` total-record and the `exhaustive: never` check** (task-scheduler.ts:246,
313) — it observes + logs at info and returns WITHOUT `requestTransition` (the DB is already `cancelled`;
there is no `cancelled→cancelled` transition, so a transition call would fail-loud + warn spuriously).
**Dissent (Hipp)**: argued to cut active-cancel as gold-plating; overruled — 3 of 4 panelists + the Q6
decision keep it (an ineffective cancel that still burns agent cost is the runaway the safety layer exists
to stop).

### D7: Separate `workspace-reaper` service, built inside `createDaemon`
**Choice**: a new service mirroring data-lifecycle's shape, **constructed inside `createDaemon`** (needs
`dispatchTracker.isInFlight`). **Rejected**: folding into data-lifecycle (mixes plugin/network git ops
into a pure DB janitor). **Consequence**: data-lifecycle stays pure; reaper owns git+plugin cleanup.

### D8: Cancel always reaps (cut `CleanupConfig`)
**Choice**: cancel reaps worktree + branch unconditionally. **Consequence**: the entire `CleanupConfig`
section (`preserve_branch_on_failure`, `preserve_branch_on_cancel`) is removed as dead.

### D9: Cancelled is non-retryable (terminal)
**Choice**: no transitions out of `cancelled`; `engineer retry` keeps `{blocked, failed}` only.
**Consequence**: clean failed(retryable)-vs-cancelled(done-by-choice) separation.

### D10: External-merge backfill is audit-only
**Choice**: the already-merged path records `merged_at` + `git.pr_merged`, **no** "Merged PR" milestone
(the user merged it). **Consequence**: honest audit trail without notifying someone of their own action.

### D11: Add `engineer cancel` CLI
**Choice**: `engineer cancel <taskId>` (CLI-native parity with `engineer retry`). **Panel correction**:
the CLI is a *separate process with no task-engine* — `retry.ts:42-95` opens the DB directly
(`new BetterSqlite3` + raw `db.transaction()`) precisely so it works even when the daemon is stopped. So
`engineer cancel` is a **guarded raw transactional UPDATE** mirroring `retry.ts`, i.e. the SAME pattern as
the dashboard fix (D14) — not "via the engine," and not "cleaner than the dashboard." **Consequence**: one
guarded-UPDATE pattern applied in two command surfaces; both converge on `cancelled`.

### D12: Cancel-with-open-PR closes the PR
**Choice**: reaping a cancelled task with an open PR comments + `closePR`, then reaps the branch.
**Rationale (panel-corrected — user need FIRST)**: deleting a branch out from under an open PR leaves a
messy orphan (a PR pointing at a deleted branch) on the host; closing it is the clean abandon semantic.
Wiring the currently-dead `closePR` is a *consequence*, not the justification. **Consequence**: no orphaned
PR; `closePR` gets its first real caller + a contract-suite case (cheap — fake-hosting already implements
`doClosePR`). **Scope flag**: this is the lowest-value / highest-new-surface item — **first to cut if Session
3 runs hot** (the branch is reaped either way; only the host-side PR tidiness is lost).

### D13: `TERMINAL_STATES` / `isTerminal()` SSOT (research refinement)
**Choice**: add the constant+helper to `schemas/task.ts`; refactor the 4 ad-hoc terminal-*predicate* sites
(state-machine `completed_at`, cost-tracker, notification-router, and the app-level dedup `NOT IN` built
from the constant). **Consequence**: closes a pre-existing §11 gap (the predicate is duplicated 4× today,
once as a raw SQL string). **Honest scope of containment (panel)**: the SSOT collapses those **4 predicate
sites only**. It does NOT reach: (a) the **4 SQL literals** in `001_schema.sql` (`:13`/`:83`/`:90`/`:91` —
TS constants can't reach SQL; hand-edited, guarded by tests), nor (b) the **2 all-state arrays** in
`query-handler.ts` (these enumerate *every* state, so they derive from `Object.values(TaskStates)`, a
*different* SSOT, not `isTerminal()`). Do not claim "one constant contains the ripple" — 4 contained, 6
hand-edited/enum-derived and guarded by tests.

### D14: Dashboard-cancel TOCTOU + version fix (research + panel refinement)
**Choice**: the dashboard (and CLI) cancel becomes `UPDATE … SET state='cancelled', version = version + 1,
completed_at = ?, last_transition_at = ? WHERE id = ? AND state IN (<cancellable>)`. **Panel correction
(Architect)**: guarding on `state` is necessary but NOT sufficient — the daemon's `requestTransition`
serializes via optimistic concurrency (`version = version + 1 WHERE version = ?`, state-machine.ts). A raw
cancel write that changes state *without bumping `version`* is invisible to that CAS, so the two writers
aren't serialized and could clobber each other. Bumping `version` makes the cancel participate in the same
concurrency protocol. **Consequence**: the cancel and a concurrent daemon transition are genuinely
serialized — exactly one wins; the loser's guard matches zero rows.

### D15: stamp `merged_at` at `recordMerge`, stored on `review.merged_at`
**Choice**: stamp `review.merged_at = new Date().toISOString()` at record time for both self- and
external-merge. **Panel corrections**: (a) there is **no `clock` on `OrchestratorContext`** (types.ts) and
auto-merge has none injected — so the original "`clock.now()`" is uncompilable; use the orchestrator's
actual idiom `new Date().toISOString()`. The reaper *service* (a daemon background service like
data-lifecycle) DOES get an injected `clock` for testable retention math — tests set `review.merged_at` in
the fixture and advance the reaper's clock. (b) We *choose* not to thread the real PR `merged_at` through
the adapter (the github plugin's `pulls.get` response actually carries `merged_at` but discards it) — the
accuracy gain (detection-time vs actual-merge-time, ~one poll interval) is negligible at day-granularity
retention and not worth a one-way-door contract change. State it as a choice, not a constraint.
**Consequence**: no adapter-contract change; restart-safe (persisted on the task row, re-read every sweep).

### D16: `reaped_at` marker + all-or-nothing reap (panel BLOCKER — all 4 panelists)
**Choice**: add a real nullable `reaped_at` timestamp **column** to `tasks`. The reaper queries unreaped
terminal tasks (`state IN ('completed','cancelled') AND reaped_at IS NULL`, plus `!isInFlight`) and sets
`reaped_at` **only after a fully-successful reap** (every applicable step — worktree backstop, local branch,
remote branch, PR close — succeeded). **Context**: the plan's original "clear the workspace pointer" step
had no implementation — `cleanupWorkspace` deliberately *preserves* `task.workspace` (it's the orchestrator's
resume SSOT; nulling it would destroy audit evidence and the resume source). And it was the reaper's
loop-termination condition, left unscoped. **Rejected**: nulling `task.workspace` (destroys audit + contradicts
the stateless DB-as-SSOT design); a per-task git "does the branch still exist?" probe every sweep (a network
call per terminal task, forever). **Consequence**: the reaper is genuinely idempotent and crash-safe — a
partial reap (e.g. remote-delete throws after worktree+local succeed) leaves `reaped_at` NULL, so the next
sweep retries; `task.workspace` stays intact for the audit trail. For a merged task with `retention=null`
(keep forever) the reaper has no branch work to do, so it marks `reaped_at` immediately (worktree already
removed inline at completion). Push-only completed tasks → mark `reaped_at` immediately (branch is the
deliverable, kept). This is the soundness lynchpin; build it in Session 1 (column) + Session 2 (logic).

### D17: Reaper failure envelope + observability (panel — Hipp/Architect/Engineer)
**Choice**: the reaper, doing unattended destructive git+network ops on a timer, owns a real failure
envelope: (a) **re-entrancy guard** (`if (running) return`) — `data-lifecycle`'s bare `setInterval` can
overlap, and the reaper's per-task network ops make overlap likelier; (b) **per-operation timeout** on the
remote delete (`deleteRemoteBranch` today has none, unlike `push.ts`); (c) **already-gone = success** — wrap
the remote delete so "remote ref does not exist" is treated as the desired end-state (today only the *local*
`branch -D` is tolerant; the remote `push --delete` throws on non-zero exit); (d) **plugin-absent guard** —
if the hosting plugin is unregistered, skip the PR/remote step, still reap local worktree+branch, log it
(§15 Fail Loud); (e) **per-task isolation** — one task's reap failure is non-fatal to the sweep and logged;
(f) **bounded-retry-then-escalate** — a per-task reap-failure counter; after a threshold of consecutive
failures (registered-but-failing plugin: revoked token, branch protection) emit an `alert` notification —
*absence of `git.branch_deleted` is not an alert*; (g) **`getLastRun()` summary** mirroring data-lifecycle's
`CleanupStats` so the owner can inspect "last sweep reconciled N, failed M." **Context**: Radical Observability
is a project principle and the reaper is the least-observable component doing the most-destructive unattended
work. **Consequence**: the "crash-safe reconciliation" claim becomes real, not aspirational; the silent-rot
3am scenario (see Pre-Mortem) is closed.

## Scope Boundary

**Delivering**: the `workspace-reaper` service + branch lifecycle; the `cancelled` state model + SSOT;
effective cancel (dashboard + CLI + active-abort); external-merge backfill; config reshape; dead-config
removal; `closePR` wiring + contract test; docs + bundled mirrors; closing standards sweep.

**Deferring**: dashboard UI for `cancelled` (chips/filters) → Slice 13; notification policy knobs → Slice
10; `DigestConfig.include` cancelled entry → Slice 10; reworking the dashboard cancel onto a shared
task-engine → Slice 13 (the guarded raw UPDATE suffices for v1).

## Task Breakdown (4 sessions, each green-on-commit, ≤~400–450k tokens)

> **Docs ride with code (panel + DoD item 7).** Config/contract/bundled docs land in the SAME commit as the
> change that needs them (a code change without its doc update is unfinished work). The standalone docs
> session is therefore gone; the durable `slices/09-*.md` narrative + final cross-doc verification fold into
> the closing sweep. (Reverses the earlier 5-session cut — flagged for Farzam; revert if a dedicated
> narrative session is preferred.)

### Session 1 — State-model spine + terminal SSOT + `reaped_at`
**Goal**: `cancelled` is a fully-modeled, everywhere-handled terminal state, `isTerminal()` is the single
source of terminal-ness, and the `reaped_at` marker exists — even though nothing produces `cancelled` or
sets `reaped_at` yet (spine only).
**Where**: `schemas/task.ts`, `db/migrations/001_schema.sql`, `task-engine/{state-machine,queries,row-mapper}.ts`,
`safety-layer/cost-tracker.ts`, `daemon/{notification-router,query-handler}.ts`,
`dashboard/client/src/types/api.ts`, `cli/commands/retry.ts`.
**Approach**:
- `schemas/task.ts`: add `"cancelled"` to `TaskStateSchema`; 4 `→cancelled` transitions
  (`requirements_gathering`/`queued`/`active`+`working`/`blocked`), **none out**; `PermissionTable` row
  `{cancelled, null, []}`; add `TERMINAL_STATES` + `isTerminal()`; add `ReviewStateSchema.merged_at`
  (nullable, default null); add `reaped_at: z.string().datetime().nullable().default(null)` to `TaskSchema` (D16).
- `001_schema.sql`: add `cancelled` to the 3 state CHECKs (`:13`, `:90`, `:91`) **and the partial unique
  index `:83`** (`NOT IN ('completed','failed','cancelled')`); add the `reaped_at TEXT` column.
- `row-mapper.ts`: map `reaped_at`.
- Refactor the 4 ad-hoc terminal-predicate sites to `isTerminal()`; build the dedup `NOT IN (...)`
  (queries.ts) from `TERMINAL_STATES`; de-dup query-handler's two all-states arrays (derive from
  `Object.values(TaskStates)`); add `cancelled` to the client `TaskState` union; confirm `retry.ts`
  excludes `cancelled`.
**Depends on**: nothing.
**Verify**: `test:all` green; new tests — (1) **the e2e dedup test: real INSERT, key K → cancel → INSERT key
K again succeeds** (proves BOTH the app `NOT IN` *and* the DB index `:83` were updated in lockstep — the
single most important test); (2) transition validity (into `cancelled`, none out); (3) `completed_at` set on
`cancelled`; (4) `isTerminal` covers completed/failed/cancelled; (5) `reaped_at` defaults null + round-trips.
**Docs**: none user-facing this session (no config/contract change); the `cancelled` state is documented in
the slice narrative (closing sweep).
**Commit**: `/commit` after green.

### Session 2 — Reaper service + branch lifecycle + auto-merge (+ its docs)
**Goal**: merged branches are deleted by the reaper per `branch_retention_days`, all-or-nothing and
failure-enveloped; auto-merge only records the merge; push-only branches are preserved; external merges
are backfilled.
**Where**: `schemas/config.ts`, `cli/bundled/templates.ts`, `orchestrator/pipeline/delivery/auto-merge.ts`,
`orchestrator/index.ts`, new `core/workspace-reaper/`, `daemon/index.ts`, `cli/commands/start/bootstrap.ts`,
`task-engine/queries.ts` (new "unreaped terminal" query), `docs/configuration/{workspace,daemon}.md`.
**Approach**:
- Config: single `branch_retention_days` (`.nonnegative()`, default 0); delete `delete_branch_after_merge`
  + the entire `CleanupConfigSchema`; add `WorkspaceReaperConfigSchema {enabled:true, interval_ms:3_600_000}`
  as `daemon.workspace_reaper`. Sync `cli/bundled/templates.ts`. **Update `docs/configuration/workspace.md`
  + `daemon.md` in this commit (DoD item 7).**
- `auto-merge.ts`: `recordMerge` stamps `review.merged_at = new Date().toISOString()` (D15), emits
  `git.pr_merged`, milestone only when self-merged; **remove** `deleteRemoteBranchAfterMerge` + the immediate
  branch delete; the already-merged short-circuit calls `recordMerge(notifyMilestone=false)`. **Rewrite the
  now-stale doc-comments** (auto-merge.ts ~27-29, 180-184) that claim auto-merge deletes the branch.
- `task-engine/queries.ts`: add `getUnreapedTerminalTasks()` → `state IN ('completed','cancelled') AND
  reaped_at IS NULL` (built from `TERMINAL_STATES`).
- New `core/workspace-reaper/`: factory `{start, stop, runOnce, getLastRun}` (mirror data-lifecycle),
  injected `clock`. **D17 envelope**: re-entrancy guard, per-op timeout on remote delete, already-gone =
  success, plugin-absent → skip PR/remote + still reap local + log, per-task isolation, reap-failure counter
  → `alert` after threshold, `getLastRun()` summary. Reconciliation over `getUnreapedTerminalTasks()` ∩
  `!isInFlight(id)`: `completed`+`merged_at` → delete local+remote branch when `now-merged_at >= retention`
  (null→never→mark reaped now; 0→this sweep; N→after N days); `completed` w/o merge marker (push-only) →
  keep branch, mark reaped now (worktree already removed inline); **set `reaped_at` only on fully-successful
  reap (D16, all-or-nothing)**; worktree backstop; emit `git.branch_deleted` + `workspace.cleaned`. Construct
  inside `createDaemon` (needs `dispatchTracker.isInFlight`); `start()`/`stop()` in the daemon lifecycle +
  reverse-order rollback. Move the `git.branch_deleted` publisher declaration orchestrator→reaper (keep
  `git.pr_merged` in orchestrator — auto-merge still emits it).
**Depends on**: Session 1 (state model, `merged_at`, `reaped_at`, `isTerminal`).
**Verify**: tests — retention math incl. **boundary equality** (`>=` vs `>` at exactly N days), `null` never
reaps, `0` reaps this sweep; push-only branch never deleted; idempotent re-delete (already-gone = success);
`isInFlight` skip; external-merge backfill records + reaper deletes; **partial reap (remote-delete throws
after worktree+local succeed) leaves `reaped_at` NULL → next sweep completes**; plugin-absent → local reap
proceeds + logged, PR/remote skipped; overlapping `runOnce` → second no-ops (re-entrancy); reap-failure
counter escalates to `alert` after the threshold. Config docs grep-match the schema.
**Commit**: `/commit` after green.

### Session 3 — Cancel end-to-end (+ its docs)
**Goal**: cancelling a task (dashboard or CLI), including an active one, stops the agent and converges to
`cancelled` + fully reaped; an open PR is closed.
**Where**: `orchestrator/types.ts`, `daemon/{index,task-scheduler}.ts`, `dashboard/api/tasks.ts`,
new `cli/commands/cancel.ts`, `core/workspace-reaper/`, `tests/helpers/contract-suites/git-hosting-contract.ts`,
`cli/bundled/plugin-docs.ts` (if `closePR` surfaces).
**Approach**:
- Add `user_cancelled` to `TerminationReasonSchema`; `handleTerminatedOutcome` gains a `user_cancelled`
  **early-return branch placed before the `routeForReason` total-record + the `exhaustive: never` check**
  (D6) — observe + log at info, NO `requestTransition` (already `cancelled`); let the reaper clean up.
- Daemon `tick()`: scan `dispatchTracker.getActiveTaskIds()`; for any whose DB state is `cancelled`,
  `dispatchTracker.terminate(id, "user_cancelled")` (idempotent — safe to re-issue each tick until settle).
- Dashboard cancel + new `engineer cancel <taskId>`: BOTH are guarded versioned transactional UPDATEs
  (D11/D14) — `SET state='cancelled', version=version+1, completed_at=?, last_transition_at=? WHERE id=? AND
  state IN (<cancellable>)` + a `state_transitions` row; `engineer cancel` opens the DB directly like
  `retry.ts`. Emit a `ticket_comment` daemon-side on detection.
- Reaper: add the `cancelled` branch — if an open PR exists, `commentOnPR` + `closePR` (D12); then reap
  worktree + branch; set `reaped_at` on full success. Add a `closePR` case to the git-hosting contract suite.
**Depends on**: Sessions 1 + 2.
**Verify**: tests — active-cancel aborts the in-flight dispatch (agent SIGTERM); cancelled task fully reaped;
cancel-with-open-PR closes the PR; the **guarded-versioned-update race** (a concurrent natural `completed`
wins, the cancel matches 0 rows — and the resulting "could not transition to completed" log is **info, not a
warn**, for this expected interleave); `user_cancelled` does NOT re-transition; `user_cancelled` double-fire
no-ops; CLI cancel works with the daemon stopped.
**Docs**: `engineer cancel` in CLI help/docs + bundled plugin-docs `closePR` row if surfaced — this commit.
**Commit**: `/commit` after green.

### Session 4 — Slice narrative + closing standards sweep
**Goal**: the durable design record exists and every touched file passes a line-by-line audit vs
coding-standards / anti-patterns / philosophy. (DoD-docs already landed with their code in Sessions 1–3;
this session writes the *design narrative* and runs the final gate.)
**Where**: new `docs/archived/implementation-docs/9-oss-ready/slices/09-completion-cleanup.md`,
`docs/future-considerations.md`, and every file changed across Sessions 1–3.
**Approach**: its own clean-context session per approach.md. (1) Write `slices/09-*.md` as the durable design
source (the reaper model, the `cancelled` state, the deliverable/cancel flows, the panel decisions) — the
slice-08 precedent. (2) Final cross-doc verification: every config key grep-matches a Zod schema; bundled
docs == `docs/` == `src/`; the auto-merge stale-comment fix + any residue. (3) The principle-driven sweep
hunts (dead surface, SSOT, leaky boundaries, stale residue, swallowed errors, stale counts, manifest/doc
drift). Update memory if a new defect class surfaces.
**Depends on**: Sessions 1–3.
**Verify**: `biome` + `tsc` + `tsc-test` + `knip` + `madge` clean; `test:all` green; build OK.
**Commit**: `/commit`; then `/wrap-session` to close the slice.

## Verification Contract

| Check | Type | Command/Observation |
|---|---|---|
| Lint/format | Auto | `biome` clean |
| Types (src + tests) | Auto | `tsc` + `tsc-test` clean |
| Dead code / cycles | Auto | `knip` + `madge` clean (no orphaned exports after CleanupConfig/`delete_branch_after_merge` removal) |
| Tests | Auto | `test:all` green (unit + integration + e2e) |
| Build | Auto | build OK |
| Reaper behavior | Manual | merged branch deleted after retention; push-only branch preserved; failed untouched |
| Cancel behavior | Manual | cancelling an active task stops the agent; cancelled task reaped; open PR closed |
| **Dedup (the key test)** | Auto | e2e real-INSERT: key K → cancel → INSERT key K again **succeeds** (both app `NOT IN` + DB index `:83`) |
| Partial-reap retry | Auto | remote-delete throws after worktree+local succeed → `reaped_at` stays NULL → next sweep completes |
| Reaper resilience | Auto | plugin-absent → local reap proceeds + logged; overlapping `runOnce` no-ops; repeated failure → `alert` |
| Cancel race | Auto | concurrent natural `completed` vs cancel → exactly one wins (version CAS); loser matches 0 rows |
| Retention boundary | Auto | exactly N days → reaped (`>=`); `null` → never; `0` → this sweep |

## Risks

| Risk | If it happens | Mitigation |
|---|---|---|
| Dedup omission (app `queries.ts` AND DB index `:83`) | re-trigger of a cancelled issue: INSERT throws `UNIQUE constraint` → crashes the trigger poller (worse than a silent drop) | `TERMINAL_STATES` SSOT (app side) + explicit `:83` edit + **the e2e real-INSERT dedup test** that exercises both layers |
| State-machine ripple into Slice 8's finalized surface | a missed consumer mishandles `cancelled` | SSOT contains the 4 predicate sites; the 4 SQL + 2 array sites are hand-edited + test-guarded (enumerated, research §2) |
| Reaper reaps a live dispatch | worktree yanked from a running agent | `isInFlight` skip; reaper built inside `createDaemon` with the dispatch-tracker |
| **Partial reap orphans a branch / thrashes** | remote-delete fails mid-reap → branch orphaned forever, or worktree re-removed every sweep | all-or-nothing `reaped_at` (D16): set only on full success; idempotent re-reap; partial-failure test |
| **Reaper silent-rot under a failing plugin** | revoked token / branch protection → warns hourly forever, branches pile up, nobody told | D17: already-gone=success, plugin-absent skip+log, reap-failure counter → `alert`, `getLastRun()` summary |
| Cross-process cancel race | a raw cancel write invisible to the daemon's version CAS clobbers a concurrent transition | guarded **versioned** UPDATE (D14): bump `version` + `WHERE state IN (<cancellable>)` |
| `clock.now()` uncompilable (no clock on OrchestratorContext) | Session 2 stalls | D15: stamp with `new Date().toISOString()`; inject clock only into the reaper service |

## Pre-Mortem

*Imagine this shipped and failed. The three most likely causes:*

1. **The reaper silently rots.** A registered-but-failing hosting plugin (revoked token, branch protection)
   makes every remote-delete throw. The reaper warn-logs hourly forever; merged branches pile up; the owner
   is never told (absence of `git.branch_deleted` is not an alert). → **Mitigation (D17):** already-gone =
   success, plugin-absent skip+log, a reap-failure counter that escalates to an `alert` after a threshold,
   and a `getLastRun()` summary the owner can inspect.
2. **A cancelled issue can never be re-triggered.** The DB partial unique index `:83` was edited for the app
   layer but not the SQL — re-triggering the same source issue throws `UNIQUE constraint` on INSERT and
   crashes the trigger poller. → **Mitigation:** the e2e real-INSERT dedup test (exercises both layers in
   lockstep) + `:83` as an explicit Session-1 acceptance criterion.
3. **A partial reap orphans a remote branch forever.** The reaper removes the worktree and the local branch,
   then the remote delete fails — but the task is marked reaped anyway, so the orphan is never retried. →
   **Mitigation (D16):** all-or-nothing `reaped_at` — set only after every step succeeds; partial failure
   leaves it NULL so the next sweep retries; explicit partial-failure test.

## Panel Review

**Panelists**: Linus Torvalds (data structures), D. Richard Hipp (failure paths/testing), Technical
Architect (one-way doors/operational), The Engineer (earns-its-bytes/taste). Each read the plan + the actual
source. Verdict: architecture sound; three factual errors about the existing code + under-specified soundness.

**Incorporated**:
- **`reaped_at` marker + all-or-nothing reap (D16)** — all 4 flagged that the "clear the workspace pointer"
  step had no implementation and was the reaper's loop-termination/soundness lynchpin. Replaced with a real
  `reaped_at` column set only on full success (preserves `task.workspace` audit; partial reap retries).
- **`new Date()` not `clock.now()` (D15)** — Hipp/Torvalds: no clock on `OrchestratorContext`; the original
  was uncompilable.
- **`engineer cancel` is a guarded raw UPDATE, == D14 (D11)** — Torvalds: the CLI has no task-engine
  (`retry.ts` proves the pattern). Dropped the "via engine / cleaner" framing.
- **Cancel write bumps `version` (D14)** — Architect: state-guard alone is invisible to the daemon's
  optimistic-concurrency CAS.
- **Reaper failure envelope + observability (D17)** — Hipp/Architect/Engineer: per-op timeout, already-gone
  = success, plugin-absent guard, re-entrancy guard, bounded-retry-then-alert, `getLastRun()`.
- **Honest framing** — D13 (SSOT contains 4 sites, not all), D3 (`0` ≠ today's immediate), D15 (chosen, not
  forced); the `user_cancelled` early-return before the `routeForReason`/`never` check (D6); stale auto-merge
  comments rewritten (Session 2).
- **The e2e dedup test** (Hipp's "single most important test") + the adversarial reaper/cancel tests, into
  the Verification Contract.
- **Docs ride with code** (Torvalds, per DoD item 7) → 5 sessions collapse to 4.

**Declined**:
- **Cut active-cancel (D6)** — Hipp alone; overruled by 3 panelists + the Q6 decision (an ineffective cancel
  that still burns agent cost is the runaway the safety layer exists to stop). Kept, with the idempotent-
  terminate note that makes the per-tick re-detection safe.
- **Cut `closePR`-on-cancel (D12)** — not cut, but re-justified on user need (no orphaned PR) and demoted to
  "first to cut if Session 3 runs hot."
- **Cut the reaper `enabled` flag** — Engineer questioned it; kept for operational parity with data-lifecycle
  + the registry health loop (operators legitimately disable background services); noted.

## References
- Requirements: `.claude/temp/requirements-gathering/slice-09-completion-cleanup.md`
- Research: `.claude/temp/research/slice-09-completion-cleanup.md`
- Slice 8 design source (for the durable narrative): `docs/archived/implementation-docs/9-oss-ready/slices/08-pipeline-phases.md`
