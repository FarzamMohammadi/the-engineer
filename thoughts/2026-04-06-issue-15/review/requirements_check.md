# Requirements Check: Include Merge Resolution in Post-Approval Processes

This review covers both the original issue #15 requirements AND the PR #16 Round 2 refinement (extract `evaluatePostApprovalChecks` pure function).

---

## Part A: PR #16 Round 2 Refinement Requirements

These are the **current task requirements** from `requirements.md` — PR reviewer feedback requesting deduplication.

### R1. Extract `evaluatePostApprovalChecks` pure function
**Status: MET**

Function defined at module scope in `review-handler.ts` (lines ~84-96). Signature matches spec exactly:
```typescript
export function evaluatePostApprovalChecks(
  checksState: "passing" | "failing" | "pending" | "none",
  mergeable: boolean,
): PostApprovalIssue[]
```
Pure — no closure dependencies, no side effects. Exported for direct unit testing.

### R2. All 3 call sites refactored to use the function
**Status: MET**

- **Site 1 — `handleCodeApproval` (~line 840):** `const issues = evaluatePostApprovalChecks(checks_state, mergeable)` replaces inline conditional branches. ✅
- **Site 2 — `checkSingleTaskCI` (~line 872):** Same pattern — `evaluatePostApprovalChecks(checks_state, mergeable)` after CI resolves from pending. ✅
- **Site 3 — `attemptMerge` (~line 764):** `evaluatePostApprovalChecks("passing", false)` with inline comment explaining the synthetic inputs. ✅

No inline conditional logic for building the issues array remains at any call site.

### R3. `PostApprovalIssue` type exported
**Status: MET**

`export type PostApprovalIssue = "ci_failure" | "merge_conflict"` at line ~82. Test file imports it successfully.

### R4. 8 unit tests for pure function covering all `checks_state × mergeable` combinations
**Status: MET**

`describe("evaluatePostApprovalChecks")` block at end of `review-handler.test.ts` covers:
- `("passing", true)` → `[]` ✅
- `("passing", false)` → `["merge_conflict"]` ✅
- `("failing", true)` → `["ci_failure"]` ✅
- `("failing", false)` → `["ci_failure", "merge_conflict"]` ✅
- `("none", true)` → `[]` ✅
- `("none", false)` → `["merge_conflict"]` ✅
- `("pending", true)` → `[]` ✅
- `("pending", false)` → `["merge_conflict"]` ✅

### R5. Zero behavioral changes — existing tests pass without modification
**Status: MET**

Existing test descriptions updated (`"pipeline_fix"` → `"post_approval_fix"`) to match new naming, but these reflect naming changes from Round 1, not behavioral changes. All 2453 tests pass per implementation session-result.

### R6. `pnpm run typecheck` and `pnpm run lint` clean
**Status: MET** (per implementation session-result)

---

## Part B: Original Issue #15 Requirements (Carried Forward)

These are the foundational requirements from the original issue. They were implemented in Round 1 and must still be met.

### 1. Merge conflict detection as a post-approval process
**Status: MET**

`handleCodeApproval()` destructures `mergeable` from `getCachedPRStatus()` and evaluates it via `evaluatePostApprovalChecks()`. `attemptMerge()` catches `merge_conflict` error code (409) and re-queues instead of retrying infinitely.

Tests: "CI passing + mergeable false → re-queues with merge_conflict", "attemptMerge: merge_conflict error → re-queues for resolution"

### 2. Grouping CI failure + merge conflicts into one RRPIR cycle
**Status: MET**

When CI is failing AND `mergeable === false`, `evaluatePostApprovalChecks` returns `["ci_failure", "merge_conflict"]`. `handlePostApprovalFailures()` creates ONE synthetic feedback round with comments for ALL issues. Only one `requestTransition` to `queued` occurs.

Test: "CI failing + mergeable false → grouped feedback with BOTH issues" verifies single `requestTransition` call.

### 3. Single re-queue (not separate costly cycles)
**Status: MET**

`handlePostApprovalFailures()` accepts an array and creates one feedback round. Test asserts `queuedCalls.toHaveLength(1)`.

### 4. Extensible for future post-approval checks
**Status: MET**

