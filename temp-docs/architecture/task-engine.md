# Task Engine — Layer 2 Design

The Task Engine is the state authority for all work in the system. It owns the task lifecycle, state machine, task hierarchy, and permission gates. The Orchestrator does the thinking; the Task Engine enforces the rules.

Part of **Layer 2** — see [`layers.md`](layers.md). Builds on the Layer 1 state machine in [`task-states.md`](task-states.md). Resolves gaps: #3, #6, #9, #13, #14, #24.

---

## Revised State Machine

Layer 1 defined 6 states. Layer 1.5 revealed that "waiting for review" is fundamentally different from "blocked" — the task isn't stuck, it's done-for-now pending judgment. Review-Pending is now a top-level state.

### States

| State | Meaning | Sub-states |
|-------|---------|------------|
| **Intake** | Task just arrived. Being loaded and validated. | — |
| **Queued** | Understood, ready to work. Waiting for agent capacity. | — |
| **Active** | Agent is working on this task. | Working, Supervising, Integrating |
| **Blocked** | Cannot proceed. Needs information, decision, or resource from a human or external system. | — (uses status details) |
| **Review-Pending** | Work submitted for external judgment. Not stuck — done for now. | Demo, Code |
| **Completed** | Done. PR merged or deliverable shipped. | — |
| **Failed** | Unrecoverable. Reason documented. | — |

### Transition Diagram

```
                         ┌──────────┐
                         │  INTAKE  │
                         └────┬─────┘
                              │ validated
                              v
                         ┌──────────┐
                         │  QUEUED  │ ◄──── preempted (from Active)
                         └────┬─────┘
                              │ capacity available
                              v
                    ┌─────────────────────┐
               ┌──► │       ACTIVE        │ ◄──┐
               │    │  .Working           │    │
               │    │  .Supervising       │    │
               │    │  .Integrating       │    │
               │    └──┬──────┬───────┬───┘    │
               │       │      │       │        │
               │       │      │       │        │
      unblocked│       │      │       │        │ feedback
               │       │      │       │        │ received
               │       v      │       v        │
          ┌────┴───┐   │  ┌───┴────────────┐   │
          │BLOCKED │   │  │REVIEW_PENDING  ├───┘
          └────────┘   │  │  .Demo         │
                       │  │  .Code         │
                       │  └───────┬────────┘
                       │          │ approved (Code)
                       v          v
                 ┌──────────┐  ┌──────────┐
                 │  FAILED  │  │COMPLETED │
                 └──────────┘  └──────────┘
```

### All Valid Transitions

| From | To | Trigger |
|------|----|---------|
| Intake | Queued | Task validated and understood |
| Intake | Failed | Invalid task (unparseable, duplicate, etc.) |
| Queued | Active.Working | Agent has capacity, begins work |
| Active.Working | Blocked | Needs human input or external resource |
| Active.Working | Review_Pending.Demo | Draft PR opened with demo artifacts |
| Active.Working | Review_Pending.Code | PR marked Ready (when demo review is skipped or N/A) |
| Active.Working | Completed | Task done without PR (e.g., research task, docs update) |
| Active.Working | Failed | Unrecoverable error |
| Active.Working | Queued | Preempted by higher-priority task |
| Active.Working | Active.Supervising | Task decomposed, children created |
| Active.Working | Active.Supervising | Merge conflict resolved, children still executing |
| Active.Supervising | Active.Working | Merge conflict during progressive merge (requires write permissions to resolve) |
| Active.Supervising | Blocked | Child failure requires human decision |
| Active.Supervising | Active.Integrating | All children completed |
| Active.Supervising | Failed | Cascade failure (fail-fast policy) |
| Active.Integrating | Review_Pending.Demo | Integration PR opened as Draft |
| Active.Integrating | Review_Pending.Code | Integration PR opened as Ready |
| Active.Integrating | Completed | No PR needed (all work in child PRs) |
| Active.Integrating | Failed | Integration check failed unrecoverably |
| Blocked | Active.Working | Blocker resolved |
| Blocked | Active.Supervising | Blocker resolved (for supervising parent) |
| Blocked | Failed | Blocked too long, no resolution possible |
| Review_Pending.Demo | Active.Working | Feedback received — apply changes |
| Review_Pending.Demo | Review_Pending.Code | Demo approved — clean artifacts, mark PR Ready |
| Review_Pending.Code | Active.Working | Feedback received — apply changes |
| Review_Pending.Code | Completed | Code approved — merge PR |

