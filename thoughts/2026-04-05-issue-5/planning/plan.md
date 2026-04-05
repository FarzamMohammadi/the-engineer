# Plan: Retry Failed Communication Outreach

## Approach

Add an in-memory retry queue to the NotificationRouter that captures failed sends and re-attempts delivery on each daemon tick at configurable intervals. The queue is populated when `sendToFirstReachable()` exhausts all contacts without success and at least one contact returned `retryable: true`. A new `processRetries(now)` method is called from the daemon tick loop (after response polling, before scheduling). Each retry re-runs the full contact fallback chain. Retries stop when: delivery succeeds, task reaches a terminal state (`completed`/`failed`), max attempts exhausted, or max age exceeded.

The Telegram plugin is updated to mark the "not_found" (no chat_id) error as `retryable: true`, since the user may `/start` the bot later. This is the only plugin change — the Core retry mechanism operates solely on the `retryable` flag from `SendResult.error`, maintaining plugin blindness.

**Why in-memory (not SQLite)?** The retry queue holds transient delivery state for active tasks. If the daemon restarts, orphaned active tasks are recovered to `queued` state by `rebuildStateFromTaskEngine()`, which will re-trigger the outreach flow when the task re-executes. Persisting retries adds complexity without meaningful benefit. The `comm.send_failed` and `comm.retry_succeeded`/`comm.retry_exhausted` events provide the audit trail via EventBus (which IS persisted).

## Phases

### Phase 1: Schema Changes (Events + Config)

- [x] **`src/schemas/events.ts`** — Add three new event types to `EventTypeSchema`: `"comm.send_failed"`, `"comm.retry_succeeded"`, `"comm.retry_exhausted"`
- [x] **`src/schemas/events.ts`** — Add payload schemas:
  - `CommSendFailedPayloadSchema`: `{ task_id: string, person_id: string, kind: string, channels_tried: string[], retryable: boolean }`
  - `CommRetrySucceededPayloadSchema`: `{ task_id: string, person_id: string, kind: string, channel: string, attempt: number }`
  - `CommRetryExhaustedPayloadSchema`: `{ task_id: string, person_id: string, kind: string, attempts: number, reason: string }` (reason: "max_attempts" | "max_age" | "task_terminal")
- [x] **`src/schemas/events.ts`** — Add types to `EventPayloads` mapped type and `eventPayloadSchemas` runtime registry
- [x] **`src/schemas/config.ts`** — Add `notification_retry` nested config to `DaemonConfigSchema`:
  ```
  notification_retry: z.object({
    interval_ms: z.number().int().positive().default(30_000)
      .describe("How often to retry failed notification sends. Default: 30 seconds."),
    max_attempts: z.number().int().positive().default(120)
      .describe("Maximum retry attempts per notification. Default: 120 (~1 hour at 30s intervals)."),
    max_age_ms: z.number().int().positive().default(3_600_000)
      .describe("Maximum age of a retry entry before it is discarded. Default: 1 hour."),
  }).default({})
  ```
- **Verify:** `pnpm run typecheck` passes. No runtime changes yet.

### Phase 2: Telegram Plugin — Mark "not_found" as Retryable

- [x] **`src/plugins/communication/telegram-comm/telegram-comm.ts`** (~line 163-170) — Change the `createAdapterError("not_found", ...)` call to include `{ retryable: true }`:
  ```typescript
  error: createAdapterError(
    "not_found",
    `No chat_id for user "${target.user_id}" — they need to /start the bot first`,
    { retryable: true },
  ),
  ```
- [x] **`src/plugins/communication/telegram-comm/telegram-comm.test.ts`** — Add/update test: when user has no chat_id, `sendMessage` returns `error.retryable === true`
- **Verify:** `pnpm test -- telegram-comm` passes.

### Phase 3: NotificationRouter — Add Retry Queue + Processing

This is the core change. The retry queue is internal to the router factory closure.

