# Requirements Check — Retry Failed Communication Outreach

## Acceptance Criteria Verification

### 1. Failed outreach messages (retryable) are automatically retried at configurable intervals (~30s)
**Rating: MET**

- `notification-router.ts`: When `sendToFirstReachable()` exhausts all contacts and at least one returned `retryable: true`, a `RetryEntry` is pushed to the in-memory `retryQueue` (line 392-407).
- `processRetries()` (line 418-583) checks `now - entry.lastAttemptAt < retryConfig.interval_ms` and skips entries not yet due.
- Config default in `schemas/config.ts`: `interval_ms: 30_000` (30 seconds).
- Test: "processRetries skips if interval not elapsed" confirms gating works.

### 2. Retries stop when delivery succeeds
**Rating: MET**

- `processRetries()` retry loop: on successful delivery, entry is spliced from queue and `comm.retry_succeeded` is emitted (line 553-570).
- Test: "processRetries delivers on retry and emits comm.retry_succeeded" confirms this.

### 3. Retries stop when task reaches terminal state (completed/failed)
**Rating: MET**

- `processRetries()` checks `task.state === TaskStates.completed || task.state === TaskStates.failed` (line 433). Also handles `!task` (task not found).
- Emits `comm.retry_exhausted` with `reason: "task_terminal"`.
- Test: "processRetries stops on terminal task state (completed)" confirms this.

### 4. Retries stop when max attempts reached
**Rating: MET**

- `processRetries()` checks `entry.attempts >= retryConfig.max_attempts` (line 464).
- Default: 120 attempts (~1 hour at 30s).
- Test: "processRetries stops on max attempts" confirms this.

### 5. Retries stop when max age exceeded
**Rating: MET**

- `processRetries()` checks `now - entry.enqueuedAt > retryConfig.max_age_ms` (line 449).
- Default: 3,600,000ms (1 hour).
- Test: "processRetries stops on max age" confirms this.

### 6. Telegram "not_found" (user hasn't /started bot) is marked retryable
**Rating: MET**

- `telegram-comm.ts` line 169: `{ retryable: true }` added to `createAdapterError("not_found", ...)`.
- Test in `telegram-comm.test.ts`: `expect(result.error?.retryable).toBe(true)`.

### 7. Plugin blindness maintained — Core never references plugin identity or error codes
**Rating: MET**

- `notification-router.ts` retry logic only checks `result.error?.retryable === true` (line 317). Never checks plugin type, error code, or channel identity.
- The only plugin-specific change is inside the Telegram plugin itself (marking its own error as retryable), which is the correct boundary.

### 8. processRetries called every daemon tick
**Rating: MET**

- `daemon/index.ts` tick function: `notifications.processRetries?.(now)` added after response polling (Step 2c).
- Optional chaining used since `processRetries` is optional on `INotificationRouter`, avoiding breakage of mocks.

### 9. Events emitted for observability
**Rating: MET**

- Three new event types: `comm.send_failed`, `comm.retry_succeeded`, `comm.retry_exhausted`.
- Schemas defined in `schemas/events.ts` with proper payload types.
- Event declarations added to `EVENTS` array in `daemon/index.ts`.
- All three are emitted at correct points in the retry lifecycle.

### 10. Retry re-runs full contact fallback chain
**Rating: MET**

- `processRetries()` re-resolves contacts via `resolveContacts(notification)` and iterates all matching person contacts (line 517-530).
- Test: "retry re-runs full contact chain and succeeds on first contact" confirms both contacts tried initially, then first contact succeeds on retry.

### 11. Non-retryable failures do not enqueue
**Rating: MET**

- Enqueue condition: `if (anyRetryable && notification.taskId)` (line 392). If no contact returned `retryable: true`, nothing is enqueued.
- `comm.send_failed` still emitted with `retryable: false` for observability.
- Test: "non-retryable failure emits comm.send_failed with retryable: false and does not enqueue".

### 12. Configurable parameters
**Rating: MET**

- `schemas/config.ts`: `notification_retry` object with `interval_ms`, `max_attempts`, `max_age_ms`, all with sensible defaults and `.default({})` on the parent object for zero-config operation.

### 13. All existing tests pass
**Rating: MET**

- Full suite: 2434 tests pass. Typecheck clean. No regressions.
- Test helpers updated: `test-daemon.ts`, `integration-context.ts`, and other test files with mock contexts updated to include `config` and `clock`.

## Edge Cases Reviewed

| Edge Case | Status |
|-----------|--------|
| `notification.taskId` is undefined/null | Handled — only enqueues if `notification.taskId` is truthy (line 392) |
| Task deleted while in retry queue | Handled — `!task` check in processRetries (line 433) |
| Concurrent retries (tick faster than delivery) | Handled — `inFlight` boolean prevents overlapping retries |
| Daemon restart clears in-memory queue | Acceptable — requirements doc notes tasks recover via `rebuildStateFromTaskEngine()` which re-triggers outreach |
| `lastAttemptAt` set to `enqueuedAt` on enqueue | Correct — ensures first retry waits a full interval after initial failure |
| Exception in retry delivery | Handled — `.catch()` sets `entry.inFlight = false` so entry isn't permanently stuck |

## Code Quality Notes

1. **Clean separation**: All retry logic is encapsulated in the `createNotificationRouter` closure. No leaking abstractions.
2. **`inFlight` flag**: Smart guard against async overlap. Properly cleared in both success and error paths.
3. **Backward iteration for splice**: Correct pattern for in-place removal during iteration.
4. **Event payload schemas**: Properly typed with Zod, registered in all three maps (`EventTypeSchema`, `EventPayloads`, `eventPayloadSchemas`).
5. **Optional `processRetries` on interface**: Good call — avoids updating 15+ mock sites for a method only the daemon tick loop needs.

## Minor Observations (Not Blocking)

1. **No duplicate prevention**: If the same notification fails for the same person twice (e.g., `notify()` called again before retry succeeds), two entries will be enqueued. This is unlikely in practice since `notify()` is called once per outreach, but worth noting.
2. **`reason` field is a string, not an enum**: The `CommRetryExhaustedPayloadSchema` uses `z.string()` for `reason`. A `z.enum(["max_attempts", "max_age", "task_terminal"])` would be more precise. Minor.

## Overall Verdict

**ALL REQUIREMENTS MET.** The implementation is clean, well-tested, and architecturally sound. Plugin blindness is fully maintained. The retry mechanism integrates naturally into the daemon tick loop with proper lifecycle management. All 2434 tests pass with no regressions.
