# Dashboard Communication Plugin — Research & Design

The War Room dashboard becomes a communication channel. The owner sees outreach messages from The Engineer and responds directly through the dashboard to unblock tasks — without needing GitHub or Telegram.

This is the always-on, default channel. Unlike Telegram (needs bot token) or GitHub (needs repo), the dashboard is part of The Engineer itself. When The Engineer reaches out:
1. Dashboard is ALWAYS used (default channel, always on)
2. Other configured channels (Telegram, GitHub) are used IN ADDITION

---

## Design Questions — Resolved

### 1. Storage

**No new table.** The plugin is dumb transport — it does not own storage. Core handles persistence.

When the notification router calls `plugin.sendMessage()`, Core already publishes a `comm.message_sent` event to the Event Bus. That event is persisted in the `events` table with full payload (task_id, target, message_type, content_summary, channel). This is the persistence layer for dashboard messages.

The SSE stream (`src/dashboard/api/stream.ts`) already polls the `events` table every second. It picks up `comm.message_sent` events the same way it picks up task events and observations.

For real-time delivery to connected clients, the plugin pushes messages to an in-memory channel. Disconnected clients catch up via the events table on reconnect.

### 2. Send Path

```
Notification Router / Outreach
  → plugin.sendMessage(target, message)
  → Plugin pushes to in-memory subscribers (connected SSE clients)
  → Core publishes comm.message_sent event (already happens — Event Bus persistence)
  → Dashboard SSE stream picks up event from events table (catch-up for reconnecting clients)
```

The plugin's `doSendMessage()` pushes the message to an in-memory subscriber list. Each connected SSE client registers as a subscriber. When a message arrives, all connected clients receive it instantly.

The plugin returns a `SendResult` with `success: true` and a generated message ID. If no clients are connected, the message is still "sent" successfully — Core persists it via the Event Bus, and the client will catch up on reconnect.

### 3. Receive Path

**Core handles receive, not the plugin.** The plugin is send-only.

When the owner responds through the dashboard UI:

```
Dashboard UI → POST /api/messages/:taskId/respond { content }
  → Dashboard API handler proxies to Daemon HTTP endpoint
  → Daemon handler: POST /api/unblock { taskId, content, source: "dashboard" }
  → unblockResolver.tryUnblock({ by: "task_id", taskId })
  → Task transitions blocked → queued
  → Task resumes from return_to_phase
```

The dashboard process doesn't instantiate Core components (no TaskEngine, no EventBus). It proxies the response to the Daemon's HTTP endpoint. The Daemon calls the UnblockResolver (a Core component running in-process).

### 4. Unblock Mechanism — Shared UnblockResolver

**Not dashboard-specific.** A shared Core abstraction that any source feeds into.

```typescript
type UnblockInput =
  | { by: "external_ref"; ref: ExternalRef; source: string }
  | { by: "task_id"; taskId: string; source: string };

interface UnblockResolver {
  tryUnblock(input: UnblockInput): boolean;
}
```

- `by: "external_ref"` — for trigger adapters. Scans blocked tasks for matching ref. Extracted from existing `tryUnblockMatchingTask()` in `trigger-poller.ts`.
- `by: "task_id"` — for dashboard, future APIs. Direct lookup by task ID.
- Both paths: check task is blocked, clear blocked field, transition blocked → queued, log.
- No match / not blocked: discard silently, debug log.

Every source that can bring a response (trigger polling, dashboard, future Telegram receive, future Slack, Jira) feeds into the same resolver. Uniform API, swappable integrations.

### 5. Always-On Registration

Seed template approach. Add `dashboard-comm.yaml` to `seed/config/plugins/`. `engineer init` copies it to `~/.engineer/config/plugins/dashboard-comm.yaml`. The existing plugin discovery mechanism picks it up — no special-case logic in the loader.

The config file is trivially simple:

```yaml
# Dashboard communication — always on, no external tokens needed.
```

