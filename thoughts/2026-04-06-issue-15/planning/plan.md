# Plan: Include Merge Resolution in Post-Approval Processes

## Approach

Refactor the post-approval flow in `review-handler.ts` to:
1. Replace the single CI-only check with a grouped post-approval check that evaluates CI status AND mergeability together
2. Convert the infinite merge-failure retry loop in `attemptMerge()` to a resolution re-queue for `merge_conflict` errors
3. Generalize `handlePipelineFailure()` into `handlePostApprovalFailures()` that accepts a list of issues, builds a single synthetic feedback round, and re-queues once
4. Rename `pipeline_fix` transition reason to `post_approval_fix` and update retry counting to match (with backward compat for in-progress tasks)
5. Update `checkSingleTaskCI()` to also check mergeability after CI passes

All changes are in one file (`review-handler.ts`) and its test file. No schema, plugin, or scheduler changes needed — the existing infrastructure (PRStatus.mergeable, MergeResult.error.code, synthetic feedback rounds) already supports everything.

## Phases

### Phase 1: Introduce `PostApprovalIssue` type and `handlePostApprovalFailures()` function
- [x] Define a `PostApprovalIssue` type (union of `"ci_failure"` | `"merge_conflict"`) at the top of review-handler.ts near existing constants
- [x] Rename `MAX_PIPELINE_FIX_RETRIES` to `MAX_POST_APPROVAL_FIX_RETRIES` (same value: 3)
- [x] Create `countPostApprovalFixAttempts(taskId)` that counts state history entries with reason `"post_approval_fix"` OR `"pipeline_fix"` (backward compat for tasks already in progress with old reason)
- [x] Create `handlePostApprovalFailures(taskId: string, issues: PostApprovalIssue[])` that:
  - Calls `countPostApprovalFixAttempts()` for retry limit
  - If over limit: complete task with manual merge message listing all unresolved issues
  - Builds a single synthetic feedback round with comments describing ALL issues (CI failure instructions + merge conflict resolution instructions as applicable)
  - Transitions to `queued` with reason `"post_approval_fix"`
  - Clears `emittedFeedbackKeys` and `approvedAwaitingCI`
  - Posts a single notification listing all issues being fixed
- [x] Add `"CI pipeline failing"` and merge-conflict related prefixes to `SELF_COMMENT_PREFIXES` (verify existing entries cover new message prefixes; add any new ones for the grouped case like `"Post-approval issues"`)
- **Verify:** TypeScript compiles (`pnpm run typecheck`). New function exists but is not yet called.