- [x] **`src/core/interfaces/notification-router.interface.ts`** — Add `processRetries?(now: number): void` as an **optional** method on `INotificationRouter` (avoids breaking 15+ test mock sites)
- [x] **`src/core/daemon/notification-router.ts`** — Add to `NotificationRouterContext`: a `config` field typed as `Pick<DaemonConfig, "notification_retry">` (or import the full `DaemonConfig` and pick). Also add `clock: Clock` for timestamp access.
- [x] **`src/core/daemon/notification-router.ts`** — Define retry queue entry type inside the factory:
  ```typescript
  interface RetryEntry {
    notification: Notification;
    personId: string;
    enqueuedAt: number;
    attempts: number;
    lastAttemptAt: number;
  }
  ```
- [x] **`src/core/daemon/notification-router.ts`** — Add `retryQueue: RetryEntry[]` array in the factory closure
- [x] **`src/core/daemon/notification-router.ts`** — Modify `sendToFirstReachable()`:
  - After the "None succeeded" warning (line 346-351), check if any contact's `SendResult.error?.retryable` was `true` during the delivery attempts
  - To capture this: modify `tryDeliverToContact()` to return `{ delivered: boolean, retryable: boolean }` instead of just `boolean`. Track the `retryable` flag from `result.error?.retryable` on failure.
  - If at least one contact was retryable, push a `RetryEntry` to `retryQueue` with `enqueuedAt: clock.now()`, `attempts: 0`, `lastAttemptAt: 0`
  - Emit `comm.send_failed` event with `retryable: true`
  - If no contacts were retryable, emit `comm.send_failed` with `retryable: false` (fire-and-forget, no retry)
- [x] **`src/core/daemon/notification-router.ts`** — Add `processRetries(now: number)` function:
  ```
  1. Iterate retryQueue (backwards for safe splice)
  2. For each entry:
     a. Check task state: if completed/failed → remove entry, emit comm.retry_exhausted (reason: "task_terminal"), continue
     b. Check max age: if (now - entry.enqueuedAt) > config.notification_retry.max_age_ms → remove, emit comm.retry_exhausted (reason: "max_age"), continue
     c. Check max attempts: if entry.attempts >= config.notification_retry.max_attempts → remove, emit comm.retry_exhausted (reason: "max_attempts"), continue
     d. Check interval: if (now - entry.lastAttemptAt) < config.notification_retry.interval_ms → skip (not due yet)
     e. Re-resolve contacts, re-attempt delivery via the same sendToFirstReachable logic (but inline, not recursive — use a helper)
     f. If delivered: remove entry, emit comm.retry_succeeded
     g. If not delivered: increment attempts, update lastAttemptAt = now (entry stays in queue)
  ```
- [x] **`src/core/daemon/notification-router.ts`** — Return `processRetries` in the factory's return object: `return { notify, syncStateToCommPlugin, processRetries }`
- [x] **`src/core/daemon/notification-router.ts`** — Add event declarations for the three new events to the EVENTS array in `src/core/daemon/index.ts` (following existing pattern with `payloadSchema`, `publishers`, `subscribers`)
- **Verify:** `pnpm run typecheck` passes.

### Phase 4: Daemon Tick Loop Integration

- [x] **`src/core/daemon/index.ts`** — Add retry processing step in `tick()` after Step 2b (response polling) and before Step 3+4 (preemption + scheduling):
  ```typescript
  // Step 2c: Process pending notification retries
  notifications.processRetries?.(now);
  ```
  Note: `notifications` is `ctx.notifications` (type `INotificationRouter`). Using optional chaining since `processRetries` is optional on the interface.
