# Event Catalog — Layer 3

The complete event taxonomy for The Engineer. Every event type, its schema, who emits it, who subscribes, and why. This is the authoritative reference — if an event isn't here, it doesn't exist.

Part of **Layer 3** — see [`layers.md`](layers.md). Built on the event model defined in [`event-bus.md`](event-bus.md).

---

## Action Pipeline

**Derived from:** Auth middleware systems (HTTP middleware chains, Kubernetes admission controllers, Linux DAC + LSM hooks, API gateways).

Every action in the system flows through a middleware pipeline before execution. Safety checks happen in the pipeline, not on the Event Bus. The Event Bus is pure pub/sub for post-action notifications.

```
Action Pipeline:

  Intent (component decides to do X)
    │
    ├─ Gate 1: Task Engine
    │    Is action class X legal in current state+sub-state?
    │    (Like DAC in Linux — structural permission check)
    │    Reject → action.rejected event, stop
    │
    ├─ Gate 2: Safety Layer
    │    Does policy allow X given scope, cost, autonomy config?
    │    (Like LSM/SELinux — policy-based check)
    │    Three verdicts: proceed / ask_human / deny
    │    Deny → action.rejected event, stop
    │    Ask_human → task transitions to Blocked, question sent
    │
    ├─ Execute
    │    Component performs the action (Workspace Manager, tool, etc.)
    │
    └─ Notify
         Post-action event published to Event Bus
         (Pure notification — async delivery, no interception)
```

### What Changed from Layer 2

Layer 2 had the Safety Layer as an Event Bus pre-processor that intercepted events synchronously before delivery. This created a timing ambiguity: events named in past tense (`git.pushed`) were intercepted before the action happened.

The Action Pipeline resolves this cleanly:
- **Safety checks** happen in the pipeline, before execution
- **Events** are always post-action notifications (past tense names are correct)
- **Event Bus** is pure pub/sub — no pre-processing, no synchronous interception
- **Defense in depth** = two gates in the pipeline, both must pass. No bypass possible if the pipeline is the only path to execution.

### Pipeline Scope

Not every operation goes through the full pipeline. The pipeline applies to **actions that change state or have side effects**:

| Goes through pipeline | Example | Why |
|----------------------|---------|-----|
| Yes | `git push`, `file write`, `PR create`, `merge`, `deploy` | Side effects, irreversible |
| Yes | `send message to human`, `create child task` | External communication, structural change |
| No | `read file`, `search code`, `query knowledge` | Read-only, no side effects |
| No | `create checkpoint`, `append journal` | Internal bookkeeping, always allowed |

Read-only operations skip the pipeline. Gate 1 (Task Engine) still applies to reads via the permission table (e.g., `Completed` state has read-only access), but Gate 2 (Safety Layer) is not consulted for reads.

---

## Event Envelope

Every event shares a common envelope. Updated from [`event-bus.md`](event-bus.md) § Event Schema — simplified now that pre-processing is removed.

```
Event {
  id:              string          // Unique, monotonically increasing within a task
  type:            string          // Canonical event type: "task.state_changed", "git.pushed", etc.
  source:          string          // Component that emitted: "task_engine", "workspace_manager", etc.
  task_id:         string?         // null for system-level events (triggers, config reload)
  timestamp:       datetime        // When the event occurred
  payload:         object          // Type-specific data (schema defined per event below)

  // Audit fields (populated by Event Bus, not emitter)
  sequence:        number          // Global sequence number (monotonically increasing)
}
```

### Changes from Layer 2 Envelope

- **Removed** `status` field ("delivered" | "vetoed") — no more vetoing on Event Bus
- **Removed** `veto_reason` field — no more vetoing on Event Bus
- Pipeline rejections are logged as `action.rejected` events instead (see below)

### Subscription Filters

Unchanged from [`event-bus.md`](event-bus.md). Subscribers register by event type and optional field filters:

```
Subscription {
  subscriber_id:   string          // Component identifier
  event_type:      string          // Or pattern: "task.*", "git.*"
  filter:          object?         // Field-level filter: { "payload.to_state": "Completed" }
}
```

The `priority` field is removed — no more "pre_process" vs "normal" distinction. All subscriptions are async.

