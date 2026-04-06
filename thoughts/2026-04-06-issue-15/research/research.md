# Research: Include Merge Resolution in Post-Approval Processes

## Task Context

Add merge conflict resolution as a post-approval process and group it with the existing CI failure fix so that simultaneous issues (CI failing + merge conflicts) are handled in a single RRPIR cycle. Full details in requirements.md.

## Codebase Analysis

### Current Post-Approval Flow (review-handler.ts)

The approval flow is:

```
handleFeedbackEvent() → handleReviewApproval() → handleCodeApproval()
```

`handleCodeApproval()` (lines 760-802):
1. Checks if auto-merge is allowed (safety layer + PR number + repo + hosting plugin exist)
2. Fetches `PRStatus` via `getCachedPRStatus()` — returns `{ checks_state, mergeable, ... }`
3. **Only uses `checks_state`** — `mergeable` is fetched but completely ignored
4. Routes based on `checks_state`:
   - `"passing"` or `"none"` → `attemptMerge()`
   - `"pending"` → add to `approvedAwaitingCI` map, defer to next tick
   - anything else (failing) → `handlePipelineFailure()`

**Key finding:** `mergeable` is already returned by `getCachedPRStatus()` but is never checked in `handleCodeApproval()`. The infrastructure is there — it's just unused.

### attemptMerge() (lines 697-758)

When CI passes and merge is attempted:
1. Calls `hosting.mergePR()` with configured strategy
2. On API exception (catch block): logs warning, calls `allowApprovalRetry()`, notifies "will retry" — **infinite retry loop**
3. On `result.success === false`: logs warning, calls `allowApprovalRetry()`, notifies "will retry" — **infinite retry loop**
4. On success: updates review state to "merged", transitions to completed

**Critical gap:** When `result.success === false` with `error.code === "merge_conflict"`, the code retries forever. It never creates a synthetic feedback round or re-queues. The `error.code` field is available but not inspected.

### handlePipelineFailure() (lines 626-686)

The proven pattern for post-approval re-queuing:
1. Counts previous attempts via `countPipelineFixAttempts()` (filters state history by `reason === "pipeline_fix"`)
2. If over `MAX_PIPELINE_FIX_RETRIES` (3): complete task with manual merge message
3. Creates synthetic unapplied feedback round with CI failure context
4. Transitions to `queued` with reason `"pipeline_fix"`
5. Clears `emittedFeedbackKeys` and `approvedAwaitingCI` for the task
6. Notifies via ticket comment

**How the rework path triggers:** In `task-scheduler.ts` `dispatchTask()` (line 171): `hasUnappliedFeedback = task.review?.feedback_rounds?.some((r) => !r.applied)`. If true, checkpoint is nullified and the task restarts from requirements_gathering.

### checkSingleTaskCI() (lines 806-832)

The CI polling path for tasks in `approvedAwaitingCI`:
1. Fetches fresh `PRStatus` (NOT cached — uses `hosting.getPRStatus()` directly)
2. If CI passing/none → calls `attemptMerge()` — **same infinite retry problem if merge conflicts**
3. If CI failing → `handlePipelineFailure()`
4. If pending → do nothing, check again next tick

**Note:** This path also doesn't check `mergeable`. If CI passes but conflicts exist, it calls `attemptMerge()` which will hit the retry loop.

### GitHub Plugin: PRStatus.mergeable (github-hosting.ts lines 209-237)

```typescript
mergeable: pr.mergeable ?? false
```

GitHub's `pr.mergeable` can be `null` when GitHub is still computing mergeability. The plugin defaults to `false`. This means:
- `null` (computing) → treated as `false` (not mergeable) — **premature conflict detection risk**
- `true` → mergeable
- `false` → confirmed conflicts

### GitHub Plugin: classifyMergeError() (lines 597-608)

Maps HTTP status to error codes:
- 405 → `"pr_not_mergeable"` (branch protection, other blocks)
- 409 → `"merge_conflict"`
- Other → `"network_error"`

The `MergeResult.error.code` field carries this classification back to `attemptMerge()`, but it's never inspected there.

## Relevant Files