- [x] **`src/core/daemon/index.ts`** — Add the three new event declarations to the `EVENTS` array:
  ```typescript
  {
    type: "comm.send_failed",
    description: "Emitted when a notification could not be delivered to any channel for a person",
    payloadSchema: CommSendFailedPayloadSchema,
    publishers: ["notification-router"],
    subscribers: [],
  },
  {
    type: "comm.retry_succeeded",
    description: "Emitted when a previously failed notification is successfully delivered on retry",
    payloadSchema: CommRetrySucceededPayloadSchema,
    publishers: ["notification-router"],
    subscribers: [],
  },
  {
    type: "comm.retry_exhausted",
    description: "Emitted when notification retries are abandoned (max attempts, max age, or task terminal)",
    payloadSchema: CommRetryExhaustedPayloadSchema,
    publishers: ["notification-router"],
    subscribers: [],
  },
  ```
- [x] **`src/core/daemon/notification-router.ts`** — Update `NotificationRouterContext` to include `config` (at minimum `notification_retry` portion) and `clock`
- [x] **Wiring** — Three call sites need `config` and `clock` added:
  1. **`src/cli/bootstrap.ts:145`** — Add `config: { notification_retry: config.daemon.notification_retry }` and `clock: new RealClock()` (import `RealClock` already present at line 24)
  2. **`test/helpers/test-daemon.ts:325`** — Add `config: { notification_retry: { interval_ms: 100, max_attempts: 3, max_age_ms: 10_000 } }` and `clock: { now: vi.fn().mockReturnValue(Date.now()) }`
  3. **`test/helpers/integration-context.ts:154`** — Same pattern as test-daemon.ts
- **Verify:** `pnpm run typecheck` passes. `pnpm test` passes (existing tests still green).

### Phase 5: Tests

- [x] **`src/core/daemon/notification-router.test.ts`** — Update `createMockContext()` to include `config: { notification_retry: { interval_ms: 100, max_attempts: 3, max_age_ms: 10_000 } }` and `clock: { now: vi.fn().mockReturnValue(Date.now()) }`
- [x] **Test: retry queue populated on retryable failure** — Send a notification where `sendMessage` returns `{ success: false, error: { retryable: true, ... } }`. Verify `comm.send_failed` event is emitted with `retryable: true`.
- [x] **Test: processRetries delivers on retry** — Enqueue a failed send, then mock `sendMessage` to succeed, call `processRetries(now)` with `now` past the interval. Verify delivery and `comm.retry_succeeded` event.
- [x] **Test: processRetries skips if interval not elapsed** — Enqueue a failed send, call `processRetries(now)` with `now` before the interval. Verify `sendMessage` not called again.
- [x] **Test: processRetries stops on terminal task state** — Enqueue a failed send, mock `taskEngine.getTask()` to return `{ state: "completed" }`, call `processRetries`. Verify entry removed and `comm.retry_exhausted` emitted with reason `"task_terminal"`.
- [x] **Test: processRetries stops on max attempts** — Enqueue a failed send, set `attempts` to `max_attempts`, call `processRetries`. Verify `comm.retry_exhausted` with reason `"max_attempts"`.
- [x] **Test: processRetries stops on max age** — Enqueue a failed send with old `enqueuedAt`, call `processRetries`. Verify `comm.retry_exhausted` with reason `"max_age"`.
- [x] **Test: non-retryable failure does not enqueue** — Send notification where `sendMessage` returns `{ success: false, error: { retryable: false } }`. Verify `comm.send_failed` emitted with `retryable: false` and no entry in retry queue.
- [x] **Test: retry re-runs full contact chain** — Person has 2 contacts. First attempt: both fail (retryable). Retry: first contact succeeds. Verify both contacts were tried on first attempt and first contact succeeds on retry.
- **Verify:** `pnpm test -- notification-router` — all tests pass. `pnpm test` — full suite green.

### Phase 6: Final Verification

- [x] `pnpm run typecheck` — no type errors
- [x] `pnpm run lint` — no lint violations
- [x] `pnpm test` — full test suite passes
- [x] `pnpm run build` — production build succeeds
- **Verify:** All checks pass.

## Risks & Mitigations

