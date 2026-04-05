# Requirements: Retry Failed Communication Outreach

## Task Description
When a communication outreach fails (e.g., Telegram message can't be delivered because user hasn't `/start`ed the bot), keep retrying at configurable intervals (~30s) while the task/ticket is still active. This ensures that when the user comes online or connects, the notification is delivered and the task unblocks.

Source: GitHub Issue #5

## Gathered Context

### Current Behavior (What Exists)
1. **Outreach flow**: Orchestrator's `outreach-sender.ts` reads `.txt` files from the outreach directory, resolves contacts via PeopleDirectory, and routes through `NotificationRouter` with `kind: "question"`.
2. **NotificationRouter** (`src/core/daemon/notification-router.ts`): Tries each contact for a person in order (fallback chain). On failure, tries next contact. If all fail, logs `warn` and gives up. **Fire-and-forget** — caller never sees the failure.
3. **Plugin error reporting**: Plugins return `SendResult` with `AdapterError` containing `retryable: boolean` and `retry_after_ms: number | null`. **These fields are currently set by plugins but completely ignored by the router.**
4. **Telegram plugin**: Returns `retryable: true` for 429 (rate limit) and 5xx errors. Returns `error.code = "not_found"` when user hasn't `/start`ed the bot (no chat_id mapping). This "not_found" case is the primary scenario the issue describes.
5. **Task blocked state**: When outreach succeeds, task transitions to `blocked` with `contacted` history. The daemon's `unblock-resolver.ts` watches for responses. `health-monitor` escalates long-blocked tasks to `failed` after a timeout.
6. **Daemon tick loop**: 10-step cycle running every 1-5s. Currently has no retry step for failed communications.

### What Needs to Change
A retry mechanism for failed outreach messages that:
- **Persists failed sends** so they survive daemon restarts
- **Retries at intervals** (~30s, configurable) while the task is in an active lifecycle state (not `completed` or `failed`)
- **Stops retrying** when: message is delivered, task completes/fails, or a max retry count/duration is reached
- **Remains plugin-blind** — Core never checks which plugin failed or why. It sees a failed `SendResult` with `retryable` flag and acts on that alone. This is the critical architectural constraint from `docs/philosophy.md` § Plugin Blindness.

### Key Files
| File | Role |
|------|------|
| `src/core/daemon/notification-router.ts` | Central message routing — where retry logic should hook in |
| `src/core/daemon/index.ts` | Daemon tick loop — needs a retry processing step |
| `src/core/orchestrator/outreach-sender.ts` | Outreach sender — consumes NotificationRouter |
| `src/core/orchestrator/phase-runner.ts` | Phase runner — triggers outreach before blocking |
| `src/adapters/communication.ts` | CommunicationAdapter base class with SendResult/AdapterError |
| `src/schemas/notifications.ts` | Notification kind discriminated union |
| `src/schemas/task.ts` | Task states, BlockedDetails, ValidTransitions |
| `src/core/daemon/unblock-resolver.ts` | Handles unblocking on response receipt |
| `src/plugins/communication/telegram-comm/telegram-comm.ts` | Telegram plugin — primary failure scenario |
| `src/plugins/communication/github-comm/github-comm.ts` | GitHub comm plugin — for reference |

### Design Considerations
1. **Plugin Blindness**: The retry mechanism must live in Core (NotificationRouter or a new component) and operate only on `SendResult.error.retryable` — never on plugin identity or error codes.
2. **Persistence**: Failed sends should be stored in SQLite (fits the existing EventBus/DB pattern) so retries survive restarts.
3. **Daemon tick integration**: A retry processing step in the tick loop (similar to `responsePoller.poll()`) that checks for pending retries and attempts re-delivery.
4. **Lifecycle awareness**: Retries must check task state before each attempt — if task is `completed` or `failed`, discard the pending retry.
5. **Configurable interval**: ~30s default, but should be a daemon config value.
6. **Max retries or TTL**: Need a bound to prevent infinite retries. Could be time-based (retry for N hours) or count-based.
7. **"not_found" is not currently retryable**: Telegram returns `retryable: false` for "not_found" (user hasn't started bot). The issue specifically wants this case retried. This means either: (a) the Telegram plugin should mark "not_found" as `retryable: true` (since the user may `/start` later), or (b) Core retries all failed sends regardless of `retryable` flag. Option (a) is architecturally cleaner — the plugin knows its error semantics.
8. **Multiple contacts per person**: The current fallback chain (try contact 1, then 2, then 3) should still apply. Retry should re-attempt the full chain, not just the last-tried contact.
9. **Event emission**: Failed sends and retries should emit events for observability.

## Questions Asked
None needed — the task description, codebase exploration, and architecture docs provide sufficient clarity.

## Assessment
**Ready to proceed to research.** The requirements are clear:
- Add a retry queue for failed communication sends
- Integrate retry processing into the daemon tick loop
- Persist pending retries in SQLite
- Respect plugin blindness — retry decisions based on `SendResult` metadata only
- Update Telegram plugin to mark "not_found" as retryable (user may `/start` later)
- Make interval configurable (~30s default)
- Add lifecycle-aware cleanup (stop retrying when task completes/fails)

**Complexity: moderate** — touches NotificationRouter, daemon tick loop, and Telegram plugin. Needs a new retry queue component and DB table. But the scope is well-bounded and the patterns (SQLite persistence, tick loop integration, adapter error handling) are already established in the codebase.

## Team Contacts Referenced
- Farzam Mohammadi (owner) — not contacted; requirements are sufficiently clear from the issue description and codebase analysis