- `src/core/daemon/review-handler.ts` — **Primary file to change.** Contains `handleCodeApproval()`, `attemptMerge()`, `handlePipelineFailure()`, `checkSingleTaskCI()`, `countPipelineFixAttempts()`. All changes happen here.
- `src/core/daemon/review-handler.test.ts` — **Tests for all the above.** 1439 lines. Uses vitest. Must add tests for: merge conflict detection, grouped post-approval issues, retry counting under new unified reason.
- `src/schemas/adapters.ts` — `PRStatusSchema` with `mergeable: z.boolean()`, `MergeResultSchema` with `error: AdapterErrorSchema.nullable()`. **No changes needed** — schemas already support everything.
- `src/schemas/events.ts` — `WorkspaceMergeConflictPayload` already defined. Possibly emit this event for observability. **Optional.**
- `src/plugins/git-hosting/github-hosting/github-hosting.ts` — `doGetPRStatus()` populates `mergeable`, `doMergePR()` uses `classifyMergeError()`. **No changes needed** — plugin already provides all needed data.
- `src/core/daemon/task-scheduler.ts` — `dispatchTask()` reads unapplied feedback rounds to decide checkpoint nullification. **No changes needed** — existing rework mechanism works for any synthetic feedback round.
- `src/core/daemon/types.ts` — `ReviewHandlerContext` type. **No changes needed.**
- `test/helpers/contract-suites/git-hosting-contract.ts` — Contract tests for hosting adapter. **No changes needed.**

## Patterns & Conventions

### Code Style
- TypeScript strict mode, Biome linter
- Module pattern: factory function (`createReviewHandler()`) returning interface, closure over dependencies
- Private helper functions as closures inside factory
- `observer.info/warn/error/debug` for logging with structured context objects
- `sanitizeErrorMessage(err)` for safe error logging
- `notifications.notify({ kind, taskId, message })` for user-facing notifications

### Test Patterns
- Vitest with `describe/it/expect`
- Mock factories: `createMockHostingPlugin()`, `createMockNotifications()`, `createMockCallbacks()`
- `createReviewTask(overrides)` for test task creation
- `buildContext([tasks])` to wire up mocks
- `await flush()` after `handleFeedbackEvent()` (async handler)
- Direct `as unknown as { methodName: ReturnType<typeof vi.fn> }` casts for mock assertions
- Tests verify: transition calls, notification messages, mock non-calls (negative assertions)

### Naming
- Transition reasons: `"pipeline_fix"`, `"feedback_rework:approved"`, `"code_approved"`, `"code_approved_merged"`, `"pr_merged"`
- Comment prefixes in `SELF_COMMENT_PREFIXES` array for filtering daemon comments during polling
- Constants: `MAX_PIPELINE_FIX_RETRIES = 3`

### Error Handling
- API exceptions: catch, log warning, allow retry (next tick)
- Business logic failures: log, notify, handle based on error classification
- Non-fatal operations (workspace cleanup, branch deletion): try-catch with warning, never block main flow

## Dependencies & Integration Points

### What This Change Touches
1. **`handleCodeApproval()`** — Must check `mergeable` alongside `checks_state`, route to grouped handler
2. **`attemptMerge()`** — Must inspect `result.error.code` for `merge_conflict` and route to resolution instead of infinite retry
3. **`checkSingleTaskCI()`** — After CI passes, must also check mergeability before calling `attemptMerge()`
4. **`handlePipelineFailure()`** — May need generalization or replacement with a broader post-approval handler
5. **`countPipelineFixAttempts()`** — Must handle new unified reason or multiple reasons

### What Depends on This
- `task-scheduler.ts` `dispatchTask()` — reads `feedback_rounds` for rework detection. **No change needed** — works with any synthetic feedback round content.
- `SELF_COMMENT_PREFIXES` — New notification messages for merge conflicts need to be added here so the daemon doesn't mistake its own comments for reviewer feedback.
- `approvedAwaitingCI` map — CI polling path must also handle the grouped case.

## Contract Verification

### PRStatus.mergeable field
**Verified:** `doGetPRStatus()` in `github-hosting.ts` (line 233): `mergeable: pr.mergeable ?? false`. The field is populated from GitHub's API response. GitHub returns `null` when computing, `true` when mergeable, `false` when conflicts exist.

