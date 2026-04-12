# PR Management — End-to-End Flow

PR management spans three phases of The Engineer's pipeline: **demo_prep** (creation), **review_pending** (polling, feedback, CI gate), and **completion** (merge, cleanup). This document covers every code path, decision point, and notification in the lifecycle.

## Key Files

| Component | File | Role |
|---|---|---|
| PR creation | `src/core/orchestrator/pr-manager.ts` | commitAndPush + createPullRequest (split workflow) |
| Review polling | `src/core/daemon/review-handler.ts` | Detect reviews, approvals, merges |
| CI gate + merge | `src/core/daemon/review-handler.ts` | Check CI, attempt merge, pipeline fix |
| GitHub API | `src/plugins/git-hosting/github-hosting/github-hosting.ts` | All GitHub REST operations |
| Notifications | `src/core/daemon/notification-router.ts` | Route milestone notifications |
| Workspace/git | `src/core/workspace-manager/index.ts` | Worktrees, push, branch cleanup |
| Safety policy | `src/core/safety-layer/policy-engine.ts` | Auto-merge config, scope checks |

---

## 1. PR Creation

The PR workflow is split into two independent steps: **commit+push** and **PR creation**. Each step returns a discriminated result that the phase runner matches on — errors block the task and notify the owner instead of silently continuing.

**Entry points:** `commitAndPush()` and `createPullRequest()` in `pr-manager.ts`

Called by `tryCommitPushAndCreatePR()` in `phase-runner.ts` after the demo_prep phase completes.

### Step 1: commitAndPush

```
commitAndPush(sessionId, taskId, dispatch)
  |
  +-- No workspace path?  → nothing_to_push (skip — continue pipeline)
  +-- No workspace record? → nothing_to_push (skip — continue pipeline)
  |
  +-- git add -A
  +-- git diff --cached --quiet  (anything to commit?)
  |     |
  |     +-- YES: git commit -m "feat: {title}" (or "fix: address review feedback" for rework)
  |     +-- NO:  check rev-list count ahead of base
  |               +-- 0 ahead: nothing_to_push (skip)
  |
  +-- workspaceManager.pushBranch(taskId)  (token injected at operation time, never persisted)
  |
  +-- Returns: { outcome: "pushed", committed: boolean }
  |            { outcome: "nothing_to_push" }
  |            { outcome: "error", step: "commit"|"push", reason: string }
```

**On error:** Task transitions to `blocked`, owner notified via `task_error`, session ends. The task waits for human resolution (e.g., fix credentials) and can be unblocked to retry from the same phase.

### Step 2: createPullRequest

Only called after `commitAndPush` returns `"pushed"`.

```
createPullRequest(sessionId, taskId, demoPrepOutput, dispatch)
  |
  +-- Is rework? (task.review.pr_number exists?)
  |     |
  |     +-- YES: dismiss stale approvals (gitHosting.dismissApprovals)
  |     |        mark all feedback_rounds as applied
  |     |        notify "Pushed rework"
  |     |        → rework_pushed
  |     +-- NO:  continue to PR creation
  |
  +-- No git hosting plugin? → no_hosting_plugin (skip — continue pipeline)
  |
  +-- Resolve PR description (demoPrepOutput > deliverable file > default)
  +-- Sanitize secrets from description
  +-- Apply pr_decorations if present (plugin-blind, all values opaque):
  |     +-- title: [title_prefix] <AI title> [title_suffix]  (space-joined)
  |     +-- description: [description_prefix] > trigger ref > AI description > [description_suffix] > --- > branding
  +-- gitHosting.createPR({ repo, branch, base, title, body, draft: false })
  +-- Update task: review = { pr_number, pr_state: "ready", ... }
  +-- Notify: "PR created: {url}" (milestone + ticket comment)
  |
  +-- Returns: { outcome: "created", pr_number, url }
  |            { outcome: "rework_pushed" }
  |            { outcome: "no_hosting_plugin" }
  |            { outcome: "error", step: "pr_creation", reason: string }
```