`PostApprovalIssue` union type + `evaluatePostApprovalChecks` pure function = single extensibility point. Adding a new check type requires: (1) extend union, (2) add detection in pure function, (3) add comment-building in `handlePostApprovalFailures`. The reviewer's feedback was specifically to create this single extensibility point — now achieved.

### 5. Infinite merge retry loop eliminated
**Status: MET**

`attemptMerge()` inspects `result.error?.code === "merge_conflict"` and calls `handlePostApprovalFailures` + returns. Non-merge-conflict errors (`network_error`, `pr_not_mergeable`) retain existing retry behavior.

Tests: "attemptMerge: merge_conflict error → re-queues", "attemptMerge: network_error → retries next tick"

### 6. `checkSingleTaskCI()` checks mergeability after CI passes
**Status: MET**

Destructures `mergeable` from `hosting.getPRStatus()`. Uses `evaluatePostApprovalChecks` to detect issues before calling `attemptMerge()`.

Tests: "checkSingleTaskCI: CI passing + mergeable false → re-queues", "CI passing + mergeable true → calls attemptMerge"

### 7. CI pending → defer (don't evaluate stale mergeable)
**Status: MET**

When `checks_state === "pending"`, code defers to `approvedAwaitingCI` without calling `evaluatePostApprovalChecks`. Avoids premature conflict detection from GitHub's `null → false` coercion.

Test: "CI pending → defers to approvedAwaitingCI (ignores mergeable)"

### 8. Backward compatibility with `pipeline_fix` history entries
**Status: MET**

`countPostApprovalFixAttempts()` counts both `"post_approval_fix"` and `"pipeline_fix"` reasons in state history.

Test: "backward compat: pipeline_fix history entries counted by retry counter"

### 9. Retry limit with grouped issues
**Status: MET**

Completion message maps all unresolved issues to human-readable labels and joins them.

Test: "retry limit with grouped issues → completes with message listing all issues"

### 10. `SELF_COMMENT_PREFIXES` updated
**Status: MET**

Two new entries: `"Post-approval issues"` and `"Merge conflicts detected"` (review-handler.ts lines ~115-116).

### 11. Unified transition reason `post_approval_fix`
**Status: MET**

All new re-queues use `"post_approval_fix"`. Old `"pipeline_fix"` only referenced in backward-compat counting.

---

## Edge Cases Verified

| Edge Case | Status | Notes |
|-----------|--------|-------|
| Stale `mergeable` (true at pre-check, 409 at merge) | MET | `attemptMerge()` catches `merge_conflict` error code as reactive fallback |
| `mergeable: null` → `false` coercion from GitHub | MET | Deferred when CI is pending; treated as real signal when CI is resolved |
| `pr_not_mergeable` (405) vs `merge_conflict` (409) | MET | Only 409 triggers re-queue; 405 retries (branch protection isn't agent-fixable) |
| Network error during merge | MET | Retries next tick, not re-queued |
| Empty issues array from `evaluatePostApprovalChecks` | MET | Only possible when CI passing/none + mergeable — leads to `attemptMerge()` |

---

## Test Coverage Assessment

**18 new tests total:**
- 8 unit tests for `evaluatePostApprovalChecks` pure function (all state combinations)
- 10 integration tests for post-approval merge conflict detection scenarios

**Existing tests updated** to reflect `post_approval_fix` naming. All tests pass.

---

## Scope Note

This PR includes changes beyond issue #15:
- **PR decorations** (`pr_decorations` replacing `pr_prefix` in `ExternalRefSchema`) — separate improvement to PR title/body composition
- **`fetch_before_create` removal** — makes remote fetch unconditional before worktree creation
- **`deleteRemoteBranch`** — new workspace manager method + `git.branch_deleted` event
- **`architecture_review`** added to `ReviewPhaseNameSchema`

These are related improvements bundled into the same branch. The reviewer should be aware of the broader scope.

---

## Summary

**All requirements: MET.** Both the PR #16 Round 2 refinement (extract pure function, refactor 3 call sites, 8 unit tests) and the original issue #15 requirements (merge conflict detection, grouping, extensibility, backward compat) are fully implemented and tested.