- **Risk:** `processRetries` is synchronous but delivery is async (fire-and-forget). Could lead to concurrent retries for same entry if tick is faster than delivery.
  **Mitigation:** Mark entries with an `inFlight: boolean` flag. Set `true` before attempting, clear on completion. Skip entries where `inFlight === true`. This prevents overlapping retries.

- **Risk:** Retry queue grows unbounded if many notifications fail continuously.
  **Mitigation:** `max_attempts` (120) and `max_age_ms` (1 hour) bound each entry. Additionally, terminal task states prune entries. The queue is per-daemon-process and resets on restart. For extra safety, could add a hard cap (e.g., 1000 entries) but unlikely to be needed given task count is bounded by `max_concurrent`.

- **Risk:** Breaking the `NotificationRouterContext` type by adding `config` and `clock` could break existing call sites.
  **Mitigation:** Find the exact call site(s) for `createNotificationRouter` and update them. The daemon already has `config` and `clock` in `DaemonContext`, so the values are available.

- **Risk:** `tryDeliverToContact` return type change from `boolean` to `{ delivered: boolean, retryable: boolean }` breaks existing callers.
  **Mitigation:** This function is private (closure-scoped). Only `sendToFirstReachable` calls it. Update the single call site.

- **Risk:** Adding `processRetries` to `INotificationRouter` breaks ~15+ test files that mock the interface with `{ notify: vi.fn(), syncStateToCommPlugin: vi.fn() }`.
  **Mitigation:** Add `processRetries` as an **optional method** on the interface (`processRetries?(now: number): void`), OR add `processRetries: vi.fn()` to all mock sites. The optional approach is cleaner — callers that don't need retry (orchestrator tests) don't break. The daemon tick loop uses a type assertion or checks for method existence. **Recommended: make it optional on the interface.** The daemon tick in `index.ts` can safely call `notifications.processRetries?.(now)` with optional chaining. This avoids touching 15+ test files for a no-op mock.
  
  Affected mock locations (for reference if non-optional approach chosen):
  - `src/core/daemon/task-scheduler.test.ts`
  - `src/core/daemon/cost-limit-queue.test.ts`
  - `src/core/daemon/query-handler.test.ts`
  - `src/core/orchestrator/phase-runner.test.ts`
  - `src/core/orchestrator/llm-caller.test.ts`
  - `src/core/orchestrator/decomposition-handler.test.ts`
  - `src/core/orchestrator/pr-manager.test.ts`
  - `src/core/orchestrator/workspace-lifecycle.test.ts`
  - `src/core/orchestrator/workspace-lifecycle.issue-comment.test.ts`
  - `test/helpers/test-daemon.ts`
  - `test/helpers/integration-context.ts`

## Test Strategy

- **Unit tests** (Phase 5) cover all retry lifecycle scenarios: enqueue, deliver on retry, interval gating, terminal-state cleanup, max-attempts cleanup, max-age cleanup, non-retryable skip, full-chain retry.
- **Telegram plugin test** confirms `retryable: true` on "not_found" error.
- **Existing notification-router tests** continue to pass (no regression).
- **Integration tests**: The daemon tick loop integration is validated by typecheck + existing daemon tests. No new integration test needed — the retry is an internal mechanism that's transparent to callers.

## Success Criteria

- [x] Failed outreach messages (retryable) are automatically retried at ~30s intervals
- [x] Retries stop when: delivery succeeds, task reaches terminal state, max attempts reached, or max age exceeded
- [x] Telegram "not_found" (user hasn't /started bot) is marked retryable
- [x] Plugin blindness maintained — Core never references plugin identity or error codes
- [x] `processRetries(now)` called every daemon tick, gated by interval config
- [x] Events emitted for observability: `comm.send_failed`, `comm.retry_succeeded`, `comm.retry_exhausted`
- [x] All existing tests pass, new tests cover retry lifecycle
- [x] `typecheck`, `lint`, `build` all pass
