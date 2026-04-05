# Refinements — Retry Failed Communication Outreach

## Review Findings Summary

The requirements check rated ALL 13 acceptance criteria as MET. My independent code review confirms this assessment. The implementation is architecturally sound, well-tested, and PR-ready.

## Findings by Severity

### Critical / Security
None.

### Bugs
None found. Key correctness checks verified:
- Backward iteration with `splice()` is correct pattern for in-place removal
- `inFlight` flag properly cleared in both success and `.catch()` error paths
- `retryQueue.indexOf(entry)` in async callback uses object reference equality — safe
- `as string` assertion on `taskId` is guarded by the enqueue condition (`notification.taskId` truthy)
- `lastAttemptAt` initialized to `enqueuedAt` ensures first retry waits a full interval

### Requirements Gaps
None. All functionality implemented per spec.

### Code Quality (Minor, Non-blocking)

1. **`reason` field is `z.string()` not `z.enum()`** — `CommRetryExhaustedPayloadSchema` uses `z.string()` for the `reason` field. A `z.enum(["max_attempts", "max_age", "task_terminal"])` would be more precise. Not worth fixing — the three string literals are only emitted internally and the loose schema doesn't cause runtime issues.

2. **No duplicate prevention** — If `notify()` were called twice for the same notification/person before the first retry succeeds, two entries would be enqueued. This is a theoretical edge case — `notify()` is called once per outreach in the current flow. Not worth adding complexity for.

## What Was Fixed
Nothing. No actionable issues found.

## What Remains Unfixed
Nothing blocking. The two minor observations above are documented for future consideration.

## Verification
- **Typecheck**: Clean (`tsc --noEmit` for both configs)
- **Tests**: 2434/2434 pass, 98/98 test files
- **Duration**: 12.77s

## Architecture Review

The implementation correctly:
- Encapsulates retry state in the `createNotificationRouter` closure (no leaked abstractions)
- Maintains plugin blindness — Core checks only `result.error?.retryable === true`
- Makes `processRetries` optional on `INotificationRouter` (avoids breaking 15+ mock sites)
- Uses fire-and-forget async with `inFlight` guard against overlapping retries
- Integrates into daemon tick loop via `notifications.processRetries?.(now)` (Step 2c)
- Provides full observability via three new events: `comm.send_failed`, `comm.retry_succeeded`, `comm.retry_exhausted`
- Supports zero-config operation via `notification_retry.default({})`

## Files Changed (19 files, +724 / -13)

| File | Change |
|------|--------|
| `src/core/daemon/notification-router.ts` | Core retry queue + processRetries logic |
| `src/core/daemon/notification-router.test.ts` | 8 new retry lifecycle tests |
| `src/core/daemon/index.ts` | Tick loop integration + event declarations |
| `src/core/interfaces/notification-router.interface.ts` | Optional `processRetries?` method |
| `src/schemas/events.ts` | 3 new event types + payload schemas |
| `src/schemas/config.ts` | `notification_retry` config block |
| `src/plugins/communication/telegram-comm/telegram-comm.ts` | Mark "not_found" as `retryable: true` |
| `src/plugins/communication/telegram-comm/telegram-comm.test.ts` | Verify retryable flag |
| `src/cli/bootstrap.ts` | Wire config + clock into router |
| `test/helpers/test-daemon.ts` | Add config + clock to test context |
| `test/helpers/integration-context.ts` | Add config + clock to integration context |
| 8 other test files | Add `notification_retry` to `DaemonConfig` fixtures |

## Verdict
**PR-ready.** Clean implementation, comprehensive tests, no regressions.
