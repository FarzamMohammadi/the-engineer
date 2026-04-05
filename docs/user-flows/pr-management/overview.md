# PR Management — End-to-End Flow

PR management spans three phases of The Engineer's pipeline: **demo_prep** (creation), **review_pending** (polling, feedback, CI gate), and **completion** (merge, cleanup). This document covers every code path, decision point, and notification in the lifecycle.

## Key Files

| Component | File | Role |
|---|---|---|
| PR creation | `src/core/orchestrator/pr-manager.ts` | Commit, push, create/update PR |
| Review polling | `src/core/daemon/review-handler.ts` | Detect reviews, approvals, merges |
| CI gate + merge | `src/core/daemon/review-handler.ts` | Check CI, attempt merge, pipeline fix |
| GitHub API | `src/plugins/git-hosting/github-hosting/github-hosting.ts` | All GitHub REST operations |
| Notifications | `src/core/daemon/notification-router.ts` | Route milestone notifications |
| Workspace/git | `src/core/workspace-manager/index.ts` | Worktrees, push, branch cleanup |
| Safety policy | `src/core/safety-layer/policy-engine.ts` | Auto-merge config, scope checks |

---

## 1. PR Creation

**Entry point:** `commitPushAndCreatePR()` in `pr-manager.ts`

Called after the demo_prep phase completes. Handles both initial creation and rework pushes.

### Flow

```
Orchestrator completes demo_prep
  |
  v
commitPushAndCreatePR(dispatch, demoPrepOutput)
  |
  +-- git add -A
  +-- git diff --cached --quiet  (anything to commit?)
  |     |
  |     +-- YES: git commit -m "feat: {title}" (or "fix: address review feedback" for rework)
  |     +-- NO:  check rev-list count ahead of base
  |               +-- 0 ahead: skip PR entirely (nothing to push)
  |
  +-- workspaceManager.pushBranch(taskId)  (token injected at operation time, never persisted)
  |
  +-- Is rework? (task.review.pr_number exists?)
  |     |
  |     +-- YES: mark all feedback_rounds as applied, notify "Pushed rework", return
  |     +-- NO:  continue to PR creation
  |
  +-- Resolve PR description (demoPrepOutput > deliverable file > default)
  +-- Sanitize secrets from description
  +-- Apply pr_decorations if present (plugin-blind, all values opaque):
  |     +-- title: [title_prefix] <AI title> [title_suffix]  (space-joined)
  |     +-- description: [description_prefix] > trigger ref > AI description > [description_suffix] > --- > branding
  +-- gitHosting.createPR({ repo, branch, base, title, body, draft: false })
  +-- Update task: review = { pr_number, pr_state: "ready", ... }
  +-- Notify: "PR created: {url}" (milestone + ticket comment)
```

### Notifications

| Event | Kind | Message |
|---|---|---|
| PR created | `milestone` + `ticket_comment` | "PR created: {url}" |
| Rework pushed | `ticket_comment` | "Pushed rework addressing review feedback." |

---

## 2. Review Polling

**Entry point:** `checkFeedback()` — called every daemon tick for all `review_pending` tasks.

### Aggregate State Resolution

For each task, three API calls in parallel:
1. `hosting.getReviewStatus()` — formal GitHub reviews
2. `getCachedPRStatus()` — PR state, CI status (cached per tick)
3. `fetchPRCommentStrings()` — PR comments (self-authored filtered out)

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

### Dedup Logic

Every feedback emission is deduped by `"${aggregateState}:${commentCount}"` per task. Same state + same comment count = no re-emission. This prevents ~60K no-op events/week on active repos.

**Critical:** the dedup key must be cleared when merge fails (via `allowApprovalRetry()`) or the task gets stuck in a loop where approval is detected but never re-processed.

### Merge Detection

`checkMerges()` — also called every tick. If PR state is `"merged"` (someone merged manually on GitHub), complete the task immediately with reason `"pr_merged"`.

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
  +-- Fetch PR status (cached)
  +-- checks_state?
        |
        +-- "passing" or "none":  attemptMerge() immediately
        |
        +-- "pending":  add to approvedAwaitingCI map
        |               notify "Code approved — waiting for CI pipeline to complete before merging."
        |               (checkApprovedCI() polls on subsequent ticks)
        |
        +-- "failing":  handlePipelineFailure()
