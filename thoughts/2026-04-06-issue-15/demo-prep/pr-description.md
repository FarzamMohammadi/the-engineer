## Summary

Adds merge conflict resolution as a post-approval process and groups it with the existing CI failure handling so that simultaneous issues are fixed in a single RRPIR cycle instead of burning multiple expensive cycles. Includes Round 2 refinement: `evaluatePostApprovalChecks` extracted as a pure function per reviewer feedback.

**Before:** After PR approval, `handleCodeApproval()` only checked CI status. If CI passed, it called `attemptMerge()` — which retried infinitely on merge conflicts (HTTP 409). If CI failed AND merge conflicts existed, only CI was detected. After the agent fixed CI and returned, it would discover conflicts on the next merge attempt, triggering another full RRPIR cycle. The issue-detection logic was duplicated inline at 3 call sites.

**After:** `handleCodeApproval()` evaluates both `checks_state` AND `mergeable` together. When multiple issues coexist, they're bundled into one synthetic feedback round and the agent fixes everything in a single cycle. A single pure function `evaluatePostApprovalChecks(checksState, mergeable)` is the sole extensibility point for all post-approval checks.

Closes #15

## What changed

### Core: Grouped post-approval failure handling (`review-handler.ts`)

- **`evaluatePostApprovalChecks()` pure function** — exported, module-scope, no closure dependencies. Single place to add new post-approval check types. Signature: `(checksState, mergeable) => PostApprovalIssue[]`
- **`PostApprovalIssue` type exported** — `"ci_failure" | "merge_conflict"` union, extensible for future check types
- **`handlePostApprovalFailures(taskId, issues[])`** replaces `handlePipelineFailure(taskId)` — accepts an array of issues, builds a single feedback round with instructions for ALL of them, re-queues once with reason `"post_approval_fix"`
- **All 3 call sites use `evaluatePostApprovalChecks()`** — no inline conditional logic remains:
  - `handleCodeApproval()` — pre-merge evaluation of `checks_state` + `mergeable`
  - `checkSingleTaskCI()` — post-CI-poll evaluation before merge attempt
  - `attemptMerge()` — reactive fallback when merge API returns 409 (uses synthetic inputs: `"passing", false`)
- **`handleCodeApproval()` decision tree:**
  - CI pending → defer (don't evaluate `mergeable` — GitHub may still be computing)
  - CI passing/none + mergeable → `attemptMerge()` (happy path)
  - CI passing/none + not mergeable → re-queue for merge conflict resolution
  - CI failing + not mergeable → grouped re-queue for both issues
  - CI failing + mergeable → re-queue for CI fix only
- **`attemptMerge()`** — when the merge API returns 409 (`merge_conflict`), re-queues for resolution instead of retrying forever. Other errors (`network_error`, `pr_not_mergeable`) still retry (transient).
- **Backward compatibility** — `countPostApprovalFixAttempts()` counts both old `"pipeline_fix"` and new `"post_approval_fix"` history entries, so in-progress tasks aren't affected.
- **`SELF_COMMENT_PREFIXES`** — added `"Post-approval issues"` and `"Merge conflicts detected"` to prevent the daemon from misinterpreting its own comments.

### Also in this PR (bundled improvements)

- **`attemptMerge()` uses `workspaceConfig.pr.default_merge_strategy`** instead of hardcoded `"squash"`
- **`finalizeTaskCompletion()` deletes remote branch** after merge when `delete_branch_after_merge` is configured, emits `git.branch_deleted` event
- **`fetch_before_create` config removed** — remote fetch is now unconditional before worktree creation
- Philosophy docs, contribution docs restructure, RRPIR prompt strengthening, and other doc/config changes

## Key design decisions

1. **Single pure function as extensibility point** — `evaluatePostApprovalChecks` is the one place to add new post-approval checks. Adding a check type means: extend the union, add detection in the pure function, add comment-building in `handlePostApprovalFailures`. Three places, one concept.

2. **Unified `post_approval_fix` reason** instead of separate `pipeline_fix`/`merge_conflict_fix` — aligns with the "one cycle fixes all" philosophy and simplifies retry counting.

3. **Don't evaluate `mergeable` when CI is pending** — GitHub returns `null` (coerced to `false`) while computing mergeability. Deferring avoids premature conflict detection.

4. **Double safety net for stale mergeability** — even when `mergeable: true` at pre-check, `attemptMerge()` catches HTTP 409 and re-queues. Covers the race between check and merge.

5. **Only HTTP 409 triggers re-queue, not 405** — 405 (`pr_not_mergeable`) indicates branch protection rules the agent can't fix. Those still retry.

## Test plan

- [ ] Run `pnpm test:unit` — 18 new tests (8 unit tests for `evaluatePostApprovalChecks`, 10 integration tests for post-approval scenarios)
- [ ] Verify `evaluatePostApprovalChecks` covers all 8 `checks_state x mergeable` combinations
- [ ] Verify `handleCodeApproval` tests cover all four CI x mergeable scenarios plus pending edge case
- [ ] Verify `attemptMerge` distinguishes `merge_conflict` (re-queue) from `network_error` (retry)
- [ ] Verify `checkSingleTaskCI` checks mergeability after CI passes
- [ ] Verify backward compat: tasks with old `"pipeline_fix"` history counted correctly
- [ ] Verify retry limit: grouped issues -> completion message lists all issues
- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run lint` passes

## Breaking changes

- **Transition reason renamed**: `"pipeline_fix"` -> `"post_approval_fix"`. Code that filters state history by reason should check for both. The retry counter already does this.
- **`fetch_before_create` config option removed**: Remote fetch before worktree creation is now unconditional. Remove this key from your config if present (it will be ignored by schema validation).