---

## Active Sub-States

### Working

The default Active sub-state. The agent is doing work: researching, planning, coding, testing, self-reviewing. The Orchestrator controls which **phase** the agent is in (research, planning, execution, self-review, etc.). Phases are Orchestrator concerns, not Task Engine concerns — the Task Engine only knows "Working."

**When decomposition approval is needed:** The Orchestrator creates a decomposition plan and sends it to the human for approval. The task transitions Active.Working → Blocked with reason "awaiting decomposition plan approval." When the human approves, it transitions Blocked → Active.Working → Active.Supervising (the Orchestrator creates children upon unblock, then the Task Engine transitions to Supervising).

### Supervising

The parent task enters this sub-state after creating child tasks. The parent monitors children's progress, handles cascade failures, and makes coordination decisions. The parent is NOT directly modifying code — children do that.

Supervising tracks:
- Children's current states
- Dependency ordering (which children must complete before others start)
- Failures and their cascade implications

### Integrating

All children have completed. The parent does final verification: runs integration tests, checks for conflicts between child PRs, ensures the whole is consistent. Then opens a PR (or confirms all child PRs are sufficient).

---

## Review-Pending Sub-States

### Demo

A Draft PR is open with demo artifacts. The task is waiting for the human to judge: "did we build the right thing?"

**Entry:** Active.Working → Review_Pending.Demo (Draft PR opened)
**Exit (feedback):** Review_Pending.Demo → Active.Working (apply feedback, then return here)
**Exit (approved):** Review_Pending.Demo → Review_Pending.Code (clean demo artifacts, mark PR Ready)

### Code

The PR is marked Ready. The task is waiting for the human to judge: "did we build it right?"

**Entry:** Review_Pending.Demo → Review_Pending.Code (demo approved) OR Active.Working → Review_Pending.Code (no demo needed)
**Exit (feedback):** Review_Pending.Code → Active.Working (apply feedback, then return here)
**Exit (approved):** Review_Pending.Code → Completed (merge PR)

### Demo Approval Mechanism (Gap #13 — Resolved)

The PR state is the discriminator. The system does not need a separate "demo approved" signal:

| Event | PR state | Interpretation |
|-------|----------|---------------|
| GitHub review approval | Draft | Demo approved |
| GitHub review approval | Ready | Code approved |
| GitHub PR comment | Draft or Ready | Feedback — transition to Active.Working |

The Task Engine watches for trigger events (via Event Bus) and maps them to state transitions using this table.

### Re-Review Detection

When the Engineer pushes an update in response to feedback:
1. Task transitions from Active.Working back to Review_Pending (Demo or Code)
2. The system does NOT require a new explicit approval — it watches for the next review event
3. GitHub's own review state ("changes requested" → new commits → reviewer re-reviews) handles the human side

---

## Review-Pending vs Blocked (Gap #24 — Resolved)

These are distinct states with different semantics:

| Aspect | Blocked | Review-Pending |
|--------|---------|---------------|
| **Why waiting** | Missing info, decision, or resource | Work is done, awaiting judgment |
| **Agent posture** | Tried to self-unblock, reached out, documented | Submitted deliverable, waiting |
| **Timeout behavior** | Reminder → self-unblock → stay blocked | Reminder only — cannot self-approve |
| **Scheduling** | Agent freed for other work | Agent freed for other work |
| **On resolution** | Returns to Active.Working (or Supervising) | Returns to Active.Working (feedback) or advances (approved) |

