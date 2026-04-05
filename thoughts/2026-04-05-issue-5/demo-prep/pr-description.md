# PR: Retry failed communication outreach while ticket is active

Closes #5

## Summary

When a communication outreach fails — e.g., a Telegram user hasn't `/start`ed the bot — the message was silently dropped. The task would transition to `blocked` believing the person was contacted, but no notification was ever delivered. The person never knew they were needed, and the task stayed stuck.

This PR adds an in-memory retry queue to the NotificationRouter that re-attempts failed sends at configurable intervals (default 30s) until the message is delivered, the task reaches a terminal state, or safety limits are hit.

## What Changed

### Core: Retry queue in NotificationRouter (+239 lines)
- When `sendToFirstReachable()` exhausts all contacts and at least one returned `retryable: true`, the notification is enqueued for retry.
- `processRetries(now)` is called every daemon tick. It iterates the queue and re-attempts delivery for entries whose interval has elapsed.
- Each retry re-runs the **full contact fallback chain** (re-resolves contacts, tries each in order). This means if a user `/start`s the Telegram bot between retries, the next attempt will find their chat_id and succeed.
- An `inFlight` flag prevents overlapping async retries for the same entry.

### Retry lifecycle bounds
Retries stop when:
- **Delivery succeeds** — entry removed, `comm.retry_succeeded` emitted
- **Task reaches terminal state** (`completed`/`failed`) — entry removed, `comm.retry_exhausted` emitted with `reason: "task_terminal"`
- **Max attempts reached** (default: 120, ~1 hour at 30s) — `reason: "max_attempts"`
- **Max age exceeded** (default: 1 hour) — `reason: "max_age"`

### Telegram plugin: Mark "not_found" as retryable (+1 line)
The Telegram plugin now returns `retryable: true` when a user has no chat_id (hasn't `/start`ed the bot). Previously this was `retryable: false` by default, which meant the message was permanently lost.

### Config: `notification_retry` block
```
daemon:
  notification_retry:
    interval_ms: 30000      # How often to retry (default: 30s)
    max_attempts: 120        # Max retries per notification (default: 120)
    max_age_ms: 3600000      # Max age before discard (default: 1 hour)
```
Zero-config: the entire block defaults to `{}` which applies all defaults.

### Events: Three new event types for observability
- `comm.send_failed` — emitted on initial failure (includes `retryable` flag)
- `comm.retry_succeeded` — emitted when a retry delivers successfully
- `comm.retry_exhausted` — emitted when retries are abandoned (with `reason`)

### Daemon tick loop: Step 2c
`notifications.processRetries?.(now)` added after response polling, before scheduling. Optional chaining because `processRetries` is optional on `INotificationRouter` — this avoids breaking 15+ test mock sites that only implement `notify` and `syncStateToCommPlugin`.

## Key Design Decisions

1. **In-memory queue, not SQLite**: The retry queue holds transient delivery state. On daemon restart, active tasks are recovered to `queued` by `rebuildStateFromTaskEngine()`, which re-triggers the outreach flow. Persistence adds complexity without meaningful benefit. Events (which ARE persisted) provide the audit trail.

2. **Plugin blindness maintained**: The Core retry mechanism checks only `result.error?.retryable === true`. It never references plugin identity, error codes, or channel types. The Telegram plugin decides its own error semantics (marking `not_found` as retryable) — that's the plugin's business.

3. **Optional `processRetries` on interface**: Rather than adding a required method to `INotificationRouter` (which would break ~15 test files with mock routers), the method is optional. The daemon tick uses optional chaining. Clean, minimal blast radius.

4. **Full chain retry**: Retries store the original `Notification` object and re-resolve contacts each time. This handles the case where a user connects to a channel between retry attempts.

## Files Changed (19 files, +724 / -13)

| File | Change |
|------|--------|
| `src/core/daemon/notification-router.ts` | Core retry queue + `processRetries()` logic |
| `src/core/daemon/notification-router.test.ts` | 8 new retry lifecycle tests |
| `src/core/daemon/index.ts` | Tick loop integration + 3 event declarations |
| `src/core/interfaces/notification-router.interface.ts` | Optional `processRetries?` method |
| `src/schemas/events.ts` | 3 new event types + payload schemas |
| `src/schemas/config.ts` | `notification_retry` config block |
| `src/plugins/communication/telegram-comm/telegram-comm.ts` | Mark "not_found" as `retryable: true` |
| `src/plugins/communication/telegram-comm/telegram-comm.test.ts` | Verify retryable flag |
| `src/cli/bootstrap.ts` | Wire config + clock into router context |
| `test/helpers/test-daemon.ts` | Add config + clock to test context |
| `test/helpers/integration-context.ts` | Add config + clock to integration context |
| 8 other test files | Add `notification_retry` to `DaemonConfig` fixtures |

## How to Test

### Automated
```bash
# Full test suite (2434 tests, all passing)
pnpm test

# Retry-specific tests
pnpm test -- notification-router

# Telegram plugin test
pnpm test -- telegram-comm

# Type safety
pnpm run typecheck
```

### Key test scenarios covered
1. **Retryable failure enqueues** — send fails with `retryable: true`, verify `comm.send_failed` event and entry in queue
2. **Retry delivers** — advance clock past interval, verify delivery and `comm.retry_succeeded` event
3. **Interval gating** — call `processRetries` before interval elapses, verify no retry attempted
4. **Terminal task stops retries** — set task to `completed`, verify entry pruned with `reason: "task_terminal"`
5. **Max attempts stops retries** — exhaust attempt count, verify `reason: "max_attempts"`
6. **Max age stops retries** — age past TTL, verify `reason: "max_age"`
7. **Non-retryable skipped** — send fails with `retryable: false`, verify no enqueue
8. **Full chain retry** — person with 2 contacts, verify both tried on retry

### Manual verification
1. Configure a Telegram comm plugin with a user who hasn't `/start`ed the bot
2. Create a task that triggers outreach to that user
3. Observe `comm.send_failed` events in logs with `retryable: true`
4. Have the user `/start` the bot
5. Wait for next retry cycle — observe `comm.retry_succeeded` event and message delivery

## Breaking Changes

None. The `notify()` signature is unchanged (still fire-and-forget `void`). The `processRetries` method is optional on the interface. Config defaults to zero-config operation. All existing tests pass without modification to their assertions.

## Deployment Notes

No migration needed. The new `notification_retry` config block is fully optional with sensible defaults. The retry queue is in-memory and starts empty on each daemon start.
