# Plan: Debug Manual PR Merge Detection

## Approach

Manual PR merge detection is **already fully implemented** in `src/core/daemon/review-handler.ts` but reportedly not working. The core functionality exists:

- Daemon polls PRs every 5 seconds via `checkMerges()`
- Uses `GitHostingAdapter.getPRStatus()` to detect merged state
- Transitions tasks: `review_pending` → `completed` when `pr.state === "merged"`
- Plugin-blind design works with any git hosting provider

This is a **debugging task** to identify why existing functionality fails. The plan focuses on diagnosis, observability improvements, and edge case handling rather than building new features.

## Phases

### Phase 1: Enhanced Diagnostics and Logging
- [x] Add detailed merge detection logging to `src/core/daemon/review-handler.ts`
  - Log every `checkMerges()` call with task count and IDs
  - Log PR status queries: `{taskId, repo, prNumber, state, merged, elapsed}`
  - Log state transition attempts and failures
  - Add circuit breaker status and failure count logging
- [x] Add daemon tick diagnostics to `src/core/daemon/index.ts`
  - Log when merge checking is called vs skipped
  - Track per-tick timing for merge detection operations
- [x] Create diagnostic CLI command `engineer debug-merges [--task-id <id>] [--follow]`
  - Show current `review_pending` tasks with PR metadata
  - Display recent merge detection activity and failures
  - Real-time streaming mode to watch merge detection in action
- **Verify:** Logs show detailed merge detection activity, easy to spot missing calls or API failures

### Phase 2: Task State Validation and Recovery
- [x] Validate task metadata completeness in `src/core/daemon/review-handler.ts`
  - Log tasks missing required fields: `review.pr_number`, `repo`
  - Track tasks stuck in `review_pending` without proper metadata
- [x] Add task state recovery mechanism to `src/core/orchestrator/pr-manager.ts`
  - Detect tasks with PRs created but missing metadata
  - Backfill missing `pr_number` from git remote tracking or adapter queries
- [x] Enhance state transition validation in `src/core/task-engine/`
  - Log failed state transitions with detailed reasons
  - Add recovery paths for common transition failures
- [x] Create repair CLI command `engineer repair-tasks [--dry-run]`
  - Identify tasks with incomplete PR metadata
  - Option to auto-repair missing fields from git hosting API
- **Verify:** All `review_pending` tasks have complete metadata, repair command fixes broken tasks

### Phase 3: API Reliability and Error Handling
- [x] Enhance API failure handling in `src/core/daemon/review-handler.ts`
  - Distinguish between transient (network) vs persistent (auth) failures
  - Add exponential backoff for transient failures before circuit breaker
  - Log detailed API error responses for debugging
- [x] Add GitHostingAdapter health monitoring to `src/adapters/git-hosting.ts`
  - Periodic health checks beyond basic connectivity
  - Track API rate limiting and quota usage
  - Monitor authentication token validity
- [x] Improve circuit breaker observability in review-handler
  - Log when circuit breaker triggers and recovers
  - Expose circuit breaker metrics via CLI status command
- [x] Add API debugging mode via environment variable `DEBUG_MERGE_DETECTION=true`
  - Log full API request/response cycles
  - Bypass rate limiting for debugging (with warnings)
- **Verify:** API failures are clearly diagnosed, circuit breaker behavior is observable

### Phase 4: Edge Case Detection and Handling
- [x] Add merge detection edge case handling to `src/core/daemon/review-handler.ts`
  - Handle rapid merge scenarios (merge before first poll)
  - Detect PRs closed without merge vs actual merges
  - Handle force-push scenarios that change PR state
- [x] Add timing-based diagnostics for race conditions
  - Track time between PR creation and first merge poll
  - Log concurrent state changes during merge detection
  - Detect tasks that transition away from `review_pending` before merge poll
- [x] Enhance GitHub adapter PR state detection in `src/plugins/git-hosting/github-hosting/github-hosting.ts`
  - Add detailed logging for `mapPRState()` decisions
  - Handle GitHub API edge cases (draft merges, forced merges)
  - Add validation that `pr.merged` field accurately reflects merge status
- [x] Create comprehensive test scenarios for edge cases
  - Rapid merge immediately after PR creation
  - Multiple concurrent tasks with same repo
  - Network interruptions during polling
- **Verify:** System handles edge cases gracefully, race conditions are detectable

### Phase 5: System Integration Validation
- [x] Add end-to-end merge detection test to integration test suite
  - Create PR via The Engineer → manually merge → verify task completion
  - Test across different merge strategies (merge, squash, rebase)
  - Validate with different git hosting plugins (if available)
- [x] Enhanced observability via event bus in `src/core/daemon/review-handler.ts`
  - Publish `merge.detected` events with detailed metadata
  - Track merge detection performance metrics
  - Add dashboard integration points for monitoring
- [x] Validate daemon configuration and plugin setup
  - Ensure tick interval allows sufficient merge detection frequency
  - Verify git hosting plugin authentication and permissions
  - Check repository access and API scopes
- [x] Create health check for merge detection system
  - Add to `engineer doctor` command
  - Verify all required components are functional
  - Test merge detection on a dummy PR if possible
- **Verify:** End-to-end flow works reliably, system health is monitorable

## Risks & Mitigations

- **Risk:** Changes introduce performance overhead in hot daemon loop → **Mitigation:** Use debug flags for verbose logging, benchmark tick timing
- **Risk:** Diagnostic changes mask the actual bug → **Mitigation:** Add logging incrementally, test after each change
- **Risk:** Race conditions in concurrent task polling → **Mitigation:** Use shared PR status cache, atomic state transitions
- **Risk:** API rate limiting from enhanced monitoring → **Mitigation:** Respect existing circuit breaker, add backoff mechanisms
- **Risk:** Plugin-blindness violations during debugging → **Mitigation:** All diagnostics go through adapter interfaces, no GitHub-specific code in Core

## Test Strategy

- **Unit Tests:** Mock merge detection scenarios with controlled API responses
- **Integration Tests:** End-to-end merge detection with real GitHub API calls
- **Manual Testing:** Create test PRs, merge manually, verify task completion
- **Edge Case Testing:** Rapid merges, network failures, concurrent operations
- **Performance Testing:** Daemon tick timing with enhanced logging enabled

## Success Criteria

- [ ] Clear identification of why merge detection fails in user's environment
- [ ] Enhanced logging reveals merge detection activity at every step
- [ ] Diagnostic tools enable real-time monitoring of merge detection
- [ ] System reliably detects manual PR merges within 5-10 seconds
- [ ] All edge cases and failure modes are handled gracefully
- [ ] Plugin-blindness principle is maintained throughout all changes
- [ ] Zero regression in existing daemon performance or functionality