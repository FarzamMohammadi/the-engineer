# Event Bus -- Layer 2 Design

The Event Bus is the nervous system of the architecture. All inter-component communication flows through it. Every event is logged -- the event stream IS the audit trail. It is a **Core** component (always present, never swapped).

Part of **Layer 2** -- see [`layers.md`](../layers.md). Added during holistic review to formalize what all 7 component designs depend on.

> **Layer 3 Update (Decision #42 — Action Pipeline):** The Pre-Processing Hook section below and references to `action.requested` are superseded by Layer 3. The Event Bus is now pure pub/sub — no pre-processing, no synchronous interception. Safety checks happen in the Action Pipeline (Gate 1: Task Engine, Gate 2: Safety Layer) before action execution. Events are always post-action notifications. See [`event-catalog.md`](../3-interactions/event-catalog.md) § Action Pipeline.

---

## Proven Systems

| Proven system | What we take | Applied as |
|---------------|-------------|------------|
| **Message broker (RabbitMQ/Kafka)** | Publish/subscribe, topic-based routing, guaranteed delivery, ordered streams | Events published to topics, components subscribe with filters, delivery guarantees |
| **OS signals / interrupts** | Synchronous handling for critical signals, async for the rest | Safety Layer pre-processing is synchronous (must complete before delivery). All other subscriptions are async. |
| **Write-Ahead Log** | Append-only, durable, replayable | Event stream is append-only and replayable. Components can reconstruct state from events (Safety Layer cost accumulators, Daemon state on restart). |

---

## What the Event Bus Owns (and Doesn't)

| Concern | Owner | Why |
|---------|-------|-----|
| **Event routing** (publish to subscribers) | Event Bus | Infrastructure |
| **Event persistence** (append-only log) | Event Bus | Audit trail requirement |
| **Pre-processing hooks** (Safety Layer interception) | Event Bus | Structural enforcement |
| **Subscription management** (register/unregister) | Event Bus | Infrastructure |
| Event content and semantics | Emitting component | Components define their events |
| What to do with events | Subscribing component | Components decide how to react |

---

## Event Model

### Canonical Events

Components emit **canonical events**. Each event type is emitted by exactly one component (single ownership). Subscribers filter by event fields to select what they care about.

See [`relationships.md`](../1-system/relationships.md) § Event Conventions for the full canonical event table.

### Event Schema

Every event shares a common envelope:

```
Event {
  id:              string          (unique, monotonically increasing within a task)
  type:            string          (canonical event type: "task.state_changed", "git.pushed", etc.)
  source:          string          (component that emitted: "task_engine", "workspace_manager", etc.)
  task_id:         string?         (null for system-level events like trigger polling)
  timestamp:       datetime
  payload:         object          (type-specific data)

  -- Audit fields (populated by Event Bus, not emitter) --
  sequence:        number          (global sequence number)
  status:          "delivered" | "vetoed"
  veto_reason:     string?         (populated by Safety Layer if vetoed)
}
```

### Subscription Filters

Subscribers register interest by event type and optional field filters:

```
Subscription {
  subscriber_id:   string          (component identifier)
  event_type:      string          (or pattern: "task.*", "git.*")
  filter:          object?         (field-level filter: { "payload.to_state": "Completed" })
  priority:        "pre_process" | "normal"   (pre_process = Safety Layer only)
}
```

The shorthand used throughout component docs (e.g., `task.completed` in the Daemon loop) is a subscription filter on `task.state_changed where payload.to_state == "Completed"`, not a separate event type.

---

## Delivery Model

### Ordering

Events are **ordered per task** (events for the same `task_id` are delivered in emission order). Events across different tasks have no ordering guarantee. System-level events (null `task_id`) are ordered among themselves.

This matches the architecture: task isolation is a core principle. Cross-task ordering is only needed for cost accumulation, and the Safety Layer handles that via timestamps (not ordering).

### Delivery Guarantees

**At-least-once delivery.** Events may be delivered more than once in crash recovery scenarios. Subscribers must be idempotent or handle deduplication using `event.id`.

**Why not exactly-once:** Exactly-once requires distributed transactions between the Event Bus and every subscriber -- complexity that doesn't pay for itself. At-least-once with idempotent subscribers is simpler and sufficient.

### Synchronous vs Asynchronous

| Delivery mode | Who uses it | Why |
|--------------|------------|-----|
| **Synchronous (pre-process)** | Safety Layer only | Must complete verdict (allow/veto) before event reaches other subscribers. Security boundary. |
| **Asynchronous (normal)** | All other subscribers | Non-blocking. Components process events at their own pace. |

---

## Pre-Processing Hook (Safety Layer)

The Safety Layer registers as the sole pre-processor on the Event Bus. It intercepts specific event types synchronously before they reach other subscribers.

### Flow

```
EventBus.publish(event):
  1. Check: is event.type in pre-processed types?
     Pre-processed types: action.requested, cost.incurred, git.pushed, git.merge, deploy.requested
  2. If yes: Safety Layer pre-process
     verdict = SafetyLayer.intercept(event)
     if verdict.vetoed:
       event.status = "vetoed"
       event.veto_reason = verdict.reason
       persist(event)         // still logged for audit trail
       return                 // NOT delivered to normal subscribers
  3. event.status = "delivered"
  4. persist(event)            // append to event log
  5. Deliver to normal subscribers (async)
```

### Rules

- Only ONE pre-processor allowed (the Safety Layer). No chaining of pre-processors.
- Pre-processing is synchronous -- the event waits for the verdict.
- Vetoed events are persisted with `status: "vetoed"` -- the audit trail shows what was attempted AND blocked.
- The Safety Layer can only **veto**, never modify event content.
- Events NOT in the pre-processed list skip step 2 entirely (no overhead for most events).

---

## Persistence

The event log is append-only and durable. It serves three purposes:

1. **Audit trail** -- every action, every decision, every veto is recorded
2. **State reconstruction** -- Safety Layer cost accumulators and Daemon state are rebuilt from event replay on restart
3. **Analytics foundation** -- combined with Session Journal and Task history for the Engineer Dashboard

### Retention

All events are retained indefinitely (audit requirement from `goals.md` § Observability). Compaction and archival strategies are Layer 3/4 concerns.

### Replay

Components can request event replay for state reconstruction:

```
replay(filters: { type?, task_id?, since?, until? }) -> Event[]
```

Used by:
- **Safety Layer** on startup: replays `cost.incurred` events within relevant time windows to rebuild cost accumulators
- **Daemon** on startup: replays recent `task.state_changed` events to rebuild priority queue (or reads directly from Task Engine)

---

## Operations

```
-- Publishing --
publish(event: Event)                    // emit an event (goes through pre-processing if applicable)

-- Subscribing --
subscribe(subscription: Subscription)    // register interest
unsubscribe(subscriber_id, event_type?)  // remove subscription(s)

-- Replay --
replay(filters) -> Event[]              // replay events for state reconstruction

-- Query --
getEvents(task_id, since?, until?, type?) -> Event[]   // read events for a task (audit trail)
```

---

## Interaction with Components

| Component | Interaction |
|-----------|-------------|
| **Safety Layer** | Registers as pre-processor for specific event types. Intercepts synchronously, veto-only. |
| **Task Engine** | Emits `task.state_changed`, `task.created`, `task.children_all_done`, `task.feedback_received`. Subscribes to Workspace Manager and cost events for Task object sync. |
| **Daemon** | Subscribes to task state changes, preemption signals, trigger events, `comm.message_received`. Emits preemption and timeout events. |
| **Orchestrator** | Emits `action.requested`, `cost.incurred`, `preemption.ready`. Subscribes to events for current task. |
| **Workspace Manager** | Emits `workspace.*` and `git.*` events. |
| **Communication Plugins** | Emit `comm.message_received`, `comm.message_sent`. Subscribe to `task.state_changed` for state sync (GitHub labels). |
| **Session/Memory** | Does not directly interact with Event Bus. Checkpoints reference `last_event_id` as a pointer for replay correlation. |

---

## Open Questions for Layer 3

- **Implementation technology**: In-process event queue? External message broker? The single-core architecture suggests in-process is sufficient initially, with the option to externalize for multi-core.
- **Backpressure**: If a subscriber falls behind, does the Event Bus buffer? Drop? Apply backpressure to publishers? (Unlikely in single-core but relevant for multi-core.)
- **Event schema validation**: Should the Event Bus validate event payloads against schemas? Or trust publishers?
- **Subscription lifecycle**: How are subscriptions managed across Orchestrator sessions? (The Orchestrator subscribes when dispatched, unsubscribes when done.)
- **Event compaction / archival**: For long-running systems, the event log will grow. Compaction strategies? Archive to cold storage?
- **Cross-task event correlation**: How to correlate events across parent and child tasks for the Dashboard analytics?
