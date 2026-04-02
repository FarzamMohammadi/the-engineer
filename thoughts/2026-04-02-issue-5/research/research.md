# Research: Keep Retrying Unsuccessful Outreach

## Task Context
When communication outreach fails (e.g., Telegram user unreachable), implement retry logic that attempts delivery at intervals (suggested 30s) while the ticket remains active. Must respect plugin-blindness principles and integrate cleanly with the existing three-tier architecture.

## Codebase Analysis

### Current Outreach Flow
The existing outreach system follows this path:

1. **Requirements gathering phase** writes `.txt` files to `outreach/` directory when human input is needed
2. **`sendOutreach()`** (`src/core/orchestrator/outreach-sender.ts`) reads these files and calls `NotificationRouter.notify()`
3. **NotificationRouter** (`src/core/daemon/notification-router.ts`) resolves contacts and calls `sendToFirstReachable()`
4. **`sendToFirstReachable()`** tries each person's contacts in order via `tryDeliverToContact()`
5. **`tryDeliverToContact()`** calls `plugin.sendMessage()` and returns boolean success
6. **Critical Gap**: When all contacts fail, system logs warning and gives up entirely - no retry mechanism exists

### Architecture Foundation

**Three-Tier Model** (per `/docs/architecture/three-tier-model.md`):
- **Core** speaks only through adapter contracts, never knows specific plugins
- **CommunicationAdapter** contract defines `sendMessage()` returning `SendResult`
- **AdapterError** includes unused `retryable: boolean` and `retry_after?: duration` fields

**Plugin Blindness Principle** (per `/docs/philosophy.md`):
- Core never references plugin names or makes platform-specific assumptions
- Must work through `CommunicationAdapter.sendMessage()` contract exclusively
- Detection and retry must be plugin-agnostic

**Event Bus System** (per `src/core/daemon/index.ts`):
- All inter-component communication flows as events
- `comm.message_sent` events are published on successful delivery
- Event-driven architecture enables reactive retry logic

### Task State Management

**Active Tasks** (per `src/schemas/task.ts`):
- Task states: `requirements_gathering`, `queued`, `active`, `blocked`, `review_pending`, `completed`, `failed`
- "Active ticket" means not in terminal states (`completed`, `failed`)
- `blocked` state specifically indicates waiting for human input

**State Transitions**:
- Tasks can move from `blocked` back to `active` when unblocked
- Task state changes emit `task.state_changed` events
- Blocked tasks contain `BlockedDetails` with contacted history

### Daemon Timing Infrastructure

**Tick Loop** (per `src/core/daemon/index.ts`):
- Main loop runs every `tick_interval_ms` (default: 5 seconds)
- Coordinates all subsystem polling and event processing
- Houses response poller, health monitor, trigger poller, etc.

**Response Poller** (`src/core/daemon/response-poller.ts`):
- Already polls communication plugins every `response_poll_interval_ms` (default: 5 seconds)
- Manages per-plugin cursors and failure tracking with adaptive backoff
- Pattern exists for timed communication polling

**Configuration** (`src/schemas/config.ts`):
- Multiple interval configurations: `tick_interval_ms`, `response_poll_interval_ms`, etc.
- Timeout stages with `repeat_interval_ms` support for recurring actions
- Established patterns for configurable timing behavior

## Relevant Files

- `src/core/daemon/notification-router.ts` — Core message delivery logic, where retry mechanism should integrate
- `src/core/orchestrator/outreach-sender.ts` — Creates outreach requests, would need to track retry state
- `src/core/daemon/index.ts` — Main daemon loop, coordinates subsystem timing
- `src/core/daemon/response-poller.ts` — Reference implementation for timed polling with failure tracking
- `src/schemas/adapters.ts` — CommunicationAdapter and AdapterError contracts
- `src/schemas/config.ts` — Configuration schemas for intervals and timeouts
- `src/schemas/events.ts` — Event definitions including `comm.message_sent` events
- `src/schemas/task.ts` — Task states and BlockedDetails structure
- `docs/philosophy.md` — Plugin blindness principle constraints
- `docs/architecture/three-tier-model.md` — Adapter contract boundaries