No db_path, no tokens, no external service configuration. The plugin runs in-process with the Daemon and has no external dependencies.

### 6. Default Channel in People Directory

**No changes needed.** The notification router (`src/core/daemon/notification-router.ts`) iterates ALL comm plugins with `send` capability (lines 126-131). It does not filter by People Directory contacts. The dashboard plugin automatically receives every notification just by being registered and having `send` capability.

The outreach flow (`src/core/orchestrator/phase-runner.ts`, `sendOutreachFromFiles()`) follows the same pattern — sends to ALL send-capable plugins. Dashboard delivery is automatic.

### 7. Prompt Implications

**None.** The LLM writes `outreach/{person-id}.txt` files. The Orchestrator reads these and delivers via all send-capable comm plugins. The dashboard plugin receives outreach automatically. No prompt changes needed.

### 8. Owner-Only

For v1, only the owner communicates through the dashboard. No authentication — the dashboard is `localhost`-only (CORS restricted to `http://localhost:3847`). The design does not prevent adding auth later:
- The POST endpoint could check a session token
- The UnblockResolver's `source` field tracks where the unblock came from

### 9. Message Format

The plugin's `formatMessage()` returns a dashboard-friendly format. Since the dashboard renders rich UI (not plain text), formatting is minimal — type prefix for accessibility, content as-is.

The `FormattedMessage` type already carries `metadata.task_id` and `metadata.type`. The SSE push includes the full message object so the dashboard UI can render task context, phase, and message type.

### 10. Existing Patterns

Follow `TelegramCommPlugin` and `GitHubCommPlugin` exactly:
- Config schema in `config.ts` (Zod validation)
- Plugin class extends `CommunicationAdapter`
- `hasCapability()` returns `true` for `"send"` only
- `doInitialize()` validates config (trivial — no external service)
- `doSendMessage()` delivers to platform (in-memory push)
- `doHealthCheck()` always healthy (no external dependency)
- `doShutdown()` cleans up subscribers
- Contract compliance suite validates the implementation

---

## Architecture Analysis

### Components That Participate

**DashboardCommPlugin** (`src/plugins/communication/dashboard-comm/`)
- Capabilities: `["send"]`
- `doSendMessage()`: pushes to in-memory subscriber list (SSE clients)
- `formatMessage()`: minimal formatting for dashboard display
- `doInitialize()`: sets up in-memory subscriber infrastructure
- `doHealthCheck()`: always healthy — no external dependency
- No DB access. No external API. Pure in-memory transport.

**Notification Router** (`src/core/daemon/notification-router.ts`)
- No changes. `sendToRecipients()` already iterates all comm plugins with `send` capability. The dashboard plugin is automatically included.

**Outreach Flow** (`src/core/orchestrator/phase-runner.ts`)
- No changes. `sendOutreachFromFiles()` already sends to all send-capable plugins.

**SSE Stream** (`src/dashboard/api/stream.ts`)
- Extend to filter and emit `comm.message_sent` events alongside observations and task events. These events are already in the `events` table — just need a new SSE event type (e.g., `"comm"`) and a poll for `comm.message_sent` / `comm.message_received` event types.
- This provides catch-up for clients that reconnect after missing real-time pushes.

**Dashboard API** (`src/dashboard/server.ts`)
- Add POST endpoint for responses. Proxies to Daemon's unblock endpoint.
- No direct Core access — the dashboard is a separate process.

**UnblockResolver** (new, `src/core/daemon/unblock-resolver.ts`)
- Extracted from `tryUnblockMatchingTask()` in `trigger-poller.ts`
- Shared interface: `tryUnblock({ by: "external_ref" | "task_id" })`
- Called by trigger poller (refactored) and Daemon HTTP handler (new)

**Daemon** (`src/core/daemon/index.ts`)
- Creates UnblockResolver during initialization
- Passes it to trigger poller (replaces inline unblock logic)
- Exposes HTTP endpoint for dashboard to call

