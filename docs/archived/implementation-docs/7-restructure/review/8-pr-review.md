# Phase 8: PR Creation & Review Lifecycle

---

## Flow

```
Phase 7 (demo_prep or fast-path self_review) completes
    │
    ▼
prManager.commitPushAndCreatePR()
    ├─ git add -A
    ├─ git diff --cached --quiet → has changes?
    ├─ git commit -m "feat: {title}"
    ├─ workspaceManager.pushBranch(taskId)    ← token-injected URL
    ├─ Is rework? (task.review.pr_number exists)
    │   ├─ YES: mark feedback applied, comment "Pushed rework", return true
    │   └─ NO: continue to PR creation
    ├─ gitHosting.createPR({ draft: true, ... })
    ├─ Update task.review { pr_number, pr_state: "draft", feedback_rounds: [] }
    ├─ Notify milestone + comment on source issue
    └─ return true
    │
    ▼
Pipeline exits → outcome: "review_pending"
Daemon transitions → review_pending.demo
    │
    ▼
Review polling begins (every tick):
    ├─ reviewHandler.checkMerges()     ← detect merged PRs
    └─ reviewHandler.checkFeedback()   ← detect approvals / changes_requested
```

---

## Production Files

| # | File | Role |
|---|------|------|
| 1 | `src/core/orchestrator/pr-manager.ts` | Commit, push, PR creation, rework detection |
| 2 | `src/core/daemon/review-handler.ts` | Merge detection, feedback polling, approval flows |

---

## PR Creation: `commitPushAndCreatePR()`

### Commit
- `git add -A` in worktree
- `git diff --cached --quiet` to detect staged changes
- Commit message: `feat: {task.title}` (new) or `fix: address review feedback` (rework)
- If no changes AND no commits ahead of base → return false (no PR)

### Push
- `workspaceManager.pushBranch(taskId)` — token injected into URL transiently (D151)
- Pushes to same branch on every invocation

### Rework Path
- Detects rework: `task.review.pr_number != null`
- Marks all feedback rounds as `applied: true`
- Comments "Pushed rework addressing review feedback."
- Does NOT create a new PR — pushes to existing branch

### New PR Path
- `gitHosting.createPR({ repo, branch, base, title, body, draft: true })`
- PR description sanitized via `sanitizeSecrets()` (D154)
- Updates `task.review`: `{ pr_number, pr_state: "draft", demo_artifacts: [], feedback_rounds: [] }`

---

## Review Polling: Merge Detection

`checkMerges()` — runs every tick for all `review_pending` tasks:

1. `hosting.getPRStatus(repo, pr_number)` → check state
2. If `state === "merged"`:
   - If sub_state was `demo`: transition demo → code first
   - Transition → `completed` (reason: "pr_merged")
   - `cleanupWorkspace(taskId, true)` — preserve branch
   - Send completion notification + comment on issue

---

## Review Polling: Feedback Detection

`checkFeedback()` — runs every tick:

1. **Circuit breaker**: Skip if 3+ API failures in 5-minute window
2. **Prune stale dedup**: Remove entries for tasks no longer in review_pending
3. For each task:
   - `hosting.getReviewStatus(repo, prNumber)` → reviewer states
   - `hosting.getPRStatus(repo, prNumber)` → draft status
   - `fetchPRCommentStrings()` → filter out engineer's own comments
   - `resolveAggregateState()` → "changes_requested" | "approved" | "comment" | null

### Self-Comment Filtering

`ENGINEER_COMMENT_MARKERS` list prevents the daemon from treating its own comments as human feedback. Critical for avoiding infinite feedback loops.

### Aggregate State Resolution

| Condition | Result |
|-----------|--------|
| Any reviewer requested changes | `changes_requested` |
| All reviewers approved | `approved` |
| Comments exist (no approval/rejection) | `comment` |
| No reviews yet | `null` |

### Event Emission (dedup)

- `review.poll_completed` — always emitted (observability)
- `task.feedback_received` — only if aggregate state changed (dedup key: `state:commentCount`)
  - Payload: `{ stage: "demo"|"code", feedback_type, reviewer, content, pr_number }`

---

## State Transitions in This Phase

| From | To | Trigger |
|------|----|---------|
| `active.working` | `review_pending.demo` | PR created (pipeline exit) |
| `review_pending.demo` | `review_pending.code` | Demo approved |
| `review_pending.code` | `completed` | Code approved (+ optional auto-merge) |
| `review_pending.{demo,code}` | `completed` | PR merged externally |

---

## Test Files

| File | Type |
|------|------|
| `src/core/orchestrator/pr-manager.test.ts` | Unit — commit, push, PR creation |
| `src/core/daemon/review-handler.test.ts` | Unit — merge/feedback polling |
