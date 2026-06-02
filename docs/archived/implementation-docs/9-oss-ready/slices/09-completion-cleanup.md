# Slice 9: Completion & Cleanup (the reaper)

> **This file is the durable design record for terminal-task cleanup — the reaper.** It captures
> not just *what* was decided but *why*, because this reasoning seeds the eventual user-facing docs
> (how a task finishes, what gets cleaned up, how cancel works). Read it as a design narrative.
>
> **Status: RRP complete (Session 51). No code yet.** Working artifacts:
> `.claude/temp/requirements-gathering/slice-09-completion-cleanup.md` (requirements),
> `.claude/temp/research/slice-09-completion-cleanup.md` (research, observations-vs-inferences),
> `.claude/temp/create-plan/slice-09-completion-cleanup.md` (the panel-reviewed plan — full decision
> rationale + task breakdown live there). This file is the synthesis; the plan is the build script.

## Requirements

Gathered through co-owner Q&A (Session 51), grounded by direct reading of the real code (no
sub-agents), and the resulting plan stress-tested by a 4-panelist expert review (Torvalds, Hipp,
Technical Architect, The Engineer) against the actual source.

### Scope Framing — this is mostly *refinement*, not greenfield

Grounding overturned the roadmap's implied scope: **most "completion & cleanup" already works.**
The worktree is removed on completion (`task-scheduler.handleCompletedOutcome` →
`cleanupWorkspace(taskId, preserveBranch=true)`), completion notifications already fire, self-merge
already deletes the remote branch + emits `git.pr_merged`, and a periodic `data-lifecycle` service
already reaps DB rows + blobs + vacuum. What is genuinely missing is the **one owner of the cleanup
that cannot happen inline** — and that is what Slice 9 builds: a daemon-resident **reconciliation
reaper**, plus a first-class, *effective* `cancelled` state.

The slice also wires reserved/dead surface to its natural consumer (`branch_retention_days`,
`closePR`) and cuts genuinely dead config (`CleanupConfig`).

**The original roadmap item 11 "parent integration" is MOOT** — decomposition / child-tasks were cut
in Slice 6, so there are no child branches to integrate. Confirmed and dropped.