**On error:** Same as commitAndPush — task blocks, owner notified, awaits human resolution.

### Phase Runner Orchestration

```
tryCommitPushAndCreatePR()  (phase-runner.ts)
  |
  +-- commitAndPush()
  |     +-- nothing_to_push → return null (continue pipeline to integration)
  |     +-- error           → blockForPrWorkflowError() (task blocked, owner notified)
  |     +-- pushed          → continue to step 2
  |
  +-- createPullRequest()
        +-- no_hosting_plugin → return null (continue pipeline)
        +-- error             → blockForPrWorkflowError() (task blocked, owner notified)
        +-- created / rework_pushed → exit with review_pending
```

### Notifications

| Event | Kind | Message |
|---|---|---|
| PR created | `milestone` + `ticket_comment` | "PR created: {url}" |
| Rework pushed | `ticket_comment` | "Pushed rework addressing review feedback." |
| Commit/push/PR failed | `task_error` | "PR workflow failed at {step}: {reason}" |

---

## 2. Review Polling

**Entry point:** `checkFeedback()` — called every daemon tick for all `review_pending` tasks.

### Aggregate State Resolution

For each task, three API calls in parallel:
1. `hosting.getReviewStatus()` — formal GitHub reviews
2. `getCachedPRStatus()` — PR state, CI status (cached per tick)
3. `fetchFilteredPRComments()` — PR comments as `PRComment[]` with IDs (self-authored filtered out)

**Precedence:**
```
changes_requested  >  approved  >  comment  >  null (no action)
```

### Comment-Based Approval

When `enable_comment_approval: true` in safety config:
- Detects `/approve` or `/approved` as standalone comment
- Validates author against People Directory (owners + reviewers)
- If no people configured, anyone can approve (solo dev mode)
- Formal reviews always take precedence over comment commands

### Feedback Accommodation Tracking

Two-tier dedup prevents both per-tick redundancy and cross-rework-cycle infinite loops:

**Tier 1 — Persistent accommodation (survives restarts and rework cycles):**
- `task.review.accommodated_comment_ids` — PR comment IDs already queued for rework
- `task.review.accommodated_review_state` — last aggregate state that was processed
- `hasUnaccommodatedFeedback()` checks: are there new comment IDs not in the set? Has the aggregate state changed? If neither → skip emission entirely.
- Updated when new feedback is detected, before event emission.

**Tier 2 — In-memory dedup (within a single review_pending stay):**
- `emittedFeedbackKeys` map: `"${aggregateState}:${commentCount}"` per task
- Same state + same comment count = no re-emission within the same cycle
- Cleared on rework (`handleFeedbackRework`) and merge failure (`allowApprovalRetry()`)
- Pruned each tick for tasks no longer in `review_pending`

Tier 1 is the primary gate — it prevents the infinite rework loop where persistent PR comments are re-detected as "new" after rework completes. Tier 2 is a cheap optimization that prevents redundant event emission within a single polling cycle.

### Merge Detection

`checkMerges()` — also called every tick. If PR state is `"merged"` (someone merged manually on GitHub), complete the task immediately with reason `"pr_merged"`. Both auto-merge and manual merge paths converge through `finalizeTaskCompletion()`, which handles remote branch deletion (if `delete_branch_after_merge` is enabled), workspace cleanup, notifications, and children-done checks.

---

## 3. CI Gate

**Entry point:** `handleCodeApproval()` — called when an `approved` feedback event fires.

### Decision Tree

```
PR Approved
  |
  +-- auto_merge_after_approval enabled?
  |     |
  |     +-- NO:  complete task, notify "Code review approved — ready to merge."
  |     +-- YES: continue
  |
  +-- Fetch PR status (cached) — checks_state AND mergeable
  +-- checks_state?
        |
        +-- "pending":  add to approvedAwaitingCI map
        |               notify "Code approved — waiting for CI pipeline to complete before merging."
        |               (checkApprovedCI() polls on subsequent ticks — evaluates ALL checks when CI resolves)
        |
        +-- CI resolved (passing/failing/none):
              evaluatePostApprovalChecks(checks_state, mergeable)
              |
              +-- No failures:  attemptMerge() immediately
              +-- Failures found:  handlePostApprovalFailures(taskId, failures)
                                   (groups CI failure + merge conflict into ONE rework cycle)
```

