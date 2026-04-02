# Research: Manual PR Merge Detection and Task Completion

## Task Context

The task is to detect manual PR merges across git hosting providers and mark tasks as completed when this occurs. The user reports that after creating PRs, The Engineer loses track when users manually merge without providing feedback comments. Requirements gathering found that manual merge detection is already implemented but apparently not functioning as expected.

## Codebase Analysis

### Current Manual Merge Detection Implementation

The system **already has comprehensive manual merge detection** implemented in `src/core/daemon/review-handler.ts`:

1. **`checkMerges()` Function (Lines 201-213):**
   - Called every daemon tick (default: 5 seconds)
   - Queries all `review_pending` tasks
   - Uses `GitHostingAdapter.getPRStatus()` to check PR state
   - When `status.state === "merged"`, calls `completeTaskOnMerge()`

2. **Task Completion Flow (Lines 125-168):**
   - Handles sub-state transitions: `demo` → `code` → `completed`
   - Transitions task to `TaskStates.completed` with reason `"pr_merged"`
   - Performs cleanup: workspace cleanup, notifications, finalization

3. **Daemon Integration (src/core/daemon/index.ts, Lines 472-474):**
   - Main tick loop calls `reviewHandler.checkMerges(reviewPendingTasks)` every 5 seconds
   - Shared PR status cache prevents duplicate API calls
   - Circuit breaker protects against API failures

### Plugin-Blindness Compliance

The implementation correctly follows the plugin-blindness principle:

- Uses `GitHostingAdapter.getPRStatus()` interface - never references specific plugins
- Works with any git hosting provider (GitHub, GitLab, etc.)
- State mapping handled by adapter plugins (e.g., GitHub's `mapPRState()`)
- `PRStatus.state` enum: `"open" | "closed" | "merged"` is universal

### State Machine & Transitions

Valid transitions are properly defined in `src/schemas/task.ts`:
- `review_pending.demo` → `review_pending.code` → `completed` (Lines 283-287)
- Both transitions use `"pr_merged"` as the reason
- Task completion triggers workspace cleanup and notifications

### Task Metadata Requirements

For merge detection to work, tasks need:
- `task.review.pr_number`: Set by PR manager after creation (Line 288 in `pr-manager.ts`)
- `task.repo`: Repository identifier for API calls
- `task.state === "review_pending"`: Correct state for polling

## Relevant Files

- `src/core/daemon/review-handler.ts` — Core merge detection logic and task completion flow
- `src/core/daemon/index.ts` — Daemon tick loop that calls merge detection every 5 seconds
- `src/core/orchestrator/pr-manager.ts` — Sets `pr_number` on tasks after PR creation
- `src/plugins/git-hosting/github-hosting/github-hosting.ts` — GitHub adapter with correct state mapping
- `src/adapters/git-hosting.ts` — GitHostingAdapter interface for plugin-blind PR status queries
- `src/schemas/task.ts` — Task state transitions and review state schema
- `src/schemas/config.ts` — Daemon configuration including polling intervals and circuit breaker

## Patterns & Conventions

**Configuration:**
- Default tick interval: 5 seconds (`tick_interval_ms: 5000`)
- Circuit breaker: Max 3 API failures per 5-minute window before pausing
- Graceful error handling with sanitized logging

**Error Handling:**
- Circuit breaker prevents API overload during hosting provider outages
- Failed PR status checks are logged but don't crash the daemon
- Missing task metadata (no `pr_number` or `repo`) is silently skipped

**Testing:**
- Comprehensive test suite in `review-handler.test.ts`
- Merge detection tested with mocked hosting plugins
- State transition validation and cleanup verification

## Dependencies & Integration Points

**Core Dependencies:**
- `GitHostingAdapter` plugin for PR status queries
- `TaskEngine` for state transitions and task metadata
- `WorkspaceManager` for cleanup operations
- `NotificationRouter` for completion notifications

**API Dependencies:**
- Git hosting provider API (GitHub, GitLab, etc.) via adapter
- Network connectivity for PR status polling
- Valid authentication tokens

**Critical Integration Points:**
- PR creation must set `task.review.pr_number` (handled by PR manager)
- Tasks must be in `review_pending` state to be polled
- Circuit breaker state affects all review polling operations

## Complexity Assessment

**Moderate** — The core functionality is already implemented and tested. This appears to be a debugging/diagnosis issue rather than new development. The complexity lies in identifying why existing functionality isn't working as expected in the user's environment.

## Open Questions

Since the functionality exists but reportedly isn't working, the investigation should focus on:

1. **Is the daemon actually calling `checkMerges()` regularly?**
   - Daemon might not be running or tick interval misconfigured
   - Circuit breaker might be triggered, pausing all review polling

2. **Are tasks reaching `review_pending` state with proper metadata?**
   - Tasks need both `pr_number` and `repo` fields set
   - State transitions from PR creation might be failing

3. **Is the GitHostingAdapter returning correct "merged" state?**
   - API authentication issues could cause status query failures
   - Rate limiting or hosting provider API changes

4. **Are there race conditions in task lifecycle?**
   - PR creation timing vs. state transitions
   - Concurrent state changes during polling

5. **Is the issue with detection vs. notifications?**
   - Merge detection might work but notification delivery fails
   - User expectations vs. actual system behavior

## Key Findings

1. **Manual merge detection is fully implemented** — Complete system exists in `review-handler.ts` with proper state transitions, cleanup, and notifications.

2. **Plugin-blindness is correctly maintained** — Uses adapter interface, works with any git hosting provider, no hardcoded platform logic.

3. **Integration is comprehensive** — Daemon tick loop, circuit breaker, caching, error handling all properly implemented.

4. **Testing coverage exists** — Comprehensive test suite validates merge detection, state transitions, and edge cases.

5. **This is a debugging task, not new development** — The issue is diagnosing why existing functionality isn't working in the user's environment, not building new features.

The research strongly suggests this is an operational/configuration issue rather than missing functionality. Planning should focus on diagnostic approaches to identify the root cause of why existing merge detection is failing.