Both states free the agent's capacity for other tasks — the Daemon can assign the agent to a different task while waiting. When the waiting task gets unblocked or receives feedback, it re-enters the scheduling queue.

---

## Task Hierarchy (Gap #6 — Resolved)

### Parent-Child Relationships

Any task can become a parent by decomposing its work into children. This is recursive — a child can itself decompose further.

**Rules:**
- A parent creates children. Children do NOT create siblings.
- Children are independent tasks with their own full lifecycle (Intake → ... → Completed/Failed).
- Children carry a `parent_id` linking them to the parent.
- The parent tracks children in its `children` field, including dependency ordering.
- The parent enters Active.Supervising when children are created.
- Children can run sequentially (dependency chain) or in parallel (no dependencies between them), subject to Daemon capacity.

### Dependency Ordering

Children have an execution order defined by dependencies:

```
Example: JWT migration (#50)
  #51 (JWT utils)  ─┐
                     ├─→  #53 (migrate endpoints)  ─┐
  #52 (middleware) ─┘     #54 (migrate routes)     ──┼─→  #55 (cleanup)
                          (parallel with #53)        │
```

The parent's `children` field stores both the child IDs and their dependency graph. The Daemon uses this to determine which children are eligible for scheduling (all dependencies completed).

### Knowledge Flow Between Siblings

When a child completes, its output (what it built, key decisions, file paths) is attached to the parent's context as a "child completion summary." Subsequent siblings can access this via the parent — they don't directly access each other's session logs. This maintains isolation while enabling knowledge flow.

```
Child #51 completes → summary attached to Parent #50's context
Child #52 starts → Orchestrator reads Parent #50's context, sees #51's summary
```

This is a Task Engine concern (attaching summaries to parent context). The content of the summary is an Orchestrator concern (what to include).

---

## Cascade Failure (Gap #9 — Resolved)

When a child task enters Failed state, the Event Bus emits a `task.failed` event. The parent (in Supervising) receives it and applies the cascade policy.

### Policies

| Policy | Behavior | When to use |
|--------|----------|------------|
| **pause-siblings** (default) | Pause all non-completed siblings. Parent evaluates failure and decides: retry child, adjust plan, or escalate to human. | Most cases. Conservative, prevents wasted work. |
| **fail-fast** | Fail the parent and all siblings immediately. | When any failure invalidates the entire plan. |
| **best-effort** | Only pause siblings that depend on the failed child. Unaffected siblings continue. | When parts of the work are independently valuable. |
| **manual** | Pause all siblings. Immediately notify the human. Do not attempt self-resolution. | When the stakes are high and the human must decide. |

**Default: pause-siblings.** The parent attempts to understand the failure before involving the human. If the parent determines it needs human input, it transitions to Blocked.

The cascade policy is set on the parent task and inherited by children (unless overridden). It's part of the Task object.

---

## Task Object Schema

What a Task actually contains. This is the source of truth for any piece of work.

