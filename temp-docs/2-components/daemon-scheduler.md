# Daemon/Scheduler -- Layer 2 Design

The Daemon is the always-running process -- the kernel of the system. It manages what work gets done and when. It owns trigger polling, task scheduling, preemption, capacity management, and health monitoring. It does NOT own task state (Task Engine), reasoning (Orchestrator), or persistence (Session/Memory).

Part of **Layer 2** -- see [`layers.md`](../layers.md). Resolves gaps: #8, #12.

---

## Proven System: OS Kernel Scheduler

The Daemon is derived from the OS kernel's scheduler and process manager. Specifically: a **single-core CPU with cooperative multitasking**.

| OS concept | Daemon equivalent |
|-----------|-------------------|
| CPU core | Agent working slot (capacity) |
| Process | Task |
| Ready queue | Priority queue of Queued tasks |
| Context switch | Checkpoint + task swap |
| Cooperative yield | Graceful preemption (agent finishes operation, checkpoints, yields) |
| Process states (Running/Ready/Blocked/Waiting) | Task states (Active.Working/Queued/Blocked/Review-Pending) |
| Scheduler loop | Daemon loop (hybrid event-driven + polling) |

**Single-core now, multi-core later.** The architecture is designed for one working slot (one Active.Working task at a time). But all interfaces use abstract capacity -- `max_concurrent` is a configuration value, not a hardcoded 1. When we evolve to multi-core (multiple concurrent agent sessions), we change the config. The scheduling logic stays the same.

---

## Daemon Loop

The Daemon runs a hybrid loop with two input channels:

- **Event Bus subscriptions** -- reacts to internal state changes
- **Trigger polling** -- periodically checks external sources for new work

### Loop Structure

```
loop {
  1. PROCESS EVENTS
     Drain pending Event Bus events:
     (Note: events like "task.completed" are subscription filters on the
      canonical `task.state_changed` event -- see relationships.md § Event Conventions)
     - task.state_changed (to=Completed)    -> free working slot, evaluate queue
     - task.state_changed (to=Blocked)      -> free working slot, evaluate queue
     - task.state_changed (to=Review_Pending) -> free working slot, evaluate queue
     - task.state_changed (to=Active, from=Blocked) -> task re-enters Queued, evaluate queue
     - task.feedback_received               -> task re-enters Queued (or Active if slot free)
     - task.created                         -> new task in Intake, validate -> Queued
     - task.children_all_done              -> parent transitions Supervising -> Integrating
     - preemption.ready                    -> complete the pending preemption swap
     - comm.message_received               -> route to query handler (see Query Handler below)

  2. POLL TRIGGERS
     For each registered trigger (per its configured interval):
     - Call trigger.poll() -> TriggerEvent[]
     - Deduplicate (idempotency key check)
     - For each new event: create task via Task Engine (Intake)

  3. EVALUATE PREEMPTION
     If agent is Active.Working on task X:
       For each Queued task Y where Y.priority > X.priority:
         If (Y.priority - X.priority) >= preemption_threshold:
           Initiate graceful preemption of X for Y
           Break (one preemption per tick)

  4. SCHEDULE
     If working slot available AND Queued tasks exist:
       Pick highest-priority Queued task (FIFO tiebreak)
       Transition: Queued -> Active.Working (via Task Engine)
       Dispatch to Orchestrator with full task context

  5. HEALTH CHECKS
     - Stuck detection
     - Blocked timeout escalation
     - Crash recovery check

  6. WAIT
     Sleep(tick_interval) or wait for next Event Bus event
     (whichever comes first -- the loop is woken by events)
}
```

### Event-Driven vs Polling

Most scheduling decisions are event-driven -- a task completing, blocking, or receiving feedback triggers immediate re-evaluation. Trigger polling is the exception: external sources (GitHub Issues, etc.) must be actively checked.

The `WAIT` step is event-aware: if an Event Bus event arrives during sleep, the loop wakes immediately. This gives near-instant response to internal state changes while batching external polling.

---

## Capacity Model

```
Capacity {
  max_concurrent:     number      (default: 1 -- the single-core era)
  working_tasks:      string[]    (task IDs in Active.Working or Active.Integrating)
  available:          computed    (max_concurrent - len(working_tasks))
}
```