### CI Polling Loop (`checkApprovedCI`)

Called every tick after `checkFeedback()`. For each task in the `approvedAwaitingCI` map:

```
Poll PR status (checks_state + mergeable)
  |
  +-- "pending":  keep in map, check again next tick
  |
  +-- CI resolved:  evaluatePostApprovalChecks(checks_state, mergeable)
        |
        +-- No failures:  notify "CI pipeline passed — proceeding with merge."
        |                 attemptMerge()
        |
        +-- Failures:     handlePostApprovalFailures()
                          (e.g., CI failing + merge conflicts → ONE grouped rework)
```

The map is pruned each tick — tasks no longer in `review_pending` are removed.

**Daemon restart:** the map is in-memory only. On restart, `checkFeedback()` re-detects the approval and re-enters the CI gate flow. Naturally idempotent.

### Tri-State Checks

`checks_state` in `PRStatus` schema is an enum: `"passing" | "failing" | "pending" | "none"`.

Resolved by querying **both** GitHub APIs in parallel (repos with GitHub Actions use the Checks API, while some use the legacy Status API — or both):

**Status API** (`repos.getCombinedStatusForRef`) — legacy commit statuses:
- `"success"` + total_count > 0 → `"passing"`
- `"pending"` + total_count > 0 → `"pending"`
- `"failure"` / `"error"` → `"failing"`
- total_count = 0 → `"none"`

**Checks API** (`checks.listForRef`) — GitHub Actions and third-party check runs:
- All completed with `success`/`skipped`/`neutral` → `"passing"`
- Any `in_progress`/`queued` → `"pending"`
- Any completed with `failure`/`cancelled`/`timed_out`/`action_required` → `"failing"`
- No check runs → `"none"`

**Combining:** worst state wins (`failing` > `pending` > `passing` > `none`). Both `"none"` = `"none"` (no CI configured). API exception → `"failing"` (fail-safe).

---

## 4. Merge Execution

**Entry point:** `attemptMerge()` — called when CI passes (or no CI).

### Pre-Merge: Thoughts Cleanup

If `exclude_thoughts_on_merge: true`:
1. Find files added by this branch (not pre-existing): `git diff --name-only --diff-filter=A origin/{base} -- thoughts/`
2. `git rm` those files
3. Commit: "chore: remove engineering thoughts before merge"
4. Push (token injected)

Non-fatal — merge proceeds even if cleanup fails.

### Merge Flow

```
tryRemoveThoughtsBeforeMerge()
  |
  v
hosting.mergePR(repo, prNumber, "squash")
  |
  +-- API exception:
  |     warn + allowApprovalRetry() + notify "will retry"
  |     (leave in review_pending, next tick retries)
  |
  +-- result.success = false:
  |     +-- "merge_conflict" (409):  handlePostApprovalFailures() — re-queue for resolution
  |     +-- "pr_not_mergeable" (405) / "network_error":  allowApprovalRetry() + notify, retry next tick
  |
  +-- result.success = true:
        update review.pr_state = "merged"
        transition to completed (reason: "code_approved_merged")
        finalizeTaskCompletion:
          delete remote branch (if delete_branch_after_merge, best-effort)
          workspace cleanup + notify + children-done check
```

### `allowApprovalRetry()`

On any merge failure, deletes the dedup key for this task. Without this, the next tick sees the same approval state, dedup suppresses re-emission, and `handleCodeApproval` never runs again — the task gets stuck.

---

## 5. Post-Approval Fix

**Entry point:** `handlePostApprovalFailures()` — called when post-approval checks detect issues (CI failure, merge conflicts, or both).

**Evaluation:** `evaluatePostApprovalChecks(checksState, mergeable)` — pure function that returns an array of `PostApprovalCheckFailure` objects. Extensible: adding a future check = adding one `if` block.