```
Task {
  -- Identity --
  id:            string        (internal unique ID)
  external_ref:  ExternalRef?  (e.g., { type: "github_issue", repo: "owner/repo", number: 47 })

  -- State --
  state:         Intake | Queued | Active | Blocked | Review_Pending | Completed | Failed
  sub_state:     Working | Supervising | Integrating | Demo | Code | null
  phase:         string?       (Orchestrator's current phase: "research", "planning", "execution", etc.)

  -- Hierarchy --
  parent_id:     string?       (null for top-level tasks)
  children: [{
    id:          string
    state:       (current state of child)
    depends_on:  string[]      (IDs of siblings that must complete first)
  }]
  cascade_policy: "pause-siblings" | "fail-fast" | "best-effort" | "manual"

  -- Context --
  title:         string
  description:   string
  source_text:   string        (original issue/ticket body, preserved verbatim)
  acceptance_criteria: string[]
  team: [{                     (the Engineer's team for this task — who to work with)
    person_id:   string        (links to People Directory for contact details + channels)
    role:        "author" | "reviewer" | "domain_expert" | "stakeholder"
    context:     string        (why they're relevant — "owns auth module", "created the issue")
  }]
  related: [{                  (prior art, context the Engineer should know about)
    type:        "issue" | "pr" | "doc" | "previous_attempt" | "spec" | "design"
    ref:         string        (URL, issue number, file path)
    relevance:   string        (why this matters — "previous failed attempt at same feature")
  }]
  decisions: [{
    what:        string
    why:         string
    alternatives_considered: string[]
    decided_by:  "agent" | "human"
    timestamp:   datetime
  }]
  child_summaries: [{          (populated as children complete)
    child_id:    string
    summary:     string
    key_outputs: string[]      (file paths, endpoints, etc.)
  }]

  -- Workspace --
  workspace: {
    repo:        string
    branch:      string
    worktree_path: string?
  }?

  -- Review --
  review: {
    pr_number:   number?
    pr_state:    "draft" | "ready" | "merged" | null
    demo_artifacts: [{
      type:      "screenshot" | "recording" | "tui" | "preview_url"
      location:  string       (PR description, branch path, URL)
      permanent: boolean      (false = cleaned up before Ready)
    }]
    feedback_rounds: [{
      stage:     "demo" | "code"
      comments:  string[]
      applied:   boolean
    }]
  }?

  -- Blocked details (populated when state = Blocked) --
  blocked: {
    reason:      string
    efforts_made: string[]
    contacted:   [{ person: string, channel: string, timestamp: datetime }]
    needed:      string
    waiting_for: string
  }?

  -- Tracking --
  priority:      number        (higher = more important)
  cost: {
    llm_tokens:  number
    llm_cost_usd: number
    compute_time_ms: number
  }
  history:       StateTransition[]   (audit trail — every state change recorded)
  timestamps: {
    created:     datetime
    started:     datetime?     (first time entering Active)
    completed:   datetime?
    last_transition: datetime
  }

  -- Session link --
  session_id:    string        (links to Session/Memory for full logs)
}

StateTransition {
  from_state:    string
  to_state:      string
  from_sub:      string?
  to_sub:        string?
  reason:        string
  timestamp:     datetime
  triggered_by:  string        (event ID that caused this transition)
}
```

### Design Principles

