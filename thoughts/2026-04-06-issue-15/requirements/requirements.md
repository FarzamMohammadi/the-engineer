# Requirements: Extract evaluatePostApprovalChecks Pure Function (PR #16 Feedback)

## Task Description

PR #16 reviewer feedback on the "Include merge resolution in post-approval processes" feature. The reviewer identified duplicated logic for building the `PostApprovalIssue[]` array and requests extracting it into a single pure function.

## Reviewer Feedback (PR #16, Round 1)

**Problem:** The `evaluatePostApprovalChecks` logic is duplicated inline at 3 call sites in `review-handler.ts`:
1. `handleCodeApproval` (lines ~835-848)
2. `checkSingleTaskCI` (lines ~873-896)
3. `attemptMerge` (line ~758) — implicitly

**Requested fix:** Extract a pure function:
```typescript
function evaluatePostApprovalChecks(
  checksState: PRStatus["checks_state"],
  mergeable: boolean,
): PostApprovalIssue[] { ... }
```

All 3 call sites should call this single function. This makes the extensibility point a single location.

## Gathered Context

### Duplication Analysis

**File:** `src/core/daemon/review-handler.ts`

**Site 1 — `handleCodeApproval` (lines 835-848):**
The decision tree after CI pending is excluded:
- CI passing/none + mergeable false -> `["merge_conflict"]`
- CI passing/none + mergeable true -> empty (proceed to merge)
- CI failing + mergeable false -> `["ci_failure", "merge_conflict"]`
- CI failing + mergeable true -> `["ci_failure"]`

**Site 2 — `checkSingleTaskCI` (lines 873-896):**
Identical logic to Site 1. Same conditional pattern building the same array.

**Site 3 — `attemptMerge` (line 753-758):**
Different pattern — catches a merge_conflict *after* the merge API returns a 409 error. Hardcodes `["merge_conflict"]`. This is a runtime safety net (reactive), not a pre-check (proactive). It doesn't have `checks_state` available.

### Design for the Pure Function

```typescript
function evaluatePostApprovalChecks(
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

**Call site refactoring:**

Sites 1 and 2: Replace inline conditionals with:
```typescript
const issues = evaluatePostApprovalChecks(checks_state, mergeable);
if (issues.length > 0) {
  handlePostApprovalFailures(taskId, issues);
} else {
  // proceed to merge
}
```

Site 3 (attemptMerge): The reviewer listed this as a duplication site. It can use the function with synthetic inputs: `evaluatePostApprovalChecks("passing", false)` produces `["merge_conflict"]`. This is clean — it says "CI was fine but merge failed" which is exactly the situation (CI already passed before we attempted merge).

### Scope of Change

- **Single file:** `src/core/daemon/review-handler.ts`
- **New function:** ~8 lines
- **Refactored sites:** 3 call sites updated
- **Tests:** Existing tests should continue passing. Optionally add direct unit tests for the pure function.
- **No architectural changes, no new types, no cross-file impact**

## Assessment

This is a trivial mechanical refactoring. The reviewer's feedback is precise and includes the exact function signature. The duplicated pattern is obvious in the code. No ambiguity, no design decisions needed.

**Complexity: trivial** — Single file, extract function, update 3 call sites. Clear reviewer guidance.

## Team Contacts Referenced

- Farzam Mohammadi (owner) — Provided PR review feedback on #16
