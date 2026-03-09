# Error Propagation -- Layer 3

How failures flow through the system. The cross-cutting view -- not what happens within a single protocol's failure table, but how a failure in component A ripples through B, C, D.

Part of **Layer 3** -- see [`layers.md`](layers.md). Complements:
- **[Protocols](protocols.md)** -- per-protocol failure tables (51 scenarios across P1-P15)
- **Layer 2 docs** -- component-level error handling within each component

This document adds: failure classification, component criticality, cross-component propagation chains, named recovery patterns, and comm plugin error handling (deferred from Layer 2).

---

## 1. Failure Classification

Every failure in the system fits a 3-axis classification. This vocabulary is used throughout the document and can be referenced by other docs.

### Severity

| Severity | Definition | System behavior |
|----------|-----------|-----------------|
| **Fatal** | System cannot operate safely | Abort startup or halt operations |
| **Degraded** | System operates with reduced capability | Continue with limitations, notify human |
| **Transparent** | Failure handled internally, no external impact | Retry succeeds, nobody notices |

### Recoverability

| Recoverability | Definition | Example |
|---------------|-----------|---------|
| **Self-healing** | System recovers automatically | Trigger poll fails once, succeeds next interval |
| **Human-resolvable** | Human intervention needed | Cost limit hit, workspace branch deleted |
| **Requires-restart** | Component or system restart needed | Corrupted plugin state, persistent storage error |

### Blast Radius

| Blast radius | Definition | Example |
|-------------|-----------|---------|
| **Isolated** | One task affected | Workspace creation fails for a single task |
| **Scoped** | Tasks sharing a resource affected | Per-repo cost limit blocks all tasks in that repo |
| **System-wide** | All tasks affected | Global cost limit, Daemon crash, Event Bus down |

---

## 2. Component Criticality Map

What happens when each component is unavailable. Only three components are truly fatal -- Event Bus, Task Engine, Daemon. Everything else degrades gracefully. This is by design: persistent state lives in exactly three stores, everything else is reconstructable.