## Patterns & Conventions

**Timing & Polling**:
- Subsystems integrate with daemon's main tick loop
- Configurable intervals via `config.ts` schemas with `.default()` values
- Adaptive backoff patterns for handling failures (see response-poller.ts)
- Per-plugin failure tracking and rate limiting

**Plugin Integration**:
- All Core components work exclusively through adapter contracts
- Capability-based feature detection (`plugin.hasCapability("send")`)
- StandardError codes in `AdapterError` for consistent handling
- Plugin-agnostic error handling via `retryable` and `retry_after` fields

**Event-Driven Architecture**:
- Components communicate via Event Bus, not direct calls
- State changes trigger events that other components can react to
- Event schemas defined in `/schemas/events.ts` with validation
- Fire-and-forget async patterns for non-blocking operations

**State Persistence**:
- Task state managed by TaskEngine (database-backed)
- BlockedDetails structure tracks contacted history
- Configuration-driven behavior patterns throughout codebase

## Dependencies & Integration Points

**Core Components to Enhance**:
- **NotificationRouter**: Add retry state management and scheduling
- **Daemon**: Integrate retry polling into existing tick loop
- **TaskEngine**: Query for tasks needing retry attempts
- **Event Bus**: Track failed/successful message delivery

**Configuration Extensions Needed**:
- `outreach_retry_interval_ms` (default: 30000)
- `max_outreach_retries` (default: unlimited while active)
- Integration with existing timeout/interval patterns

**Event Flow Changes**:
- Track failed `sendMessage()` calls for retry scheduling
- React to `task.state_changed` events to stop retries for completed/failed tasks
- Emit retry attempt events for observability

**Data Storage**:
- Persist retry state to survive daemon restarts
- Track per-task, per-contact retry history
- Leverage existing BlockedDetails structure or extend it

## Complexity Assessment

**Moderate** — The implementation requires:

1. **New subsystem** (RetryManager) following existing daemon subsystem patterns
2. **Configuration schema additions** following established config patterns  
3. **State persistence** for tracking retry schedules across restarts
4. **Event integration** to react to state changes and track delivery status
5. **Plugin-blind implementation** using only CommunicationAdapter contracts

However, this builds on well-established patterns:
- Response poller provides timing and failure tracking template
- NotificationRouter already handles fallback chains
- AdapterError contract includes unused retry fields
- Event-driven architecture supports reactive behavior

## Open Questions

None — sufficient context available. The retry logic should enhance the existing `sendToFirstReachable()` mechanism in NotificationRouter, integrated with the daemon's tick loop for timing, using persistent state to track retry schedules, and respecting the plugin-blindness principle throughout.

## Key Findings

**Architecture Integration Point**: Enhance NotificationRouter with retry state management while maintaining its plugin-blind design. The daemon's existing response poller provides the timing pattern to follow.

**Plugin Blindness Compliance**: Use only `CommunicationAdapter.sendMessage()` results and `AdapterError.retryable` fields. Never assume specific plugins or platform behaviors.

**Timing Strategy**: Integrate with daemon's tick loop (5s default) to check retry schedules, with configurable retry intervals (30s suggested). Follow response-poller.ts adaptive backoff patterns.

**State Management**: Persist retry schedules to survive restarts, keyed by task ID and contact details. Leverage existing BlockedDetails structure or extend appropriately.

**Event Integration**: React to `task.state_changed` events to stop retries for terminal states, emit retry events for observability, track `comm.message_sent` success/failure.

**Graceful Degradation**: System must work with zero retry-capable plugins, one plugin, or many plugins. Retry logic is Core enhancement, not plugin requirement.