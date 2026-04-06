# Plan: Extract `evaluatePostApprovalChecks` Pure Function (PR #16 Round 2)

## Approach

Extract the duplicated `PostApprovalIssue[]` building logic from 3 call sites in `src/core/daemon/review-handler.ts` into a single pure function `evaluatePostApprovalChecks(checksState, mergeable)`. This is a mechanical refactoring per PR #16 reviewer feedback — no new behavior, single file change.

The function is pure (no closure dependencies), so it can be extracted to module scope and exported for direct unit testing.

## Phases

### Phase 1: Add `evaluatePostApprovalChecks` pure function
- [x] Add the function at module scope in `src/core/daemon/review-handler.ts`, placed just below the `PostApprovalIssue` type definition (line ~82) and above `createReviewHandler`:
  ```typescript
  /** Evaluate PR state and return all post-approval issues found. Pure — no side effects. */
  export function evaluatePostApprovalChecks(
    checksState: PRStatus["checks_state"],
    mergeable: boolean,
  ): PostApprovalIssue[] {
    const issues: PostApprovalIssue[] = [];
    if (checksState === "failing") {
      issues.push("ci_failure");
    }
    if (mergeable === false) {
      issues.push("merge_conflict");
    }
    return issues;
  }
  ```
- [x] Also export `PostApprovalIssue` type (change from local `type` to `export type`) so tests can reference it.
- **Verify:** `pnpm run typecheck` passes. Function exists but is not yet called.

### Phase 2: Refactor `handleCodeApproval` (Site 1, lines ~835-848)
- [x] Replace the two branches after `checks_state === "pending"` (the `else if (passing/none)` and `else` blocks) with a single `else` block:
  ```typescript
  } else {
    const issues = evaluatePostApprovalChecks(checks_state, mergeable);
    if (issues.length > 0) {
      handlePostApprovalFailures(taskId, issues);
    } else {
      await attemptMerge(taskId, task, repo, prNumber, hosting);
    }
  }
  ```
  The `pending` early path (lines 826-834) stays untouched — `evaluatePostApprovalChecks` is never called when CI is pending.
- **Verify:** `pnpm test -- review-handler` — existing `handleCodeApproval` tests pass unchanged.

### Phase 3: Refactor `checkSingleTaskCI` (Site 2, lines ~873-896)
- [x] Replace the `if (passing/none)` and `else if (failing)` branches with a unified non-pending block:
  ```typescript
  if (checks_state === "pending") {
    observer.debug("CI checks still pending — will check again next tick", { taskId, prNumber });
  } else {
    approvedAwaitingCI.delete(taskId);
    const issues = evaluatePostApprovalChecks(checks_state, mergeable);
    if (issues.length > 0) {
      handlePostApprovalFailures(taskId, issues);
    } else {
      notifications.notify({
        kind: "ticket_comment",
        taskId,
        message: "CI pipeline passed — proceeding with merge.",
      });
      const task = taskEngine.getTask(taskId);
      if (task) {
        await attemptMerge(taskId, task, repo, prNumber, hosting);
      }
    }
  }
  ```
  Key detail: `approvedAwaitingCI.delete(taskId)` must be inside the `else` block (non-pending), matching current behavior where it's called in both the passing and failing branches.
- **Verify:** `pnpm test -- review-handler` — existing `checkSingleTaskCI` tests pass unchanged.

### Phase 4: Refactor `attemptMerge` (Site 3, line ~758)
- [x] Replace `handlePostApprovalFailures(taskId, ["merge_conflict"])` at line 758 with:
  ```typescript
  // CI already passed before merge attempt; merge failed → only merge_conflict
  handlePostApprovalFailures(taskId, evaluatePostApprovalChecks("passing", false));
  ```
- **Verify:** `pnpm test -- review-handler` — existing `attemptMerge` merge_conflict test passes unchanged.

### Phase 5: Add direct unit tests for `evaluatePostApprovalChecks`
- [x] Import `evaluatePostApprovalChecks` in `src/core/daemon/review-handler.test.ts`
- [x] Add a `describe("evaluatePostApprovalChecks")` block with tests for all `checks_state` × `mergeable` combinations:
  - `("passing", true)` → `[]`
  - `("passing", false)` → `["merge_conflict"]`
  - `("failing", true)` → `["ci_failure"]`
  - `("failing", false)` → `["ci_failure", "merge_conflict"]`
  - `("none", true)` → `[]`
  - `("none", false)` → `["merge_conflict"]`
  - `("pending", true)` → `[]`
  - `("pending", false)` → `["merge_conflict"]`
- **Verify:** `pnpm test -- review-handler` — all new + existing tests pass. `pnpm run typecheck` and `pnpm run lint` clean.

## Risks & Mitigations

- **Risk:** Behavioral change in `handleCodeApproval` when `checks_state` is `"pending"` and `mergeable` is `false` — currently `pending` defers without checking mergeable; refactored code must preserve this. → **Mitigation:** The `pending` branch remains as a separate early-return before the `else` that calls `evaluatePostApprovalChecks`. The function is never reached for pending state.

- **Risk:** `evaluatePostApprovalChecks("passing", false)` in `attemptMerge` is less readable than `["merge_conflict"]`. → **Mitigation:** Add inline comment explaining the synthetic inputs. The reviewer explicitly requested this call site use the function.

- **Risk:** Exporting `evaluatePostApprovalChecks` and `PostApprovalIssue` increases public API surface. → **Mitigation:** These are internal module exports, not re-exported from `src/core/index.ts` barrel. Only the test file imports them.

## Pre-mortem

1. **`checkSingleTaskCI` refactoring misplaces `approvedAwaitingCI.delete()`:** Currently it's called in both the passing and failing branches. The refactored version consolidates into the `else` (non-pending) block. If accidentally placed outside the `else`, the pending poll would break. **Mitigation:** The plan explicitly notes this — `delete` goes inside the `else` block. Tests will catch if it's wrong (pending CI test would fail).

2. **Order dependency in `evaluatePostApprovalChecks` return array:** `handlePostApprovalFailures` iterates `issues.includes()` — order doesn't matter. But if any downstream code ever indexes into the array by position, the order (`ci_failure` before `merge_conflict`) becomes a contract. **Mitigation:** Acceptable — no code indexes by position, only uses `.includes()`. Document the function as returning issues in detection order.

3. **`attemptMerge` synthetic call masks future issue types:** If a new `PostApprovalIssue` variant is added (e.g., `"branch_protection"`), the synthetic `evaluatePostApprovalChecks("passing", false)` won't detect it. **Mitigation:** Acceptable — `attemptMerge` is a reactive fallback (merge already failed with a specific error). New issue types would need their own detection logic at that call site anyway.

## Test Strategy

- All ~20 existing post-approval tests in `review-handler.test.ts` must pass unchanged (they already cover all behavioral combinations).
- 8 new direct unit tests for the pure function covering every `checks_state` × `mergeable` combination.
- `pnpm run typecheck` + `pnpm run lint` clean.

## Success Criteria
- [x] `evaluatePostApprovalChecks` exists as a single exported pure function
- [x] All 3 call sites use it instead of inline conditional logic
- [x] Zero behavioral changes — all existing tests pass without modification
- [x] 8 new unit tests for the pure function
- [x] `pnpm run typecheck` and `pnpm run lint` clean