**Gap:** `pr.mergeable ?? false` treats `null` (computing) the same as `false` (conflicts). For the grouped post-approval check, this means:
- If CI is `"pending"` and `mergeable` is `false` (but actually `null` from GitHub), we should NOT immediately declare merge conflicts. We should defer to next tick for both.
- If CI is `"passing"` and `mergeable` is `false`, we have a real signal — check conflicts, re-queue.
- If CI is `"failing"` and `mergeable` is `false`, both issues are real — group them.

**Mitigation:** Since `handleCodeApproval()` already uses `getCachedPRStatus()` which returns the full `PRStatus`, and since `null` → `false` is the current behavior, the main risk is premature conflict detection when GitHub hasn't finished computing. The existing behavior (attempting merge and failing) actually handles this edge case because GitHub returns 409 only for real conflicts, not for "still computing." So the pre-check with `mergeable` should be treated as a "likely conflicts" signal, and the actual merge attempt failure (409) should be treated as "definite conflicts."

### MergeResult.error.code field
**Verified:** `doMergePR()` in `github-hosting.ts` (lines 179-195) catches errors, calls `classifyMergeError()`, and wraps the result in `createAdapterError(code, ...)`. The `error.code` field is reliably set to `"merge_conflict"`, `"pr_not_mergeable"`, or `"network_error"`.

### Synthetic feedback round mechanism
**Verified:** `handlePipelineFailure()` creates feedback rounds with `applied: false`. `task-scheduler.ts` checks `feedback_rounds.some(r => !r.applied)` and nullifies checkpoint. This is content-agnostic — any unapplied feedback triggers the rework path.

## Complexity Assessment

**Moderate.** Clear pattern to follow (`handlePipelineFailure()`), primary changes in one file (`review-handler.ts`), but requires:
1. A new grouped post-approval check function that aggregates CI + mergeability issues
2. Careful handling of the `attemptMerge()` failure path (distinguish `merge_conflict` from transient errors)
3. Deciding on retry counting: unified `post_approval_fix` reason vs. separate reasons
4. Handling the `checkSingleTaskCI()` path (CI polling → merge → conflict discovery)
5. Edge case: `mergeable === false` when GitHub is still computing (null → false coercion)
6. Adding new `SELF_COMMENT_PREFIXES` entries for merge conflict notifications
7. Comprehensive tests mirroring existing CI failure test patterns

## Open Questions

None. All architectural decisions are engineering judgment calls with clear answers from the existing patterns.

## Key Findings

1. **`mergeable` is already fetched but unused.** `getCachedPRStatus()` returns `mergeable` in every call to `handleCodeApproval()`. Adding a mergeability check requires no new API calls — just reading a field that's already there.

2. **`attemptMerge()` has an infinite retry loop for merge conflicts.** When `result.success === false` with `error.code === "merge_conflict"`, it retries every tick forever. This must be converted to a re-queue for resolution (but only for `merge_conflict`, not for `network_error` or `pr_not_mergeable` which may be transient).

3. **The synthetic feedback round pattern is content-agnostic.** The scheduler doesn't care what the feedback round says — it just checks `applied === false`. So grouping multiple issues into one feedback round is simply a matter of concatenating the instruction strings.

4. **Three entry points need updating:**
   - `handleCodeApproval()` — pre-merge check of `mergeable` + `checks_state`, grouped handler
   - `attemptMerge()` — post-merge-failure handling for `merge_conflict` error code
   - `checkSingleTaskCI()` — after CI passes, check mergeability before attempting merge

5. **The `null` → `false` coercion for `mergeable` is a real edge case** but can be handled by: (a) using `mergeable` only as a pre-check signal alongside a definitive CI state, and (b) treating actual merge API 409 as the definitive conflict signal in `attemptMerge()`.

6. **Unified retry reason recommended.** Using `"post_approval_fix"` instead of separate `"pipeline_fix"` and `"merge_conflict_fix"` reasons aligns with the grouping philosophy and simplifies retry counting. The existing `"pipeline_fix"` entries in state history can be counted alongside `"post_approval_fix"` for backward compatibility (tasks already in progress).

7. **`SELF_COMMENT_PREFIXES` needs new entries** for merge conflict and grouped post-approval notifications to prevent the daemon from misinterpreting its own comments as reviewer feedback.
