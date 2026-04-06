# Requirements Check: Include Merge Resolution in Post-Approval Processes

## Acceptance Criteria Verification

### 1. Merge conflict detection as a post-approval process
**Status: MET**

`handleCodeApproval()` now destructures `mergeable` from `getCachedPRStatus()` (review-handler.ts ~line 814) and evaluates it alongside `checks_state`. When `mergeable === false` with passing CI, it calls `handlePostApprovalFailures(taskId, ["merge_conflict"])`. This is the primary detection path.

Additionally, `attemptMerge()` now inspects `result.error?.code === "merge_conflict"` (review-handler.ts ~line 749) and re-queues instead of retrying — handling the case where GitHub's mergeability state was stale at pre-check time.

Tests: "CI passing + mergeable false → re-queues with merge_conflict", "attemptMerge: merge_conflict error → re-queues for resolution"

### 2. Grouping CI failure + merge conflicts into one RRPIR cycle
**Status: MET**

When CI is failing AND `mergeable === false`, `handleCodeApproval()` builds `["ci_failure", "merge_conflict"]` and calls `handlePostApprovalFailures()` once (review-handler.ts ~line 840). The function creates a single synthetic feedback round with comments covering BOTH issues.

Tests: "CI failing + mergeable false → grouped feedback with BOTH issues" verifies ONE `requestTransition` call to `queued`, and the feedback round contains both "CI pipeline is failing" and "Merge conflicts detected".

### 3. Single re-queue (not separate costly cycles)
**Status: MET**

`handlePostApprovalFailures()` takes an array of `PostApprovalIssue` and creates one feedback round with all issue comments concatenated. Only one `requestTransition(taskId, "queued", null, "post_approval_fix", "daemon")` call occurs regardless of how many issues are present.

Test: "CI failing + mergeable false" asserts `queuedCalls.toHaveLength(1)`.

### 4. Extensible for future post-approval checks
**Status: MET**

The `PostApprovalIssue` type is a union (`"ci_failure" | "merge_conflict"`) that can be extended with new members. The `handlePostApprovalFailures()` function iterates over an array of issues and builds comments per-issue — adding a new check type requires: (1) adding to the union, (2) adding an `if (issues.includes(...))` block with appropriate comments, (3) adding the detection logic in the calling code.

### 5. Conversion of infinite merge retry loop to resolution re-queue
**Status: MET**

In `attemptMerge()`, when `result.error?.code === "merge_conflict"`, the code now calls `handlePostApprovalFailures(taskId, ["merge_conflict"])` and returns — breaking out of the previous retry pattern. Non-merge-conflict errors (`network_error`, `pr_not_mergeable`) still get the existing retry behavior.

Tests: "attemptMerge: merge_conflict error → re-queues", "attemptMerge: network_error → retries next tick"

### 6. `checkSingleTaskCI()` also checks mergeability after CI passes
**Status: MET**

`checkSingleTaskCI()` now destructures `mergeable` from `hosting.getPRStatus()` (review-handler.ts ~line 862). When CI passes but `mergeable === false`, it calls `handlePostApprovalFailures(taskId, ["merge_conflict"])` instead of `attemptMerge()`. When CI is failing, it also checks mergeability to group issues.

Tests: "checkSingleTaskCI: CI passing + mergeable false → re-queues", "checkSingleTaskCI: CI passing + mergeable true → calls attemptMerge"

### 7. CI pending → defer (don't evaluate stale mergeable)
**Status: MET**

When `checks_state === "pending"`, the code defers to `approvedAwaitingCI` without evaluating `mergeable`. This handles the edge case where GitHub returns `null` (coerced to `false`) while still computing mergeability.

Test: "CI pending → defers to approvedAwaitingCI (ignores mergeable)"

### 8. Backward compatibility for `pipeline_fix` history entries
**Status: MET**

`countPostApprovalFixAttempts()` counts both `reason === "post_approval_fix"` AND `reason === "pipeline_fix"` entries in state history. In-progress tasks with old `pipeline_fix` entries are counted correctly toward the retry limit.

Test: "backward compat: pipeline_fix history entries counted by retry counter"

### 9. Retry limit with grouped issues shows all issues in completion message
**Status: MET**

When `attempt > MAX_POST_APPROVAL_FIX_RETRIES`, the completion message includes a description of ALL unresolved issues (e.g., "CI pipeline failing, merge conflicts").

Test: "retry limit with grouped issues → completes with message listing all issues"

### 10. `SELF_COMMENT_PREFIXES` updated for new notification messages
**Status: MET**

Two new entries added: `"Post-approval issues"` and `"Merge conflicts detected"` (review-handler.ts lines 100-101). These prevent the daemon from misinterpreting its own comments as reviewer feedback.

### 11. Unified transition reason `post_approval_fix`
**Status: MET**

All post-approval re-queues use `"post_approval_fix"` as the transition reason. The old `"pipeline_fix"` reason is only referenced in backward-compat counting, not generated by new code.

## Edge Cases Verified

| Edge Case | Status | Notes |
|-----------|--------|-------|
| Stale `mergeable` (true at pre-check, 409 at merge) | MET | `attemptMerge()` catches `merge_conflict` error code as fallback |
| `mergeable: null` → `false` coercion | MET | Handled by deferring when CI is pending (the most likely co-occurrence) |
| `pr_not_mergeable` (405) vs `merge_conflict` (409) | MET | Only 409 triggers re-queue; 405 retries (branch protection is not agent-fixable) |
| Network error during merge | MET | Retries next tick, not re-queued |
| Race between CI poll and approval handler | Acceptable | Existing `emittedFeedbackKeys` dedup + atomic transitions handle this |

## Test Coverage Assessment

**10 new tests added, all passing.** The tests cover:
- All four `handleCodeApproval` scenarios (CI passing/failing × mergeable true/false)
- CI pending edge case
- `attemptMerge` merge_conflict vs network_error distinction
- Both `checkSingleTaskCI` paths (CI passed + mergeable/not mergeable)
- Backward compatibility with mixed `pipeline_fix`/`post_approval_fix` history
- Retry limit with grouped issues

**Existing tests updated** to reflect new naming (`post_approval_fix` instead of `pipeline_fix`). All 2445 tests pass.

## Summary

**All acceptance criteria: MET.** The implementation correctly adds merge conflict resolution as a post-approval process, groups simultaneous issues into a single RRPIR cycle, eliminates the infinite retry loop for merge conflicts, maintains backward compatibility, and is extensible for future post-approval checks. Test coverage is comprehensive.