### Phase 2: Refactor `handleCodeApproval()` to use grouped check
- [x] Change line 780 to destructure both `checks_state` AND `mergeable` from `getCachedPRStatus()`
- [x] Replace the current routing logic with grouped evaluation:
  - If `checks_state` is `"pending"`: defer to `approvedAwaitingCI` (same as now — don't evaluate `mergeable` yet since GitHub may still be computing)
  - If `checks_state` is `"passing"` or `"none"`:
    - If `mergeable` is `true`: call `attemptMerge()` (happy path)
    - If `mergeable` is `false`: call `handlePostApprovalFailures(taskId, ["merge_conflict"])`
  - If `checks_state` is failing:
    - If `mergeable` is `false`: call `handlePostApprovalFailures(taskId, ["ci_failure", "merge_conflict"])`
    - If `mergeable` is `true`: call `handlePostApprovalFailures(taskId, ["ci_failure"])`
- [x] Remove the old `handlePipelineFailure()` function (replaced by `handlePostApprovalFailures()`)
- [x] Remove the old `countPipelineFixAttempts()` function (replaced by `countPostApprovalFixAttempts()`)
- **Verify:** TypeScript compiles. No references to removed functions remain.

### Phase 3: Fix `attemptMerge()` to handle merge_conflict errors
- [x] In the `if (!result.success)` block (line 724), add a check for `result.error?.code === "merge_conflict"`:
  - If merge_conflict: call `handlePostApprovalFailures(taskId, ["merge_conflict"])` and return (no retry)
  - For `pr_not_mergeable` (405 — branch protection, etc.): keep the existing retry behavior (transient, may resolve)
  - For `network_error`: keep existing retry behavior
- **Verify:** TypeScript compiles. The infinite retry loop for merge conflicts is eliminated.

### Phase 4: Update `checkSingleTaskCI()` to check mergeability
- [x] After CI passes (line 815-825), before calling `attemptMerge()`, fetch fresh PR status and check `mergeable`:
  - Already have `hosting.getPRStatus()` call at line 812. Destructure `mergeable` alongside `checks_state`.
  - If CI passing AND `mergeable` is `true`: call `attemptMerge()` (same as now)
  - If CI passing AND `mergeable` is `false`: call `handlePostApprovalFailures(taskId, ["merge_conflict"])`
  - If CI failing: call `handlePostApprovalFailures(taskId, ["ci_failure"])` (same logic, new function name) — also check `mergeable` and group if both
- **Verify:** TypeScript compiles. All three entry points now use the grouped handler.

### Phase 5: Tests
- [x] Update existing `handlePipelineFailure` tests to use `handlePostApprovalFailures` naming and `"post_approval_fix"` transition reason
- [x] Add test: `handleCodeApproval` with CI passing + `mergeable: false` → calls `handlePostApprovalFailures` with `["merge_conflict"]`
- [x] Add test: `handleCodeApproval` with CI failing + `mergeable: false` → grouped feedback round contains BOTH CI and merge conflict instructions
- [x] Add test: `handleCodeApproval` with CI failing + `mergeable: true` → only CI failure in feedback round
- [x] Add test: `handleCodeApproval` with CI pending → defers to `approvedAwaitingCI` (ignores `mergeable`)
- [x] Add test: `attemptMerge` when merge result has `error.code === "merge_conflict"` → re-queues instead of retrying
- [x] Add test: `attemptMerge` when merge result has `error.code === "network_error"` → still retries (existing behavior preserved)
- [x] Add test: `checkSingleTaskCI` with CI passing + `mergeable: false` → calls `handlePostApprovalFailures` with merge conflict
- [x] Add test: `checkSingleTaskCI` with CI passing + `mergeable: true` → calls `attemptMerge` (happy path)
- [x] Add test: retry counting backward compat — task with existing `"pipeline_fix"` history entries counted by `countPostApprovalFixAttempts()`
- [x] Add test: retry limit reached with grouped issues → completes task with message listing all issues
- **Verify:** `pnpm test:unit` passes. All new tests pass. All existing tests pass (or are updated).

## Risks & Mitigations

- **Risk:** `mergeable: false` when GitHub is still computing (null → false coercion in plugin) causes premature conflict detection → **Mitigation:** When `checks_state` is `"pending"`, skip mergeability evaluation entirely (defer both to next tick). Only evaluate `mergeable` when we have a definitive CI signal. This is why Phase 2 keeps the `pending` → defer path unchanged.

- **Risk:** Backward compat — tasks already in-progress with `"pipeline_fix"` reason in their state history → **Mitigation:** `countPostApprovalFixAttempts()` counts both `"pipeline_fix"` and `"post_approval_fix"` reasons. No in-progress tasks break.

- **Risk:** `attemptMerge()` gets called in Phase 2 only when `mergeable: true`, but GitHub's mergeability state can be stale (goes from true to false between check and merge) → **Mitigation:** Phase 3 adds a fallback in `attemptMerge()` itself: if the merge API returns 409 (`merge_conflict`), it re-queues instead of retrying. Double safety net.

- **Risk:** `pr_not_mergeable` (HTTP 405 — branch protection rules, pending required reviews) could be grouped with merge conflicts incorrectly → **Mitigation:** Only `merge_conflict` (409) triggers re-queue. `pr_not_mergeable` (405) keeps the existing retry behavior since branch protection issues are typically transient or require different handling (not something the agent can fix by rebasing).

## Pre-mortem

**Failure mode 1: Race between CI poll and approval handler.** If `handleCodeApproval()` fires while a CI poll is already in-flight for the same task, both could try to re-queue simultaneously. **Mitigation:** The existing `emittedFeedbackKeys` dedup prevents double-processing. Additionally, `requestTransition()` is atomic — the second caller's transition will fail (task is already in `queued` state), which is handled by the existing `if (!transition.success)` guard. Acceptable risk.

**Failure mode 2: Stale mergeable state leads to wasted RRPIR cycle.** Agent gets re-queued for merge conflicts that don't actually exist (because GitHub hadn't finished computing). After the full RRPIR cycle, there are no conflicts to fix, wasting tokens. **Mitigation:** This only happens when CI is already failing (the only case where we evaluate `mergeable` alongside a non-pending CI state AND mergeable could be stale). The CI fix cycle would likely resolve any actual conflicts too since it pushes new commits. Acceptable — the alternative (ignoring pre-check and only relying on merge API 409) delays detection by one merge attempt.

**Failure mode 3: Unbounded growth of `SELF_COMMENT_PREFIXES`.** Each new notification message pattern requires a new prefix. **Mitigation:** This is already the case — adding 1-2 prefixes for a new feature is fine. If this becomes a problem, the prefix check could be replaced with a `[The Engineer]` tag on all bot comments. Out of scope for this change.

## Test Strategy

- Mirror existing `handlePipelineFailure` test patterns from `review-handler.test.ts`
- Use `createMockHostingPlugin()` with configurable `getPRStatus()` return values (set `mergeable` field)
- Use `createMockHostingPlugin()` with configurable `mergePR()` that returns `{ success: false, error: { code: "merge_conflict", message: "..." } }`
- Verify synthetic feedback round content contains the right instructions for each issue combination
- Verify transition reason is `"post_approval_fix"` in all grouped cases
- Verify backward compat: tasks with `"pipeline_fix"` history are counted correctly
- Negative assertions: `attemptMerge` NOT called when `mergeable: false`, `handlePostApprovalFailures` NOT called when everything passes

## Success Criteria

- [x] `handleCodeApproval()` checks both `checks_state` AND `mergeable` — no post-approval issue goes undetected
- [x] When CI failing + merge conflicts coexist, ONE feedback round captures BOTH issues, ONE re-queue happens
- [x] `attemptMerge()` no longer retries infinitely for `merge_conflict` errors — re-queues for resolution
- [x] `checkSingleTaskCI()` checks mergeability after CI passes before attempting merge
- [x] Backward compat: existing `"pipeline_fix"` history entries counted in retry limit
- [x] All existing tests pass (updated for new naming)
- [x] New tests cover: grouped issues, merge conflict only, CI only, backward compat, retry limit, attemptMerge conflict handling
- [x] TypeScript strict mode passes, Biome lint passes