Shorthand convention: `task.completed` in docs means a subscription filter on `task.state_changed where payload.to_state == "Completed"`, not a separate event type.

---

## Event Catalog

### Naming Convention

- **Past tense** for completions: `git.pushed`, `git.committed`, `workspace.created`
- **Past tense** for state changes: `task.state_changed`, `cost.limit_reached`
- **Past tense** for receipts: `comm.message_received`, `task.feedback_received`
- **No request/intent events** — those are handled by the Action Pipeline, not Event Bus

### Event Groups

---

### `task.*` — Task Lifecycle Events

**Owner:** Task Engine

#### `task.created`

A new task has been created.

```
payload {
  task_id:         string          // The new task's ID
  parent_id:       string?         // Parent task ID (null if top-level)
  title:           string          // Task title
  external_ref:    string?         // GitHub issue URL, Jira ticket, etc.
  source:          string          // What triggered creation: "trigger.github", "decomposition", "manual"
  priority:        number          // Initial priority (1-100)
  repo:            string          // Primary repo
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Daemon | Adds task to scheduling queue |
| Comm Plugin (GitHub) | Creates GitHub issue for child tasks, updates parent checklist |

---

#### `task.state_changed`

A task has transitioned between states.

```
payload {
  task_id:         string
  from_state:      string          // Previous state: "Intake", "Queued", "Active", etc.
  from_sub:        string?         // Previous sub-state: "Working", "Supervising", etc.
  to_state:        string          // New state
  to_sub:          string?         // New sub-state
  reason:          string          // Why: "scheduled", "preempted", "blocked_on_human", "review_approved", etc.
  triggered_by:    string          // Component that requested: "daemon", "orchestrator", "trigger"
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Daemon | Updates scheduling queue, triggers dispatch or preemption |
| Comm Plugin (GitHub) | Syncs labels (`engineer:{state}`), posts milestone comments |
| Comm Plugin (Telegram) | Sends notification on key transitions (configurable) |

**Note:** Workspace Manager is NOT a subscriber here. Task Engine calls Workspace Manager directly for progressive merge (on child completion) and workspace cleanup (on terminal states), per `task-engine.md` § Task Completion Flow. These are direct component calls, not Event Bus subscriptions.

**Common subscription filters (shorthand used in other docs):**
- `task.completed` → `task.state_changed where to_state == "Completed"`
- `task.failed` → `task.state_changed where to_state == "Failed"`
- `task.blocked` → `task.state_changed where to_state == "Blocked"`
- `task.activated` → `task.state_changed where to_state == "Active"`

---

#### `task.children_all_done`

All children of a parent task have reached terminal state (Completed or Failed).

```
payload {
  parent_task_id:  string
  child_ids:       string[]        // All child task IDs
  all_succeeded:   boolean         // true if all Completed, false if any Failed
  failed_ids:      string[]        // IDs of children that Failed (empty if all_succeeded)
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Daemon | Transitions parent from Active.Supervising → Active.Integrating |

---

#### `task.feedback_received`

Human feedback has been received for a task in review.

```
payload {
  task_id:         string
  stage:           "demo" | "code"           // Which review stage
  feedback_type:   "approved" | "changes_requested" | "comment"
  reviewer:        string                    // Who reviewed (GitHub username, etc.)
  content:         string?                   // Comment text (null for pure approval)
  pr_number:       number
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Daemon | Triggers state transition (Review_Pending → Active.Working or next stage) |
| Orchestrator (via Daemon) | Daemon routes feedback to active Orchestrator session if task is dispatched; otherwise handles state transition directly |

---

### `action.*` — Action Pipeline Events

**Owner:** Action Pipeline (emitted by the pipeline infrastructure, not individual components)

#### `action.rejected`

An action was rejected by the Action Pipeline (Gate 1 or Gate 2).

```
payload {
  task_id:         string
  action_class:    string          // "write", "git-remote", "merge", "deploy", etc.
  gate:            "task_engine" | "safety_layer"
  reason:          string          // "State Active.Working does not permit merge", "Branch main not in push_to whitelist", etc.
  details:         object?         // Action-specific context: { file: "...", branch: "...", etc. }
  requested_by:    string          // Component that attempted: "orchestrator", "workspace_manager"
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| (audit trail only) | Logged for observability — shows what was attempted AND blocked |

**Note:** There is no `action.completed` event. Successful actions emit their specific post-action events (`git.pushed`, `git.committed`, etc.). The absence of `action.rejected` + presence of a specific event = action succeeded.

---

### `cost.*` — Cost Tracking Events

#### `cost.incurred`

**Owner:** Orchestrator

An LLM call or other billable operation has completed.

```
payload {
  task_id:         string
  repo:            string
  provider_id:     string          // Registry ID of the LLM provider plugin
  provider_type:   "cli" | "api"   // CLI (subscription) vs API (pay-per-token)
  operation:       string          // "reasoning", "code_generation", "analysis", etc.

  // For API providers
  tokens_in:       number?         // Input tokens
  tokens_out:      number?         // Output tokens
  spend_usd:       number?         // Dollar cost

  // For CLI providers
  usage_units:     number?         // Provider-specific usage metric
  remaining:       number?         // Remaining quota (if provider reports it)
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Task Engine | Updates `task.cost` field (per-task accumulation) |
| Safety Layer | Updates ephemeral cost accumulators, checks limits |

---

#### `cost.limit_reached`

**Owner:** Safety Layer

A cost limit has been breached. Safety Layer emits this after processing a `cost.incurred` event that pushed accumulators over the limit.

```
payload {
  task_id:         string?         // null if global limit
  limit_type:      "per_task" | "per_repo" | "daily_global" | "monthly_global"
  limit_scope:     string?         // Repo name (for per_repo), null otherwise
  current_spend:   number          // Current accumulated spend/usage
  limit_value:     number          // The configured limit
  provider_type:   "cli" | "api"   // Which provider type hit the limit
  resets_at:       datetime?       // When the limit resets (for time-based limits)
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Daemon | Transitions affected task(s) to Blocked, notifies human |
| Comm Plugin | Sends cost alert to owner |

---

### `preemption.*` — Task Preemption Events

#### `preemption.requested`

**Owner:** Daemon

Daemon has decided a running task should yield to a higher-priority task.

```
payload {
  target_task_id:  string          // Task being asked to yield
  preempting_task_id: string       // Higher-priority task waiting
  reason:          string          // "priority_delta_exceeded", "manual_preemption"
  priority_delta:  number          // Gap between the two priorities
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Orchestrator | Finishes current atomic op, checkpoints, yields |

---

#### `preemption.ready`

**Owner:** Orchestrator

The Orchestrator has finished its atomic operation, created a checkpoint, and is ready to yield.

```
payload {
  task_id:         string          // Task that is yielding
  checkpoint_id:   string          // Checkpoint created for resume
  phase:           string          // Phase the task was in when preempted
  atomic_op:       string          // What operation was completed: "llm_call", "file_write", "test_run"
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Daemon | Transitions yielding task to Queued, dispatches preempting task |

---

### `timeout.*` — Response Timeout Events

**Owner:** Daemon

Emitted by Daemon's timer system when a task has been Blocked waiting for human response beyond configured thresholds.

#### `timeout.reminder`

```
payload {
  task_id:         string
  blocked_since:   datetime        // When the task entered Blocked
  elapsed:         duration        // How long blocked
  channel:         string          // Where the question was sent: "telegram", "github"
  question_summary: string         // Brief summary of what was asked
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Comm Plugin | Sends reminder to human on the original channel |

---

#### `timeout.self_unblock_check`

```
payload {
  task_id:         string
  blocked_since:   datetime
  elapsed:         duration
  decision_category: string        // Autonomy category of the blocked question
  can_self_unblock: boolean        // Whether autonomy config allows self-unblock for this category
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Orchestrator | If `can_self_unblock`, applies default answer and resumes |

---

#### `timeout.alert`

```
payload {
  task_id:         string
  blocked_since:   datetime
  elapsed:         duration
  escalation:      string          // "owner_notified", "all_channels_notified"
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Comm Plugin | Sends alert to ALL configured channels |

---

### `trigger.*` — External Trigger Events

**Owner:** Daemon

#### `trigger.new_event`

A trigger plugin has detected new work.

```
payload {
  idempotency_key: string          // Dedup key (e.g., "github:issue:42")
  source:          string          // Trigger plugin ID: "github_issues", "jira", "manual"
  event_type:      string          // "issue_opened", "issue_assigned", "manual_create"
  external_ref:    string          // URL or ID of the external item
  title:           string          // Task title derived from trigger
  body:            string?         // Description/body from external source
  repo:            string          // Target repo
  metadata:        object?         // Source-specific data (labels, assignees, etc.)
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Daemon (self) | Creates task via Task Engine (deduplicates by idempotency_key) |

---

#### `trigger.pr_review`

A PR review event has been detected on a PR owned by The Engineer.

```
payload {
  task_id:         string          // Task that owns this PR
  pr_number:       number
  repo:            string
  review_type:     "approved" | "changes_requested" | "comment"
  pr_state:        "draft" | "ready"   // Whether PR is still draft or marked ready
  reviewer:        string          // GitHub username
  comment:         string?         // Review comment text
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Daemon | Converts to `task.feedback_received` via Task Engine |

**Note:** This is a trigger event, not a task event. The Daemon translates it into a `task.feedback_received` event after validation. This keeps the trigger layer separate from the task lifecycle.

---

### `workspace.*` — Workspace Lifecycle Events

**Owner:** Workspace Manager

#### `workspace.created`

```
payload {
  task_id:         string
  repo:            string
  branch:          string          // Branch name: "engineer/47-dark-mode"
  worktree_path:   string          // Filesystem path to the worktree
  base_branch:     string          // Branch it was created from: "main", parent branch
  base_commit:     string          // SHA of the base commit
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Task Engine | Updates `task.workspace` field |

---

#### `workspace.verified`

Workspace integrity check completed (called on resume after crash/preemption).

```
payload {
  task_id:         string
  status:          "valid" | "recoverable" | "lost"
  current_commit:  string?         // Current HEAD (null if lost)
  recovery_action: string?         // "none", "recreated_from_branch", "checkout_reset"
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Daemon | Proceeds with dispatch if valid/recoverable; fails task if lost |

---

#### `workspace.cleaned`

Workspace (worktree) has been cleaned up after task completion.

```
payload {
  task_id:         string
  branch_preserved: boolean        // true if branch kept (for completed tasks), false if deleted
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| (audit trail only) | Cleanup confirmation |

---

#### `workspace.merge_conflict`

A merge conflict occurred during progressive merge (child → parent).

```
payload {
  task_id:         string          // Task that triggered the merge (child or parent)
  source_branch:   string          // Branch being merged in
  target_branch:   string          // Branch being merged into
  conflicting_files: string[]      // Files with conflicts
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Daemon | Triggers parent state transition (Supervising → Working) for conflict resolution |
| Comm Plugin | Notifies owner of merge conflict |

---

### `git.*` — Git Operation Events

**Owner:** Workspace Manager

All `git.*` events are post-action notifications — the git operation has already completed when the event is emitted.

#### `git.branch_created`

```
payload {
  task_id:         string
  repo:            string
  branch:          string          // Full branch name
  from_ref:        string          // What it was created from (branch name or SHA)
  commit_sha:      string          // HEAD of the new branch
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| (audit trail only) | Branch creation record |

---

#### `git.committed`

```
payload {
  task_id:         string
  repo:            string
  sha:             string          // Commit SHA
  message:         string          // Commit message (first line)
  files_changed:   number          // Number of files in the commit
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| (audit trail only) | Commit record |

---

#### `git.pushed`

```
payload {
  task_id:         string
  repo:            string
  branch:          string          // Branch that was pushed
  remote:          string          // Remote name: "origin"
  commits:         number          // Number of commits pushed
  head_sha:        string          // SHA of the branch tip after push
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| (audit trail only) | Push record |

---

#### `git.pr_opened`

```
payload {
  task_id:         string
  repo:            string
  pr_number:       number
  draft:           boolean         // true = Draft PR (demo gate), false = Ready PR
  title:           string
  url:             string          // Full PR URL
  base_branch:     string          // Target branch: "main"
  head_branch:     string          // Source branch: "engineer/47-dark-mode"
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Task Engine | Updates `task.review.pr_number`, `task.review.pr_state` |
| Comm Plugin (Telegram) | Notifies owner: "PR ready for review" |

---

#### `git.pr_updated`

```
payload {
  task_id:         string
  repo:            string
  pr_number:       number
  draft:           boolean         // Current draft status
  previous_draft:  boolean         // Previous draft status (detects Draft → Ready transition)
  update_type:     "commits_added" | "marked_ready" | "description_updated"
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Task Engine | Updates `task.review.pr_state` |
| Comm Plugin (Telegram) | Notifies on Draft → Ready transition |

---

#### `git.pr_merged`

```
payload {
  task_id:         string
  repo:            string
  pr_number:       number
  merge_strategy:  "merge" | "squash" | "rebase"  // How it was merged
  merge_sha:       string          // Merge commit SHA
  into_branch:     string          // Target branch: "main"
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Task Engine | Triggers state transition toward Completed |
| Workspace Manager | Triggers workspace cleanup |

---

#### `git.merge_completed`

A branch merge completed (used for progressive merge of child → parent, distinct from PR merge).

```
payload {
  task_id:         string          // Task whose branch was merged
  repo:            string
  source_branch:   string          // Branch merged in (child branch)
  target_branch:   string          // Branch merged into (parent branch)
  merge_sha:       string          // Resulting merge commit SHA
  strategy:        "merge" | "rebase"
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Task Engine | Updates parent task context (child summary attached) |
| Daemon | Checks if all children done, schedules next eligible child |

---

### `health.*` — System Health Events

**Owner:** Daemon

Emitted by Daemon's health monitoring system when anomalies are detected. These are operational alerts — they notify humans of problems that may need intervention.

#### `health.stuck_detected`

A task has exceeded health thresholds without expected progress.

```
payload {
  task_id:         string
  condition:       "no_journal_entries" | "no_state_transition"
  threshold:       duration        // The configured threshold that was exceeded
  elapsed:         duration        // How long the condition has persisted
  last_activity:   datetime?       // Last journal entry or state transition timestamp
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Comm Plugin | Alerts owner that task may be stuck |

---

#### `health.trigger_failure`

A trigger plugin has exceeded its consecutive failure threshold.

```
payload {
  trigger_id:      string          // Registry ID of the failing trigger plugin
  consecutive_failures: number     // How many consecutive failures
  threshold:       number          // Configured failure threshold
  last_error:      string          // Most recent error message
  last_success:    datetime?       // When the trigger last polled successfully (null if never)
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Comm Plugin | Alerts owner of trigger integration failure |

---

### `comm.*` — Communication Events

**Owner:** Comm Plugins

#### `comm.message_received`

An inbound message from a human or external system.

```
payload {
  source:          string          // Plugin ID: "telegram", "github", "email"
  sender:          string          // Who sent it (username, email, etc.)
  content:         string          // Message text
  reply_to:        string?         // Message ID being replied to (for threaded replies)
  task_id:         string?         // Linked task (if reply to a task-specific question)
  platform_metadata: object?       // Platform-specific data (Telegram message_id, GitHub comment URL, etc.)
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| Daemon | Routes to query handler (status check) or to Orchestrator (task response) |

---

#### `comm.message_sent`

An outbound message was sent.

```
payload {
  task_id:         string?         // null for system-level messages
  target:          string          // Where sent: "telegram:farzam", "github:issue:42"
  message_type:    "notification" | "question" | "status_response" | "milestone" | "alert"
  content_summary: string          // Brief summary (not full content — that's in the message itself)
  channel:         string          // Plugin ID: "telegram", "github"
}
```

**Subscribers:**
| Subscriber | Why |
|-----------|-----|
| (audit trail only) | Communication record |

---

## Delivery Model

Unchanged from [`event-bus.md`](event-bus.md), but simplified:

### Ordering
Events are **ordered per task** (`task_id`). Cross-task events have no ordering guarantee. System events (null `task_id`) are ordered among themselves.

### Delivery Guarantees
**At-least-once delivery.** Subscribers must be idempotent or handle deduplication using `event.id`.

### All Delivery is Async
With pre-processing removed, ALL event delivery is asynchronous. No subscriber blocks event delivery. Components process events at their own pace.

---

## Event Bus Policies

### Schema Validation

The Event Bus does NOT validate event payloads against schemas. Publishers are trusted (they are internal components, not external actors). Schema validation is a development-time concern (tests), not a runtime concern.

**Rationale:** In a single-process system with a small number of trusted publishers, runtime schema validation adds overhead without meaningful safety benefit. The Action Pipeline handles safety; the Event Bus handles routing.

### Cross-Task Event Correlation

Parent and child tasks are correlated via `task_id` and the Task Engine's hierarchy (`parent_id` on task objects). To correlate events across a task tree:

1. Query Task Engine for the parent and its children
2. Query Event Bus for events with any of those `task_id` values
3. Order by `sequence` for a unified timeline

No special correlation mechanism needed — the task hierarchy provides it.

### Event Compaction

The event log grows indefinitely (audit requirement). Two strategies for long-running systems:

1. **Archive**: Events older than a configurable threshold (e.g., 90 days) are moved to cold storage. The Event Bus keeps a pointer to archived ranges for replay requests.
2. **Compaction for replay**: Safety Layer cost accumulators only need recent events (within the current billing period). Replay can be bounded by time window.

Implementation details (storage format, archive destination) are Layer 4.

### Subscription Lifecycle

Subscriptions are managed by the Event Bus and persist across Orchestrator sessions:
- **Daemon** subscribes at system startup, never unsubscribes
- **Task Engine** subscribes at system startup, never unsubscribes
- **Comm Plugins** subscribe at registration, unsubscribe at deregistration
- **Safety Layer** subscribes at system startup (for `cost.incurred`), never unsubscribes
- **Orchestrator** does not subscribe directly — the Daemon routes relevant events to the Orchestrator as part of the dispatch protocol

The Orchestrator receiving events via the Daemon (not direct subscription) keeps subscription management simple and avoids lifecycle issues when the Orchestrator is not active.

---

## Summary

| Group | Events | Owner |
|-------|--------|-------|
| `task.*` | `created`, `state_changed`, `children_all_done`, `feedback_received` | Task Engine |
| `action.*` | `rejected` | Action Pipeline |
| `cost.*` | `incurred`, `limit_reached` | Orchestrator, Safety Layer |
| `preemption.*` | `requested`, `ready` | Daemon, Orchestrator |
| `timeout.*` | `reminder`, `self_unblock_check`, `alert` | Daemon |
| `trigger.*` | `new_event`, `pr_review` | Daemon |
| `health.*` | `stuck_detected`, `trigger_failure` | Daemon |
| `workspace.*` | `created`, `verified`, `cleaned`, `merge_conflict` | Workspace Manager |
| `git.*` | `branch_created`, `committed`, `pushed`, `pr_opened`, `pr_updated`, `pr_merged`, `merge_completed` | Workspace Manager |
| `comm.*` | `message_received`, `message_sent` | Comm Plugins |

**Total: 28 event types** across 10 groups.

---

## Changes from Layer 2

| What changed | From (Layer 2) | To (Layer 3) | Why |
|-------------|---------------|--------------|-----|
| Event Bus model | Pre-processing hook (Safety Layer intercepts synchronously) | Pure pub/sub (all async) | Action Pipeline handles safety checks before execution |
| `action.requested` | Pre-processed event, Orchestrator emits before acting | Removed | Pipeline gates replace pre-action interception |
| `action.rejected` | Did not exist | New event | Audit trail for pipeline rejections |
| `deploy.requested` | Pre-processed event | Removed (future event) | No state permits deploy in current design; add when deploy support designed |
| Event envelope | Had `status` ("delivered"/"vetoed") and `veto_reason` | Simplified — no status/veto fields | No vetoing on Event Bus |
| Subscription priority | "pre_process" vs "normal" | All subscriptions equal (async) | No pre-processing |
| `trigger.pr_review` | Referenced in Daemon doc but not in canonical table | Added as canonical event | Reconciliation |
| `workspace.verified` | Referenced in Workspace Manager doc but not in canonical table | Added as canonical event | Reconciliation |
| `git.branch_created` | Referenced in Workspace Manager doc but not in canonical table | Added as canonical event | Reconciliation |
| Orchestrator subscriptions | Direct Event Bus subscription | Daemon routes events to Orchestrator | Simpler lifecycle management |

---

## Open Questions for Layer 4

- Event persistence technology (in-process log vs external store)
- Archive/cold storage destination and format
- Event serialization format (JSON, MessagePack, Protobuf)
- Event ID generation strategy (UUID, ULID, sequence)