```

### CI Polling Loop (`checkApprovedCI`)

Called every tick after `checkFeedback()`. For each task in the `approvedAwaitingCI` map:

```
Poll PR status
  |
  +-- "passing" or "none":  notify "CI pipeline passed — proceeding with merge."
  |                         attemptMerge()
  |
  +-- "failing":  handlePipelineFailure()
  |
  +-- "pending":  keep in map, check again next tick
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
  |     warn + allowApprovalRetry() + notify "rejected: {reason}. Will retry."
  |     (leave in review_pending, next tick retries)
  |     Common reasons: "pr_not_mergeable" (405), "merge_conflict" (409)
  |
  +-- result.success = true:
        update review.pr_state = "merged"
        transition to completed (reason: "code_approved_merged")
        finalizeTaskCompletion: workspace cleanup + notify + children-done check
```

### `allowApprovalRetry()`

On any merge failure, deletes the dedup key for this task. Without this, the next tick sees the same approval state, dedup suppresses re-emission, and `handleCodeApproval` never runs again — the task gets stuck.

---

## 5. Pipeline Fix

**Entry point:** `handlePipelineFailure()` — called when CI is failing after approval.

### Retry Counting

Counts `pipeline_fix` transitions in the task's state history (DB-persisted). Survives daemon restarts.

- Max retries: **3** (`MAX_PIPELINE_FIX_RETRIES`)
- After 3 failures: complete task, notify "Please fix CI and merge manually."

### Rework Flow

```
Count pipeline_fix attempts in state history
  |
  +-- attempt > 3?  complete task, give up
  |
  +-- Add synthetic unapplied feedback round:
  |     {
  |       stage: "code",
  |       applied: false,
  |       comments: [
  |         "CI pipeline is failing (attempt N/3).",
  |         "The PR has been approved but cannot be merged until CI passes.",
  |         "Investigate the CI failure, fix the root cause, and push the fix."
  |       ]
  |     }
  |
  +-- Transition: review_pending -> queued (reason: "pipeline_fix")
  +-- Clear dedup key + approvedAwaitingCI entry
  +-- Notify: "CI pipeline failing — reworking to fix (attempt N/3)."
```

### How the Orchestrator Handles It

The synthetic unapplied feedback round triggers the existing rework path in the task scheduler:

1. `hasUnappliedFeedback = true` → checkpoint cleared → no resume
2. Orchestrator starts from **requirements_gathering** (full reflection)
3. The LLM sees the CI failure context in the feedback round
4. It investigates, fixes, pushes to the same branch
5. Returns to `review_pending` → next tick detects existing approval → CI gate re-evaluates

This reuses the same code path as reviewer feedback rework — no special-casing needed.

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
| Approved, no auto-merge | completion + ticket | "Code review approved — ready to merge." |
| Approved, CI pending | ticket | "Code approved — waiting for CI pipeline to complete before merging." |
| CI passed (after wait) | ticket | "CI pipeline passed — proceeding with merge." |
| CI failing | ticket | "CI pipeline failing — reworking to fix (attempt N/3)." |
| Fix retry limit hit | completion + ticket | "CI pipeline failed after N fix attempts. Please fix CI and merge manually." |
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
                    PR created/pushed
                          |
                          v
                 +----------------+
                 | review_pending |<------ merge failure retry (same tick)
                 |    (code)      |<------ CI pending (deferred, next tick)
                 +-------+--------+
                         |
          +--------------+--------------+
          |              |              |
     PR approved    PR approved    changes_requested
     CI passing     CI failing     or comment feedback
          |              |              |
          v              v              v
    attemptMerge   pipeline_fix    feedback_rework
          |              |              |
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

### Daemon restart with pending CI
- `approvedAwaitingCI` map is in-memory — lost on restart
- Next tick: `checkFeedback()` re-detects approval, `handleCodeApproval()` re-evaluates CI
- Flow is naturally idempotent

### "Head branch out of date" merge failure
- GitHub returns 409 (`merge_conflict`)
- `allowApprovalRetry()` clears dedup key
- Next tick: approval re-detected, CI re-checked, merge re-attempted
- If base branch keeps advancing, retry continues each tick
- Consider: future enhancement to rebase/merge base into branch

### Concurrent reviewers
- Dedup key: `"approved:{commentCount}"` — only first approval triggers merge flow
- If reviewer B adds a comment after A approves, key changes, re-emits — but aggregate state is still `approved`

### Manual merge on GitHub
- `checkMerges()` detects `state === "merged"` before feedback polling
- Task completes with reason `"pr_merged"` regardless of CI state
