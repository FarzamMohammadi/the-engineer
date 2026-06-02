# PR Management Flow

How The Engineer turns a reviewed change into a merged pull request — and how it reacts to everything that happens on that PR after it opens.

PR management is two cooperating pieces:

- The pipeline's **delivery phase** — the sub-phases that describe, push, open, and (on approval) merge the pull request.
- The daemon's **PR-event poller** — a background loop that watches each open PR and feeds review feedback, CI results, approvals, and merges back into the task.

Everything upstream of delivery (requirements → research → planning → execution → review) is identical no matter how the work ships. Only delivery changes shape, and it changes by configuration, not by branching code.

## The two deliverables

The whole pipeline exists to produce **one of two deliverables**, chosen by `workspace.pr.skip_pr_creation` (global default, per-repo override):

| Mode | Setting | Deliverable | Done when |
|------|---------|-------------|-----------|
| **PR mode** (default) | `skip_pr_creation: false` | A reviewed, merged pull request | The PR is merged |
| **Push-only mode** | `skip_pr_creation: true` | A pushed branch — no PR, no review, no merge | The branch is pushed |

In push-only mode, every PR-specific delivery sub-phase skips and the task completes as soon as the branch is pushed. It is a deliberate escape hatch for operators who own the downstream PR process themselves.

## Delivery sub-phases

In PR mode, delivery runs four sub-phases in order, then waits:

