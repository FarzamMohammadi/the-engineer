# Requirements: Keep Retrying Unsuccessful Outreach

## Task Description

When communication outreach fails (e.g., Telegram user unreachable), the system should keep retrying at intervals (suggested 30s) while the ticket is active. When the user becomes available, deliver the notification to unblock the task.

This must be implemented following plugin-blindness principles, work through the existing three-tier architecture, and integrate cleanly with PR management, state transitions, and the state machine.

## Gathered Context

### Current Outreach System
Through codebase exploration, I found the current outreach flow:

1. **Requirements gathering phase** creates `.txt` files in `outreach/` directory when it needs human input
2. **`sendOutreach()` function** (in `src/core/orchestrator/outreach-sender.ts`) reads these files and calls `NotificationRouter.notify()`
3. **NotificationRouter** (in `src/core/daemon/notification-router.ts`) attempts delivery via `sendToFirstReachable()`:
   - Tries each person's contacts in order (first = preferred)
   - For each contact, finds appropriate plugin and calls `sendMessage()` 
   - If delivery fails, tries next contact/channel for that person
   - If all contacts fail, logs warning and gives up entirely

### Architecture Constraints

**Three-tier model** (from `/docs/architecture/three-tier-model.md`):
- **Core** never knows about specific plugins (plugin-blindness principle)
- **Adapters** define contracts like `CommunicationAdapter` with `sendMessage()` method
- **Plugins** implement the contracts (TelegramCommPlugin, GitHubCommPlugin, etc.)

**CommunicationAdapter contract** (from `implementation-docs/3-interactions/adapter-contracts.md`):
- `sendMessage(target, message) -> SendResult` where `SendResult.success: boolean`
- `SendResult.error?: AdapterError` with `retryable: boolean` and `retry_after?: duration`
- Fallback chain handled by Core, not plugins

**Task states** (from `src/schemas/task.ts`):
- Tasks can be: `queued`, `active`, `blocked`, `review_pending`, `completed`, `failed`
- "Active ticket" likely means not in `completed` or `failed` states

### Current Gaps
1. **No retry mechanism** - when `sendMessage()` fails, system tries other contacts but never retries the same contact later
2. **No availability detection** - no way to detect when a previously unreachable user comes back online
3. **No persistent retry state** - failed outreach attempts are not tracked for later retry

### Key Technical Decisions Needed
1. **Where to implement retry logic?** Options:
   - Task Engine (manages task lifecycle and state)
   - Daemon (has timer/scheduling capabilities) 
   - NotificationRouter (already handles message delivery)

2. **How to detect user availability?** Must work through adapter contracts:
   - Periodic retry attempts (simple, plugin-blind)
   - Plugin capability to report user status (requires extending contracts)
   - Hybrid: retry + optional status reporting

3. **Retry state storage:** 
   - In-memory (lost on restart)
   - Database (persistent)
   - File-based (like other phase data)

## Assessment

I have sufficient context to proceed to the research phase. The requirements are clear:

**Core requirement:** Add retry logic for failed outreach that:
- Respects plugin-blindness (works through CommunicationAdapter contract)
- Retries at configurable intervals while task is active
- Integrates with existing NotificationRouter and task state machine
- Handles multiple communication channels per person appropriately

**Technical approach:** The retry logic should live at the Core tier (likely in NotificationRouter or a new RetryManager component) and use the existing `AdapterError.retryable` and `retry_after` fields to respect plugin-specific retry policies.

**Complexity level:** Medium - requires extending existing Core components and adding persistent state tracking, but follows established patterns.

The plugin-blindness constraint actually simplifies the design - we just need to enhance the Core's handling of failed `sendMessage()` calls rather than implement plugin-specific retry logic.

## Questions Asked

No outreach needed - sufficient information available in codebase and task description.

## Team Contacts Referenced

- **Farzam Mohammadi** (owner) - provided initial task requirements and architectural context