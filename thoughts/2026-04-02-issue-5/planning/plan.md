# Plan: Keep Retrying Unsuccessful Outreach

## Approach

Implement a plugin-blind retry system for failed communication outreach. When NotificationRouter fails to deliver a message to all contacts for a person, instead of giving up, schedule retry attempts at configurable intervals while the task remains active.

**Core Strategy**: Enhance the existing NotificationRouter with a RetryManager subsystem that:
1. Captures failed delivery attempts instead of discarding them
2. Persists retry schedules to survive daemon restarts  
3. Integrates with the daemon tick loop for timing (following response-poller.ts patterns)
4. Respects AdapterError.retryable and retry_after_ms fields (plugin-blind)
5. Stops retries when tasks reach terminal states (completed/failed)

**Plugin Blindness Compliance**: Uses only CommunicationAdapter.sendMessage() results and AdapterError contract fields. Never assumes specific plugins or platform behaviors.

## Phases

### Phase 1: Retry State Management Infrastructure
- [x] Create `src/schemas/retry.ts` with retry state and configuration schemas
- [x] Add retry configuration to `src/schemas/config.ts` (outreach_retry_interval_ms, max_outreach_retry_attempts)
- [x] Create `src/core/daemon/retry-manager.ts` following response-poller.ts patterns for timing and failure tracking
- [x] Implement persistent retry state storage using the same pattern as other Core components
- **Verify:** RetryManager can persist/load retry schedules and integrate with daemon tick loop

### Phase 2: NotificationRouter Integration  
- [x] Modify `src/core/daemon/notification-router.ts` sendToFirstReachable() to capture failed deliveries
- [x] Replace "give up" logic (line 346-351) with retry scheduling via RetryManager
- [x] Extract AdapterError.retryable and retry_after_ms from failed sendMessage() calls
- [x] Respect per-plugin retry policies while maintaining plugin-blindness
- **Verify:** Failed notifications are scheduled for retry instead of being discarded

### Phase 3: Event-Driven Retry Management
- [x] Subscribe to `task.state_changed` events in RetryManager to stop retries for terminal states
- [x] Enhance retry attempts to emit observability events (`outreach.retry_scheduled`, `outreach.retry_succeeded`, `outreach.retry_abandoned`)
- [x] Implement retry attempt logic that calls back into NotificationRouter.sendToFirstReachable()
- [x] Add adaptive backoff similar to response-poller.ts for repeated failures
- **Verify:** Retries stop when tasks complete/fail, retry attempts are observable, backoff prevents spam

### Phase 4: Configuration and Integration
- [ ] Add retry configuration defaults to `src/schemas/config.ts` (30s interval, unlimited attempts while active)
- [ ] Integrate RetryManager into daemon subsystem lifecycle in `src/core/daemon/index.ts`
- [ ] Update daemon.poll() to include retry checks alongside other subsystem polling
- [ ] Ensure RetryManager follows Universal Adapter Contract patterns (initialize, healthCheck, shutdown)
- **Verify:** RetryManager starts/stops with daemon, respects configuration, integrates with existing polling

### Phase 5: Edge Case Handling and Robustness  
- [ ] Handle contact list changes between retry attempts (person directory updates)
- [ ] Prevent retry loops for permanently failing contacts (max failures per contact per task)
- [ ] Handle concurrent retry attempts and delivery success race conditions
- [ ] Add retry state cleanup for old completed/failed tasks to prevent memory leaks
- **Verify:** System gracefully handles edge cases without retry loops or state corruption

## Risks & Mitigations

- **Risk:** Retry loops cause message spam → **Mitigation:** Adaptive backoff with max attempts per contact, respect AdapterError.retry_after_ms from plugins
- **Risk:** Plugin blindness violations → **Mitigation:** Only use CommunicationAdapter contract, never reference plugin names or platform specifics  
- **Risk:** Memory leaks from unbounded retry state → **Mitigation:** Cleanup retry state for terminal tasks, implement max retry age limits
- **Risk:** Race conditions between retries and success → **Mitigation:** Check delivery success before each retry attempt, use atomic retry state updates
- **Risk:** Daemon restart loses retry schedules → **Mitigation:** Persistent retry state storage, reload on startup

## Test Strategy

**Unit Tests:**
- RetryManager state persistence and loading
- Retry scheduling logic and adaptive backoff
- Event bus integration for task state changes
- Configuration schema validation

**Integration Tests:**
- Full retry flow: failed delivery → scheduled retry → eventual success
- Plugin-blind behavior with mock CommunicationAdapter implementations  
- Task state transitions stopping retry attempts
- Daemon restart preserving retry schedules

**Edge Case Tests:**
- Contact list changes during retry window
- Multiple simultaneous retry attempts
- Task completion during retry attempt
- Plugin failure modes and retry_after_ms handling

**Manual Verification:**
- Set up Telegram plugin with unreachable user, verify retry attempts at 30s intervals
- Complete task during retry window, verify retries stop immediately
- Restart daemon with active retries, verify schedules are preserved

## Success Criteria

- [ ] Failed outreach messages are automatically retried at configurable intervals (default 30s)
- [ ] Retry attempts continue until task reaches terminal state (completed/failed)
- [ ] Plugin blindness maintained - system works with any CommunicationAdapter implementation
- [ ] Retry state survives daemon restarts without data loss
- [ ] No message spam - adaptive backoff prevents excessive retry attempts to permanently failing contacts
- [ ] Existing notification flow unchanged for successful deliveries (no performance impact)
- [ ] Observability events allow monitoring of retry behavior and success rates