### What Consumes a Working Slot

| State | Consumes slot? | Why |
|-------|---------------|-----|
| Active.Working | Yes | Agent is actively doing work (LLM, tools, code) |
| Active.Integrating | Yes | Agent is actively verifying and integrating child outputs |
| Active.Supervising | **No** | Lightweight monitoring -- parent watches children, no LLM work |
| Blocked | No | Agent is freed, waiting for external input |
| Review-Pending | No | Agent is freed, waiting for human judgment |
| Queued | No | Waiting for a slot |
| Intake | No | Being validated |

Active.Supervising is the key insight: a parent task doesn't hold the CPU while its children execute. It parks itself, freeing the slot for a child (or any other task). When all children complete, the parent wakes up into Active.Integrating, which does consume a slot.

### Concurrency-Ready Invariant

All scheduling logic uses:
```
if capacity.available > 0:
  schedule_next()
```

Never:
```
if agent_is_free:  // hardcoded boolean
  schedule_next()
```

This means going from single-core to multi-core is a config change, not a code change.

---

## Priority Model

User-assigned with sensible defaults. Simple, predictable, transparent.

### Priority Schema

```
Priority {
  value:       number    (1-100, higher = more important)
  source:      "explicit" | "default" | "aged"
  base_value:  number    (original value before aging)
  assigned_at: datetime
}
```

### Default Priority Rules

When a task has no explicit priority, the Daemon assigns a default based on signals:

| Signal | Default priority | Rationale |
|--------|-----------------|-----------|
| Label: critical / P1 | 90 | Urgent, likely production issue |
| Label: bug | 70 | Bugs before features |
| Label: security | 80 | Security issues are high priority |
| Label: feature / enhancement | 50 | Standard work |
| No label | 50 | Neutral default |
| Child task | parent.priority | Inherits parent's urgency |

The signal-to-priority mapping is configurable. These are sensible defaults for a standard GitHub workflow.

### Explicit Priority

The user can set priority explicitly:
- GitHub issue label (e.g., `priority:90` or `P1`)
- Direct command via comm channel ("set #47 to priority 80")

Explicit priority always overrides defaults. Source is recorded as `"explicit"`.

### Starvation Prevention (Aging)

Tasks that sit in Queued too long get a small priority bump to prevent starvation:

- After `aging_threshold` (configurable, default: 24 hours) in Queued state
- Bump: `+aging_increment` per `aging_interval` (default: +5 per 24h)
- Cap: aging never pushes a task above `aging_cap` (default: 75)
- Source changes to `"aged"`, `base_value` preserved

This ensures low-priority tasks eventually get serviced, but can never outprioritize an explicit P1 (90) through aging alone.

---

## Scheduling Algorithm

Priority queue with FIFO tiebreak. The simplest correct algorithm.

```
next_task():
  eligible = queued_tasks
    .filter(task -> is_eligible(task))
    .sort_by(priority.value DESC, queued_at ASC)
  return eligible.first

is_eligible(task):
  if task.parent_id is not null:
    parent = get_task(task.parent_id)
    // Check dependency ordering
    for dep_id in task_dependency(task, parent):
      if get_task(dep_id).state != Completed:
        return false
  return true
```

### Eligibility

A Queued task is eligible to run if:
- It has no parent (top-level task) -- always eligible
- It has a parent and all its `depends_on` siblings are Completed

Ineligible tasks remain Queued but are skipped during scheduling. They become eligible when their dependencies complete (the `task.completed` event triggers re-evaluation).

---

## Preemption

Graceful only. The agent is never ripped mid-operation.

### When Preemption Triggers

```
should_preempt(current_task, candidate_task):
  if candidate_task.priority.value - current_task.priority.value >= preemption_threshold:
    return true
  return false
```

`preemption_threshold` is configurable (default: 20). This prevents thrashing -- a priority-51 task won't preempt a priority-50 task.

### Preemption Flow

