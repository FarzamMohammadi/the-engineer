# Session 58 (Slice 10 build) — 2026-06-04

Slice 10 (Communication), **S2 of the build plan: cancel/label coverage** (Pillar A).
Branch `slice10-build` (isolated worktree). Footwork: `.claude/temp/{requirements-gathering,research,create-plan}/slice-10-communication.md` (Session 56). Plan section: `create-plan` § S2.

> Naming note: logged as `58-slice10-s2.md` to mirror S1's `57-slice10-s1.md` (the bare `sessions/57.md`/`58.md` belong to the unrelated Dashboard Sync tangent — the Slice-10 build reused the session counter on its own branch).

## The gap S2 closes

A **non-active** cancel — a queued or blocked task cancelled via `engineer cancel` or the dashboard — got no source-ticket comment and kept a stale comm-plugin label forever. Cancel (and `engineer retry`) are raw DB writes (`task-engine/cancel.ts`) that emit no `task.state_changed`, so the daemon's `daemon:state-sync` subscription never fires `syncStateToCommPlugin` for them; and `cancelled` is terminal, so it never self-corrects. Only the *active*-cancel path emitted a comment (from the task-scheduler), and no path applied `engineer:cancelled`.

## What I did (one unit of work: code + tests + docs + observability)

Reaper-driven, because the reaper already visits every cancelled task exactly once via `getUnreapedTerminalTasks` until `reaped_at` is stamped.

1. **Single emitter in the reaper.** `src/core/workspace-reaper/index.ts`: `reapCancelledTask` now calls a new `announceCancel(task)` **before** any reap step or early return (so it covers the queued-cancel case, which has no workspace and early-returns). `announceCancel`:
   - `notify`s the `ticket_comment` "Task cancelled by the owner." (the same wording the scheduler used).
   - calls `notifications.syncStateToCommPlugin(...)` **directly** (not a synthetic `task.state_changed` event — that would wake every other state subscriber, e.g. the cost-tracker) with `to_state: cancelled`, so the comm plugin applies `engineer:cancelled`. Confirmed against `github-utils.diffStateLabels`: it derives the target label from the state and removes any other `engineer:`-prefixed label, so this works with **no label-set change** and ignores `from_state` (I pass `cancelled` for both — the prior state is not on the task row at reap time, and the diff does not use it).
   - emits a `state_transition` observation `cancel_reconciled` (`trigger: cross_process_cancel`, `commented`, `synced_label`) so the dashboard timeline shows *why* the label + comment appeared. `commented`/`synced_label` reflect whether each dispatch was issued; actual delivery is observable on the S1 `notification_delivered`/`notification_send_failed` observations.
   - **Isolated failure boundaries** (coding-standards §5): the comment, the label sync, and the observation each have their own try/catch — one failing never skips the others, and none can leave `reaped_at` NULL.
   - **First-visit idempotency guard** (`cancelAnnounced` Set, in-memory like `consecutiveFailures`): the cancel reap is all-or-nothing, so a failed PR-close/branch-delete leaves the task unreaped and revisited next sweep — but the comment is not idempotent, so the guard fires the announcement exactly once per task while unreaped, and clears on a successful reap (bounds memory; a process restart can re-announce once, acceptable for a best-effort courtesy comment).

2. **Removed the duplicate.** `src/core/daemon/task-scheduler.ts` `handleUserCancelledTermination` no longer emits the `ticket_comment` (the reaper is now the sole emitter for all cancels). Kept its `observer.info` abort record. The active-cancel still gets exactly one comment — from the reaper, when it reclaims the (now-`cancelled`, workspace-bearing) task.

3. **`engineer retry` self-heal — confirmed, no hook added.** Retry is a raw `failed → queued` DB write (no event), but the next dispatch's `dispatchTask` calls `requestTransition(queued → active.working)`, which publishes `task.state_changed` → `daemon:state-sync` → `syncStateToCommPlugin` → the label flips to `engineer:active`. So retry self-corrects on the next dispatch with no new code (verified `state-machine.ts` publishes the event).

4. **Docs.** `docs/usage-guide/writing-tickets.md` gained the `engineer:cancelled` label row + a short note that a cancel can come from `engineer cancel`/the dashboard and the label is reconciled on cleanup. No bundled mirror lists the label set (only `plugin-docs.ts` mentions `engineer:active` as a `label_prefix` example), so nothing to mirror.

## Tests

- `tests/unit/core/workspace-reaper/index.test.ts` (+4, now 26): queued-cancel (no workspace) → comment + `to_state: cancelled` sync + reaped; blocked-cancel (with workspace) → comment + sync + branch deleted + reaped; reaper retry across sweeps → exactly one comment + one sync (idempotent guard); sync throws → comment still posts and the reap still completes (isolation). Added a `syncStateToCommPlugin` mock + a `cancelComments` helper to the harness.
- `tests/unit/core/daemon/task-scheduler.test.ts` (test 20e rewritten): user-cancelled termination records the abort (`observer.info` spy) and makes **no** `ticket_comment` (the reaper owns it now), still no re-transition.

## Decisions / deviations

- **`from_state` on the reaper's sync payload = `cancelled`.** The task is already `cancelled` at reap time and the prior state is not stored on the task row; the label diff ignores `from_state` (derives the label from `to_state`). Using `cancelled` for both is honest as a *reconciliation* (`reason: reaper_cancel_reconciliation`), not a claim about the prior state. Documented in code.
- **Observation type = `state_transition` (`cancel_reconciled`), not `decision_point`.** The scope said "state_transition/decision observation"; this is a state change (per coding-standards §14: state changes → `state_transition`), and there is no fork/road-not-taken to record, so a decision_point would be the wrong type. The dashboard timeline renders any observation generically (`GenericObservationBody` + `JsonViewer` drill-down), so it surfaces with full input — no view change needed.
- **In-memory idempotency guard, not a DB marker.** Matches the existing `consecutiveFailures` pattern and the scope's framing ("a reaper that retries"). The within-process retry case (the one the scope names) is fully covered; a restart mid-retry can re-announce once.

## Gates

- lint: green (0 errors; 2 pre-existing `noExcessiveCognitiveComplexity` warnings in `notification-router.ts` `notify`/`processRetries` — same baseline as S1, none in S2's files).
- typecheck: clean (`tsc --noEmit` src + test tsconfig).
- tests: 2514 unit (S1's 2510 + 4 new reaper tests) + 64 integration + 16 e2e, all green.

## Discrepancies vs the footwork docs (reality wins)

- The reaper already had a PR comment ("This task was cancelled by the owner; closing the pull request.") in `closeOpenPr` — that is a *PR* comment on a different surface, NOT the source-ticket comment. S2 adds the source-ticket comment; the PR comment is unchanged.
- `getWorkspaceRecord` returning null (queued-cancel) early-returns before the PR/branch work, so `announceCancel` had to be placed at the very top of `reapCancelledTask`, before that early return — the queued-cancel still gets its comment + label.

## Out-of-scope notes for later sessions

- `PersonSchema.preferences` still carries `notification_level` + per-person `quiet_hours` (unwired scaffolding for the cut quiet-hours feature) — flagged by S1, still a candidate for the Slice 10 closing sweep. Not touched.
- The 2 `notification-router.ts` complexity warnings are pre-existing; left as-is (S6 audit territory if they are addressed at all).

## Next

S3 — decision-escalation engine + policy wiring (the one new BUILD capability): `DecisionsSchema` + central validation in `agent-step.mapResult`, the runner consults `consultJudgment({type: "should_i_ask"})` per surfaced decision, autonomy template defaults, `SafetyQuery` reconcile, threshold-absent fix.
