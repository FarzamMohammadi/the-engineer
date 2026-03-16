# Phase 10: Completion & Cleanup

---

## Flow

```
Task reaches terminal state via one of:
    │
    ├─ A. Code approved (Phase 9) → completed
    ├─ B. PR merged externally (Phase 8 merge detection) → completed
    ├─ C. Pipeline completed without PR (rare) → completed
    ├─ D. Blocked escalation timeout → failed
    │
    ▼
handleTaskCompletion() or completeTaskOnMerge()
    ├─ State transition → completed (or failed)
    ├─ checkAndEmitChildrenAllDone(taskId)
    ├─ workspaceManager.cleanupWorkspace(taskId, preserveBranch: true)
    │   ├─ git worktree remove {path} --force
    │   └─ (branch preserved for PR reference)
    ├─ notifications.sendCompletion(taskId, title)
    ├─ notifications.commentOnTaskIssue("Task completed." or "PR merged.")
    └─ Emit workspace.cleaned event
```

---

## Production Files

| # | File | Role |
|---|------|------|
| 1 | `src/core/daemon/task-scheduler.ts` | `handleTaskCompletion()` — outcome routing |
| 2 | `src/core/daemon/review-handler.ts` | `completeTaskOnMerge()` — merge detection path |
| 3 | `src/core/workspace-manager/index.ts` | `cleanupWorkspace()` — git worktree removal |
| 4 | `src/core/daemon/notification-router.ts` | Completion notifications |
| 5 | `src/core/daemon/index.ts` | `handleChildrenAllDone()` — parent task resume |

---

## Completion Paths

### Path A: Code Approved (from Phase 9)
1. `handleCodeApproval()` transitions → completed
2. Optional auto-merge via `hosting.mergePR()`
3. Standard cleanup + notifications

### Path B: PR Merged Externally
1. `checkMerges()` detects `status.state === "merged"`
2. If was in demo sub_state: transition demo → code first
3. Transition → completed (reason: "pr_merged")
4. Cleanup workspace (preserve branch)
5. Send completion notification

### Path C: Pipeline Completed (no PR)
1. All 7 phases finish without PR creation
2. `handleTaskCompletion()` with outcome "completed"
3. Standard cleanup

### Path D: Failed (blocked escalation)
1. `checkBlockedEscalation()` fires final stage
2. Transition → failed (reason: "blocked_timeout_escalation")
3. Send escalation alert

---

## Workspace Cleanup: `cleanupWorkspace()`

| Step | Action | Notes |
|------|--------|-------|
| 1 | Look up workspace record | Idempotent: returns if not found |
| 2 | `git worktree remove {path} --force` | Handles dirty working trees |
| 3 | Branch deletion (if !preserveBranch) | Wrapped in try-catch |
| 4 | Remove from internal map | `workspaces.delete(taskId)` |
| 5 | Emit `workspace.cleaned` | `{ task_id, branch_preserved }` |

Branch is always preserved on completion (for PR reference). Only deleted on explicit cleanup.

---

## Child Completion: `checkAndEmitChildrenAllDone()`

Called after any child reaches terminal state:

1. Get child's `parent_id`
2. Fetch all siblings: `taskEngine.getChildren(parent_id)`
3. Check if ALL siblings are in `completed` or `failed`
4. If yes: emit `task.children_all_done` event
   - `{ parent_task_id, child_ids, all_succeeded, failed_ids }`

### Parent Resume: `handleChildrenAllDone()`

EventBus subscriber in Daemon:

1. Get parent task, verify `active.supervising`
2. Transition → `active.integrating`
3. Build child summaries (title, branch, PR number, test status, decisions)
4. Update `task.child_summaries`
5. Re-dispatch parent to Orchestrator → enters integration phase

---

## Notifications

| Event | Template | Channels |
|-------|----------|----------|
| Completion | "Task '{title}' completed successfully." | Telegram + GitHub issue |
| PR merged | "PR merged — task completed." | GitHub issue |
| Error | "Task '{title}' encountered an error: {reason}" | Telegram + GitHub issue |
| Review pending | "Pull request created — awaiting review." | Telegram + GitHub issue |

All notifications are fire-and-forget (`.catch(err => logger.error(err))`).

---

## State Transitions

| From | To | Reason |
|------|----|--------|
| `review_pending.code` | `completed` | code_approved / code_approved_merged |
| `review_pending.{demo,code}` | `completed` | pr_merged |
| `active.working` | `completed` | pipeline_completed |
| `blocked` | `failed` | blocked_timeout_escalation |

---

## Test Files

| File | Type |
|------|------|
| `src/core/daemon/task-scheduler.test.ts` | Unit — completion handling |
| `src/core/workspace-manager/index.test.ts` | Unit — cleanup |
| `src/core/daemon/notification-router.test.ts` | Unit — notifications |
