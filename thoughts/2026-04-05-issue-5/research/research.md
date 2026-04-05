# Research: Retry Failed Communication Outreach

## Task Context
When communication outreach fails (e.g., Telegram user hasn't `/start`ed the bot), keep retrying at ~30s intervals while the task is active. The retry mechanism must be plugin-blind (Core never references specific plugins), persist across restarts, and integrate into the daemon tick loop.

## Codebase Analysis

### Current Flow (How Outreach Works Today)

1. **Orchestrator's phase-runner** (`phase-runner.ts:518-541`) detects `need_more_info` from requirements_gathering phase.
2. Calls `sendOutreach()` (`outreach-sender.ts`) which reads `.txt` files from the outreach directory.
3. `sendOutreach()` calls `notifications.notify({ kind: "question", ... })` for each person.
4. **NotificationRouter** (`notification-router.ts`) resolves contacts via PeopleDirectory, groups by person, then calls `sendToFirstReachable()`.
5. `sendToFirstReachable()` is an async fire-and-forget function that tries each contact's channel in order. If all fail, it logs a warning and **drops the message**.
6. The task transitions to `blocked` state with `contacted` history (even if delivery failed).

### Where It Breaks

- **`tryDeliverToContact()`** (line 259-308): Returns `false` on failure. The `SendResult.error.retryable` and `retry_after_ms` fields are available in the result but **completely ignored**.
- **Telegram "not_found" case** (telegram-comm.ts:162-170): When user hasn't `/start`ed the bot, returns `createAdapterError("not_found", ...)` with **default `retryable: false`** (the `createAdapterError` default). The `isRetryable()` function (line 85-91) only returns `true` for 429 and 5xx — but the "not_found" case doesn't even reach the try/catch block; it returns early at line 162.
- **No retry infrastructure exists anywhere**. Failed sends are simply lost.

### Architecture Constraints (Plugin Blindness)

From `docs/philosophy.md` § Plugin Blindness:
- Core never knows which plugins exist, never references plugin by name
- Core speaks exclusively through adapter contracts
- The test: "If I deleted every plugin and replaced them with different implementations, would Core still compile and function?"

This means:
- The retry mechanism lives in Core (NotificationRouter or new subsystem)
- Retry decisions are based solely on `SendResult.error.retryable` field
- The Telegram plugin must be updated to mark "not_found" as `retryable: true` (the plugin knows its error semantics)

### Daemon Tick Loop (Where Retry Processing Fits)

The tick loop (`index.ts:442-503`) has 10 steps:
1. Cost limit queue processing
2. Trigger polling
2b. Response polling (comm plugins)
3+4. Preemption + scheduling
6. Health: stuck detection + blocked escalation + review reminders
7+8. Review handler (merges, feedback, CI)
9. Cleanup expired seen keys
10. Memory instrumentation

A retry step would fit naturally after Step 2b (response polling) and before Step 3 (scheduling). Both response polling and retry processing deal with communication adapters and task lifecycle.

### Existing Patterns to Follow

**Subsystem pattern**: Every daemon subsystem follows the same pattern:
- Factory function (`createXxx(ctx, ...)`) returning an interface object
- Narrowed context type in `types.ts` (e.g., `ResponsePollerContext`, `HealthMonitorContext`)
- Tests in co-located `.test.ts` file
- Integration into daemon via `index.ts` (construction in factory, wiring in `tick()`)

**CostLimitQueue** (`cost-limit-queue.ts`): Simplest subsystem — in-memory queue, drained on each tick. Not persistent (acceptable for cost limits, NOT for retry queue).

**ResponsePoller** (`response-poller.ts`): Better pattern for retries — per-plugin cursors, adaptive backoff, interval-based polling with `now` parameter. Uses `config.response_poll_interval_ms`.

**EventBus persistence**: Events are persisted to SQLite via EventBus. The retry queue could use the event stream itself for persistence (record failed sends as events, replay on restart), OR use a separate in-memory queue reconstructed from events on startup.

**Event declarations**: Each subsystem declares its events in an `EVENTS` array (see daemon `index.ts:37-95`). New event types need additions to `EventTypeSchema` in `schemas/events.ts`, plus payload schemas, plus entries in `EventPayloads` and `EventPayloadSchemas`.

### Config Pattern

`DaemonConfigSchema` in `schemas/config.ts` — all fields have `.default()` values and `.describe()` strings. New retry config would be a nested object like `review_polling` (lines 176-195).

### Notification Types

`Notification` type in `schemas/notifications.ts` is a discriminated union. Each kind has specific fields. The `notify()` method is synchronous (`void` return). This is important — the retry system needs access to the full notification payload to re-attempt delivery.

### INotificationRouter Interface

Currently just two methods: `notify()` and `syncStateToCommPlugin()`. The retry system could either:
- (a) Extend this interface (adds `processRetries()` or similar)
- (b) Be a separate subsystem that wraps/decorates the router
- (c) Be built into `notify()` itself (track failures internally)

Option (c) is cleanest — `notify()` already has access to the failed result via `sendToFirstReachable`. It just needs to enqueue failures.

### Task Lifecycle Awareness

Terminal states where retries should stop: `completed`, `failed` (from `TaskStates`).
The health monitor already checks `blocked` tasks and escalates to `failed` after timeout. Retries should stop when task leaves `blocked` (or any terminal state).

`taskEngine.getTask(taskId)` is available in the router context — can check `task.state` before each retry attempt.

## Relevant Files

### Must Change
- `src/core/daemon/notification-router.ts` — Add retry tracking to `sendToFirstReachable()`, enqueue failed sends, add `processRetries()` method
- `src/core/daemon/index.ts` — Add retry processing step to tick loop
- `src/core/daemon/types.ts` — Add `NotificationRetryContext` type if new subsystem
- `src/core/interfaces/notification-router.interface.ts` — Add `processRetries()` to interface
- `src/schemas/config.ts` — Add `notification_retry` config section to `DaemonConfigSchema`
- `src/schemas/events.ts` — Add `comm.send_failed` and `comm.retry_attempted` event types + payload schemas
- `src/plugins/communication/telegram-comm/telegram-comm.ts` — Mark "not_found" error as `retryable: true`

### Must Add
- `src/core/daemon/notification-router.test.ts` — New test cases for retry behavior

### Context Files (No Changes)
- `src/adapters/communication.ts` — CommunicationAdapter base class (sendMessage, SendResult)
- `src/adapters/errors.ts` — `createAdapterError()` factory (defaults retryable=false)
- `src/schemas/adapters.ts` — `SendResult`, `AdapterError` schemas
- `src/schemas/notifications.ts` — Notification discriminated union, NotificationKinds
- `src/schemas/task.ts` — Task states, ValidTransitions, BlockedDetails
- `src/core/daemon/response-poller.ts` — Pattern reference for polling + interval logic
- `src/core/daemon/cost-limit-queue.ts` — Pattern reference for tick-driven processing
- `src/core/daemon/health-monitor.ts` — Blocked escalation (stops retries on failed)
- `src/core/daemon/unblock-resolver.ts` — Unblock flow (stops retries on unblock)
- `src/core/orchestrator/outreach-sender.ts` — Caller of notify() for outreach
- `src/core/orchestrator/phase-runner.ts` — Where outreach triggers blocking
- `docs/philosophy.md` — Plugin blindness principles
- `docs/architecture/three-tier-model.md` — Three-tier model, AdapterError contract
- `test/helpers/test-observer-facade.ts` — Test observer helper
- `test/helpers/mock-factories.ts` — Mock factories for tests

## Patterns & Conventions

### Coding Style
- Factory functions, not classes (Decision #124)
- Vitest for testing with `describe`/`it`/`expect`
- Mock factories with `vi.fn()` and `createMockContext()` patterns
- `satisfies PublishInput<"event.type">` for type-safe event publishing
- Observer facade for structured logging (debug/info/warn/error)
- `async function flush()` helper in tests for fire-and-forget promises

### Naming
- Subsystem files: `kebab-case.ts` with co-located `.test.ts`
- Interfaces: `I`-prefixed in `src/core/interfaces/`
- Context types: `XxxContext` narrowed via `Pick<DaemonContext, ...>`
- Event types: `domain.action` (e.g., `comm.message_sent`)
- Payload schemas: `XxxPayloadSchema` with exported `XxxPayload` type

### Test Patterns
- Co-located with source: `notification-router.test.ts` next to `notification-router.ts`
- Helper functions at top: `createMockCommPlugin()`, `createMockContext()`
- `async function flush()` for microtask queue drain
- Import `createTestObserverFacade` from test helpers
- Numbered test descriptions matching requirement order

### Directory Structure
- Core daemon subsystems: `src/core/daemon/*.ts`
- Interfaces: `src/core/interfaces/*.interface.ts`
- Schemas: `src/schemas/*.ts`
- Plugins: `src/plugins/communication/{plugin-name}/{plugin-name}.ts`
- Test helpers: `test/helpers/`

## Dependencies & Integration Points

### What This Change Touches
1. **NotificationRouter** — Core change: add retry queue + processing
2. **Daemon tick loop** — Add retry step between response polling and scheduling
3. **DaemonConfig** — New config section for retry interval/limits
4. **Event schema** — New event types for observability
5. **Telegram plugin** — Mark "not_found" as retryable
6. **INotificationRouter interface** — Extend with retry processing method

### What Depends On It
- **Orchestrator's outreach-sender** — Calls `notifications.notify()`. No change needed (retry is transparent).
- **Health monitor's blocked escalation** — When task moves to `failed`, retries must stop. The retry system checks task state before each attempt.
- **Unblock resolver** — When task is unblocked, retries must stop. Same lifecycle check.
- **Response poller** — No direct interaction, but both poll comm plugins. Retry re-uses the same `sendMessage()` path.
- **Daemon state** — May want to expose retry queue depth in `DaemonState` for observability.

### Ripple Effects
- Minimal. The retry mechanism is internal to NotificationRouter + daemon tick. The `notify()` signature doesn't change (it remains fire-and-forget `void`). The only external-facing change is the new `processRetries()` method on the interface.
- Telegram plugin change is isolated — just changing `retryable` default for the early-return "not_found" case.

## Complexity Assessment

**Moderate.** Well-bounded scope with clear patterns to follow.

Key complexity factors:
1. **Persistence decision**: In-memory queue reconstructed from EventBus events vs. separate SQLite table. EventBus approach is simpler and follows existing patterns.
2. **Lifecycle coordination**: Retries must check task state before each attempt. Multiple components can change task state (unblock resolver, health monitor, orchestrator). But all go through TaskEngine, so checking `task.state` is sufficient.
3. **Concurrency**: `notify()` is fire-and-forget async. Retry processing in tick loop is sequential. No race conditions if retry queue is tick-driven (not timer-driven).
4. **Full chain retry**: Must retry the full contact fallback chain, not just the last contact. This means storing the original notification payload, not just the failed contact.

## Open Questions

None — all architectural decisions are well-constrained by the codebase patterns and plugin-blindness principle.

## Key Findings

1. **The "not_found" case in Telegram returns `retryable: false`** — The Telegram plugin's early return (no chat_id) bypasses the try/catch that sets retryable. It uses `createAdapterError("not_found", ...)` which defaults to `retryable: false`. This is the first thing to fix: the plugin should mark this as `retryable: true` because the user may `/start` the bot later.

2. **`sendToFirstReachable()` is the right hook point** — This is where all contacts for a person are tried and where "all failed" is detected (line 347-351). The retry queue should be populated from here.

3. **Store the `Notification` object for retries, not the resolved message** — This allows re-resolving contacts on retry (in case the user `/start`s between attempts, the contact resolution may succeed differently).

4. **EventBus-backed persistence is the simplest approach** — Emit a `comm.send_failed` event with the notification payload. On daemon restart, replay these events to reconstruct the retry queue. Emit `comm.retry_succeeded` or `comm.retry_exhausted` to clear them. This follows the existing "event stream IS the audit trail" principle.

5. **Tick-driven processing avoids concurrency issues** — Instead of `setInterval` inside the router, expose a `processRetries(now)` method called from the daemon tick loop. This is consistent with how `responsePoller.poll()`, `costLimitQueue.process()`, and `healthMonitor.checkBlockedEscalation()` all work.

6. **Config shape**: A nested object under `DaemonConfigSchema` similar to `review_polling`:
   ```
   notification_retry: {
     interval_ms: 30_000 (default)
     max_attempts: 100 (~50 min of retries at 30s intervals)
     max_age_ms: 3_600_000 (1 hour TTL)
   }
   ```

7. **No changes to `outreach-sender.ts` or `phase-runner.ts`** — The retry is transparent to callers. `notify()` still returns `void`. The retry infrastructure is internal to the notification system.
