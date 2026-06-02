# Research: Slice 9 — Completion & Cleanup (the reaper)

**Date**: 2026-06-01 | **Repo**: the-engineer | **Branch**: main | **Commit**: 36b68a8

Facts-before-opinions investigation grounding the Slice 9 plan. Read directly (no sub-agents),
verifying every claim against source. Pairs with
`.claude/temp/requirements-gathering/slice-09-completion-cleanup.md`.

## What I Found

### 1. Existing terminal-cleanup surface (most of it already works)
**Files**: `core/daemon/task-scheduler.ts`, `core/workspace-manager/index.ts`, `core/data-lifecycle/index.ts`

- `handleCompletedOutcome` (task-scheduler.ts:187-218): on a `completed` outcome it transitions
  the task to `completed` (reason `pipeline_completed`), runs `triggerEvaluationIfEnabled` (worktree
  must still exist), then `workspaceManager.cleanupWorkspace(taskId, /*preserveBranch*/ true)`, then
  notifies `completion` + a `ticket_comment`. This is the only non-interface caller of
  `cleanupWorkspace`.
- `cleanupWorkspace(taskId, preserveBranch?)` (workspace-manager/index.ts:405-465): idempotent;
  removes the worktree via `git worktree remove --force` (existsSync-guarded), deletes the **local**
  branch via `git branch -D` only when `!preserveBranch`, leaves `task.workspace` intact, emits
  `workspace.cleaned`.
- `deleteRemoteBranch(taskId)` (workspace-manager/index.ts:560-583): `git push --no-verify <authUrl>
  --delete <branch>` from the repo clone. Throws `WorkspaceNotFoundError` if no record.
- `data-lifecycle` (data-lifecycle/index.ts): a fully-wired periodic service —
  `start()/stop()/runCleanup()/getLastRun()`, `setInterval(config.interval_ms)`; prunes `events`,
  `observations`, `journal_entries`, `checkpoints` by `max_age_days` (excluding active-task data for
  journal/checkpoints), cleans orphaned blobs, runs incremental vacuum, emits
  `system.cleanup_completed`. **Touches no git/worktree/branch and no plugin.** Pure DB/blob janitor.

**Consequence (observed):** completed tasks have their worktree removed but their **local branch
kept** (`preserveBranch=true`); the remote branch is deleted only by auto-merge on self-merge. Failed
and cancelled tasks never call `cleanupWorkspace` at all → their worktrees persist on disk.

### 2. The `cancelled`-state blast radius (precise enumeration)
**Files**: `schemas/task.ts`, `core/task-engine/{state-machine,queries}.ts`, `core/safety-layer/cost-tracker.ts`, `core/daemon/{notification-router,query-handler}.ts`, `dashboard/api/tasks.ts`, `dashboard/client/src/types/api.ts`

There is **no `isTerminal()` helper or `TERMINAL_STATES` constant**. Terminal-ness is checked
ad-hoc as `completed || failed` in several places. Adding `cancelled` requires touching each.

State-model edits (`schemas/task.ts`):
- `TaskStateSchema` (line 7): add `"cancelled"`.
- `ValidTransitions` (265-283): add `→ cancelled` from `requirements_gathering`, `queued`,
  `active`(+`working`), `blocked`. **No** transitions *out* of `cancelled` (terminal, non-retryable).
- `PermissionTable` (296-320): add `{ state: cancelled, sub_state: null, allowed: [] }`.
- `ReviewStateSchema` (152-159): add `merged_at: z.string().datetime().nullable().default(null)`
  (the retention clock; same file, separate concern).

Terminal-*check* consumers (each currently `completed || failed`):
- `state-machine.ts:134` — sets `completed_at` on terminal transition. `cancelled` must set it too.
- `task-engine/queries.ts:33-38` — **dedup SQL** `state NOT IN ('completed','failed')` as a **raw
  string literal**. CRITICAL: omitting `cancelled` here leaves a cancelled task's idempotency key
  locked, blocking re-trigger of the same source issue.
- `cost-tracker.ts:256` — `accumulators.per_task.delete(taskId)` on terminal. Add `cancelled`.
- `notification-router.ts:420` — drops a queued notification + emits `comm.retry_exhausted` for a
  terminal task. Add `cancelled` (stop retrying notifications to a cancelled task).