### Retry Counting

Counts `post_approval_fix` transitions in the task's state history (DB-persisted, survives restarts). Also counts legacy `pipeline_fix` for backward compatibility with in-flight tasks.

- Max retries: **3** (`MAX_POST_APPROVAL_FIX_RETRIES`)
- After 3 failures: complete task, notify listing all unresolved issues + "Please fix and merge manually."

### Rework Flow

```
evaluatePostApprovalChecks(checks_state, mergeable)
  |
  +-- Returns failure array (e.g., ["ci_pipeline", "merge_conflict"])
  |
  v
handlePostApprovalFailures(taskId, failures)
  |
  +-- Count post_approval_fix + pipeline_fix attempts in state history
  +-- attempt > 3?  complete task, give up
  |
  +-- Build ONE synthetic unapplied feedback round with ALL failure instructions:
  |     {
  |       stage: "code",
  |       applied: false,
  |       comments: [
  |         "Post-approval fix attempt N/3 — M issue(s) to resolve:",
  |         ...CI failure instructions (if applicable),
  |         ...merge conflict instructions (if applicable)
  |       ]
  |     }
  |
  +-- Reset accommodation state:
  |     accommodated_review_state = null
  |     accommodated_comment_ids = []
  |     (ensures fresh approval is detectable after rework)
  |
  +-- Transition: review_pending -> queued (reason: "post_approval_fix")
  +-- Clear dedup key + approvedAwaitingCI entry
  +-- Notify: "Post-approval issues: {list} — reworking (attempt N/3)."
```

**Key design:** Multiple issues are grouped into a single RRPIR cycle. This is critical for cost — each cycle consumes significant tokens. Without grouping, CI failure and merge conflicts would trigger separate cycles.

### How the Orchestrator Handles It

The synthetic unapplied feedback round triggers the existing rework path in the task scheduler:

1. `hasUnappliedFeedback = true` → checkpoint cleared → no resume
2. Orchestrator starts from **requirements_gathering** (full reflection)
3. The LLM sees the CI failure context in the feedback round
4. It investigates, fixes, pushes to the same branch
5. PR manager dismisses stale approvals on GitHub (the old approval was for different code)
6. Returns to `review_pending` → accommodation state is reset → awaits fresh approval
7. Reviewer re-reviews the updated PR → new approval detected → CI gate re-evaluates

The old approval is explicitly invalidated — changed code must not ride on a stale approval. This reuses the same code path as reviewer feedback rework, with the addition of approval dismissal on push.

---

## 6. Configuration

### safety.yaml — Merge Policy

```yaml
merge:
  auto_merge_after_approval:
    default: false                     # Global default (safety-first)
    repos:
      owner/internal-docs: true        # Per-repo override
  enable_comment_approval: false       # Allow /approve in PR comments
  exclude_thoughts_on_merge: false     # Remove thoughts/ before merge
```

### daemon.yaml — Review Polling

```yaml
review_polling:
  failure_window_ms: 300_000           # 5-minute sliding window
  max_failures_before_pause: 3         # Pause after 3 API failures in window
```

### scope.yaml — Branch Protection

```yaml
branches:
  merge_to: ["main"]                   # Only merge to these branches
```

---

## 7. Notification Matrix

Every notification the owner receives during PR lifecycle:

| Milestone | Kind | Message |
|---|---|---|
| PR created | milestone + ticket | "PR created: {url}" |
| Rework pushed | ticket | "Pushed rework addressing review feedback." |
| Commit/push/PR failed | task_error | "PR workflow failed at {step}: {reason}" — task blocked |
| Stale approvals dismissed | (logged, not notified) | Dismissed via GitHub API with "Re-review required" message |
| Approved, no auto-merge | completion + ticket | "Code review approved — ready to merge." |
| Approved, CI pending | ticket | "Code approved — waiting for CI pipeline to complete before merging." |
| CI passed (after wait) | ticket | "CI pipeline passed — proceeding with merge." |
| Post-approval issues | ticket | "Post-approval issues: {list} — reworking (attempt N/3)." |
| Fix retry limit hit | completion + ticket | "Post-approval issues ({list}) unresolved after N fix attempts. Please fix and merge manually." |
| Merge succeeded | completion + ticket | "Code approved — PR #X auto-merged." |
| Merge rejected | ticket | "Auto-merge rejected: {reason}. Will retry." |
| Merge API failed | ticket | "Auto-merge API call failed — will retry." |
| PR merged (detected) | completion + ticket | "PR merged — task completed." |
| Reviewer feedback | ticket | "Reviewer feedback received ({type}) — reworking." |

