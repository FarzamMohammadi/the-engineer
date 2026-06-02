# Requirements: Slice 9 — Completion & Cleanup (the reaper)

> RRP requirements artifact. Feeds the durable slice narrative (`slices/09-*.md`) and the
> implementation plan. Decisions reached via co-owner Q&A (Session 51). No code yet.

## Context

Slice 9 *completes and unifies* terminal-task cleanup. Grounding showed most "cleanup"
already works: worktree removal on completion, completion notifications, self-merge audit +
remote-branch delete, and a periodic `data-lifecycle` service that reaps DB rows + blobs +
vacuum. The genuinely-missing piece is a daemon-resident **reconciliation reaper** that owns
branch lifecycle and the cleanup paths that cannot happen inline (cross-process cancel,
retention-window deletion, external-merge backfill). Slice 9 also makes **cancel** first-class
and actually effective, and removes the dead cleanup config the Slice 8 sweep left reserved.

## True Intent

Make every terminal path — self-merged, externally-merged, push-only, failed, cancelled —
converge to a correct, observable, **idempotent** end-state through one reconciling owner,
rather than scattered, incomplete, in-the-moment cleanup. Bring reserved/dead surface to life
(`branch_retention_days`, `closePR`) or cut it (`CleanupConfig`). The reaper is the answer to
the cross-process problem (the dashboard can't reach the daemon's services) and the
stateless/idempotent philosophy Slice 8 established (no fast-path that can silently miss).

## Scope

### In Scope
- **`workspace-reaper` service** — new daemon-resident periodic reconciliation sweep over
  terminal tasks. Separate from `data-lifecycle` (different deps: git + hosting plugin +
  network; different failure model). Idempotent, crash/restart-safe.
- **Branch deletion ownership → reaper only.** `auto-merge` stops deleting branches; it
  *records* the merge (`git.pr_merged` audit + "Merged PR" milestone + a `merged_at` marker).
- **External-merge backfill.** The already-merged short-circuit path records the merge
  (`merged_at` + `git.pr_merged` audit, **no** milestone — the user merged it themselves);
  the reaper then deletes the branch per retention.
- **Config reshape (single source of truth).** Drop `delete_branch_after_merge`.
  `branch_retention_days` alone governs merged branches: `null` = keep forever, `0` = delete
  promptly (next sweep), `N` = delete N days after merge. Default `0` (preserves today's
  delete-on-merge). Schema `.positive()` → `.nonnegative()`.
- **`cancelled` terminal state.** First-class, distinct from `failed`. Enum + transitions +
  action-permissions + `completed_at` + all terminal-state consumers updated.
- **Effective active-cancel.** Cancelling a *running* task aborts the dispatch: the daemon
  detects the cross-process DB flip on its tick and aborts via Slice 6's terminate machinery
  (new `user_cancelled` TerminationReason). Agent stops promptly — no runaway cost.