All-states enumerations (list everything, currently 6 states):
- `query-handler.ts:56-64` and `:98-105` — **duplicated** state arrays for status counts and
  issue-number scan. Add `cancelled` to both (or derive from `Object.values(TaskStates)`).

Dashboard + CLI:
- `dashboard/api/tasks.ts:325-374` — the cancel endpoint: a **raw `writeDb` UPDATE** to `failed`
  (check-then-act on `cancellableStates`, no version guard). Change target to `cancelled`.
- `dashboard/api/tasks.ts:152` — reason-enrichment filter `blocked || failed` (optional: add
  `cancelled` so its transition reason surfaces).
- `dashboard/client/src/types/api.ts:4` — `TaskState` union: add `cancelled`. (UI *display* of the
  state is Slice 13; the type + cancel write are Slice 9.)
- `cli/commands/retry.ts:71` — `retryableStates = {blocked, failed}`. **No change** — `cancelled`
  stays out (non-retryable). Verify it isn't accidentally included.

NOT in the blast radius (these *produce* `failed`, they don't check terminal-ness):
- `health-monitor.ts:226` (blocked-timeout escalation → failed) and `daemon/index.ts:422` (crash-budget
  → failed). No `cancelled` change.

DB schema literals (`src/db/migrations/001_schema.sql`) — state is enumerated in **four** SQL sites,
all needing `cancelled` (pre-v1: edit the file directly; the DB wipe is the migration):
- `:13` — `tasks.state TEXT NOT NULL CHECK(state IN (...))`.
- `:90` / `:91` — `state_transitions.from_state` / `to_state` CHECK constraints.
- `:83` — the **partial UNIQUE INDEX** on `idempotency_key` `WHERE state NOT IN ('completed','failed')`
  — the *durable* dedup enforcement (sibling to the app-level `queries.ts:36`). Omitting `cancelled`
  makes a re-triggered cancelled source issue violate the unique constraint on INSERT.
- (`:128` `end_reason` is `SessionEndReason`, not `TaskState` — no change.)

Deferred (Slice 10 reserved): `config.ts:250` `DigestConfig.include` default
`["completed","blocked","failed"]` — a digest content list; adding `cancelled` is a Slice 10 concern.

### 3. auto-merge today + the external-merge gap
**Files**: `core/orchestrator/pipeline/delivery/auto-merge.ts`

- `runAutoMerge` (84-163): re-checks the live PR. **Already-merged short-circuit** (98-101):
  `status.state === "merged"` → `resolved("merged")` and returns — **without** `recordMerge`. This is
  the external-merge gap: no `git.pr_merged` audit, no remote-branch delete, no merge marker.
- `recordMerge` (185-213): publishes `git.pr_merged`, notifies a `milestone` ("Merged PR #N"), then
  calls `deleteRemoteBranchAfterMerge`.
- `deleteRemoteBranchAfterMerge` (216-236): gated by `delete_branch_after_merge`; calls
  `workspaceManager.deleteRemoteBranch`, emits `git.branch_deleted`, best-effort.
- `removeThoughtsBeforeMerge` (166-178): strips `thoughts/` from the branch before a self-merge
  (gated `shouldExcludeThoughtsOnMerge`). The external path never reaches it (already merged).
- `git.pr_merged` / `git.branch_deleted` are also declared in `orchestrator/index.ts:60-73` (EVENTS,
  publisher `orchestrator`).

### 4. Termination machinery (the `user_cancelled` path)
**Files**: `core/orchestrator/types.ts`, `core/dispatch-tracker/index.ts`, `core/daemon/task-scheduler.ts`

- `TerminationReasonSchema` (orchestrator/types.ts:41-47): `cooperative_preemption`,
  `preemption_timeout`, `hard_cap_exceeded`, `cost_limit_reached`, `graceful_shutdown`. Add
  `"user_cancelled"`.
- `DispatchTracker` (dispatch-tracker/index.ts:33-50) exposes exactly what's needed:
  `terminate(taskId, reason)` (records reason + `controller.abort()` → SIGTERMs the agent),
  `isInFlight(taskId)`, `getActiveTaskIds()`. The late callback synthesizes `Outcomes.terminated`
  with the recorded reason; identity-guarded so a superseded dispatch no-ops.
- `handleTerminatedOutcome` (task-scheduler.ts:240-315): routes by reason — preemption/shutdown →
  `queued`, hard_cap → `failed`, cost_limit → `blocked`, via `routeForReason` + `requestTransition`.
  **`user_cancelled` is different:** the DB is already `cancelled` (set by dashboard/CLI before the
  abort), so the handler must *not* re-transition — just observe/log. It needs a distinct branch, not
  a `routeForReason` entry.

### 5. Daemon lifecycle + tick (reaper placement + cancel-detection)
**Files**: `core/daemon/index.ts`, `cli/commands/start/bootstrap.ts`

- `start()` (index.ts:549-594): `registry.startHealthCheckLoop()` → `dataLifecycleManager?.start()` →
  rebuild → subscriptions → `tickInterval = setInterval(tick, config.tick_interval_ms)`. Atomic with
  reverse-order rollback.
- `stop()` (598-629): clear tick → flush cost snapshot → `dataLifecycleManager?.stop()` →
  `scheduler.drainForShutdown` → plugin shutdown.
- `dataLifecycleManager` is built in `bootstrap.ts:179` and passed into `createDaemon` — it has **no**
  daemon-internal deps. The **dispatch-tracker is created inside `createDaemon`**, so a reaper that
  needs `isInFlight` must be constructed inside `createDaemon`, not bootstrap.
- The `tick()` loop is the natural fast home for cross-process cancel-detection: iterate
  `dispatchTracker.getActiveTaskIds()`, read each task's DB state, `terminate(id, "user_cancelled")`
  if `cancelled`. Single-task concurrency → ~1 check per tick.

### 6. Config structure
**Files**: `schemas/config.ts`, `cli/bundled/templates.ts`, `docs/configuration/{workspace,daemon}.md`

- `PrConfigSchema` (305-334): `default_merge_strategy`, `delete_branch_after_merge` (bool, default
  true), `branch_retention_days` (`.int().positive().nullable().default(null)`, RESERVED for Slice 9,
  read by nothing), `skip_pr_creation`.
- `CleanupConfigSchema` (336-346): `preserve_branch_on_failure` (true), `preserve_branch_on_cancel`
  (false). **Read by no `src/` logic** — dead.
- `DataLifecycleConfigSchema` (12-24): `{ enabled: true, interval_ms: 3_600_000, retention: {...} }`.
- `DaemonConfigSchema` (36-229) holds `data_lifecycle: DataLifecycleConfigSchema.default({})` at
  line 144 — the slot a sibling `workspace_reaper: WorkspaceReaperConfigSchema.default({})`
  (`{ enabled: true, interval_ms: 3_600_000 }`) mirrors.

### 7. Reusable primitives for the reaper / cancel paths (all exist)
**Files**: `adapters/git-hosting.ts`, `plugins/git-hosting/github-hosting/github-hosting.ts`, `schemas/adapters.ts`

- `closePR(repo, prNumber)` (git-hosting.ts:64) → `doClosePR` implemented (github-hosting.ts:191),
  documented (plugin-docs) — but **zero production callers and no contract-suite test**. Dead reserved
  surface; cancel-with-open-PR is its natural consumer.
- `commentOnPR(repo, prNumber, comment, replyTo?)` (git-hosting.ts:101) — available for the
  "Task cancelled" comment.
- `getPRStatus` → `PRStatusSchema` (adapters.ts:316-324): `{ number, state, draft, mergeable,
  checks_state, url }` — **no `merged_at`/merge timestamp**. So an external merge has no host-provided
  merge time.
- `NotificationKinds` (notifications.ts:5-20): includes `completion`, `milestone`, `ticket_comment`,
  `alert`, etc. — **no** cancel-specific kind. `ticket_comment` suffices for a cancel notice.

### Cross-cutting concerns
- **No terminal-state SSOT.** `completed || failed` is duplicated across state-machine, cost-tracker,
  notification-router, and the dedup SQL (the last as a raw string). This is a §11 single-source-of-truth
  gap *today*, independent of Slice 9 — and it's exactly why a buried check (dedup) is easy to miss.
- **Dashboard cancel is racy.** tasks.ts:325-374 reads state, validates `cancellableStates`, then does
  an unconditional `writeDb` UPDATE — a TOCTOU with no version guard. A dispatch completing concurrently
  (version-guarded `requestTransition` → `completed`) could be clobbered by the raw cancel write.
- **`query-handler` duplicates the all-states array** twice — minor DRY.
- **`merged_at` has no host source for external merges** → must be stamped locally.
- **The reaper is daemon-coupled** (dispatch-tracker) in a way data-lifecycle is not.

## What It Means

### Patterns to follow
- **Mirror `data-lifecycle` for the reaper's shape** — `start()/stop()/run-once()` factory, injected
  `clock` (for testable retention math), `setInterval(config.interval_ms)`, an EVENTS declaration,
  daemon `start()/stop()` wiring + reverse-order rollback. But **construct it inside `createDaemon`**
  (needs `dispatchTracker.isInFlight`), not in bootstrap.
- **Introduce a terminal-state SSOT** (`TERMINAL_STATES` + `isTerminal(state)` in `schemas/task.ts`)
  and refactor the four ad-hoc checks (state-machine `completed_at`, cost-tracker, notification-router,
  and the dedup SQL built from the constant). Turns "add `cancelled` in N spots, risk missing one"
  into a one-line constant change and closes a pre-existing §11 gap. Strongly recommended.
- **`merged_at = clock.now()` at `recordMerge`** for both self- and external-merge. Uniform, no
  `PRStatus` contract change; external-merge inaccuracy (detection time vs actual) is negligible at
  day-granularity retention.
- **Reuse existing primitives:** `deleteRemoteBranch` + `cleanupWorkspace(…, false)` (local branch) for
  reaping; `closePR` + `commentOnPR` for cancel-with-open-PR; `ticket_comment` for the cancel notice.
- **Reconciliation predicate (reaper sweep):** for each terminal task with a `workspace` record and
  `!dispatchTracker.isInFlight(id)`:
  - `completed` + `review.merged_at` set → delete local+remote branch once
    `now - merged_at >= branch_retention_days` (null → never; 0 → now). Backstop-reap any lingering
    worktree.
  - `completed` + no merge marker (push-only) → leave the branch (deliverable); backstop worktree only.
  - `cancelled` → if open PR: comment + `closePR`; then reap worktree + branch unconditionally.
  - `failed` → skip entirely.
  - After a full reap, clear the workspace pointer so the sweep stops reconsidering.

### Risks
- **Dedup SQL omission** (queries.ts:36): highest-severity correctness trap — a cancelled task keeps
  its idempotency key locked. Mitigation: the `TERMINAL_STATES` SSOT + building the `NOT IN (...)`
  clause from it.
- **Dashboard cancel TOCTOU**: change the raw write to a guarded conditional UPDATE
  (`... WHERE id = ? AND state IN (<cancellable>)`) so it only cancels if still cancellable, and never
  clobbers a concurrent terminal transition.
- **Reaping a live dispatch**: a cancelled task may still be aborting (hung agent ignoring SIGTERM).
  Mitigation: the `isInFlight` skip — the reaper never touches an in-flight task.
- **Touching Slice 8's just-finalized state machine**: the `cancelled` state ripples through the schema
  + ~6 consumers. Pre-v1 means no migration, and the SSOT refactor contains the ripple — but it is real
  surface and wants careful test coverage (transition validity, dedup freeing, completed_at).
- **State-machine change is schema-level**: `001_schema.sql`'s `state` CHECK constraint must add
  `cancelled` (the DB-wipe is the migration, per pre-v1).

### Open questions
- **Sweep-summary event?** data-lifecycle emits `system.cleanup_completed`. The reaper could emit a
  `workspace.reaped`-style summary, or rely on per-action `git.branch_deleted` + `workspace.cleaned`.
  Low-stakes; default to per-action events + an info log unless a summary is wanted. (Decide in plan.)
- Everything else from the requirements doc's open list is now resolved above (merged_at storage +
  clock, tick placement, user_cancelled no-transition, reaper interval default = 1h, the full code +
  DB blast radius incl. the four `001_schema.sql` sites).
