# Requirements: Include Merge Resolution in Post-Approval Processes

## Task Description

Add merge conflict resolution as a post-approval process, and group it with the existing CI failure fix so that when multiple post-approval issues occur simultaneously (e.g., CI failing + merge conflicts), they are handled in a single RRPIR cycle instead of separate costly cycles.

Source: GitHub issue #15 (FarzamMohammadi/the-engineer)

## Gathered Context

### Current State: CI Failure Handling (commit d58c10a)

After PR approval, the system checks CI pipeline status in `handleCodeApproval()` (review-handler.ts):
- **CI passing** -> `attemptMerge()`
- **CI pending** -> defer to `checkApprovedCI()` (poll next tick)
- **CI failing** -> `handlePipelineFailure()` which:
  1. Counts previous `pipeline_fix` attempts from state history (max 3)
  2. Creates a synthetic unapplied feedback round with CI failure context
  3. Re-queues the task (transition to `queued` with reason `pipeline_fix`)
  4. The scheduler sees unapplied feedback, nullifies checkpoint, restarts from requirements_gathering
  5. The full RRPIR cycle runs with CI failure context, pushes fix, returns to review_pending

### Current State: Merge Conflict Handling (GAP)

In `attemptMerge()`, when `hosting.mergePR()` fails:
- **API exception** -> logs warning, calls `allowApprovalRetry()`, notifies "will retry", leaves in `review_pending`
- **`result.success === false`** (includes `merge_conflict` HTTP 409, `pr_not_mergeable` HTTP 405) -> same: retry next tick

**This is a retry loop, not a resolution mechanism.** If there are actual merge conflicts, retrying forever will never resolve them. The agent needs to be re-queued to resolve the conflicts.

### Available Infrastructure

1. **`PRStatus.mergeable: boolean`** — already returned by `getPRStatus()`, populated from GitHub's `pr.mergeable` field. Can detect conflicts BEFORE attempting merge.
2. **`classifyMergeError()`** in the GitHub plugin — already classifies HTTP 409 as `merge_conflict` and HTTP 405 as `pr_not_mergeable`.
3. **`MergeResult.error.code`** — already carries the classified error code back to the caller.
4. **`workspace.merge_conflict` event** — already defined in `src/schemas/events.ts` (with `task_id`, `source_branch`, `target_branch`, `conflicting_files`).
5. **Synthetic feedback round pattern** — proven by `handlePipelineFailure()`. Same mechanism applies for merge conflicts.

### The Core Design Problem: Grouping Post-Approval Issues

The owner's key insight: CI failure and merge conflicts can happen simultaneously. Currently `handleCodeApproval()` checks CI first, and only reaches `attemptMerge()` if CI passes. This means:
- If CI fails AND there are merge conflicts, only CI failure is detected
- After the agent fixes CI and returns, it discovers merge conflicts on the next merge attempt
- That triggers ANOTHER full RRPIR cycle — extremely wasteful

**Required behavior:** Before re-queuing, detect ALL post-approval issues and bundle them into one synthetic feedback round. One RRPIR cycle fixes everything.

### Design: Post-Approval Check Aggregation

The flow should become:

```
PR approved
  |
  v
Check CI status + Check mergeability (parallel or sequential)
  |
  +-- All clear (CI passing + mergeable) -> attemptMerge()
  |
  +-- Any issues found -> aggregate into one feedback round -> re-queue once
      Examples:
        - CI failing only -> "Fix CI pipeline"
        - Not mergeable only -> "Resolve merge conflicts"  
        - Both CI failing + not mergeable -> "Fix CI AND resolve merge conflicts"
```

This aggregation pattern is also extensible for future post-approval checks (e.g., branch protection changes, required status checks added).

### Key Implementation Points

1. **Where to detect mergeability:** In `handleCodeApproval()`, check `getPRStatus().mergeable` alongside `checks_state`. The `mergeable` field from GitHub tells us if there are conflicts without attempting the merge.

2. **Where to handle merge failure during actual merge:** In `attemptMerge()`, when `result.success === false` and `result.error.code === 'merge_conflict'`, create a merge resolution feedback round instead of just retrying.

3. **Grouping mechanism:** A new function (e.g., `handlePostApprovalIssues()`) that:
   - Takes CI state + mergeability state
   - Builds a combined list of issues
   - Creates ONE synthetic feedback round with ALL issues
   - Re-queues once with a reason like `post_approval_fix`
   - Tracks retry count across all post-approval fix types

4. **Retry counting:** Currently `countPipelineFixAttempts()` counts `pipeline_fix` transitions. Need to decide: keep separate counters per issue type, or unify under one `post_approval_fix` counter? Unified is simpler and aligns with the "one cycle fixes all" philosophy.

5. **Edge case: merge conflict detected at merge time (not pre-check):** Even when `mergeable === true` at check time, GitHub's mergeable state can be stale. The actual merge attempt may still fail with 409. This already-existing retry path in `attemptMerge()` should be converted from "retry next tick" to "re-queue for resolution" — but only for `merge_conflict`, not for transient `network_error`.

6. **Edge case: `mergeable` field is null/unknown on GitHub:** GitHub sometimes returns `null` for mergeable while it's computing. Current code defaults to `false` (`pr.mergeable ?? false`). This means a pending mergeability check would trigger conflict resolution prematurely. Consider: if CI is still pending AND mergeable is false, defer to next tick (both might resolve). Only trigger conflict resolution when we have a definitive signal.

7. **What the agent needs to do for merge conflict resolution:** Rebase or merge the base branch into the feature branch, resolve conflicts, push. The synthetic feedback round should instruct this clearly.

8. **`checkApprovedCI()` (the CI poll loop for pending CI):** When CI transitions from pending to passing, it calls `attemptMerge()`. If that merge fails with conflicts, the new conflict resolution handler should kick in here too — not just the retry loop.

9. **Transition reason:** Currently `pipeline_fix` is used for CI failures. A new unified reason like `post_approval_fix` (or keep `pipeline_fix` and add `merge_conflict_fix`, with the grouped case using `post_approval_fix`) should be defined.

## Assessment

**This is clear enough to proceed to research.** The codebase exploration reveals a well-structured pattern (synthetic feedback rounds) that directly extends to merge conflict resolution. The grouping mechanism is the novel part but the design is straightforward.

No human input needed. The task owner's intent is unambiguous: add merge conflict resolution and group post-approval issues. The architecture decisions (where to detect, how to group, retry counting) are engineering judgment calls with clear best answers derivable from the existing patterns.

**Complexity: moderate** — Clear pattern to follow (existing CI fix), touches primarily review-handler.ts, but requires careful design of the grouping mechanism, handling of edge cases (stale mergeable state, concurrent issues), and updating the existing `handlePipelineFailure` / `handleCodeApproval` flow.

## Team Contacts Referenced

- Farzam Mohammadi (owner) — provided task description via GitHub issue #15