Out of scope (handed downstream):
- **Dashboard UI for `cancelled`** (chips, filters, reaper-run surfacing) → Slice 13. The *state* +
  CLI text land here; the *display* is Slice 13 (consistent with Slice 8's UI deferral).
- **Notification policy knobs** (quiet hours, batching), and the `DigestConfig.include` `cancelled`
  entry → Slice 10.
- **Reworking the dashboard cancel onto a shared task-engine** (cross-process refactor) → Slice 13.

### Goals (priority order)

1. **One idempotent reconciling owner of terminal cleanup.** Every terminal path — self-merged,
   externally-merged, push-only, failed, cancelled — converges to a correct end-state through one
   sweep, not scattered in-the-moment cleanup. Idempotent and crash-safe by construction.
2. **Effective cancel.** Cancelling a running task actually stops the agent — no runaway agent cost.
3. **Honest config.** No contradictory knobs, no dead config. Reserved surface is wired or cut.
4. **Loud and observable.** The reaper does unattended *destructive* git/network ops on a timer; a
   persistent failure escalates, it does not rot silently.
5. **Plugin-blind.** The reaper acts through adapter contracts (`closePR`, `deleteRemoteBranch`,
   hosting); Core still compiles and functions with every plugin deleted.

---

## The Architecture

This is the heart of the slice. Read this and you understand it.

### Why a reconciliation reaper (not event-driven, not minimal-cut)

Two cleanup triggers are inherently **asynchronous and out-of-process**, and they force the shape:

1. **Retention is a timer.** `branch_retention_days: N` means "delete N days after merge." There is
   no event "it is now N days later" — something must wake up and check.
2. **Cross-process cancel.** The dashboard and the CLI write the DB but are *not the daemon* — they
   cannot reach `workspaceManager`, `dispatchTracker`, or the hosting plugin. The cleanup must happen
   daemon-side, after the fact.

When the trigger is "time passed" or "another process changed the DB," reconciliation is not an
abstraction you reach for — it is the only correct shape. Event-driven cleanup here would be a
fast-path that silently misses (daemon down when the merge happened → branch never reaped). This is
the same stateless/idempotent philosophy Slice 8 established when it deleted the in-memory
`approvedAwaitingCI` map in favor of recomputing readiness every poll.

The minimal-cut alternative (fix the two real bugs, delete the speculative config) cannot honor
retention without becoming the reaper anyway, and leaves the cross-process cancel cleanup unsolved.

### The `workspace-reaper` service

A new daemon-resident service mirroring `data-lifecycle`'s shape (`{ start, stop, runOnce,
getLastRun }`, an injected `clock`, a `setInterval(interval_ms)` loop, an EVENTS declaration). It is
**separate** from `data-lifecycle` — that one is a pure local DB/blob janitor with no plugin or
network dependency; the reaper does git operations and calls the hosting plugin (network, fallible,
plugin-dependent). Folding the two would poison a clean module with a foreign failure model. It is
constructed **inside `createDaemon`** (unlike the daemon-independent `data-lifecycle`, built in
bootstrap) because it needs `dispatchTracker.isInFlight`.

### The reconciliation predicate

Each sweep, over **unreaped terminal tasks** (`state IN ('completed','cancelled') AND reaped_at IS
NULL`) that are **not currently dispatching** (`!dispatchTracker.isInFlight(id)` — never reap a
workspace out from under a running agent):

| Disposition | Reaper action |
|---|---|
| `completed` + `review.merged_at` set (a merge happened) | delete local + remote branch when `now − merged_at ≥ branch_retention_days` (`null` → never; `0` → this sweep; `N` → after N days) |
| `completed`, no merge marker (push-only) | the pushed branch **is the deliverable** — keep it; mark reaped (worktree already removed inline at completion) |
| `cancelled` | if an open PR exists: `commentOnPR` + `closePR`; then reap worktree + branch |
| `failed` | **skipped entirely** — preserved as debug evidence + retry source |

The worktree is a **backstop** here — completion already removes it inline; the reaper only catches
stragglers (a failed inline cleanup, or a cancelled task whose cleanup is cross-process).

### `reaped_at`: the soundness marker (all-or-nothing)

`cleanupWorkspace` deliberately **preserves** `task.workspace` (it is the orchestrator's resume
source-of-truth and the audit trail) — so there was no honest way to "clear the workspace pointer"
to stop the sweep reconsidering a task. Instead, a real nullable **`reaped_at` timestamp column** on
`tasks` is set **only after a fully-successful reap** (every applicable step succeeded). A partial
reap — e.g. worktree + local branch removed, then the remote delete throws — leaves `reaped_at` NULL,
so the next sweep retries; the branch is never orphaned and the workspace audit record stays intact.
This is the lynchpin that makes "crash-safe reconciliation" real rather than aspirational. The panel
flagged its absence as the single highest-risk gap.

### The `cancelled` terminal state

Cancel is **not** a failure — modelling it as one was the smell that would have forced reason-string
matching. A first-class state is justified by a **mechanical fork**, not just UI truthfulness:
- the reaper **reaps** `cancelled` but **preserves** `failed` (opposite policies);
- `cancelled` is **terminal/non-retryable**; `failed` is **retryable** (`failed → queued`).

Two behaviors switch on it → it is a real state. It threads through the schema + ~6 consumers + 4 SQL
sites; the ripple is **contained, not erased**, by a `TERMINAL_STATES` / `isTerminal()` SSOT that
collapses the 4 ad-hoc `completed || failed` predicate sites (one of which was a raw SQL string) —
closing a pre-existing §11 duplication. The 4 SQL literals in `001_schema.sql` and the 2 all-state
arrays in `query-handler` are hand-edited / enum-derived (a TS constant cannot reach SQL); they are
guarded by tests, not by the constant.

**The dedup landmine.** "A terminal task frees its idempotency key" is enforced in **two** places:
the app-level `queries.ts` (`state NOT IN (...)`) **and** the DB partial UNIQUE index in
`001_schema.sql:83`. Both must include `cancelled`, or re-triggering a cancelled source issue throws
`UNIQUE constraint` on INSERT and crashes the trigger poller. The guard is the one test that exercises
both layers: a **real INSERT** — create key K → cancel → INSERT key K again must succeed.

### Effective cancel, across processes

The dashboard and the new `engineer cancel` CLI both write `cancelled` via a **guarded, versioned**
transactional UPDATE — `SET state='cancelled', version = version + 1, … WHERE id = ? AND state IN
(<cancellable>)` — so the write participates in the daemon's optimistic-concurrency CAS (`version =
version + 1 WHERE version = ?`) and genuinely serializes against a concurrent daemon transition
(exactly one wins; the loser matches zero rows). The CLI opens the DB directly (like `retry.ts`) — it
is a separate process with no task-engine, so this is the *same* guarded-UPDATE pattern, not a
"via-the-engine" path.

For an **active** (running) task, the daemon's tick detects the cross-process flip — `for id of
dispatchTracker.getActiveTaskIds(): if getTask(id).state === 'cancelled' → terminate(id,
"user_cancelled")` — and aborts through Slice 6's existing terminate machinery (a new
`user_cancelled` `TerminationReason`). The agent subprocess gets SIGTERM'd; no runaway cost.
`terminate` is idempotent, so re-detecting on each tick until the dispatch settles is a safe no-op.
`handleTerminatedOutcome` handles `user_cancelled` in an **early-return branch placed before the
`routeForReason` total-record and the `exhaustive: never` check** — it observes and logs, and does
**not** re-transition (the DB is already `cancelled`; there is no `cancelled → cancelled` transition).

### Branch-deletion ownership: auto-merge → reaper

`auto-merge` stops deleting branches. It only **records** the merge: stamps `review.merged_at` (via
`new Date().toISOString()` — there is no clock on the orchestrator context), emits the `git.pr_merged`
audit, and notifies the "Merged PR" milestone *only* on a self-merge. The **external-merge backfill**
runs the same record path with no milestone (the user merged it themselves) — closing the audit gap
where the already-merged short-circuit previously returned `done` without recording anything. The
reaper is then the **sole** branch deleter. Deletion lags up to one sweep interval (default 1h) — but
the deliverable (the merge) is already complete and its milestone already fired, so nobody waits on
it. One deletion policy, one place, idempotent.

### The Deliverable framing (carried from Slice 8)

The reaper respects Slice 8's two deliverables:
- **PR mode** — done when *merged*; the merged branch is deleted per `branch_retention_days`.
- **Push-only** — done when *pushed*; the pushed branch **is the deliverable** and is never reaped.

---

## Decisions (locked record — full rationale in the plan)

- **D1** Reconciliation reaper (over event-driven / minimal-cut) — forced by timer-retention +
  cross-process cancel; idempotent/crash-safe.
- **D2** Reaper is the **sole** branch deleter; auto-merge only records the merge.
- **D3** Single `branch_retention_days` (`null`=keep / `0`=next sweep / `N`=days; default `0`,
  `.nonnegative()`); delete `delete_branch_after_merge`. (`0` ≠ today's *immediate* — it is "next
  sweep, ≤ interval"; an honest, accepted change.)
- **D4** Reaper never touches `failed` tasks (debug + retry); `preserve_branch_on_failure` cut.
- **D5** Distinct `cancelled` terminal state (mechanical fork: reap-vs-preserve, retry-vs-not).
- **D6** Effective active-cancel via a `user_cancelled` termination; early-return, no re-transition;
  idempotent `terminate` makes per-tick re-detection safe.
- **D7** Separate `workspace-reaper` service, built inside `createDaemon`.
- **D8** Cancel always reaps → the entire `CleanupConfig` section is cut.
- **D9** `cancelled` is terminal / non-retryable (`engineer retry` stays `{blocked, failed}`).
- **D10** External-merge backfill is audit-only (no redundant milestone).
- **D11** `engineer cancel` CLI = a guarded raw versioned UPDATE (CLI has no task-engine; == D14).
- **D12** Cancel-with-open-PR closes the PR (user need: no orphaned PR), wiring dead `closePR`;
  first to cut if Session 3 runs hot.
- **D13** `TERMINAL_STATES`/`isTerminal()` SSOT — collapses 4 predicate sites; 4 SQL + 2 array sites
  hand-edited/enum-derived and test-guarded (not constant-contained).
- **D14** Cancel writes are guarded **and versioned** (participate in the daemon's CAS).
- **D15** Stamp `merged_at` with `new Date().toISOString()`; the reaper service gets an injected clock
  for testable retention math. (We *choose* not to thread the host's real `merged_at` through the
  adapter — negligible gain at day granularity.)
- **D16** `reaped_at` marker + **all-or-nothing** reap (set only on full success; partial → retry).
- **D17** Reaper failure envelope + observability: re-entrancy guard, per-op timeout, already-gone =
  success, plugin-absent skip+log, per-task isolation, bounded-retry-then-`alert`, `getLastRun()`.

---

## Failure Model & Edge Cases

The reaper runs unattended destructive ops on a timer, so its failure envelope is load-bearing:
- **Remote branch already deleted** (host auto-deleted, or a human deleted it) → treated as success
  (desired state reached).
- **Hosting plugin unregistered** → skip the PR/remote step, still reap the local worktree + branch,
  log the reduced capability (§15 Fail Loud).
- **Network failure / hung delete** → bounded by a per-op timeout; the per-task reap is isolated and
  non-fatal to the sweep; `reaped_at` stays NULL → retried next sweep.
- **Registered-but-failing plugin** (revoked token, branch protection) → a reap-failure counter
  escalates to an `alert` after a threshold (absence of `git.branch_deleted` is not an alert).
- **Daemon restart mid-retention** → nothing lost; retention recomputed from the persisted
  `merged_at` every sweep.
- **Overlapping sweeps** → a re-entrancy guard (`if (running) return`) — the reaper's per-task network
  ops make overlap likelier than `data-lifecycle`'s DB deletes.
- **Cancel of a task with no workspace** → state transition only; nothing to reap.
- **Cancel race** (a dispatch completes naturally as the cancel lands) → the versioned CAS picks one
  winner; the "could not transition to completed" log on the losing side is **info**, an expected
  interleave, not a warn.

---

## Cross-Slice Handoffs

### Inbound (reserved/parked surface landing here)
- **`branch_retention_days`** (`schemas/config.ts`, reserved by Slice 8) → wired by the reaper.
- **External-merge audit gap** (Slice 8 sweep finding) → backfilled by `auto-merge` recording the
  already-merged path; the reaper deletes the branch.
- **`closePR`** (dead adapter method, built but uncalled) → wired by cancel-with-open-PR.

### Outbound
- **Slice 10 (Communication):** the cancel `ticket_comment` and the reaper's failure `alert` flow
  through the notification router; the reserved `notification.*` / `question_batching.*` policy knobs
  remain Slice 10's to honor; the `DigestConfig.include` `cancelled` entry is Slice 10's.
- **Slice 13 (Dashboard UI):** display of the `cancelled` state (chips/filters), the reaper run
  summary (`getLastRun`), and `reaped_at` visibility. Slice 9 emits the data; Slice 13 displays it.

---

## Session Breakdown (4 sessions, each green-on-commit, ≤ ~400–450k tokens)

Docs ride with the code that needs them (DoD item 7); the durable narrative + final cross-doc
verification fold into the closing sweep.

1. **State-model spine + terminal SSOT + `reaped_at`.** `cancelled` (enum, 4 transitions in, none
   out, permission row); `TERMINAL_STATES`/`isTerminal()`; `ReviewStateSchema.merged_at`; `reaped_at`
   column; the 4 `001_schema.sql` sites incl. the `:83` dedup index; refactor the 4 predicate sites;
   de-dup the query-handler arrays; client `TaskState` union. Gated by the e2e real-INSERT dedup test.
   (Spine only — nothing produces `cancelled`/`reaped_at` yet.)
2. **Reaper service + branch lifecycle + auto-merge** (+ its docs). Config reshape (single
   `branch_retention_days`; cut `delete_branch_after_merge` + `CleanupConfig`; add
   `daemon.workspace_reaper`); auto-merge records-not-deletes + external backfill + stale-comment
   rewrite; the `workspace-reaper` service (D17 envelope, all-or-nothing `reaped_at`, `getLastRun`),
   built inside `createDaemon`; move the `git.branch_deleted` publisher to the reaper.
3. **Cancel end-to-end** (+ its docs). `user_cancelled` + early-return handler + tick detection;
   guarded versioned cancel writes (dashboard + `engineer cancel`); reaper cancel branch (`closePR` +
   reap); `closePR` contract test.
4. **Slice narrative + closing standards sweep.** Finalize this file; cross-doc verification; the
   principle-driven sweep; `/wrap-session`.

---

## Future Considerations

- **Threading the host's real `merged_at`** through `GitHostingAdapter` if sub-day branch retention
  ever becomes a need (the github plugin already receives it from `pulls.get` and discards it).
- **Async reaper operations** if branch counts ever grow enough that per-sweep git/network latency
  matters (today: single-user, a handful of terminal tasks per sweep).

## Documentation Seed

For the documentation slice (Slice 12) and this slice's own doc updates:
- **"How a task finishes and gets cleaned up"** → the reconciliation predicate table + the
  deliverable framing (PR-mode branch reaped per retention vs push-only branch kept).
- **"How cancel works"** → the `cancelled` state + cross-process detection + active-abort.
- **"What the reaper guarantees"** → idempotent all-or-nothing reconciliation + the failure envelope.