```
1. Daemon detects: Queued task Y should preempt Active.Working task X
2. Daemon sets pending_preemption = { target: X, replacement: Y }
3. Daemon emits Event Bus: preemption.requested { task_id: X, reason: "higher priority task Y" }

4. Orchestrator receives preemption.requested
5. Orchestrator finishes current atomic operation (file write, test run, etc.)
6. Orchestrator creates checkpoint via Session/Memory:
   Checkpoint { reason: "preemption", context_summary, key_findings, next_action, ... }
7. Orchestrator emits Event Bus: preemption.ready { task_id: X, checkpoint_id: C }

8. Daemon receives preemption.ready
9. Daemon transitions X: Active.Working -> Queued (via Task Engine)
   X retains its checkpoint reference for resume
10. Daemon transitions Y: Queued -> Active.Working (via Task Engine)
11. Daemon dispatches Y to Orchestrator with full context
12. Daemon clears pending_preemption
```

### What "Atomic Operation" Means

The Orchestrator defines what's atomic. Examples:
- A file write (don't interrupt mid-write)
- A test run (let tests finish)
- An LLM call (let the response complete)
- A git commit (don't interrupt mid-commit)

NOT atomic (can be interrupted between):
- Between file reads during research
- Between planning steps
- Between test run and result analysis

The Orchestrator is responsible for identifying safe yield points. The Daemon trusts it to yield promptly after receiving the preemption signal.

### Preemption Timeout

If the Orchestrator doesn't yield within `preemption_timeout` (configurable, default: 60 seconds), the Daemon escalates:
1. Logs a warning
2. Sends a second preemption signal
3. If still no response after another timeout: force-terminates the Orchestrator session, recovers from last checkpoint

This is a safety net for stuck Orchestrator processes, not the normal flow.

---

## Task Hierarchy and Scheduling

How the Daemon handles parent-child task relationships in the single-core model.

### Decomposition Flow (Daemon's Perspective)

```
1. Parent #50 is Active.Working
2. Orchestrator decides to decompose -> creates children #51-#55 via Task Engine
3. Task Engine: Parent #50 transitions Active.Working -> Active.Supervising
4. Daemon receives task.state_changed event for #50
5. Daemon recognizes: Supervising does NOT consume working slot -> slot is freed
6. Children #51-#55 enter Queued (inherit parent priority)
7. Daemon schedules: picks first eligible child (#51, assuming linear dependencies)
8. Child #51: Queued -> Active.Working
```

### Child Execution Sequence

```
Parent #50 (Active.Supervising, slot: free)
  |
  +--> #51 (Active.Working, slot: consumed)
  |    completes -> slot freed
  |
  +--> #52 (Active.Working, slot: consumed)
  |    completes -> slot freed
  |
  +--> #53 and #54 are both eligible (parallel-ready dependencies)
  |    But single-core: Daemon picks higher priority or FIFO -> #53 first
  |    #53 completes -> #54 next
  |
  +--> #55 (depends on #53 and #54, both done) -> Active.Working
       completes -> all children done

Event: task.children_all_done { parent_id: #50 }
Parent #50: Active.Supervising -> Active.Integrating (slot: consumed)
Integration work happens
Parent #50: Active.Integrating -> Review_Pending or Completed
```

### Cross-Family Scheduling

Children are not special in the priority queue. They compete alongside all other Queued tasks. This means:

- An unrelated high-priority task can preempt a child mid-execution
- A child from family A can run before a child from family B if it has higher priority
- The Daemon doesn't "batch" a family's children -- it schedules globally

This is correct because the Daemon is a global scheduler, like an OS kernel. Family affinity would add complexity without clear benefit in single-core mode.

### Future: Multi-Core and Families

In multi-core mode, family affinity becomes interesting -- you might dedicate a core to a family's children for cache locality (context locality). But that's a future design concern. The current interfaces don't preclude it.

---

## Trigger Polling

The Daemon discovers new work by polling trigger plugins registered in the Registry.

### Trigger Plugin Interface

```
TriggerPlugin {
  id:             string
  poll_interval:  duration      (how often to poll, e.g., 30 seconds)
  poll():         TriggerEvent[]
}

TriggerEvent {
  idempotency_key: string      (unique identifier -- e.g., "github_issue:owner/repo:47")
  source:          string      (trigger plugin ID)
  payload:         object      (raw event data -- issue body, labels, author, etc.)
  received_at:     datetime
}
```

### Polling Mechanics

```
For each trigger in Registry.triggers:
  if now() - trigger.last_poll >= trigger.poll_interval:
    try:
      events = trigger.poll()
      for event in events:
        if not seen(event.idempotency_key):
          mark_seen(event.idempotency_key)
          emit Event Bus: trigger.new_event { event }
          // Task Engine picks this up and creates a task
      trigger.last_poll = now()
      trigger.consecutive_failures = 0
    catch error:
      trigger.consecutive_failures += 1
      log_warning("Trigger {trigger.id} poll failed: {error}")
      // Don't crash -- retry next interval
      // After N consecutive failures, log error and alert
```

### Deduplication

The `idempotency_key` prevents duplicate task creation. The Daemon maintains a set of seen keys (with expiry for memory management). If a trigger returns an event with a key already seen, it's silently ignored.

This handles the common case: GitHub Issues trigger polls the same issue multiple times before it's processed.

---

## Health Monitoring

The Daemon watches for anomalies and takes corrective action.

### Stuck Detection

| Condition | Threshold (configurable) | Action |
|-----------|-------------------------|--------|
| Active.Working with no journal entries | `stuck_threshold` (default: 30 min) | Emit warning, escalate to human if persists |
| Active.Working with no state transition | `max_active_duration` (default: 8 hours) | Alert human -- task may need intervention |

The Daemon queries Session/Memory for the latest journal entry timestamp. If the gap exceeds the threshold, something may be wrong.

### Blocked & Review-Pending Timeout Escalation

Timeout thresholds are owned by the Safety Layer (see `safety-layer.md` § Response Timeout Policy). The Daemon **queries** these thresholds from `SafetyLayer.getTimeoutPolicy()` on each health tick -- it does NOT cache them at startup. This ensures Safety Layer config hot-reload is immediately effective.

For Blocked tasks, three stages:

| Stage | Event emitted | Action (handled by Orchestrator/Comm) |
|-------|---------------|---------------------------------------|
| Reminder | `timeout.reminder { task_id, stage: "reminder" }` | Comm plugin sends reminder to human |
| Self-unblock check | `timeout.self_unblock_check { task_id }` | Orchestrator evaluates if a reasonable default exists |
| Alert | `timeout.alert { task_id, stage: "alert" }` | Escalation alert -- task blocked too long |

For Review-Pending tasks: only `timeout.reminder` events -- the agent cannot self-approve.

The Daemon emits these events on the Event Bus when thresholds are crossed. The Orchestrator and Comm plugins subscribe and handle the actual actions.

### Crash Recovery

If the Orchestrator process dies (detected via heartbeat or event timeout):

1. Daemon detects missing heartbeat
2. Daemon logs crash event
3. Daemon restarts Orchestrator process
4. Daemon identifies the task that was Active.Working at crash time
5. Daemon instructs Orchestrator to resume from latest checkpoint (Session/Memory)
6. Normal operation resumes

The Daemon itself is the most critical process. If the Daemon crashes:
- On restart, it scans all tasks via Task Engine
- Rebuilds priority queue from current task states
- Resumes scheduling

Daemon state is **ephemeral** -- fully reconstructable from Task Engine state. The Daemon stores no data that isn't derivable from the source of truth (Task objects).

---

## Query Handler

The Daemon owns a lightweight query handler that processes `comm.message_received` events at all times -- even when the Orchestrator is busy working on a task. The Orchestrator is never interrupted for queries.

This is not "intelligence" -- it is structured data retrieval and template-based formatting. The Daemon reads from Task Engine and Session/Memory, formats a response, and sends it via the comm plugin. No LLM is involved.

### Query Flow

```
1. Comm plugin emits Event Bus: comm.message_received { sender, content, ... }
2. Daemon receives event in its main loop
3. Daemon disambiguates: query or task response?
   a. Check: is there a task Blocked with waiting_for matching this sender?
   b. If yes: route as task response -> forward to Orchestrator (via Event Bus)
   c. If no: route as query -> handle below
4. Parse query intent (keyword matching: "status", "progress on #N", "cost", etc.)
5. Route to data source:
   - "status" -> Task Engine: getTasksByState(Active, Blocked, Review_Pending, Queued)
   - "progress on #N" -> Task Engine: getTask(N) + Session/Memory: queryJournal(N)
   - "why did you decide X" -> Session/Memory: queryJournal(N, type=decision)
   - "cost" -> Safety Layer: getCostStatus()
6. Format response using templates
7. Send via same comm plugin that received the query
```

### Query Types

| Query pattern | Data source | What's returned |
|---------------|------------|-----------------|
| "status" / "what are you doing" | Task Engine (all non-terminal tasks) | Summary of current work |
| "progress on #N" | Task Engine (state) + Session/Memory (journal) | Detailed task progress |
| "why did you decide X" | Session/Memory (decision journal entries) | Decision reasoning |
| "what errors" / "any blockers" | Session/Memory (error entries) + Task Engine (blocked tasks) | Error/blocker list |
| "cost" / "how much have you spent" | Safety Layer (cost status) | Cost summary |

### Disambiguation: Query vs Task Response

When a `comm.message_received` event arrives and a task IS blocked waiting for this sender, the message is routed as a task response to the Orchestrator -- not handled as a query. If ambiguous, the Daemon asks: "Is this a reply to my question about #47, or a new request?"

---

## Trigger Plugins: PR Review Events

The Daemon's trigger polling is not limited to discovering new work (GitHub issues). Trigger plugins also detect **PR review events** for tasks already in the system.

### GitHub PR Events Trigger

A GitHub trigger plugin polls for PR review activity on PRs associated with active tasks (tasks in Review_Pending state):

```
GitHubPRTrigger {
  id:             "github_pr_events"
  poll_interval:  duration      (default: 30 seconds)
  poll():         TriggerEvent[]

  // Polls for:
  // - Review approvals on Draft PRs (demo approval)
  // - Review approvals on Ready PRs (code approval)
  // - Review comments / changes requested
  // - New commits pushed by reviewers (rare but possible)
}
```

Events emitted:

| GitHub event | Trigger event type | Task Engine transition |
|-------------|-------------------|----------------------|
| Approval on Draft PR | `trigger.pr_review { type: "approved", pr_state: "draft" }` | Review_Pending.Demo → Review_Pending.Code |
| Approval on Ready PR | `trigger.pr_review { type: "approved", pr_state: "ready" }` | Review_Pending.Code → Completed |
| Review comment on PR | `trigger.pr_review { type: "comment" }` | Review_Pending → Active.Working |
| Changes requested | `trigger.pr_review { type: "changes_requested" }` | Review_Pending → Active.Working |

The trigger maps PR numbers to task IDs using the Task Engine's `review.pr_number` field. The Task Engine receives these trigger events and applies the corresponding state transitions.

---

## Daemon State Schema

```
DaemonState {
  -- Capacity --
  capacity: {
    max_concurrent:    number         (default: 1)
    working_tasks:     string[]       (task IDs in Active.Working or Active.Integrating)
  }

  -- Priority Queue --
  queue: [{
    task_id:           string
    priority:          Priority
    queued_at:         datetime
    eligible:          boolean        (dependencies satisfied?)
  }]

  -- Triggers --
  triggers: [{
    plugin_id:         string
    poll_interval:     duration
    last_poll:         datetime
    consecutive_failures: number
  }]
  seen_trigger_keys:   Set<string>    (idempotency keys, with TTL expiry)

  -- Preemption --
  pending_preemption: {
    target_task_id:    string         (task being preempted)
    replacement_task_id: string       (task that will take over)
    requested_at:      datetime
    status:            "requested" | "checkpointing"
  }?                                  (null when no preemption in progress)

  -- Health --
  health: {
    started_at:        datetime
    last_heartbeat:    datetime
    tasks_completed:   number         (lifetime counter)
    uptime:            duration
  }

  -- Configuration --
  config: {
    tick_interval:         duration   (default: 5 seconds)
    preemption_threshold:  number     (default: 20)
    preemption_timeout:    duration   (default: 60 seconds)
    stuck_threshold:       duration   (default: 30 minutes)
    max_active_duration:   duration   (default: 8 hours)
    // blocked_reminder_interval, blocked_self_unblock_threshold, blocked_alert_threshold
    // are NOT stored here -- read from SafetyLayer.getTimeoutPolicy() on each health tick.
    // Single source of truth: Safety Layer config. See safety-layer.md § Response Timeout Policy.
    aging_threshold:       duration   (default: 24 hours)
    aging_increment:       number     (default: 5)
    aging_interval:        duration   (default: 24 hours)
    aging_cap:             number     (default: 75)
    shutdown_timeout:      duration   (default: 30 seconds)
  }
}
```

### Ephemerality

DaemonState is ephemeral. On restart:

1. `capacity` -- rebuilt by scanning Active tasks via Task Engine
2. `queue` -- rebuilt by scanning Queued tasks via Task Engine
3. `triggers` -- reloaded from Registry config
4. `seen_trigger_keys` -- lost (acceptable: worst case is a duplicate task creation, caught by Task Engine's own deduplication)
5. `pending_preemption` -- if Daemon crashes mid-preemption, the task remains Active.Working (safe state)
6. `health` -- reset

No persistence needed for the Daemon itself. The Task Engine and Session/Memory are the persistent stores.

---

## Dispatch: Daemon to Orchestrator

When the Daemon schedules a task, it dispatches to the Orchestrator:

```
Dispatch {
  task:              Task          (full Task object from Task Engine)
  resume_from:       Checkpoint?   (null for new tasks, checkpoint for resumed tasks)
  knowledge: {
    repo:            KnowledgeEntry[]  (from Session/Memory, filtered by repo)
    user:            KnowledgeEntry[]  (from Session/Memory, user-scope)
  }
}
```

The Daemon assembles the dispatch package:
1. Gets the full Task object from Task Engine
2. If resuming: gets the latest checkpoint from Session/Memory
3. Queries relevant knowledge from Session/Memory
4. Hands everything to the Orchestrator

The Orchestrator takes it from there -- the Daemon's job is done until the next scheduling event.

---

## Concurrency-Ready Design Points

Decisions made for single-core that don't preclude multi-core:

| Design point | Single-core behavior | Multi-core evolution |
|-------------|---------------------|---------------------|
| `max_concurrent` | 1 | N (configurable) |
| Priority queue | Serves one consumer | Serves N consumers |
| Preemption | Per-task targeting | Same -- targets specific task ID |
| Event Bus events | Carry task_id | Same -- enables per-task routing |
| Capacity check | `available > 0` | Same expression, different max |
| Dispatch | To single Orchestrator | To one of N Orchestrator instances |
| Family scheduling | Global queue, no affinity | Could add core affinity for families |

The key principle: **nothing in the Daemon assumes exactly one working slot.** The number 1 appears only in the default config value.

---

## Gaps Resolved

| # | Gap | Resolution |
|---|-----|-----------|
| 8 | Concurrent task execution | Single-core architecture: one Active.Working task at a time. Active.Supervising doesn't consume the working slot, enabling parent-child execution without concurrency. All interfaces use abstract capacity (`max_concurrent` config) -- future multi-core is a config change, not a redesign. |
| 12 | Scheduling and priority/preemption | Priority queue scheduling with FIFO tiebreak. User-assigned priority with sensible defaults (label-based). Graceful preemption with configurable threshold to prevent thrashing. Aging prevents starvation. Cooperative multitasking -- agent yields at safe points, never interrupted mid-operation. |

---

## Open Questions for Layer 3

- **Event schemas**: What do `preemption.requested`, `preemption.ready`, `trigger.new_event` events look like? (Layer 3: Interactions & Protocols)
- **Orchestrator heartbeat**: How does the Daemon detect Orchestrator liveness? Periodic pings? Event Bus activity? (Layer 3)
- **Trigger plugin contract**: Full interface spec for trigger plugins -- error handling, rate limiting, authentication. (Layer 3)
- **Dispatch protocol**: How does the Daemon actually "hand" a task to the Orchestrator? Function call? Event? Process spawn? (Layer 3 or 4)
- **Multi-core dispatch**: When we go multi-core, how are Orchestrator instances managed? Process pool? Container pool? (Future design)