**Trigger Poller** (`src/core/daemon/trigger-poller.ts`)
- Refactored: `tryUnblockMatchingTask()` extracted into UnblockResolver
- Calls `unblockResolver.tryUnblock({ by: "external_ref", ref, source: event.source })`

### Components That Don't Change

- Event Bus — no new event types needed
- People Directory — no changes
- Orchestrator — no changes
- Prompts — no changes
- Task Engine — already has `requestTransition()` and `updateTaskField()` for blocked clearing
- Safety Layer — not involved

---

## UnblockResolver Design

### Interface

```typescript
import type { ExternalRef } from "../../schemas/task.js";

type UnblockInput =
  | { by: "external_ref"; ref: ExternalRef; source: string }
  | { by: "task_id"; taskId: string; source: string };

interface UnblockResult {
  unblocked: boolean;
  taskId: string | null;
  reason: string | null;
}

interface UnblockResolver {
  tryUnblock(input: UnblockInput): UnblockResult;
}
```

### Factory

```typescript
function createUnblockResolver(ctx: {
  taskEngine: ITaskEngine;
  observer: IObserver;
}): UnblockResolver
```

### Logic

**`by: "external_ref"`** (extracted from `trigger-poller.ts` lines 99-135):
1. `taskEngine.getTasksByState("blocked")` — get all blocked tasks
2. Find task where `task.external_ref` matches input ref (using existing `externalRefsMatch()`)
3. If no match: return `{ unblocked: false, taskId: null, reason: "no_match" }`
4. Clear blocked field: `taskEngine.updateTaskField(taskId, "blocked", null)`
5. Transition: `taskEngine.requestTransition(taskId, "queued", null, "trigger_response_received", "daemon")`
6. If transition fails: return `{ unblocked: false, taskId, reason: result.reason }`
7. Log and return `{ unblocked: true, taskId, reason: null }`

**`by: "task_id"`** (new path for dashboard):
1. `taskEngine.getTask(taskId)` — direct lookup
2. If task doesn't exist or isn't blocked: return `{ unblocked: false, taskId, reason: "not_blocked" }`
3. Clear blocked field: `taskEngine.updateTaskField(taskId, "blocked", null)`
4. Transition: `taskEngine.requestTransition(taskId, "queued", null, "dashboard_response_received", "daemon")`
5. If transition fails: return `{ unblocked: false, taskId, reason: result.reason }`
6. Log and return `{ unblocked: true, taskId, reason: null }`

### Extraction from Trigger Poller

Current code in `trigger-poller.ts` (lines 98-135):

```typescript
function tryUnblockMatchingTask(ref: ExternalRef, event: TriggerEvent): boolean {
  const blockedTasks = taskEngine.getTasksByState(TaskStates.blocked);
  const match = blockedTasks.find(
    (t) => t.external_ref !== null && externalRefsMatch(t.external_ref, ref),
  );
  if (!match) return false;
  taskEngine.updateTaskField(match.id, "blocked", null);
  const result = taskEngine.requestTransition(match.id, TaskStates.queued, null, "trigger_response_received", "daemon");
  // ...
}
```

This becomes:

```typescript
// In trigger-poller.ts:
const unblocked = unblockResolver.tryUnblock({
  by: "external_ref",
  ref: externalRef,
  source: event.source,
});
if (unblocked.unblocked) return;
```

The `externalRefsMatch()` pure function stays exported from `trigger-poller.ts` (or moves to a shared location) since the UnblockResolver needs it.

---

## Daemon HTTP Endpoint

### Why

The dashboard HTTP server is a separate process. It can't instantiate Core components (TaskEngine, UnblockResolver). It needs to call the Daemon to unblock tasks.

### Design

The Daemon exposes a minimal HTTP endpoint during `start()`:

```
POST /api/unblock
Content-Type: application/json

{
  "task_id": "TASK_abc123",
  "content": "Owner's response text",
  "source": "dashboard"
}

Response: 200 { "unblocked": true, "task_id": "TASK_abc123" }
     or: 200 { "unblocked": false, "reason": "not_blocked" }
```