1. **`pr-description`** — an agent pass that writes the PR narrative to a deliverable file (`thoughts/delivery/pr-description.md`) that `create-pr` later reads.
2. **`push`** — commits anything the agent left uncommitted (a safety net; execution commits as it goes), then pushes the branch through the workspace manager's authenticated push. Runs in **both** modes — it is the entire deliverable in push-only mode. A push that cannot run throws, and the task blocks loud and recoverable; nothing to push is a clean advance.
3. **`create-pr`** — opens the pull request: it composes the title and body (plugin decorations + a trigger reference + the agent's narrative + a footer), opens the PR through the git hosting plugin, records the PR number on the task, and notifies. On a **rework re-entry** (the PR already exists), it instead dismisses the now-stale approval and marks the addressed feedback applied — see [The rework loop](#the-rework-loop).
4. **`await-review`** — parks the task in the `awaiting_pr_review` block and exits the pipeline. This is an expected wait, not a failure and not a separate state: the task is `blocked`, and the poller resumes it when an external event arrives.

A fifth sub-phase, **`auto-merge`**, is **entry-only** — the normal advance path stops at `await-review` and never reaches it. It runs only when an external `pr_ready_to_merge` or `pr_merged` event re-enters the task there.

In push-only mode, `pr-description`, `create-pr`, `await-review`, and `auto-merge` all skip; only `push` runs, and the task completes.

### Key files

| Concern | File |
|---|---|
| Delivery sub-phases | `src/core/orchestrator/pipeline/delivery/{pr-description,push,create-pr,await-review,auto-merge}.ts` |
| PR-vs-push-only skip gate | `src/core/orchestrator/pipeline/delivery/deliverable.ts` |
| Background PR-event polling | `src/core/daemon/pr-event-poller.ts` |
| Core PR-event policy (routing, arbitration, dedup, `/approve`) | `src/core/orchestrator/pipeline/pr-events.ts` |
| Re-entry wiring (consume the pending event, start at its entry point) | `src/core/orchestrator/index.ts` |

## Waiting and re-entry

Once the PR is open, the task sits in `blocked(awaiting_pr_review)`. The daemon's PR-event poller drives everything from here.

Each tick, for every task waiting on review, the poller asks the git hosting plugin **what events currently hold** on the PR (`detectPrEvents`), filters them through Core policy, picks a single winner, and re-enters the task by writing the winning event's **type** onto it (`pending_pr_event`) and re-queuing it. On the next dispatch, the orchestrator reads that type, starts the pipeline at the event's entry point, and clears it.

The event vocabulary is small and typed. Only `pr_comments` carries data (the comments, so Core can dedup and find an authorized `/approve`); the rest are bare signals whose detail is re-derived live when needed:

| Event | Means | Re-enters at |
|---|---|---|
| `pr_comments` | Actionable reviewer feedback | requirements |
| `pr_ci_failure` | Checks are red | execution (`implement`) |
| `pr_merge_conflict` | The base moved; the branch no longer merges | execution (`implement`) |
| `pr_ready_to_merge` | Approved **and** CI green **and** mergeable, all at once | delivery (`auto-merge`) |
| `pr_merged` | Merged, by us or externally | delivery (`auto-merge`) |

Three Core policies shape this, all living in `pr-events.ts` so a hosting plugin never re-implements them:

- **Arbitration.** Several events can hold in one poll (a comment *and* an approval). `arbitrate` picks one winner by precedence — `pr_merged` > `pr_comments` > `pr_merge_conflict` > `pr_ci_failure` > `pr_ready_to_merge` — so pending feedback is always addressed before a merge proceeds.
- **Dedup.** `pr_comments` is filtered against the task's `accommodated_comment_ids`, so the same feedback never reworks the task twice.
- **Stateless readiness.** The plugin reports `pr_ready_to_merge` only when approval, green CI, and mergeability all hold *at the same time*, recomputed every poll. "Approved but CI still running" reports nothing — the task simply keeps waiting.

Re-entry flows entirely through the database (write the event, re-queue, re-dispatch). There is no back-channel call from the daemon into the orchestrator, so the boundary stays one-directional and crash-safe: the pending event lives on the task row and survives a restart.

## The merge

`auto-merge` performs the merge. Because it is reached only by a `pr_ready_to_merge` / `pr_merged` re-entry, the PR was just observed ready — but state can shift in the moment between the signal and the merge, so `auto-merge` **re-derives readiness from the live PR** before acting, then routes on what it finds:

| What `auto-merge` finds | What it does |
|---|---|
| Already merged | Records the merge (no milestone — the external-merge backfill) and completes the task |
| Auto-merge disabled for the repo | Notifies the owner and completes — the human merges manually |
| CI failing | Reworks: jumps back to execution to fix it |
| Not mergeable (conflict) | Reworks: jumps back to execution to resolve it |
| Checks not yet green | Returns to the review wait; the poller retries when the PR is ready |
| Green and mergeable | Removes branch thoughts (if configured), merges with the configured strategy, records the merge |

A successful merge *records* the merge: it stamps `review.merged_at` on the task, publishes **`git.pr_merged`** (from the **orchestrator**), and notifies the *Merged PR* milestone. `auto-merge` does **not** delete the branch — the daemon's **workspace reaper** is the sole branch deleter and removes the merged branch once `workspace.pr.branch_retention_days` has elapsed, publishing **`git.branch_deleted`** (from the **workspace-reaper**). An externally-merged PR takes the same record path with no milestone — the external-merge backfill — so the reaper can reap its branch too. The local worktree is reaped separately by the scheduler's normal completion path.

**Auto-merge is off by default.** `safety.merge.auto_merge_after_approval` defaults to `false`, so by default an approval *completes* the task and the owner merges the PR themselves. The merge strategy (`squash` / `merge` / `rebase`) comes from `workspace.pr.default_merge_strategy`; `safety.merge.exclude_thoughts_on_merge` removes branch-introduced `thoughts/` files before the merge.

## The rework loop

When a review event needs work rather than a merge, the task re-enters the pipeline and runs forward again:

- **New feedback** (`pr_comments`) re-enters at **requirements** — feedback can change scope, so it runs the full pipeline forward (trivial-complexity skip-gates carry it past research/planning as needed). The feedback rides into the re-entered phase as context.
- **CI failure / merge conflict** re-enters at **execution** (`implement`) to fix the root cause and re-push.

When the rework reaches delivery again, `create-pr` sees the PR already exists: it **dismisses the stale approval** (the code changed, so the prior sign-off no longer applies) and marks the addressed feedback applied, then `await-review` parks the task again. A human re-approves to re-trigger the merge — that human gate is what bounds the loop, alongside a global `total_reworks` ceiling on a single dispatch.

## The `/approve` path

A sole contributor cannot formally approve their own PR on the host, so The Engineer recognizes a `/approve` (or `/approved`) comment as an approval. This path is **gated by `safety.merge.enable_comment_approval`** (off by default — with it off, `/approve` comments are ignored).

When enabled, the poller promotes an authorized `/approve` to a merge only after a **live re-check** confirms the PR is open, green, and mergeable — the same preconditions a formal approval must meet. A not-yet-green `/approve` leaves the task waiting rather than attempting a doomed merge. Authorization is Core policy: when an owner or reviewer is configured, the commenter's GitHub handle must match one of them; when no one is configured, any `/approve` counts (a permissive floor for the single-contributor case). The plugin only reports the comment as a fact — it never learns the `/approve` convention or sees the people directory.

## Notifications

Every transition the owner cares about leaves a trail. The owner's channels receive **milestones**; the source ticket receives **comments**:

| When | Channel | Message |
|---|---|---|
| Work picked up | milestone + ticket | "Starting work on: {title}" / "Starting work on this ticket." |
| PR opened | milestone + ticket | "PR created: {url}" |
| Reviewer feedback re-queues the task | ticket | "Reviewer feedback received — reworking to address it." |
| CI failure re-queues the task | ticket | "CI is failing on the pull request — reworking to fix it." |
| Merge conflict re-queues the task | ticket | "The pull request has merge conflicts — reworking to resolve them." |
| Rework pushed | ticket | "Pushed rework addressing review feedback." |
| Approval + green re-queues for merge | ticket | "Pull request approved with CI green — merging." |
| External merge detected | ticket | "Pull request merged — finalizing." |
| Auto-merge disabled, PR ready | ticket | "PR #{n} is approved and ready. Auto-merge is disabled for this repo — merge it when you're ready." |
| Merge completed | milestone | "Merged PR #{n}" |

## Resilience

Readiness is computed statelessly from the live PR on every poll, so there is no in-memory wait-state to lose. An earlier design tracked "approved, waiting on CI" in a daemon-memory map; a restart mid-wait could strand a task forever with nothing to alert. That class of bug cannot occur here — after a restart, the poller simply re-derives readiness from the PR.

## Configuration

PR management reads its configuration from two files (documented there, not duplicated here):

- **[`safety.yaml`](../../configuration/safety.md) → `merge.*`** — `auto_merge_after_approval`, `enable_comment_approval`, `exclude_thoughts_on_merge`.
- **[`workspace.yaml`](../../configuration/workspace.md) → `pr.*`** — `default_merge_strategy`, `branch_retention_days`, `skip_pr_creation`.

The review-polling circuit breaker (`review_polling.*`) lives in [`daemon.yaml`](../../configuration/daemon.md).