---

## 8. State Transitions

```
                    +-----------+
                    |  active   |
                    | (working) |
                    +-----+-----+
                          |
                    demo_prep completes
                          |
               +----------+----------+
               |                     |
          commit/push/PR         PR created
          failed (error)         or rework pushed
               |                     |
               v                     v
          +---------+       +----------------+
          | blocked |       | review_pending |<------ merge failure retry (same tick)
          | (human) |       |    (code)      |<------ CI pending (deferred, next tick)
          +----+----+       +-------+--------+
               |
          owner fixes
          issue, unblocks
               |
               v
           +--------+
           | queued  |  (re-dispatched, resumes at demo_prep)
           +--------+
                         |
          +--------------+--------------+
          |              |              |
     PR approved    PR approved    changes_requested
     all clear    CI/merge issues   or comment feedback
          |              |              |
          v              v              v
    attemptMerge   post_approval   feedback_rework
          |           _fix              |
     +----+----+    +----+----+    +----+----+
     |         |    |         |    |         |
  success   failure queued    give up  queued
     |         |    (rework)  (3 max)  (rework)
     v         |       |         |        |
 completed   retry     v         v        v
             next   active    completed  active
             tick  (working)            (working)
                      |                    |
                   ...loop...          ...loop...
```

---

## 9. Edge Cases

### PR workflow failure (commit, push, or PR creation)
- Each step returns a discriminated result: `nothing_to_push` (skip), `error` (block), or success
- On error: task transitions to `blocked`, owner receives `task_error` notification with the failing step and reason
- Blocked metadata includes `reason: "pr_workflow_failed"` and `waiting_for: "human"`
- On unblock: task re-dispatches, resumes at demo_prep, retries the full commit+push+PR flow
- Git operations are naturally idempotent — re-committing with no changes is a no-op, re-pushing is safe
- "Nothing to do" cases (no workspace, no changes ahead of base) continue the pipeline without blocking

### Daemon restart with pending CI
- `approvedAwaitingCI` map is in-memory — lost on restart
- Next tick: `checkFeedback()` re-detects approval, `handleCodeApproval()` re-evaluates CI
- Flow is naturally idempotent

### Merge conflicts after approval
- Detected pre-merge via `PRStatus.mergeable === false` (from adapter contract, not GitHub-specific)
- Detected mid-merge via HTTP 409 (`merge_conflict`) as a safety net
- Both routes trigger `handlePostApprovalFailures()` — the agent resolves conflicts, rebases, and pushes
- If CI is also failing, both issues are grouped into one rework cycle

### Concurrent reviewers
- Accommodation tracking uses comment IDs — only genuinely new comments trigger rework
- If reviewer B adds a comment after A approves, new comment ID detected → rework triggered
- Same comments after rework → suppressed by accommodation check

### Stale approval after post-approval rework
- When post-approval fixes push new code, the PR content has changed
- The old approval is dismissed on GitHub via `dismissApprovals()` (graceful degradation if API fails)
- Accommodation state is reset (`accommodated_review_state = null`) so the system can detect a fresh approval
- The reviewer sees the dismissal message on GitHub and knows re-review is needed
- Without these two mechanisms, the task would be stuck forever in `review_pending` (accommodation gate blocks re-detection of the same "approved" state)

### Manual merge on GitHub
- `checkMerges()` detects `state === "merged"` before feedback polling
- Task completes with reason `"pr_merged"` regardless of CI state