- Binds to `127.0.0.1` only (same as dashboard — localhost-only)
- Port: configurable, default separate from dashboard port (e.g., 3848 or from daemon config)
- Single-purpose for now; can evolve into a general Daemon API later
- No authentication for v1 (localhost-only)

### Implementation Location

The HTTP server setup lives in a new file `src/core/daemon/api.ts` or inline in `src/core/daemon/index.ts`. It starts alongside the tick loop in `start()` and shuts down in `stop()`.

---

## In-Memory Push Mechanism

### Options Analyzed

**A. Callback injection** — Plugin exposes `onMessage(callback)`. Dashboard SSE handler registers a callback. Simplest. No dependencies.

**B. EventEmitter** — Plugin extends or contains an EventEmitter. SSE handler listens for `"message"` events. Standard Node.js pattern. Slightly more overhead but familiar.

**C. Shared observable** — rxjs-style observable. Overkill for this use case. Adds dependency.

### Recommendation

**Option A: Callback injection.** The plugin maintains a `Set<MessageCallback>` where `MessageCallback = (msg: DashboardMessage) => void`. SSE handlers call `plugin.subscribe(callback)` and `plugin.unsubscribe(callback)` to register/deregister.

This requires the dashboard SSE handler to access the plugin instance. Since the dashboard is a separate process, this only works if the SSE stream is served by the Daemon process (co-located) rather than the standalone dashboard process.

**Alternative**: If the SSE stream stays in the standalone dashboard process (current architecture), the in-memory push doesn't reach it. In that case, the events table catch-up IS the delivery mechanism — the SSE stream polls `comm.message_sent` events from the events table with ~1s latency. The in-memory push only benefits clients connected directly to the Daemon process (if it ever serves SSE).

**Open question for implementation**: Should the Daemon also serve SSE (in addition to or instead of the standalone dashboard)? Or is 1-second polling latency from the events table acceptable for the dashboard?

---

## SSE Delivery for Dashboard Messages

### Current SSE Architecture

`src/dashboard/api/stream.ts` polls two sources every 1 second:
1. `observations` table (by rowid cursor)
2. `events` table (by sequence cursor)

### Extension

Add filtering logic to the events poll to emit `comm.message_sent` events as a distinct SSE event type:

```typescript
// In emitEvents(), after pushing generic events:
// Filter comm events and emit as "message" SSE events for the dashboard UI
if (row.type === "comm.message_sent") {
  await stream.writeSSE({
    event: "message",
    data: JSON.stringify({ ... }),
    id: `msg:${String(row.sequence)}`,
  });
}
```

This gives the dashboard UI a dedicated `"message"` event stream it can subscribe to separately from the generic event stream. The dashboard UI renders these as outreach messages from The Engineer.

**Latency**: ~1 second (poll interval). Acceptable for v1 — the owner isn't watching the dashboard in real-time waiting for sub-second message delivery.

---

## File-by-File Change List

### New Files

| File | Purpose |
|------|---------|
| `src/plugins/communication/dashboard-comm/dashboard-comm.ts` | Plugin class — send-only, in-memory push |
| `src/plugins/communication/dashboard-comm/config.ts` | Trivial Zod schema (empty object) |
| `src/plugins/communication/dashboard-comm/index.ts` | Barrel export |
| `src/plugins/communication/dashboard-comm/dashboard-comm.test.ts` | Unit tests + contract compliance suite |
| `src/core/daemon/unblock-resolver.ts` | Shared UnblockResolver — extracted from trigger-poller |
| `src/core/daemon/unblock-resolver.test.ts` | Unit tests for both unblock paths |
| `src/dashboard/api/messages.ts` | POST endpoint — proxies response to Daemon |
| `seed/config/plugins/dashboard-comm.yaml` | Seed config (minimal) |

### Modified Files

