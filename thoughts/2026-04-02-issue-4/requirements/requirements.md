# Requirements: Manual PR Merge Detection and Task Completion

## Task Description
**From GitHub Issue #4:**
After creating the pull request, consider manual merge as integrated

**Extended Context:**
The issue occurs because The Engineer uses a GitHub PAT based on the user's account, acting as the user. Since GitHub prevents users from approving their own PRs, there's a workflow gap:
1. The Engineer creates a PR during the Review phase
2. User manually merges the PR without comments (no feedback needed)
3. The Engineer doesn't detect the manual merge and loses track of task completion
4. Task remains in `review_pending` state indefinitely instead of transitioning to `completed`

The requirement is to detect manual merges across any git hosting provider and mark the task as complete.

## Gathered Context

### Current Implementation Analysis
Through codebase exploration, I discovered that **manual merge detection is already implemented**:

1. **Existing Functionality** (`src/core/daemon/review-handler.ts`):
   - `checkMerges()` function polls PRs for merge status every 5 seconds
   - Uses `GitHostingAdapter.getPRStatus()` to check PR state
   - When `pr.state === "merged"`, calls `completeTaskOnMerge()`
   - Transitions task: `review_pending` → `completed`
   - Handles cleanup, notifications, and finalization

2. **Architecture Compliance**:
   - Follows plugin-blindness principle via `GitHostingAdapter` interface
   - Works with any git hosting provider (GitHub, GitLab, etc.)
   - Uses `PRStatus.state` enum: `"open" | "closed" | "merged"`

3. **Integration Points**:
   - Called in daemon main loop every 5 seconds (configured via `tick_interval_ms`)
   - Caches PR status per tick to avoid duplicate API calls
   - Has circuit breaker for API failures

4. **Test Coverage**:
   - Comprehensive test suite covering merge detection
   - Edge case handling (no PR number, missing plugin, etc.)
   - State transition validation

### State Machine Flow
**Current Valid Transitions:**
- `review_pending.demo` → `review_pending.code` → `completed` (via merge detection)
- `review_pending.code` → `completed` (via merge detection)

The transitions are already defined in `src/schemas/task.ts`.

### Configuration Context
- Daemon tick interval: 5 seconds (`tick_interval_ms`)
- Review polling failure threshold: 3 failures per 5 minutes (`max_failures_before_pause`)
- Circuit breaker prevents system overload during API outages

## Assessment

**The core functionality is already implemented and should be working.**

However, since the user reports manual merges aren't being detected, there are potential issues:

### Possible Root Causes
1. **Configuration Issues**:
   - Daemon not running or polling disabled
   - Incorrect git hosting plugin configuration
   - Polling interval too infrequent (though 5s should be adequate)

2. **State Issues**:
   - Tasks not reaching `review_pending` state properly after PR creation
   - Race conditions in state transitions

3. **Plugin Issues**:
   - GitHostingAdapter plugin not detecting "merged" state correctly
   - API authentication or rate limiting problems

4. **Edge Cases**:
   - PR created but task state not updated with `pr_number`
   - Tasks without proper repo or PR metadata

### Critical Questions for Implementation
Since this appears to be a bug or configuration issue rather than missing functionality, the questions are more diagnostic:

1. **Are manual merges actually going undetected, or is the detection working but notifications failing?**
2. **Are there specific scenarios (repo types, merge methods, timing) where detection fails?**
3. **Should we add more robust error handling, logging, or retry mechanisms?**

This is ready to proceed to research phase to investigate why the existing functionality isn't working as expected rather than building new functionality.

## Team Contacts Referenced
- **Farzam Mohammadi** (owner) — Problem reporter and system owner