- **Cancel cleanup.** Reaper reaps cancelled tasks fully (worktree + branch, always). If an
  open PR exists: comment + `closePR` (wiring today's dead `closePR`), then reap the branch.
- **`engineer cancel <taskId>` CLI** (CLI-native parity with `engineer retry`), routed through
  the task-engine state machine. Dashboard cancel updated to write `cancelled`.
- **Cut dead config.** Remove the entire `CleanupConfig` section
  (`preserve_branch_on_failure`, `preserve_branch_on_cancel`).
- **Reaper safety.** Never reap a task with a live dispatch (consult the dispatch-tracker).
- **Reaped marker.** After a full reap, clear the workspace pointer so the sweep stops
  reconsidering; `workspace.cleaned` is the audit.
- **Completion's local branch** (today kept forever via `preserveBranch=true`) now governed by
  retention through the reaper.
- Observability, docs (`workspace.md`, daemon config, the slice narrative), bundled mirrors,
  tests (incl. a `closePR` contract test), closing standards sweep.

### Out of Scope
- **Dashboard UI for `cancelled`** (chips, filters, display) → Slice 13, consistent with Slice
  8's UI deferral. The *state* + CLI text land in Slice 9.
- **Notification policy knobs** (quiet hours, batching) → Slice 10.
- **`data-lifecycle` internals** — already done; left as a pure DB/blob janitor.
- **"Parent integration" / child-branch integration** — MOOT (decomposition cut in Slice 6).
- **Reworking the dashboard cancel to share a task-engine** (cross-process refactor) — the raw
  write is updated to the new state; the clean path is the new CLI command. Larger dashboard
  refactor stays with Slice 13.

## Requirements

### Functional
1. **Reaper service.** Starts/stops with the daemon, gated by `daemon.workspace_reaper.enabled`,
   runs every `interval_ms`; each sweep reconciles terminal tasks' workspace+branch to desired
   state. Fully idempotent; recomputes from the DB each sweep (no in-memory wait-state).
2. **Branch deletion (reaper).** For a task carrying a `merged_at`: delete local + remote branch
   once `now - merged_at >= branch_retention_days` (`null` → never; `0` → next sweep). Idempotent
   (already-deleted = success). Emits `git.branch_deleted`.
3. **auto-merge records, never deletes.** Self-merge → record `merged_at`, emit `git.pr_merged`,
   send "Merged PR" milestone. Already-merged (external) → record `merged_at`, emit
   `git.pr_merged`, **no** milestone.
4. **`branch_retention_days` single source.** `delete_branch_after_merge` removed from schema,
   templates, docs, code.
5. **`cancelled` state.** Transitions {`requirements_gathering`, `queued`, `active`, `blocked`}
   → `cancelled`; terminal (no out-transitions; **not** retryable); sets `completed_at`; allowed
   actions `[]`. Update every consumer that special-cases terminal states.
6. **Effective active-cancel.** Daemon tick detects an active dispatch whose DB state is
   `cancelled` and aborts it; routed as `user_cancelled` (state already set → abort stops cost;
   no late-callback re-transition error).
7. **Cancel cleanup.** Reaper reaps cancelled tasks fully (worktree + branch, unconditionally).
   Open PR present → comment + `closePR`, then reap branch.
8. **`engineer cancel` CLI.** Transitions a cancellable task → `cancelled` via the task-engine.
   Dashboard cancel writes `cancelled` (+ `completed_at` + transition row).
9. **Failed untouched.** Reaper never reaps failed tasks (debug evidence + retry source).
   Resolution: `engineer retry` (→ completes → reaped) or cancel (→ reaped).
10. **Push-only preserved.** No merge marker → reaper never deletes the branch (it's the
    deliverable). Worktree still reaped inline on completion.
11. **Reaper safety.** Skip any task with a live dispatch.
12. **Reaped marker.** After a full reap, clear the workspace pointer.

### Non-Functional
- **Idempotent + crash-safe** by construction (reconciliation, not event-driven).
- **Plugin-blind.** Reaper acts through adapter contracts (`closePR`, `deleteRemoteBranch`,
  hosting); Core still compiles with every plugin removed.
- **Single-task concurrency** holds; the per-tick cancel check is ~1 task (near-free).
- **Pre-v1:** no migration — the DB wipe is the migration.
- **Cost-conscious:** active-cancel stops the agent promptly.

## Edge Cases & Error Handling
- Remote branch already deleted externally → idempotent success ("ref doesn't exist" = done).
- Hosting plugin unregistered when a remote delete / `closePR` is needed → warn, leave for a
  later sweep (reconciles when the plugin returns).
- Daemon restart mid-retention → recomputed from `merged_at`; nothing lost.
- Worktree dir already gone → `cleanupWorkspace` is idempotent.
- Cancel of a task with no workspace → state transition only; nothing to reap.
- Cancel of an active task that already pushed a branch/PR → abort, close PR if open, reap.
- `merged_at` missing on an externally-merged PR → use the PR's `merged_at` from `getPRStatus`
  if available, else detection time.
- Network failure during remote delete → retry next sweep.

## Open Questions (resolve in Research / Planning)
- Exact `merged_at` storage (`task.review.merged_at` vs a new column).
- Exact placement of the daemon-tick cancel-detection (scheduler tick vs dedicated check).
- `user_cancelled` handling in `handleTerminatedOutcome` (state is already `cancelled` → expect
  a no-op/confirm, not a re-transition).
- `daemon.workspace_reaper.interval_ms` default (proposal: `3_600_000` = 1h, matching
  data-lifecycle; retention is in days so hourly is plenty granular).
- Full enumeration of `cancelled` consumer edit sites (the blast radius).
- Whether the reaper emits a sweep-summary event (mirroring `system.cleanup_completed`).

## Affected Systems
- `src/core/workspace-reaper/` (new) + `cli/commands/start/bootstrap.ts` wiring + `daemon/index.ts` start/stop.
- `src/core/orchestrator/pipeline/delivery/auto-merge.ts` (record `merged_at`; stop deleting; external backfill).
- `src/schemas/config.ts` (reshape `branch_retention_days`; remove `delete_branch_after_merge` + `CleanupConfig`).
- `src/schemas/task.ts` (`cancelled` state, transitions, permissions).
- `src/core/task-engine/state-machine.ts` (`completed_at` for `cancelled`).
- `src/core/daemon/task-scheduler.ts` + `daemon/index.ts` (`user_cancelled` routing; tick cancel-detection).
- `src/dashboard/api/tasks.ts` (cancel → `cancelled`).
- `src/cli/commands/cancel.ts` (new); confirm `retry.ts` excludes `cancelled`.
- Terminal-state consumers: `safety-layer/cost-tracker.ts`, `daemon/notification-router.ts`, `daemon/query-handler.ts`, `daemon/health-monitor.ts`.
- `src/adapters/git-hosting.ts` / `github-hosting` (wire + contract-test `closePR`).
- `docs/configuration/workspace.md`, `daemon.md`; `cli/bundled/templates.ts`; `cli/bundled/plugin-docs.ts`.

## Acceptance Criteria
- [ ] `workspace-reaper` service exists, starts/stops with the daemon, idempotent sweep.
- [ ] `branch_retention_days` honored (null/0/N); `delete_branch_after_merge` gone everywhere.
- [ ] auto-merge no longer deletes branches; records `merged_at` + audit + milestone (self) / no milestone (external).
- [ ] External-merge emits `git.pr_merged`; reaper deletes the branch per retention.
- [ ] `cancelled` is a first-class terminal state; all terminal-state consumers handle it.
- [ ] Cancelling an active task stops the agent promptly (no runaway cost) → converges to `cancelled` + reaped.
- [ ] Cancel of a task with an open PR closes the PR + reaps.
- [ ] Failed tasks are never reaped; retry/cancel resolve them.
- [ ] Push-only branches are never reaped.
- [ ] `engineer cancel` works; dashboard cancel writes `cancelled`.
- [ ] `CleanupConfig` removed; `closePR` wired + contract-tested.
- [ ] Reaper never reaps a live-dispatch workspace.
- [ ] Docs/templates/bundled-docs match the new config; closing standards sweep clean.