| Component | If unavailable | Severity | Blast radius | Recovery |
|-----------|---------------|----------|-------------|----------|
| **Event Bus** | No event routing, no audit trail, no cost tracking, no notifications. System halts (Decision #53). | Fatal | System-wide | Requires-restart |
| **Task Engine** | No state transitions, no permissions, no scheduling basis. | Fatal | System-wide | Requires-restart |
| **Daemon** | No scheduling, no health monitoring, no trigger polling, no crash detection. | Fatal | System-wide | Self-healing (restart reconstructs all ephemeral state) |
| **Safety Layer** | Gate 2 cannot be bypassed. All side-effect actions fail. Reads unaffected. | Fatal (writes) | System-wide | Requires-restart |
| **Session/Memory** | No checkpoints, no knowledge, no journal. New tasks cannot start safely. Active work degrades (no checkpoint safety net). | Degraded → Fatal | System-wide | Requires-restart |
| **Orchestrator** | No work execution. Tasks stop progressing. Other components unaffected. | Degraded | Isolated | Self-healing (Daemon restarts, resumes from checkpoint) |
| **Workspace Manager** | No workspace creation, no commits, no PRs. Reads continue. | Degraded | Isolated | Requires-restart |
| **Registry** | No plugin discovery. Running plugins continue; new plugins cannot register. | Transparent | None | Self-healing (restart reloads manifests) |
| **LLM Provider** | Orchestrator cannot reason. Active task stalls. Auto-failover to next provider if configured (Decision #54). | Degraded | Isolated | Self-healing (failover) or Human-resolvable (no fallback) |
| **Comm Plugin (primary)** | No notifications, no question delivery. Work continues silently. Blocked tasks depend on timeout ladder. | Degraded | System-wide (comms) | Self-healing (retry/restart) |
| **Comm Plugin (secondary)** | Fallback channel lost. Primary still works. | Transparent | None | Self-healing |
| **Trigger Plugin** | No new work discovery from that source. Existing work unaffected. | Degraded | None | Self-healing (retry next interval) |
| **People Directory** | Cannot resolve contacts. Notifications fail. Task team population fails for new tasks. | Degraded | System-wide (comms) | Requires-restart (config reload) |

**Key insight:** The three skeleton components that are truly fatal are Event Bus, Task Engine, and Daemon. These are the persistent state stores and the process manager. Everything else degrades gracefully -- the architecture's isolation boundaries contain failures to the affected component.

---

## 3. Error Propagation Chains

How an initial failure cascades through the system. Each chain starts with a root cause and follows the dominoes.

---

### Chain 1: LLM Provider Down

**Root cause:** LLM provider returns fatal `PluginError` (auth failure, extended outage, rate limit exhaustion).

```
LLM Provider fails
  │
  ├─ [fallback configured] Daemon switches to next provider in priority list (Decision #54)
  │   ├─ cost.incurred events now reference new provider_id
  │   ├─ Human notified of switch (milestone notification)
  │   └─ Task continues with new provider. Transparent to Orchestrator.
  │
  └─ [no fallback] Orchestrator cannot complete any reasoning step
      ├─ Orchestrator creates minimal checkpoint (Decision #57): phase, workspace state,
      │   raw data -- no narrative context_summary (that requires LLM)
      ├─ Active work stalls. No journal entries written.
      ├─ Daemon stuck detection fires after stuck_threshold (default: 30 min)
      │   (see daemon-scheduler.md § Health Monitoring)
      ├─ ⟹ health.stuck_detected { condition: "no_journal_entries" }
      ├─ Comm Plugin alerts human
      └─ Task remains Active.Working until provider recovers or human intervenes
```

**Blast radius:** Isolated (one active task). Other tasks in Queued/Blocked/Review-Pending are unaffected.

**Recovery:** Self-healing (auto-failover) or Human-resolvable (no fallback configured).

---

### Chain 2: Event Bus Down Mid-Operation

**Root cause:** Event Bus storage becomes inaccessible during system operation.

```
Event Bus storage fails
  │
  ├─ Post-action events cannot be persisted (audit trail broken)
  ├─ cost.incurred events not delivered to Safety Layer (cost tracking drifts)
  ├─ cost.incurred events not delivered to Task Engine (per-task cost stale)
  ├─ task.state_changed events not delivered to Daemon (scheduling breaks)
  ├─ task.state_changed events not delivered to Comm Plugins (GitHub labels, notifications stop)
  │
  ├─ Action Pipeline still works (synchronous calls to Gate 1 + Gate 2)
  │   └─ BUT: cost checks in Gate 2 use stale accumulators (under-count)
  │
  └─ System halts (Decision #53):
      ├─ Daemon detects Event Bus health failure
      ├─ Orchestrator checkpoints active task (direct Session/Memory call, not event)
      ├─ Daemon stops accepting new work (no trigger polling)
      ├─ Alert via fallback channel (stderr/log if comm plugins need Event Bus)
      └─ System waits for Event Bus recovery or human intervention
```

**Blast radius:** System-wide. Fatal severity.

**Recovery:** Requires-restart. Audit trail is a safety requirement -- operating without it violates the system's integrity guarantees.

**Why halt, not degrade:** The Event Bus serves the audit trail (from `philosophy.md`: full transparency, full auditability). Cost tracking without events means the Safety Layer can't enforce limits. Notification routing breaks. The Action Pipeline technically works but its cost checks use stale data. The risk of silent over-spend or unaudited actions outweighs the benefit of continued work. (Decision #53)

---

### Chain 3: Comm Plugin Failure During Blocking Flow

**Root cause:** Primary comm plugin fails while delivering a blocking question (P11).

```
Comm plugin fails to send question
  │
  ├─ Task has already transitioned to Blocked (state is correct)
  ├─ Question not delivered to human
  │
  ├─ Timeout ladder fires (see P11 steps 16-19, daemon-scheduler.md § Blocked Timeout):
  │   ├─ Reminder (4 hr): retry via same plugin → fails again
  │   │   ├─ Try fallback channel for same person (Decision #55)
  │   │   │   via People Directory contacts[] ordered list
  │   │   └─ [all channels fail] Reminder lost
  │   │
  │   ├─ Self-unblock check (24 hr):
  │   │   ├─ [autonomy allows] Orchestrator applies default answer, resumes
  │   │   └─ [always_ask category] No self-unblock, only reminders continue
  │   │
  │   └─ Alert (48 hr): tries ALL configured channels
  │       └─ [all fail] Task stays blocked indefinitely until human checks
  │          proactively (status query) or comm recovers
  │
  └─ If comm recovers: pending questions are NOT re-sent automatically
      (they were never queued). Timeout ladder handles re-delivery.
```

**Blast radius:** Isolated (one blocked task). Other tasks continue normally.

**Recovery:** Self-healing (comm recovers + timeout retry) or Self-healing (self-unblock if autonomy permits).

---

### Chain 4: Checkpoint Storage Failure

**Root cause:** Session/Memory cannot persist checkpoint (disk full, storage error).

```
Checkpoint write fails
  │
  ├─ Orchestrator retries once (see P4 step 2 failure)
  │
  ├─ [still fails] Context depends on when this happens:
  │
  ├─ During phase transition (P4):
  │   └─ Task transitions to Failed. Cannot guarantee resume safety.
  │      Work since last successful checkpoint is lost.
  │      Branch commits preserved (workspace-manager.md § Cleanup).
  │
  ├─ During preemption (P8 step 5):
  │   └─ Orchestrator still yields (better to lose context than block
  │      higher-priority work). Resume uses last successful checkpoint.
  │      Work since that checkpoint lost. Alert logged.
  │
  ├─ During cost limit breach (P10 step 10):
  │   └─ Cost enforcement takes priority. Task transitions to Blocked.
  │      Work since last checkpoint lost. Cost safety preserved.
  │
  └─ During graceful shutdown (P15 step 18):
      └─ Daemon waits up to shutdown_timeout (30s). Force-terminates.
         Work since last checkpoint lost.
```

**Blast radius:** Isolated (one task).

**Recovery:** Human-resolvable (fix storage, task may need restart from earlier checkpoint or from scratch).

**Mitigation:** Periodic mid-phase checkpoints (optional but recommended) reduce the window of potential loss. Branch commits are always preserved as evidence regardless of checkpoint state.

---

### Chain 5: Cascade Failure in Task Hierarchy

**Root cause:** Child task enters Failed state.

```
Child task fails
  │
  ├─ Task Engine applies cascade policy (see task-engine.md § Cascade Failure):
  │
  ├─ [pause-siblings] (default):
  │   ├─ All non-completed siblings paused
  │   ├─ Parent evaluates failure
  │   │   ├─ [can recover] Parent adjusts plan, unpauses relevant siblings
  │   │   └─ [cannot recover] Parent transitions to Blocked, notifies human
  │   └─ If parent is ALSO a child → cascade propagates up the tree (recursive)
  │
  ├─ [fail-fast]:
  │   ├─ Parent and ALL siblings immediately transition to Failed
  │   ├─ Multiple workspace cleanups trigger (branches preserved per failed task policy)
  │   ├─ Multiple notifications fire
  │   └─ If parent is ALSO a child → cascade propagates up (grandparent applies ITS policy)
  │
  ├─ [best-effort]:
  │   ├─ Only siblings depending on failed child are paused
  │   ├─ Independent siblings continue
  │   └─ Parent waits for all remaining children, then evaluates
  │
  └─ [manual]:
      ├─ ALL siblings paused immediately
      ├─ Human notified with full failure context
      └─ Task tree frozen until human decides
```

**Blast radius:** Scoped (task tree). System-wide if the failed task tree is the only active work.

**Recovery:** Human-resolvable. Even `pause-siblings` (default) will eventually need human guidance if the parent can't self-recover.

**Recursive propagation:** A parent that transitions to Failed due to cascade triggers its own parent's cascade policy. In deep hierarchies, `fail-fast` can cascade from leaf to root in one chain. `pause-siblings` provides natural circuit-breaking by pausing at each level.

---

### Chain 6: Workspace / Git Failure

**Root cause:** Git operation fails (disk full, corrupted repo, network error, branch deleted externally).

```
Git failure
  │
  ├─ Workspace creation fails (P3 step 3):
  │   └─ Task transitions to Failed. Cannot work without workspace.
  │      Daemon frees the slot, schedules next task.
  │
  ├─ Push failure (P7 step 9):
  │   ├─ No post-action event emitted (action didn't happen)
  │   ├─ Orchestrator retries per phase logic (Retry-with-backoff pattern)
  │   └─ [persistent] Orchestrator may ask human for guidance (network issue?)
  │
  ├─ Merge conflict during progressive merge (P6 steps 7-11):
  │   ├─ Well-defined flow: parent Supervising → Working (consumes slot)
  │   ├─ Orchestrator resolves conflict, commits
  │   ├─ Parent returns to Supervising (slot freed)
  │   └─ [unresolvable] Orchestrator asks human (P11 blocking flow)
  │
  ├─ Branch deleted externally (P9 step 4c):
  │   ├─ Workspace verification returns "lost"
  │   ├─ Task transitions to Failed (cannot resume without branch)
  │   └─ Human notified
  │
  └─ Worktree corruption after crash:
      ├─ Workspace verification returns "recoverable"
      ├─ Worktree recreated from branch (branch is the persistent artifact)
      └─ Task resumes normally
```

**Blast radius:** Isolated (one task). Merge conflicts affect the parent-child relationship but are contained.

**Recovery:** Varies. Worktree corruption is Self-healing (recreate from branch). Branch deletion is Human-resolvable. Push failures are typically Self-healing (retry).

---

### Chain 7: Config Hot-Reload Failure

**Root cause:** Safety Layer or People Directory config file becomes invalid during hot-reload.

```
Config file invalid
  │
  ├─ Component rejects the reload, keeps previous valid config
  ├─ System continues with stale policy (may not reflect intended changes)
  │
  ├─ ⟹ health.config_reload_failed event (Decision #56)
  │   └─ Comm Plugin alerts human: "Config reload failed for {component},
  │      running with previous config. Error: {validation_error}"
  │
  └─ Human fixes config file → next hot-reload succeeds → current config applied
```

**Blast radius:** System-wide (stale policy affects all future actions) but Degraded severity (previous valid config is safe, just outdated).

**Recovery:** Human-resolvable (fix the config file).

---

## 4. Recovery Patterns

Named, reusable patterns that recur across the 51 protocol failure scenarios. Identified, not redefined -- each lists where it appears.

---

### Pattern 1: Checkpoint-then-fail

**When:** Action must stop but context must be preserved for future resume or debugging.

**Pattern:** Create checkpoint with reason → log journal entry → transition to Blocked or Failed → notify human.

**Instances:**
- Cost limit breach (P10 steps 8-12)
- Unresolvable merge conflict (P6 step 10 failure)
- Persistent checkpoint storage failure (P4 step 2 failure) -- ironic: the pattern itself fails, task goes to Failed without checkpoint
- Safety Layer persistent unavailability (P7 step 5 failure)
- LLM provider down with no fallback (Chain 1 above)

---

### Pattern 2: Retry-with-backoff

**When:** Transient failure on an external operation.

**Pattern:** Retry N times with exponential backoff + jitter. Use `PluginError.retryable` and `retry_after` fields as signals. If retries exhausted, escalate (notify human or degrade).

**Instances:**
- Comm plugin send failure (P11 step 6, P13 step 6)
- GitHub API failure for labels/comments (P2 step 7, P13 step 7)
- Trigger poll failure (P2 step 1)
- Git push failure (P7 step 9)
- Workspace Manager merge retry (P6 step 3 failure)

**Defaults:** Max retries: 3. Backoff: exponential with jitter. Configurable per plugin via manifest.

---

### Pattern 3: Fallback-channel

**When:** Primary communication path fails.

**Pattern:** Try alternative comm channel for the same recipient (via People Directory `contacts[]` ordered list, Decision #55). If all channels fail, degrade silently (log error, task state unaffected).

**Instances:**
- Notification delivery failure (P13 step 6)
- Blocking question delivery failure (P11 step 6, Chain 3 above)
- Alert escalation (P11 step 19 -- tries ALL channels)
- Cost limit alert (P10 step 12)

**Exception:** Blocking questions -- if all channels fail, the timeout ladder (P11 steps 16-19) is the safety net.

---

### Pattern 4: Ephemeral-reconstruction

**When:** Crash or restart loses in-memory state.

**Pattern:** Rebuild from the three persistent stores (Task Engine, Event Bus, Session/Memory). All ephemeral state is designed to be reconstructable.

**Instances:**
- Daemon state on restart (P15 steps 3-12): priority queue, timeout timers, dedup set -- all from Task Engine queries
- Safety Layer cost accumulators (P1 step 4, P15 step 11): replayed from `cost.incurred` events
- Registry plugin state: reloaded from manifests + `Plugin.initialize()`
- People Directory: reloaded from config file

**Design principle:** If losing it on crash requires reconstruction, it's ephemeral by design, not by accident.

---

### Pattern 5: Degrade-and-continue

**When:** Non-critical subsystem fails but core work can proceed.

**Pattern:** Log warning, continue with reduced capability, notify human if failure is sustained (via health event).

**Instances:**
- GitHub label sync failure (P2 step 7) -- best-effort, internal state authoritative
- Cost event emission failure (P10 step 2) -- cost under-counted, log warning
- Non-critical plugin init failure (P1 step 3) -- system operates without that plugin
- Trigger plugin failure (P2 step 1) -- retry next interval, alert after threshold
- Task Engine phase field update failure (P4 step 4) -- informational, not blocking
- Status query partial data (P14 step 5) -- respond with available data

---

### Pattern 6: Graceful-halt

**When:** Critical failure makes continued operation unsafe.

**Pattern:** Stop accepting new work → checkpoint active tasks → transition to safe state → alert human via all available channels (including stderr/log as last resort).

**Instances:**
- Event Bus storage inaccessible at startup (P1 step 2) or mid-operation (Chain 2)
- Task Engine inaccessible at startup (P1 step 6) or mid-operation (P15 step 9)
- Critical plugin failure at startup (P1 step 3) -- LLM provider or primary comm
- Graceful shutdown (P15 steps 13-22) -- intentional halt with checkpoint

---

## 5. Comm Plugin Error Handling

Resolves the explicit deferral from Layer 2 (see `comm-plugins.md` § open questions). Defines how comm plugin failures are handled across all communication flows.

### Outbound Message Failure

When `CommPlugin.sendMessage()` fails:

1. Check `PluginError.retryable`:
   - `true`: Retry with backoff (Pattern 2). Max retries configurable per plugin (default: 3). Respect `retry_after`.
   - `false`: Permanent failure for this channel. Try fallback (step 2).
2. Try fallback channel for the same recipient (Pattern 3):
   - Look up recipient in People Directory `contacts[]` -- ordered by preference
   - Try next channel's comm plugin
   - If all channels exhausted: message is lost
3. On permanent loss:
   - Log error with full message context (for audit trail)
   - Task state is unaffected (messages are notifications, not state transitions)
   - **Exception: blocking questions** -- if a question (P11) fails to deliver, the task is Blocked but the human doesn't know. The timeout ladder (P11 steps 16-19) is the safety net -- it will retry delivery at each escalation stage.

### Inbound Message Failure

When `CommPlugin.startListening()` fails or the listener crashes:

1. Registry health check detects unhealthy plugin
2. Registry attempts `Plugin.initialize()` to restart the listener
3. **Messages during downtime are lost** -- comm plugins are dumb transport with no queuing (see `comm-plugins.md` design)
4. Impact: human responses to questions not received, status queries not received
5. Recovery: plugin restarts via Registry. Messages sent during downtime require human to resend.
6. The timeout ladder handles the common case: if a human replied but the reply was lost, the reminder stage re-asks the question.

### GitHub State Sync Failure

When GitHub API operations (labels, comments, checklists) fail:

1. Retry with backoff (Pattern 2) for transient API errors (rate limits, 5xx)
2. During extended outage: internal state (Task Engine) is authoritative. GitHub state drifts.
3. **On recovery: automatic state reconciliation** (Decision #58):
   - GitHub comm plugin compares Task Engine state vs GitHub labels for all active tasks
   - Updates mismatched labels (`engineer:{state}`)
   - Posts catch-up comments for missed milestones
   - Reconciliation runs once on plugin recovery, not continuously

### Fallback Chain Configuration (Decision #55)

People Directory `contacts[]` becomes an ordered list of channel preferences per person:

```
Person {
  id:           string
  contacts: [
    { channel: "telegram", handle: "@farzam" },      // primary
    { channel: "github",   handle: "farzam" },        // secondary
    { channel: "email",    handle: "farzam@..." }      // tertiary
  ]
}
```

When sending a message, the system tries channels in order. This resolves the open question from `plugin-contracts.md` § Open Questions.

---

## 6. System-Wide Failure Posture

Summary of the system's emergent resilience characteristics -- design principles confirmed by the analysis above.

### Principles

1. **Persistent state in exactly three stores.** Task Engine (task state, hierarchy), Event Bus (event log, audit trail), Session/Memory (checkpoints, knowledge, journal). Everything else is reconstructable from these three.

2. **Ephemeral state is cheap to lose.** Daemon scheduling state, Safety Layer cost accumulators, Registry plugin runtime state, People Directory in-memory cache -- all rebuilt from persistent stores or config files on restart. Losing ephemeral state costs a restart, not data loss.

3. **Work preservation over everything.** Checkpoints before transitions. Branches as persistent artifacts (worktrees are ephemeral containers). Failed tasks keep their branches as evidence. The system errs on the side of preserving work product.

4. **Safety over progress.** Cost limit = stop (Decision #35). Safety Layer unavailable = no side-effect actions (cannot bypass Gate 2). Event Bus down = system halt (Decision #53). The system never trades safety for throughput.

5. **Graceful degradation, not silent failure.** When capability degrades, the human is notified via health events. The system never silently drops functionality -- it either operates fully, operates with explicit degradation alerts, or halts.

6. **The Daemon is the last line of defense.** Stuck detection, timeout ladders, crash recovery, health monitoring. If the Orchestrator fails, the Daemon catches it. If the Daemon itself fails, its restart path reconstructs everything from the three persistent stores.

### Single Points of Failure

Acceptable for a single-machine, single-user tool:

- **Event Bus storage** -- fatal if inaccessible (no redundancy)
- **Task Engine storage** -- fatal if inaccessible (no redundancy)
- **Daemon process** -- system halts without it (but recovery is fast -- ephemeral reconstruction)
- **LLM provider** -- mitigated by auto-failover (Decision #54)

Multi-machine resilience and storage redundancy are future concerns -- the architecture doesn't prevent them but doesn't require them for v1.

---

## New Events

### `health.config_reload_failed` (Decision #56)

Added to the `health.*` event group. Emitted when Safety Layer or People Directory config hot-reload fails validation.

```
payload {
  component:       string          // "safety_layer" or "people_directory"
  config_file:     string          // Path to the config file
  error:           string          // Validation error message
  running_config:  string          // "previous" (kept valid config)
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Comm Plugin | Alerts human that config reload failed |

This brings the total event catalog to **30 events** across 10 groups.

---

## Changes to Other Docs

This document establishes cross-cutting failure behavior that resolves open questions and adds minor updates to other docs:

| Doc | Change | Reason |
|-----|--------|--------|
| `event-catalog.md` | Add `health.config_reload_failed` event. Update total to 29. | Decision #56 |
| `plugin-contracts.md` | Move "Fallback chains" from Open Questions to resolved. Reference this doc and Decision #55. | Resolved by § 5 |
| `decisions.md` | Add Decisions #53-#58 | New decisions from this analysis |
