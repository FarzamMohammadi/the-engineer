# Phase 9: Feedback & Rework Loop

---

## Flow

```
task.feedback_received event (from Phase 8 polling)
    │
    ▼
reviewHandler.handleFeedbackEvent(payload)
    ├─ Guard: task.state must be review_pending
    ├─ storeFeedbackRound(payload)
    │   └─ Append to task.review.feedback_rounds[]
    │      { stage, comments[], applied: false }
    │
    ├─ If feedback_type === "approved":
    │   ├─ stage === "demo" → handleDemoApproval()
    │   │   ├─ hosting.updatePR(draft: false)
    │   │   ├─ Update task.review.pr_state: "ready"
    │   │   ├─ Transition: review_pending.demo → review_pending.code
    │   │   └─ Comment: "Demo approved — PR marked ready for code review."
    │   └─ stage === "code" → handleCodeApproval()
    │       ├─ Check safetyLayer.checkAutoMergeAllowed(repo)
    │       ├─ If allowed: hosting.mergePR(repo, prNumber, "squash")
    │       ├─ Transition: review_pending.code → completed
    │       └─ Comment: "Code approved — PR auto-merged." or "ready to merge."
    │
    └─ If feedback_type === "changes_requested":
        └─ handleFeedbackRework()
            ├─ Transition: review_pending → queued ("feedback_rework:changes_requested")
            └─ Comment: "Reviewer feedback received — reworking."
```

---

## Production Files

| # | File | Role |
|---|------|------|
| 1 | `src/core/daemon/review-handler.ts` | Feedback event handling, approval/rework flows |

---

## Rework Re-Dispatch

After rework transitions task back to `queued`:

1. **Scheduler picks up task** on next tick (`scheduleNext()`)
2. **Rework detection**: `task.review.feedback_rounds.some(r => !r.applied)` → true
3. **Checkpoint cleared**: Task restarts from intake (not from checkpoint)
4. **Existing workspace reused**: `registerExistingWorkspace()` — worktree preserved
5. **Feedback injected into prompts**:
   - `buildIntakePrompt()` includes unapplied feedback rounds
   - `buildExecutionPrompt()` includes reviewer comments
6. **LLM makes targeted fixes** based on feedback
7. **Push to existing PR**: `prManager.commitPushAndCreatePR()` detects rework
   - Commits with `fix: address review feedback`
   - Pushes to same branch (PR updated automatically)
   - Marks all feedback rounds as `applied: true`

---

## Feedback Round Lifecycle

```
feedback_rounds: [
  { stage: "demo", comments: [...], applied: false }   ← stored on changes_requested
                                                         ↓
  { stage: "demo", comments: [...], applied: true }     ← marked on successful push
]
```

- Created with `applied: false` on any feedback event
- Set to `applied: true` when `prManager.commitPushAndCreatePR()` succeeds in rework
- Approved feedback is stored with `applied: true` immediately (no rework needed)

---

## State Machine Trace

```
review_pending.demo ──(changes_requested)──→ queued
    │                                           │
    │                                      (scheduled)
    │                                           │
    │                                      active.working
    │                                           │
    │                                    (7 phases re-run)
    │                                           │
    │                                    review_pending.demo
    │                                           │
    ├──(demo_approved)──→ review_pending.code
    │                           │
    │                      (changes_requested)──→ queued → ... → review_pending.code
    │                           │
    │                      (code_approved)──→ completed
```

Rework can happen at both demo and code review stages. Each cycle creates a new session but reuses the workspace.

---

## Auto-Merge Policy

On code approval:
- `safetyLayer.checkAutoMergeAllowed(repo)` — per-repo config
- If allowed: `hosting.mergePR(repo, prNumber, "squash")`
- If merge fails: task still completes, comment "auto-merge failed, please merge manually"
- If not allowed: task completes, comment "ready to merge"

---

## Test Files

| File | Type |
|------|------|
| `src/core/daemon/review-handler.test.ts` | Unit — feedback handling, rework flow |