- **Task is the source of truth.** Any component can read the task to understand the current state of work. No hidden state elsewhere.
- **History is append-only.** The `history` field is a complete audit trail. Every transition is recorded with reason and trigger.
- **Blocked details are structured.** Not free text — structured fields that enable queryability (feeds into Gap #21).
- **Review state tracks rounds.** Each feedback round is recorded, enabling the system to answer "how many review rounds did this task take?"
- **Cost is cumulative.** Tracked on the task for per-task cost visibility. Cross-task aggregation is a Safety Layer concern (Gap #5).

---

## State Machine as Permission Gate

Each state+sub-state defines what action classes are permitted. The Task Engine enforces this — if a component requests an action that's not permitted in the current state, the request is rejected before it reaches the Safety Layer.

### Action Classes

Actions are grouped into classes rather than individual tools. This is stable as new tools are added (tools map to action classes, not the other way around).

| Action class | What it covers |
|-------------|---------------|
| **read** | Read files, search code, web search, query APIs |
| **write** | Create/modify files |
| **test** | Run tests, linters, build tools |
| **git-local** | Commit, branch, stash (local operations) |
| **git-remote** | Push, create/update PR, update PR status |
| **communicate** | Send messages, comment on PRs/issues |
| **merge** | Merge PRs |
| **deploy** | Deployment actions |
| **task-manage** | Create/modify/close child tasks and linked issues |
| **ask-human** | Ask questions to humans (via any comm channel) |

### Permission Table

| State.Sub | read | write | test | git-local | git-remote | communicate | merge | deploy | task-manage | ask-human |
|-----------|------|-------|------|-----------|------------|-------------|-------|--------|-------------|-----------|
| Intake | Y | - | - | - | - | - | - | - | - | - |
| Queued | Y | - | - | - | - | - | - | - | - | - |
| Active.Working | Y | Y | Y | Y | Y | Y | - | - | Y | Y |
| Active.Supervising | Y | - | - | - | - | Y | - | - | Y | Y |
| Active.Integrating | Y | Y | Y | Y | Y | Y | - | - | - | Y |
| Review_Pending.Demo | Y | - | - | - | - | Y | - | - | - | - |
| Review_Pending.Code | Y | - | - | - | - | Y | C | - | - | - |
| Blocked | Y | - | - | - | - | Y | - | - | - | Y |
| Completed | - | - | - | - | - | - | - | - | - | - |
| Failed | - | - | - | - | - | Y* | - | - | - | - |

**C** = only if auto-merge is configured for this repo
**Y*** = failure communication only (notify stakeholders)

### How Permissions Are Enforced

1. Component requests an action (e.g., Orchestrator wants to push code)
2. The request includes the task ID
3. Task Engine looks up the task's current state+sub-state
4. Task Engine checks the action class against the permission table
5. If denied: reject with error (logged in audit trail)
6. If allowed: pass through to Safety Layer for additional checks (cost, scope, etc.)
7. If both agree: action proceeds

This is the **two-gate model**: Task Engine gate (is this action legal in this state+sub-state?) → Safety Layer gate (is this action within policy?). Both must pass.

### Permission Reset on Loopback

When the Orchestrator loops back to an earlier phase (e.g., after review feedback reveals requirements were wrong):
1. Task transitions: Review_Pending → Active.Working
2. Permission set resets to Active.Working permissions
3. The Orchestrator is now back in a state where it can write code, run tests, push — but cannot merge
4. The transition is recorded in `history` with reason ("loopback: requirements misunderstood per review feedback")

---

## Operations

The Task Engine provides these operations:

**Task lifecycle:**
- `createTask(params) → Task` — create a new task in Intake state
- `getTask(task_id) → Task` — read full task object
- `getTasksByState(state, sub_state?) → Task[]` — query tasks by state
- `getChildren(parent_id) → Task[]` — get children of a parent task

**State transitions:**
- `requestTransition(task_id, to_state, to_sub_state?, reason, triggered_by) → TransitionResult` — request a state transition. Validates against state machine. Returns success or rejection with reason. All transitions go through this operation — no component directly mutates task state.

**Field updates:**
- `updateTaskField(task_id, field, value)` — update non-state fields (phase, workspace, cost, team, etc.). The Orchestrator uses this to update `phase`. Event subscriptions (below) use this to update `workspace` and `cost`.

**Hierarchy:**
- `attachChildSummary(parent_id, summary: ChildCompletionSummary)` — attach a child's completion summary to the parent's context

---

## Event Subscriptions

The Task Engine subscribes to events from other components to keep the Task object as the single source of truth. These updates happen automatically — other components emit events, the Task Engine reacts.

### Workspace Manager Events

The Workspace Manager is the source of truth for all git/PR state. The Task Engine keeps its `workspace` and `review` fields in sync:

| Event | Task Engine update |
|-------|-------------------|
| `workspace.created` | Set `task.workspace.repo`, `task.workspace.branch`, `task.workspace.worktree_path` |
| `workspace.cleaned` | Clear `task.workspace.worktree_path` |
| `git.pr_opened` | Set `task.review.pr_number`, `task.review.pr_state = "draft"` (or `"ready"` if not draft) |
| `git.pr_updated` (draft→ready) | Set `task.review.pr_state = "ready"` |
| `git.pr_merged` | Set `task.review.pr_state = "merged"` |

### Cost Events

| Event | Task Engine update |
|-------|-------------------|
| `cost.incurred` | Accumulate into `task.cost` (filtered by `task_id`): increment `llm_tokens`, `llm_cost_usd`, `compute_time_ms` |

The Safety Layer independently tracks cross-task cost aggregates from the same events. The Task Engine owns per-task cost; the Safety Layer owns aggregate cost.

---

## Progressive Merge on Child Completion

When a child task transitions to Completed, the Task Engine handles progressive merge as part of the child completion lifecycle — infrastructure work, like workspace creation and cleanup.

### Flow

```
1. Child #51 transitions to Completed
2. Task Engine checks: does #51 have a parent_workspace?
3. If yes: calls Workspace Manager.mergeBranch(child_branch, parent_branch)
4. If merge succeeds:
   a. Orchestrator generates child completion summary (content is Orchestrator's responsibility)
   b. Task Engine attaches summary to parent's child_summaries[] via attachChildSummary()
   c. Task Engine checks: are ALL children now Completed?
   d. If yes: emits task.children_all_done { parent_task_id, child_ids }
5. If merge conflict:
   a. Workspace Manager emits workspace.merge_conflict event
   b. Parent task transitions Active.Supervising → Active.Working (consumes slot)
   c. Orchestrator resolves the conflict (has write/git permissions in Working)
   d. After resolution: parent transitions Active.Working → Active.Supervising (frees slot)
   e. Flow continues from step 3a
```

### `task.children_all_done` Emission

The Task Engine is the sole emitter of `task.children_all_done`. When processing a child's transition to Completed, it checks if all siblings are also Completed. If yes, it emits the event. The Daemon subscribes and transitions the parent from Active.Supervising to Active.Integrating.

The Orchestrator's supervision loop reacts to this event — it does NOT independently check whether all children are done.

---

## Demo Artifact Lifecycle (Gap #16 — Addressed)

Two types of demo artifacts, handled differently:

| Type | Examples | Where they live | Lifecycle |
|------|----------|----------------|-----------|
| **Visual** | Screenshots, recordings, preview URLs | PR description (permanent) | Stay forever — they're part of the PR's history |
| **Code** | Temporary TUI, demo scripts | Branch (temporary) | Cleaned up when demo is approved (before PR → Ready) |

The Task Engine tracks artifacts in `review.demo_artifacts[]` with a `permanent` flag. When transitioning from Review_Pending.Demo → Review_Pending.Code, the Task Engine signals the Orchestrator to clean up non-permanent artifacts.

---

## Gaps Resolved

| # | Gap | Resolution |
|---|-----|-----------|
| 3 | Post-ship state | Absorbed into Review-Pending as a top-level state with Demo and Code sub-states |
| 6 | Task hierarchy | Parent-child model with dependency ordering, child summaries attached to parent context |
| 9 | Cascade failure | Four configurable policies: pause-siblings (default), fail-fast, best-effort, manual |
| 13 | Demo approval mechanism | PR state (Draft vs Ready) discriminates demo vs code approval. No separate signal needed |
| 14 | Active sub-states | Three sub-states: Working, Supervising, Integrating. Review-Pending elevated to top-level |
| 24 | Review-pending semantics | Distinct from Blocked: "done for now, pending judgment" vs "stuck, needs info." Different timeout behavior, permissions, and resolution patterns |

---

## Open Questions for Layer 3

- **Event schema**: What do `task.state_changed`, `task.created`, `task.feedback_received` events look like? (Layer 3: Interactions & Protocols)
- **Task persistence**: How is the Task object stored? In-memory with write-ahead log? Database? (Layer 3 or 4)
- **Preemption mechanics**: When a higher-priority task arrives, how does Active.Working → Queued actually work? Context saving, mid-operation interruption? (Partially Daemon concern — Gap #12)
- **Concurrent children**: Can multiple children be Active simultaneously? This depends on the single-agent vs multi-agent resolution (Gap #8, Daemon design)