| File | Change |
|------|--------|
| `src/plugins/builtin.ts` | Add dashboard-comm manifest + factory (9th plugin) |
| `src/core/daemon/trigger-poller.ts` | Extract `tryUnblockMatchingTask()` → use UnblockResolver |
| `src/core/daemon/trigger-poller.test.ts` | Update tests for refactored unblock path |
| `src/core/daemon/index.ts` | Create UnblockResolver, pass to trigger poller, add HTTP endpoint |
| `src/dashboard/server.ts` | Mount messages route |
| `src/dashboard/api/stream.ts` | Emit `comm.message_sent` events as `"message"` SSE type |
| `src/cli/templates.ts` | Add dashboard-comm to init templates |

### NOT Modified

| File | Reason |
|------|--------|
| `src/core/daemon/notification-router.ts` | Already iterates all send-capable plugins |
| `src/core/orchestrator/phase-runner.ts` | Already sends outreach to all send-capable plugins |
| `src/core/interfaces/people-directory.interface.ts` | No People Directory changes needed |
| `src/schemas/events.ts` | No new event types |
| `src/core/orchestrator/prompts/*` | Dashboard delivery is automatic |

---

## Test Strategy

### Plugin Tests (`dashboard-comm.test.ts`)

- **Contract compliance suite**: Reuse `runCommunicationContractSuite()` from `test/helpers/contract-suites/communication-contract.ts`
- **hasCapability()**: `"send"` → true, `"receive"` / `"sync"` / `"issue_management"` → false
- **doSendMessage()**: pushes to subscribers, returns SendResult with generated ID
- **formatMessage()**: all 5 message types return non-empty strings
- **doInitialize()**: succeeds with empty config
- **doHealthCheck()**: always healthy
- **doShutdown()**: clears subscribers
- **No subscribers connected**: sendMessage still succeeds (fire-and-forget)

### UnblockResolver Tests (`unblock-resolver.test.ts`)

- **by external_ref — match found**: blocked task transitions to queued, blocked field cleared
- **by external_ref — no match**: returns `{ unblocked: false, reason: "no_match" }`
- **by task_id — match found**: blocked task transitions to queued, blocked field cleared
- **by task_id — task not blocked**: returns `{ unblocked: false, reason: "not_blocked" }`
- **by task_id — task not found**: returns `{ unblocked: false, reason: "not_blocked" }`
- **transition failure**: returns `{ unblocked: false, reason }` without crashing

### Dashboard API Tests

- **POST /api/messages/:taskId/respond**: proxies to Daemon endpoint, returns result
- **Daemon unavailable**: returns appropriate error

### Trigger Poller Refactor Tests

- Existing unblock tests in `trigger-poller.test.ts` continue to pass after extraction
- Verify trigger poller delegates to UnblockResolver

### Integration Test

- Full flow: notification router sends → event persisted → SSE stream delivers → owner responds via dashboard → Daemon unblocks → task resumes

**Estimated**: ~35-45 new tests

---

## Open Questions for Implementation Session

1. **In-memory push vs events-only delivery**: If the dashboard stays a separate process, in-memory push from the plugin doesn't reach it. Is ~1s latency via events table polling acceptable? Or should the Daemon also serve SSE?

2. **Daemon HTTP endpoint details**: Port (default 3848?), configurable in daemon config? Add to `DaemonConfigSchema`? PID-like discovery (write port to `~/.engineer/run/daemon.port`)?

3. **UnblockResolver location**: `src/core/daemon/unblock-resolver.ts` keeps it as a daemon subsystem (consistent with trigger-poller, health-monitor). Or promote to `src/core/interfaces/` if other Core components need it?

4. **Dashboard writable connection**: The standalone dashboard opens DB as `readonly: true`. The response POST endpoint doesn't write to DB (it proxies to Daemon). So no writable connection needed. Confirm this is correct.

5. **`externalRefsMatch()` location**: Currently in `trigger-poller.ts`. The UnblockResolver needs it. Move to a shared utils file? Or keep in trigger-poller and import?
