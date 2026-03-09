# Protocols -- Layer 3

How components coordinate. The step-by-step choreography of every cross-component interaction in the system.

Part of **Layer 3** -- see [`layers.md`](../layers.md). The third leg of the Layer 3 triad:
- **[Event Catalog](event-catalog.md)** defines the vocabulary (what events exist, their schemas)
- **[Plugin Contracts](plugin-contracts.md)** defines the interfaces (what operations plugins expose)
- **Protocols (this doc)** defines the choreography (how components use events and interfaces to coordinate)

Protocols reference the other two but never redefine them. If a protocol needs a new event or interface method, it belongs in the respective source document.

---

## Conventions

### Reading Step Sequences

- **Bold component names** indicate who acts at each step
- `→` indicates a direct synchronous call (request/response)
- `⟹` indicates an async event published to the Event Bus
- `Event: event.type` references the event catalog schema
- `Contract: PluginType.method()` references the plugin contracts
- Steps prefixed with `[on failure]` describe the failure path for the preceding step

### Cross-References

- `(see P7)` means "see Protocol 7: Action Pipeline Execution"
- `(see event-catalog § event.type)` means "see the event schema in event-catalog.md"
- `(see plugin-contracts § Type)` means "see the contract in plugin-contracts.md"
- `(see component.md § Section)` means "see the Layer 2 doc"

---

## 1. Task Lifecycle Protocols

The main path from system boot through task completion.

---

### P1: System Startup

**Trigger:** Daemon process starts (fresh launch or restart after crash).
**Outcome:** All components initialized, scheduling active, main loop running.

**Participants:**

| Component | Role |
|-----------|------|
| Daemon | Orchestrates the startup sequence |
| Registry | Initializes all registered plugins |
| Event Bus | Starts event routing and persistence |
| Safety Layer | Loads config, rebuilds cost accumulators from event replay |
| Task Engine | Provides current task states for queue reconstruction |
| People Directory | Loads people config |

**Preconditions:**
- Configuration files exist and are valid
- Persistent storage (Task Engine, Event Bus, Session/Memory) is accessible

#### Steps

1. **Daemon** starts, loads system configuration
2. **Event Bus** initializes -- starts persistence layer, begins accepting events and subscriptions
3. **Registry** loads plugin manifests from configuration
   - For each registered plugin: validates config against `manifest.config_schema`
   - Calls `Contract: Plugin.initialize(config)` on each plugin in dependency order (triggers last -- they need comm plugins ready for error alerts)
   - `[on failure]` If a plugin fails initialization: log error, mark unhealthy, continue with remaining plugins. If a critical plugin fails (LLM provider, primary comm): abort startup, alert via fallback channel
4. **Safety Layer** loads policy configuration (scope rules, cost limits, autonomy settings)
   - Calls `Event Bus.replay({type: "cost.incurred", since: billing_window_start})` to rebuild cost accumulators
   - Applies each replayed event to restore accumulator state
5. **People Directory** loads people config file, validates entries
6. **Task Engine** is queried by Daemon: `→ TaskEngine.getTasksByState()` for all non-terminal tasks
7. **Daemon** rebuilds scheduling state from Task Engine data:
   - Populates priority queue with all Queued tasks
   - Identifies Active.Working tasks (indicates crash recovery needed -- see P15)
   - Identifies Blocked tasks and restores timeout timers
   - Identifies Active.Supervising tasks and checks child completion status
8. **Daemon** registers Event Bus subscriptions for: `task.*`, `preemption.ready`, `comm.message_received`, `cost.limit_reached`, `workspace.verified`, `workspace.merge_conflict`, `git.merge_completed`
   - Note: This is the Daemon's own subscription list (events it routes to the Orchestrator or acts on directly). Other components maintain separate subscriptions — e.g., comm plugins with `sync` capability subscribe to `task.state_changed` for GitHub state sync, and comm plugins subscribe to `health.*` for alerting. The Daemon emits `health.*` and `timeout.*` events but does not subscribe to them.
9. **Daemon** starts main loop: trigger polling, scheduling evaluation, health monitoring

#### Success Outcome

All plugins healthy, scheduling queue populated, main loop active. System is ready to poll triggers and dispatch tasks.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 2 | Event Bus storage inaccessible | Abort startup. No event persistence = no audit trail = unsafe to operate. |
| 3 | Non-critical plugin fails init | Log warning, mark unhealthy in Registry. System operates without that plugin. |
| 3 | Critical plugin fails init | Abort startup. Alert via stderr/log (comm plugins may not be available). |
| 4 | Cost event replay fails | Safety Layer starts with zero accumulators. Log warning -- cost tracking will under-count until next billing window. |
| 6 | Task Engine inaccessible | Abort startup. Cannot schedule without task state. |

#### Notes

- Plugin initialization order matters: Event Bus first, then Safety Layer, then comm plugins, then triggers. Triggers may produce events immediately on first poll -- the rest of the system must be ready.
- On restart after crash, step 7 detects orphaned Active.Working tasks. These feed into P15 (Crash Recovery).
- Configuration hot-reload is supported after startup -- Safety Layer and People Directory watch their config files. Registry supports plugin hot-swap via `replace()`.

---

### P2: Task Creation

**Trigger:** Trigger plugin returns new events from `poll()`, or manual task creation.
**Outcome:** New task exists in Queued state, added to scheduling queue.

**Participants:**

| Component | Role |
|-----------|------|
| Trigger Plugin | Discovers new work from external source |
| Daemon | Polls trigger, deduplicates, orchestrates creation |
| Task Engine | Creates and validates the task |
| Comm Plugin (GitHub) | Syncs external state (labels, comments) |

**Preconditions:**
- System startup complete (P1)
- At least one trigger plugin registered and healthy

#### Steps

1. **Daemon** calls `Contract: TriggerPlugin.poll()` on each registered trigger at its declared `poll_interval`
   - Returns `TriggerEvent[]` (see plugin-contracts § TriggerPlugin)
2. **Daemon** deduplicates each `TriggerEvent` by `idempotency_key`
   - Checks against known keys (in-memory set, populated at startup from Task Engine's `external_ref` fields)
   - `[skip]` If key already seen: discard silently (idempotent)
3. **Daemon** emits internal event for audit: `⟹ trigger.new_event` (see event-catalog § trigger.new_event)
4. **Daemon** calls `→ TaskEngine.createTask()` with:
   - `title`: from TriggerEvent.title
   - `external_ref`: from TriggerEvent.external_ref
   - `repo`: from TriggerEvent.repo
   - `source`: trigger plugin ID
   - `priority`: default priority (user-configured per repo, or system default)
   - `metadata`: from TriggerEvent.metadata (labels, assignees, etc.)
   - `parent_id`: null (top-level task)
5. **Task Engine** creates task in `Intake` state
   - Validates fields (repo exists in config, no duplicate external_ref)
   - Populates `task.team[]` from People Directory (based on repo config and roles)
   - Transitions: Intake → Queued (automatic -- Intake is transient)
   - `⟹ task.created` (see event-catalog § task.created)
   - `⟹ task.state_changed` { from: "Intake", to: "Queued" }
6. **Daemon** receives `task.created` → adds task to priority queue
7. **Comm Plugin (GitHub)** receives `task.created` → adds `engineer:queued` label to the external issue (if GitHub source)

#### Success Outcome

Task exists in Queued state with team populated, workspace not yet created, priority queue updated, external source annotated.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 1 | Trigger plugin throws PluginError | Daemon increments consecutive failure counter. If counter ≥ threshold: `⟹ health.trigger_failure`. Plugin continues to be polled on next interval. |
| 4 | Task Engine rejects (invalid repo, constraint violation) | Daemon logs error. Does NOT add to dedup set (so retry is possible if trigger re-emits). |
| 7 | GitHub API failure | Comm plugin retries per its error handling. Label sync is best-effort -- task creation is not blocked. |

#### Notes

- `Intake` is a transient validation state -- tasks pass through it in the same synchronous call. External observers only see `Queued`.
- Priority can be explicitly set via trigger metadata (e.g., GitHub label `priority:high` maps to a configured value). If not set, uses per-repo or system default.
- Manual task creation (via CLI or API) follows the same flow but uses `ManualTrigger` plugin with a synthetic idempotency key.

---

### P3: Task Dispatch

**Trigger:** Daemon's scheduling evaluation finds an eligible task and an available working slot.
**Outcome:** Task is Active.Working with workspace ready, Orchestrator has context and is executing.

**Participants:**

| Component | Role |
|-----------|------|
| Daemon | Selects task, assembles dispatch package, hands off to Orchestrator |
| Task Engine | Transitions state, provides task data |
| Workspace Manager | Creates or verifies workspace |
| Session/Memory | Provides checkpoint (if resume) and knowledge entries |
| Orchestrator | Receives dispatch, begins or resumes work |

**Preconditions:**
- At least one Queued task with no unsatisfied dependencies
- Available working slot (active working tasks < `max_concurrent`)
- System startup complete (P1)

#### Steps

1. **Daemon** evaluates scheduling on each cycle:
   - Checks: `active_working_count < max_concurrent`
   - Selects highest-priority Queued task (with priority aging applied)
   - Validates: no dependency blockers (for child tasks: parent is Supervising, sibling dependencies met)
2. **Daemon** calls `→ TaskEngine.requestTransition(task_id, "Active.Working", reason: "scheduled")`
   - `⟹ task.state_changed` { from: "Queued", to: "Active", sub: "Working" }
3. **Task Engine** calls `→ WorkspaceManager.createWorkspace(task_id, repo, base_branch, parent_branch?)`
   - Workspace Manager: `git fetch origin` → creates branch (naming: `engineer/{task_id}-{slug}`, or `engineer/{parent_id}/{child_id}-{slug}` for children) → `git worktree add`
   - `⟹ workspace.created` (see event-catalog § workspace.created)
   - `[on resume]` If task has existing workspace: `→ WorkspaceManager.verifyWorkspace()` instead (see P9)
4. **Task Engine** receives `workspace.created` → updates `task.workspace` field
5. **Daemon** assembles Dispatch package:
   - `task`: full Task object from Task Engine (includes state, team, workspace, cost, metadata)
   - `resume_from`: latest checkpoint from `→ SessionMemory.getLatestCheckpoint(task_id)` (null if new task)
   - `knowledge.repo`: from `→ SessionMemory.queryKnowledge(scope: "repo", repo_scope: task.repo)` -- repo-specific learned patterns
   - `knowledge.user`: from `→ SessionMemory.queryKnowledge(scope: "user")` -- global user preferences
6. **Daemon** hands Dispatch to Orchestrator (process-level hand-off -- Orchestrator receives full context)
7. **Orchestrator** receives Dispatch:
   - `[new task]` Creates new Session via `→ SessionMemory.createSession(task_id)`
   - `[resume]` Creates new Session linked to previous: `→ SessionMemory.createSession(task_id, previous_session_id)` (see P9 for full resume flow)
   - Enters phase pipeline at `intake-analysis` (new) or `checkpoint.phase` (resume)
   - Logs journal entry: `→ SessionMemory.appendJournal(session_id, {type: "phase_change", summary: "Task started/resumed"})`

#### Success Outcome

Orchestrator is executing the task's current phase. Workspace is ready. Session is active. Knowledge is loaded.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 2 | State transition rejected (task no longer Queued) | Race condition -- another scheduling cycle already dispatched it. Daemon skips, evaluates next candidate. |
| 3 | Workspace creation fails (disk full, git error) | Task Engine transitions task to Failed with reason. Daemon frees the slot. `⟹ task.state_changed` { to: "Failed" }. |
| 6 | Orchestrator process fails to start | Daemon detects within heartbeat timeout. Transitions task back to Queued. Retries on next scheduling cycle. |

#### Notes

- Knowledge precedence: Repo > User > Defaults. If repo knowledge says "use tabs" and user knowledge says "use spaces", repo wins.
- The Dispatch package is the complete context -- Orchestrator should not need to query other components for initial setup.
- Fast-path eligible tasks (≤2 files, no ambiguity, <30 min estimate) are dispatched identically but the Orchestrator skips planning and demo phases internally (see orchestrator.md § Fast-Path).

---

### P4: Phase Transition

**Trigger:** Orchestrator completes the current phase and is ready to advance.
**Outcome:** Checkpoint saved, task phase updated, next phase entered.

**Participants:**

| Component | Role |
|-----------|------|
| Orchestrator | Completes phase, creates checkpoint, enters next phase |
| Session/Memory | Stores checkpoint and journal entries, captures knowledge |
| Task Engine | Records current phase on task object |

**Preconditions:**
- Orchestrator is executing a task in Active.Working
- Current phase has produced its output (PhaseOutput)

#### Steps

1. **Orchestrator** completes current phase, produces PhaseOutput (findings, plan, code changes, review results, etc.)
2. **Orchestrator** creates mandatory checkpoint: `→ SessionMemory.createCheckpoint(session_id, checkpoint_data)`
   - `checkpoint_data` includes:
     - `phase`: the phase just completed (e.g., "research")
     - `phase_progress`: summary of work done in this phase
     - `context_summary`: compressed narrative of full task context so far (for context reconstruction on resume)
     - `key_findings`: list of important discoveries or decisions
     - `open_questions`: unresolved questions (empty if none)
     - `next_action`: what to do next (e.g., "begin planning phase")
     - `reason`: "phase_transition"
3. **Orchestrator** captures any knowledge learned during this phase:
   - If patterns, conventions, or domain insights were discovered:
   - `→ SessionMemory.storeKnowledge({scope: "repo", repo_scope: task.repo, domain, key, body, confidence, evidence})`
   - Knowledge entries are immutable -- new observations create new entries (old ones get `superseded_by` if updated)
4. **Orchestrator** updates task phase: `→ TaskEngine.updateTaskField(task_id, "phase", next_phase)`
5. **Orchestrator** logs journal entry: `→ SessionMemory.appendJournal(session_id, {type: "phase_change", summary: "Completed {phase}, entering {next_phase}", detail: phase_summary})`
6. **Orchestrator** loads next phase's reference docs (on-demand, per PI-Inspired Minimalism)
7. **Orchestrator** enters next phase, begins work

#### Phase Sequence

Standard (7 phases): `intake-analysis` → `research` → `planning` → `execution` → `self-review` → `demo-prep` → `integration`

Fast-path (trivial tasks): `intake-analysis` → `execution` → `self-review` → `integration` (skips research, planning, demo-prep)

#### Loopback Transitions

Orchestrator may loop back to a previous phase (e.g., execution reveals a research gap → return to research). This follows the same protocol with:
- Checkpoint reason: "phase_loopback"
- Journal entry documents why the loopback was necessary
- Task Engine field updated to the earlier phase

#### Success Outcome

Checkpoint persisted, knowledge captured, task phase reflects the new phase, next phase executing.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 2 | Checkpoint storage fails | Critical error. Orchestrator retries once. If persistent: transitions task to Failed (cannot guarantee resume safety without checkpoint). |
| 4 | Task Engine update fails | Log error, continue -- phase tracking is informational, not blocking. Retry on next transition. |

#### Notes

- Checkpoints are mandatory at phase boundaries. Additional checkpoints can be created mid-phase (e.g., after significant progress within execution) but are not required.
- The `context_summary` field is the key to context reconstruction (not LLM replay). It should be rich enough that a fresh LLM context seeded with this summary can continue work effectively.
- Phase transitions are Orchestrator-internal decisions. The Task Engine records the phase but does not enforce phase ordering -- that's the Orchestrator's responsibility.

---

### P5: Decomposition & Child Creation

**Trigger:** Orchestrator determines during planning that the task is too large for a single unit of work.
**Outcome:** Parent task is Supervising, child tasks are Queued, external issues created.

**Participants:**

| Component | Role |
|-----------|------|
| Orchestrator | Decides to decompose, defines children, requests approval |
| Safety Layer | Evaluates autonomy for `task_decomposition` category |
| Task Engine | Creates child tasks, transitions parent |
| Comm Plugin (GitHub) | Creates child issues, updates parent issue checklist |
| Comm Plugin (Telegram) | Sends decomposition notification |
| Daemon | Schedules children as slots become available |

**Preconditions:**
- Task is Active.Working, typically in `planning` phase
- Orchestrator has analyzed the work and determined decomposition is needed

#### Steps

1. **Orchestrator** formulates decomposition plan: child task definitions (title, description, repo, dependencies between siblings)
2. **Orchestrator** checks autonomy: `→ SafetyLayer.evaluate({type: "autonomy_check", category: "task_decomposition", context: {parent_task_id, child_count, estimated_scope}})`
   - Verdict `proceed`: continue to step 4
   - Verdict `ask_human`: continue to step 3
   - Verdict `deny`: abort decomposition, Orchestrator works on task as monolith
3. `[if ask_human]` **Orchestrator** sends decomposition plan for approval (enters P11: Blocking flow):
   - Formats plan as numbered list with titles, descriptions, dependency graph
   - Sends via Comm Plugin to task owner
   - Task transitions to Blocked (waiting for approval)
   - `[on approval]` Resumes at step 4
   - `[on rejection]` Orchestrator adjusts plan or works as monolith
4. **Orchestrator** creates children: for each child in the plan:
   - `→ TaskEngine.createTask({title, description, repo, parent_id: current_task_id, priority: parent.priority, dependencies: [sibling_ids]})`
   - Task Engine creates child in Intake → Queued (same as P2 step 5)
   - `⟹ task.created` for each child
5. **Orchestrator** creates external issues for each child:
   - `→ CommPlugin(GitHub).createIssue(repo, {title, body, labels: ["engineer:queued"], parent_issue: parent_external_ref})`
   - Updates each child's `external_ref` via `→ TaskEngine.updateTaskField(child_id, "external_ref", issue_url)`
6. **Orchestrator** updates parent issue with checklist:
   - `→ CommPlugin(GitHub).commentOnIssue(repo, parent_issue, checklist_comment)` listing all children with links
7. **Task Engine** transitions parent: `Active.Working → Active.Supervising`
   - `⟹ task.state_changed` { from_sub: "Working", to_sub: "Supervising" }
   - Supervising does NOT consume a working slot
8. **Daemon** receives `task.created` events for children → adds to priority queue
   - Evaluates dependencies: children with no dependencies are immediately eligible
   - Schedules eligible children as slots become available (via P3)
9. **Orchestrator** logs decomposition in journal: `→ SessionMemory.appendJournal(session_id, {type: "decision", summary: "Decomposed into N children", detail: child_list})`

#### Success Outcome

Parent is Supervising (slot freed). Children are Queued with correct dependencies. External issues exist with parent checklist. Daemon will schedule children independently.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 2 | Safety Layer denies decomposition | Orchestrator works on the task as a single unit. Logs decision. |
| 4 | Child task creation fails | Orchestrator stops creation, rolls back already-created children (transitions to Cancelled). Reports error. |
| 5 | GitHub issue creation fails | Non-blocking. Children exist internally without external references. Retry on next opportunity. |

#### Notes

- Decomposition is recursive -- a child can itself decompose further (same protocol applies).
- Child priorities inherit from parent by default. Orchestrator can adjust individual child priorities based on critical path analysis.
- Children branch from parent's branch: `engineer/{parent_id}/{child_id}-{slug}`. This ensures progressive merge flows into the parent branch.
- Sibling dependencies are expressed as `task.dependencies: [sibling_id]`. A child cannot be scheduled until all its dependencies are Completed.

---

### P6: Progressive Merge

**Trigger:** A child task reaches Completed state.
**Outcome:** Child's work is merged into parent branch, parent context updated, and (if all children done) parent transitions to Integrating.

**Participants:**

| Component | Role |
|-----------|------|
| Task Engine | Detects child completion, initiates merge, tracks all-done |
| Workspace Manager | Performs the git merge operation |
| Orchestrator | Generates child completion summary; resolves conflicts if needed |
| Daemon | Handles parent state transitions, notifies on conflict |
| Comm Plugin | Notifies on merge conflict |

**Preconditions:**
- Child task has just transitioned to Completed
- Parent task is in Active.Supervising
- Both branches exist (child branch, parent branch)

#### Steps

1. **Task Engine** detects child completion (via `task.state_changed` to Completed processing)
2. **Task Engine** calls `→ WorkspaceManager.mergeBranch(child_branch, parent_branch)`
3. **Workspace Manager** performs merge:
   - `git checkout parent_branch`
   - `git merge child_branch`
   - `[on success]` Continue to step 4
   - `[on conflict]` Continue to step 7
4. **Workspace Manager** emits `⟹ git.merge_completed` { source: child_branch, target: parent_branch, merge_sha }
5. **Orchestrator** generates child completion summary (brief narrative of what the child accomplished, key changes, test results)
   - `→ TaskEngine.attachChildSummary(parent_id, child_id, summary)` -- attaches to parent's context
   - Subsequent siblings dispatched after this point receive the prior child's summary in their Dispatch package (P3 step 5)
6. **Task Engine** checks: are ALL children in terminal state (Completed or Failed)?
   - `[not all done]` No further action. Daemon continues scheduling remaining children.
   - `[all done]` `⟹ task.children_all_done` (see event-catalog § task.children_all_done)
   - **Daemon** receives event → `→ TaskEngine.requestTransition(parent_id, "Active.Integrating")`
   - `⟹ task.state_changed` { from_sub: "Supervising", to_sub: "Integrating" }
   - Daemon dispatches parent via P3 for integration work

**Merge Conflict Path (from step 3):**

7. **Workspace Manager** emits `⟹ workspace.merge_conflict` { conflicting_files }
8. **Daemon** receives conflict event → `→ TaskEngine.requestTransition(parent_id, "Active.Working")`
   - Parent now consumes a working slot
   - `⟹ task.state_changed` { from_sub: "Supervising", to_sub: "Working" }
9. **Daemon** dispatches parent to Orchestrator (via P3)
10. **Orchestrator** resolves merge conflict:
    - Has full write + git permissions (Active.Working)
    - Resolves conflicts, commits resolution
    - `→ TaskEngine.requestTransition(parent_id, "Active.Supervising")`
    - Slot freed, parent returns to Supervising
11. **Comm Plugin** receives `workspace.merge_conflict` → notifies owner of conflict occurrence

#### Success Outcome

Child's code merged into parent branch. Parent context updated with child summary. If all children done, parent transitions to Integrating for final assembly work.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 2 | Child branch doesn't exist (deleted prematurely) | Task Engine logs error. Parent may need manual intervention -- transitions to Blocked. |
| 3 | Merge fails (not conflict -- git error) | Workspace Manager retries once. If persistent: `⟹ workspace.merge_conflict` with error details, follows conflict path. |
| 10 | Orchestrator cannot resolve conflict | Orchestrator sends conflict details to human (P11 blocking flow). Task remains Active.Working until human provides guidance. |

#### Notes

- Progressive merge means children merge into parent as they complete, not all at once. This gives later siblings access to earlier siblings' code.
- The cascade failure policy (default: `pause-siblings`) determines what happens when a child fails. Configurable per-task: `pause-siblings`, `continue`, `fail-parent`, `fail-all`. See task-engine.md § Cascade Failure.
- `Active.Integrating` is where the parent Orchestrator does final work: ensures all children's code works together, runs integration tests, prepares the PR. This may be minimal (children already tested individually) or substantial (cross-child integration issues).

---

## 2. Coordination Protocols

How the system coordinates actions, preemption, resume, and cost enforcement across components.

---

### P7: Action Pipeline Execution

**Trigger:** Orchestrator intends to perform an action (read, write, push, send message, create child task, etc.).
**Outcome:** Action is executed and post-action event emitted, or action is rejected/deferred to human.

**Participants:**

| Component | Role |
|-----------|------|
| Orchestrator | Initiates action intent, handles verdicts |
| Task Engine | Gate 1 -- validates action class against state+sub-state permission table |
| Safety Layer | Gate 2 -- evaluates action against policy (scope, cost, autonomy) |
| Executing Component | Performs the action (Workspace Manager, Comm Plugin, Task Engine, etc.) |
| Event Bus | Receives post-action notification event |

**Preconditions:**
- Task is in a non-terminal state
- Orchestrator has determined it needs to perform an action

#### Steps

**Read-Only Path (Gate 1 only):**

1. **Orchestrator** determines the action class for the intended operation
2. `[if action class is "read"]` **Orchestrator** calls `→ TaskEngine.checkPermission(task_id, "read")`
   - Task Engine checks the permission table for current state+sub-state
   - `[permitted]` Orchestrator executes the read operation directly. No Gate 2, no post-action event. Done.
   - `[denied]` `⟹ action.rejected` { gate: "task_engine", action_class: "read", reason: "State {state}.{sub} does not permit read" }. Orchestrator receives rejection. Done.

**Side-Effect Path (full pipeline):**

3. **Orchestrator** identifies the action class (`write`, `test`, `git-local`, `git-remote`, `communicate`, `merge`, `deploy`, `task-manage`, `ask-human`) and assembles action details (file path, branch name, message content, etc.)

4. **Gate 1 -- Task Engine:** `→ TaskEngine.checkPermission(task_id, action_class)`
   - Task Engine looks up current state+sub-state in the permission table (see task-engine.md § Permission Table)
   - `[denied]` Pipeline halts.
     - `⟹ action.rejected` { task_id, action_class, gate: "task_engine", reason: "State {state}.{sub} does not permit {action_class}" }
     - Orchestrator receives rejection. May adjust strategy (e.g., cannot merge in Active.Working -- expected, not a bug).
     - Done.
   - `[conditional]` For `merge` in Review_Pending.Code: Gate 1 checks whether auto-merge is configured for this repo. If not configured, denied.
   - `[permitted]` Continue to Gate 2.

5. **Gate 2 -- Safety Layer:** `→ SafetyLayer.evaluate(safety_query)`
   - Query type depends on the action:
     - Scope check (`can_i`): "Can I write to this file?", "Can I push to this branch?"
     - Autonomy check (`should_i_ask`): "Should I ask about this architectural decision?"
     - Cost check (`cost_check`): "Am I within budget?" (before cost-bearing actions)
   - Safety Layer evaluates against loaded policy configuration
   - Returns `SafetyVerdict` { allowed, action, reason, warnings? }

6. **Verdict: `proceed`** -- Continue to step 9 (Execute).
   - If verdict includes `warnings` (e.g., "approaching cost limit at 72%"): Orchestrator logs warnings in journal and may adjust behavior (choose cheaper operations)

7. **Verdict: `ask_human`** -- Action deferred pending human approval.
   - **Orchestrator** formats the question (what it wants to do and why)
   - **Orchestrator** adds question to batch (see orchestrator.md § Question Batching -- 30s window, max 5 questions)
   - **Orchestrator** requests: `→ TaskEngine.requestTransition(task_id, "Blocked", reason: "awaiting_human_decision")`
   - `⟹ task.state_changed` { to_state: "Blocked", reason: "awaiting_human_decision" }
   - **Orchestrator** sends question batch via `Contract: CommPlugin.sendMessage()` to the appropriate person from `task.team`
   - Flow continues in P11 (Blocking & Human Interaction -- Batch 3). On human approval, Orchestrator re-enters the pipeline at step 3 with the same action.
   - Done (for now).

8. **Verdict: `deny`** -- Action permanently rejected by policy.
   - `⟹ action.rejected` { task_id, action_class, gate: "safety_layer", reason: verdict.reason }
   - Orchestrator receives denial. Must find an alternative approach (e.g., file is in scope exclusion list -- cannot write to `.env`).
   - Done.

9. **Execute:** **Orchestrator** calls the appropriate component to perform the action:
   - File write/delete: Orchestrator writes directly in the worktree
   - Git commit: `→ WorkspaceManager.commit(task_id, message)`
   - Git push: `→ WorkspaceManager.push(task_id)`
   - PR create: `Contract: GitHostingPlugin.createPR(options)` (via Workspace Manager)
   - Send message: `Contract: CommPlugin.sendMessage(target, message)`
   - Create child task: `→ TaskEngine.createTask(params)` (see P5)
   - `[on failure]` Execution error: Orchestrator handles per its phase logic (retry, log, escalate). No event emitted -- the action didn't happen.

10. **Notify:** Executing component emits the post-action event on the Event Bus:
    - `⟹ git.committed`, `⟹ git.pushed`, `⟹ git.pr_opened`, `⟹ comm.message_sent`, `⟹ task.created`, etc.
    - These are pure notifications -- async delivery, no interception.

#### Success Outcome

Action executed, post-action event published, audit trail complete. If `ask_human`, task is Blocked and human has been notified (P11 takes over).

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 2/4 | Gate 1 rejects (state doesn't permit action class) | `action.rejected` event logged. Orchestrator adjusts strategy. Often expected (e.g., merge in Working). |
| 5 | Safety Layer unavailable | Critical system error. Orchestrator does NOT bypass Gate 2. Fails the action, logs error. If persistent: task transitions to Failed. |
| 8 | Gate 2 denies (policy violation) | `action.rejected` event logged. Orchestrator must find alternative. If no alternative: may ask human for guidance via `ask-human` action class. |
| 9 | Execution fails (git error, API error, disk full) | No post-action event emitted (action didn't happen). Orchestrator retries or handles per phase logic. |

#### Notes

- **Pipeline is synchronous.** Steps 3-10 happen in sequence within the Orchestrator's execution flow. Defense in depth requires sequential gates -- no bypass possible.
- **Per-action, not per-phase.** Within a single phase (e.g., execution), the Orchestrator goes through the pipeline for each side-effect action individually. No batch approval.
- **Internal bookkeeping skips the pipeline.** Creating checkpoints (`SessionMemory.createCheckpoint`), appending journal entries (`SessionMemory.appendJournal`), and updating the task phase field are always allowed. They are internal record-keeping, not side-effect actions.
- **No `action.completed` event.** Successful actions emit domain-specific events (`git.pushed`, `git.committed`, etc.). The absence of `action.rejected` plus the presence of the specific event means the action succeeded.
- **Multiple Safety queries per action.** A single action may require multiple Safety Layer evaluations (e.g., `git push` needs both a scope check and a cost check). The Orchestrator composes queries as needed.
- **Reads skip Gate 2 (Decision #50).** Read operations have no side effects -- they don't need scope, cost, or autonomy checks from the Safety Layer. Gate 1 provides defense-in-depth for terminal states.

---

### P8: Preemption

**Trigger:** Daemon's scheduling evaluation detects a Queued task with priority delta >= `preemption_threshold` above the current Active.Working task.
**Outcome:** Current task is checkpointed and moved to Queued; higher-priority task is dispatched.

**Participants:**

| Component | Role |
|-----------|------|
| Daemon | Detects preemption condition, issues request, executes the swap |
| Orchestrator | Receives preemption signal, finishes atomic operation, checkpoints, yields |
| Session/Memory | Stores preemption checkpoint |
| Task Engine | Transitions both tasks' states |

**Preconditions:**
- Task X is Active.Working (consuming a working slot)
- Task Y is Queued with `Y.priority - X.priority >= preemption_threshold` (default: 20)
- No preemption already in progress (`pending_preemption` is null)

#### Steps

1. **Daemon** evaluates preemption on scheduling tick (step 3 of daemon loop):
   - Scans Queued tasks. Finds task Y where `Y.priority - X.priority >= preemption_threshold`
   - Sets `pending_preemption = { target: X, replacement: Y, requested_at: now(), status: "requested" }`
2. **Daemon** emits: `⟹ preemption.requested` { target_task_id: X, preempting_task_id: Y, reason: "priority_delta_exceeded", priority_delta }
3. **Daemon** starts preemption timeout timer: `preemption_timeout` (default: 60 seconds)

4. **Orchestrator** receives `preemption.requested` (Daemon routes the event):
   - Notes the preemption request internally
   - Continues its **current atomic operation** to completion:
     - LLM call in progress: let the response complete
     - File write in progress: let the write finish
     - Test run in progress: let tests finish
     - Git commit in progress: let the commit complete
   - Does NOT start any new atomic operations after receiving the signal

5. **Orchestrator** creates preemption checkpoint: `→ SessionMemory.createCheckpoint(session_id, checkpoint_data)`
   - `checkpoint_data`:
     - `phase`: current phase
     - `phase_progress`: summary of progress within current phase
     - `context_summary`: LLM self-summarization of full task context (see orchestrator.md § Checkpoint Context Summary)
     - `key_findings`: important discoveries so far
     - `open_questions`: unresolved questions
     - `next_action`: what the Orchestrator was about to do next
     - `reason`: "preemption"
     - `workspace_ref`: { branch, last_commit } -- workspace persists on disk

6. **Orchestrator** logs journal entry: `→ SessionMemory.appendJournal(session_id, { type: "checkpoint_marker", summary: "Preempted for higher-priority task" })`
7. **Orchestrator** ends session: `→ SessionMemory.endSession(session_id, reason: "preempted")`
8. **Orchestrator** emits: `⟹ preemption.ready` { task_id: X, checkpoint_id, phase, atomic_op: "completed operation type" }

9. **Daemon** receives `preemption.ready`:
   - Cancels preemption timeout timer
   - Updates `pending_preemption.status = "completed"`
10. **Daemon** transitions task X: `→ TaskEngine.requestTransition(X, "Queued", reason: "preempted")`
    - `⟹ task.state_changed` { from_state: "Active", from_sub: "Working", to_state: "Queued", reason: "preempted" }
    - Task X retains checkpoint reference for future resume (P9)
    - Task X's worktree persists on disk (idle but intact)
    - Working slot is freed
11. **Daemon** clears `pending_preemption = null`
12. **Daemon** dispatches task Y via **P3** (Task Dispatch):
    - Task Y: Queued → Active.Working
    - Workspace created (if new) or verified (if Y was previously preempted)
    - Orchestrator begins working on Y

#### Preemption Timeout Path (safety net)

13. `[if Orchestrator does not emit preemption.ready within preemption_timeout (60s)]`
    **Daemon** detects timeout:
    - Logs warning: "Orchestrator did not yield within timeout for task X"
    - Sends second preemption signal: `⟹ preemption.requested` (same payload)
    - Starts second timeout window (60 seconds)

14. `[if second timeout also expires]`
    **Daemon** force-terminates:
    - Force-terminates the Orchestrator process
    - Logs error: "Force-terminated Orchestrator for task X -- failed to yield after 2 preemption requests"
    - Recovers task X from **latest existing checkpoint** (the preemption checkpoint from step 5 was never created -- use last successful checkpoint before the preemption attempt)
    - `→ TaskEngine.requestTransition(X, "Queued", reason: "preempted_forced")`
    - `⟹ task.state_changed` { to_state: "Queued", reason: "preempted_forced" }
    - Any work between the last checkpoint and force-termination is lost
    - Proceeds to step 12 to dispatch Y

#### Success Outcome

Task X is Queued with a fresh checkpoint, workspace intact on disk. Task Y is Active.Working and executing. Task X will resume later via P9 when capacity is available and its priority is highest.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 5 | Checkpoint creation fails | Orchestrator retries once. If persistent: still yields (better to lose context than block higher-priority work), logs critical error. Resume will use last successful checkpoint. |
| 10 | Task X transition to Queued fails | Should not happen (Active.Working → Queued is valid). Log error, proceed with dispatching Y. Daemon resolves on next health check. |
| 12 | Task Y dispatch fails | Follow P3 failure paths. X is already Queued and safe. |
| 13-14 | Orchestrator stuck, force-terminate needed | Work since last checkpoint is lost. Task X returns to Queued with older checkpoint. Alert logged for debugging. |

#### Notes

- **Cooperative, not preemptive.** The Orchestrator decides where the safe yield point is. The Daemon trusts it to yield promptly. The timeout is a safety net for genuinely stuck processes, not the normal mechanism.
- **One preemption at a time.** While `pending_preemption` is set, the Daemon does not initiate another preemption. This prevents cascading preemption chaos.
- **Workspace persists.** Task X's worktree stays on disk. When X is eventually resumed (P9), the workspace is verified but not recreated.
- **Priority aging continues.** While X is Queued after preemption, its priority aging continues. If X ages above Y, X may eventually preempt Y back. The `preemption_threshold` prevents thrashing.
- **Preempting a child.** If the current Active.Working task is a child, preemption targets the child (it holds the working slot). The parent stays in Active.Supervising.
- **Connects to P3** (Task Dispatch) for dispatching the replacement task, and to **P9** (Task Resume) for when the preempted task is eventually rescheduled.

---

### P9: Task Resume

**Trigger:** A previously active task is dispatched again after preemption, crash recovery, or a new session.
**Outcome:** Task is Active.Working with context reconstructed from checkpoint, workspace verified, new session created.

**Participants:**

| Component | Role |
|-----------|------|
| Daemon | Identifies resume condition, assembles dispatch package with checkpoint |
| Task Engine | Transitions state, provides task data |
| Session/Memory | Provides checkpoint and knowledge, creates new session |
| Workspace Manager | Verifies workspace integrity |
| Orchestrator | Receives dispatch, reconstructs context, resumes work |

**Preconditions:**
- Task has at least one checkpoint from a previous session (or none -- see crash recovery variant)
- Task is Queued (post-preemption, crash recovery, or re-entry after unblock)

**Three Resume Triggers:**

| Trigger | How task enters Queued | Checkpoint expected? |
|---------|----------------------|---------------------|
| Post-preemption | P8 step 10 transitioned to Queued | Yes -- fresh preemption checkpoint |
| Crash recovery | P1 step 7 detected orphaned Active.Working, transitioned to Queued | Maybe -- last checkpoint before crash. May not reflect latest work. |
| New session | System restart, task was Queued at shutdown time | Yes -- phase transition or periodic checkpoint from prior session |

#### Steps

1. **Daemon** identifies the task for dispatch (same as P3 step 1 -- priority queue evaluation)
   - Recognizes this is a resume: `→ SessionMemory.getLatestCheckpoint(task_id)` returns non-null

2. **Daemon** calls `→ TaskEngine.requestTransition(task_id, "Active.Working", reason: "resumed")`
   - `⟹ task.state_changed` { from_state: "Queued", to_state: "Active", sub: "Working", reason: "resumed" }

3. **Daemon** requests workspace verification: `→ WorkspaceManager.verifyWorkspace(task.workspace)`
   - Workspace Manager checks: worktree directory exists? Branch ref exists? Expected commit SHA reachable?
   - `⟹ workspace.verified` { task_id, status, current_commit, recovery_action }

4. **Workspace verification outcomes:**

   4a. `[status: "valid"]` Worktree intact, branch at expected commit. No action needed. Continue to step 5.

   4b. `[status: "recoverable"]` Worktree missing but branch exists (common after crash -- process died but branch persists).
   - **Workspace Manager** recreates worktree from branch: `git worktree add {path} {branch}`
   - `⟹ workspace.created` { task_id, repo, branch, worktree_path }
   - Continue to step 5.

   4c. `[status: "lost"]` Branch deleted or force-pushed over. Workspace is unrecoverable.
   - `⟹ workspace.verified` { status: "lost" }
   - **Daemon** transitions task to Failed: `→ TaskEngine.requestTransition(task_id, "Failed", reason: "workspace_lost")`
   - `⟹ task.state_changed` { to_state: "Failed", reason: "workspace_lost" }
   - **Comm Plugin** notifies human: "Task X's branch was lost. Cannot resume."
   - Done (task cannot continue).

5. **Daemon** assembles Dispatch package (same structure as P3 step 5):
   - `task`: full Task object from Task Engine
   - `resume_from`: latest checkpoint from `→ SessionMemory.getLatestCheckpoint(task_id)`
   - `knowledge.repo`: from `→ SessionMemory.queryKnowledge(scope: "repo", repo_scope: task.repo)`
   - `knowledge.user`: from `→ SessionMemory.queryKnowledge(scope: "user")`

6. **Daemon** hands Dispatch to Orchestrator

7. **Orchestrator** receives Dispatch and detects `resume_from` is not null:
   - Creates new Session linked to previous: `→ SessionMemory.createSession(task_id, previous_session_id)`
   - Sets `session.resumed_from_checkpoint` to the checkpoint ID

8. **Orchestrator** performs context reconstruction from checkpoint:
   - Reads `checkpoint.context_summary` -- seeds the new LLM context window
   - Injects `checkpoint.key_findings` as known facts
   - Injects `checkpoint.open_questions` as active threads
   - Reads `checkpoint.next_action` -- the immediate next step
   - Optionally scans journal entries after `checkpoint.journal_offset` for additional context
   - Reads `checkpoint.phase` to determine which phase to resume in

9. **Orchestrator** cross-checks workspace state against checkpoint:
   - Compares `workspace.current_commit` with `checkpoint.workspace_ref.last_commit`
   - `[match]` Workspace exactly where checkpoint expected. Resume cleanly.
   - `[diverged]` Commits exist beyond the checkpoint (possible if crash happened after a commit but before checkpoint was persisted). Orchestrator reviews delta commits (`git log`) to understand what work happened post-checkpoint. Incorporates findings into context.

10. **Orchestrator** logs journal entry: `→ SessionMemory.appendJournal(session_id, { type: "phase_change", summary: "Resumed from checkpoint in {phase} phase. Previous session ended due to {end_reason}." })`

11. **Orchestrator** enters the phase pipeline at `checkpoint.phase`:
    - If `checkpoint.next_action` describes remaining work in current phase -- continues within phase
    - If `checkpoint.phase_progress` indicates phase was nearly complete -- may complete phase and transition to next (via P4)
    - Orchestrator uses judgment to decide whether to redo any work or continue forward

#### Crash Recovery Variant

When the Daemon detects orphaned Active.Working tasks at startup (P1 step 7):

- **Daemon** transitions orphaned task to Queued: `→ TaskEngine.requestTransition(task_id, "Queued", reason: "crash_recovery")`
- Task enters normal priority queue and is dispatched via P3/P9 when its turn comes
- `[no checkpoint exists]` Task is dispatched as new (resume_from is null, follows P3 new-task path). Work since creation is lost, but the branch may have commits that provide partial context for the Orchestrator.
- `[checkpoint from earlier phase]` Some work is lost between checkpoint and crash. The Orchestrator acknowledges this in its journal and may need to redo work. Branch commits help bridge the gap.

#### Success Outcome

Orchestrator is executing at the correct phase with reconstructed context. Workspace is verified. New session is linked to the previous one. Knowledge is loaded (may include new entries from other tasks since last session).

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 3/4c | Workspace lost (branch deleted) | Task transitions to Failed. Human notified. Cannot resume without the branch. |
| 5 | Checkpoint data corrupted or missing | Treat as crash with no checkpoint -- restart task from beginning with existing branch as context. |
| 7 | Session creation fails | Critical error. Orchestrator retries. If persistent: task transitions to Failed. |
| 8 | Context reconstruction produces incoherent context | Orchestrator detects quality issue. Falls back to minimal context from just `next_action` and workspace state (branch commits). Logs degraded resume. |

#### Notes

- **Context reconstruction, not replay.** The checkpoint's `context_summary` is written to be self-sufficient. A fresh LLM context seeded with this summary can continue work effectively. Summary quality at checkpoint time determines resume quality.
- **Branch commits as safety net.** Even if the checkpoint narrative is imperfect, the branch's git history provides concrete evidence of what was done. The Orchestrator can `git log` and `git diff` to reconstruct context from the code itself.
- **Session chain for full history.** The new session links to the previous via `previous_session_id`. To understand full task history: follow the chain backward.
- **Knowledge may have changed.** Between preemption and resume, other tasks may have stored new knowledge. The dispatch package includes the latest, which may differ from the previous session.
- **Connects to P3** (Task Dispatch -- resume follows the same dispatch structure), **P8** (Preemption -- post-preemption is the most common resume trigger), **P4** (Phase Transition -- Orchestrator re-enters the phase pipeline), **P1** (System Startup -- crash recovery).

---

### P10: Cost Tracking & Enforcement

**Trigger:** Orchestrator completes an LLM call or other billable operation.
**Outcome:** Cost is recorded, accumulators updated, and (if limit breached) task is blocked and human is notified.

**Participants:**

| Component | Role |
|-----------|------|
| Orchestrator | Emits cost event after every billable operation |
| Event Bus | Routes cost event to subscribers |
| Task Engine | Updates per-task cost fields |
| Safety Layer | Updates ephemeral cost accumulators, checks limits, emits limit_reached if breached |
| Daemon | Receives limit_reached, transitions affected task(s) to Blocked |
| Comm Plugin | Sends cost alert to owner |

**Preconditions:**
- System startup complete (P1), including Safety Layer cost accumulator reconstruction from event replay
- Orchestrator is executing a task (Active.Working or Active.Integrating)

#### Steps

**Normal Flow (within limits):**

1. **Orchestrator** completes an LLM call via `Contract: LLMProvider.complete(request)`
   - LLM provider returns `CompletionResult` including `usage` data (tokens_in, tokens_out, spend_usd for API; usage_units, remaining for CLI)
   - Usage reporting is contractual -- every `CompletionResult` MUST include it (see plugin-contracts.md § LLM Provider)

2. **Orchestrator** emits: `⟹ cost.incurred` { task_id, repo, provider_id, provider_type, operation, tokens_in, tokens_out, spend_usd (API) or usage_units/remaining (CLI) }
   - One event per billable operation. Not batched.

3. **Event Bus** delivers `cost.incurred` to subscribers (async, at-least-once):

4. **Task Engine** receives `cost.incurred`:
   - Updates `task.cost` fields: increments `llm_tokens`, `llm_cost_usd`, `compute_time_ms`
   - Per-task cost visibility on the Task object

5. **Safety Layer** receives `cost.incurred`:
   - Updates ephemeral cost accumulators:
     - For API providers: `api_spend.per_task[task_id] += spend_usd`, `api_spend.daily += spend_usd`, `api_spend.monthly += spend_usd`
     - For CLI providers: `cli_usage[provider_id].requests_used += 1`, `cli_usage[provider_id].tokens_used += usage_units`
     - If `remaining` reported: updates `cli_usage[provider_id].last_known_remaining`
     - If `resets_at` reported: updates `cli_usage[provider_id].last_known_reset`

6. **Safety Layer** checks accumulators against configured limits:
   - For API: compares each accumulator against `cost_limits.api.{per_task, daily, monthly}`
   - For CLI: compares usage against `cost_limits.cli[provider_id].{daily_requests, daily_tokens}`
   - Also checks if CLI provider reported `remaining: 0` (provider-imposed exhaustion)
   - `[all within limits]` No further action. Normal flow. Done.
   - `[limit breached]` Continue to step 7.

**Limit Breach Flow:**

7. **Safety Layer** identifies the breach:
   - Determines: limit_type (`per_task` | `per_repo` | `daily_global` | `monthly_global`), current_spend, limit_value, resets_at
   - `⟹ cost.limit_reached` { task_id (null if global), limit_type, limit_scope, current_spend, limit_value, provider_type, resets_at }

8. **Daemon** receives `cost.limit_reached`:
   - Determines affected task(s):
     - `per_task` limit: only the specific task
     - `per_repo` limit: all active tasks in that repo
     - `daily_global` or `monthly_global`: ALL Active.Working and Active.Integrating tasks

9. **Daemon** signals the Orchestrator to checkpoint and stop (routes `cost.limit_reached` to the active Orchestrator)

10. **Orchestrator** receives `cost.limit_reached`:
    - Finishes current atomic operation (same concept as preemption -- complete the in-flight operation)
    - Creates checkpoint: `→ SessionMemory.createCheckpoint(session_id, { reason: "cost_limit", phase, context_summary, key_findings, open_questions, next_action })`
    - Logs journal entry: `→ SessionMemory.appendJournal(session_id, { type: "error", summary: "Cost limit reached: {limit_type}. Stopping." })`
    - Ends session: `→ SessionMemory.endSession(session_id, reason: "cost_limit")`

11. **Daemon** transitions affected task(s): `→ TaskEngine.requestTransition(task_id, "Blocked", reason: "cost_limit_reached")`
    - `⟹ task.state_changed` { to_state: "Blocked", reason: "cost_limit_reached" }
    - Task's `blocked` details: { reason: "Cost limit reached", needed: "Budget increase or limit reset", waiting_for: "owner" }
    - Working slot(s) freed

12. **Comm Plugin** receives `cost.limit_reached` (subscriber):
    - Sends cost alert to task owner (from `task.team`):
      - Which limit was hit
      - Current spend vs. configured limit
      - When it resets (for time-based limits)
      - How to resolve (increase budget, wait for reset, or manually unblock)

**Unblocking Flow:**

13. `[human increases budget]`
    - Human updates cost configuration (config file change or command)
    - **Safety Layer** detects config change (hot-reload): reloads `cost_limits`, re-evaluates accumulators
    - Human explicitly unblocks task (via comm channel: "unblock #47" or "resume #47")
    - **Daemon** routes the message → `→ TaskEngine.requestTransition(task_id, "Queued", reason: "cost_limit_resolved")`
    - Task resumes via **P9** (Task Resume)

14. `[human explicitly unblocks without changing budget]`
    - Same as step 13 but with original budget. Task may hit the limit again quickly -- human's choice.

**Time-Based Reset Flow:**

15. `[time-based limit window expires (daily/monthly)]`
    - **Safety Layer** resets accumulators for the expired window (checked on next `cost.incurred` event or at startup)
    - **Safety Layer** checks the limit's `auto_resume_on_reset` configuration:
      - `[auto_resume_on_reset: true]` Safety Layer emits an internal event. Daemon transitions affected tasks: Blocked → Queued. Tasks resume via P9.
      - `[auto_resume_on_reset: false (default)]` Task stays Blocked. **Comm Plugin** notifies human: "Daily cost limit has reset. Task #47 can be unblocked."
      - Human explicitly unblocks when ready (step 13).

**Proactive Cost Check (optional):**

16. **Orchestrator** can proactively check cost status before expensive operations:
    - `→ SafetyLayer.evaluate({ type: "cost_check", context: { task_id, repo } })`
    - Returns verdict with warnings: `{ allowed: true, warnings: ["task at 72% of per-task limit"] }`
    - Orchestrator may adjust behavior: use smaller models, batch operations, reduce exploration depth
    - This is optional proactive behavior, not a required gate in the pipeline

#### Success Outcome (normal flow)

Cost recorded on task and in Safety Layer accumulators. All within limits. Operation continues.

#### Success Outcome (limit breach)

Affected task(s) checkpointed, transitioned to Blocked, human notified with actionable information. No further cost incurred on blocked task(s). Task resumes when human increases budget, explicitly unblocks, or (if configured) limit resets automatically.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 2 | Cost event emission fails | Cost under-counted. Safety Layer accumulators drift below actual spend. Log warning. |
| 4 | Task Engine fails to update cost field | Per-task cost display stale. Non-critical -- Safety Layer is the enforcement authority. |
| 5 | Safety Layer fails to process cost event | May under-count. If limit is actually exceeded but not detected, spend continues. Log critical warning -- degraded safety. |
| 10 | Orchestrator fails to checkpoint before blocking | Work since last checkpoint lost when task resumes. Cost enforcement takes priority over work preservation. |
| 12 | Comm Plugin fails to send alert | Human not notified. Daemon retries. Task is still safely blocked. |

#### Notes

- **Cost limit = stop.** No graduated wind-down, no warning thresholds that reduce permissions. When the limit is hit, stop. Simple, predictable, safe.
- **Accumulators are ephemeral.** On system restart, Safety Layer replays `cost.incurred` events from Event Bus within relevant time windows (P1 step 4). The Event Bus is the durable store.
- **Two provider models coexist.** CLI (subscription caps) and API (dollar budgets) flow through the same `cost.incurred` event and accumulator pipeline. Different cost semantics, shared tracking infrastructure.
- **CLI provider self-reporting.** When a CLI tool reports rate limiting (`remaining: 0`), the Safety Layer treats this as a limit breach even if configured caps weren't reached -- the provider itself has stopped serving.
- **Global limits affect all tasks.** A `daily_global` breach blocks ALL Active.Working and Active.Integrating tasks, not just the triggering task.
- **auto_resume_on_reset is per-limit (Decision #49).** Default: false (human must explicitly unblock). Configurable: users who want overnight autonomy can opt in per limit type.
- **Connects to P7** (Action Pipeline -- cost_check queries during Gate 2), **P8** (Preemption -- checkpoint-then-block mirrors checkpoint-then-yield), **P9** (Task Resume -- blocked tasks resume after unblocking), **P1** (System Startup -- accumulator reconstruction).

---

## 3. Communication Protocols

How the system communicates with humans -- blocking interactions, question management, notifications, and status queries.

---

### P11: Blocking & Human Interaction

**Trigger:** The system needs human input to proceed (Safety Layer `ask_human` verdict, merge conflict needing guidance, or ambiguous requirements).
**Outcome:** Task is Blocked with structured details, human is notified on the appropriate channel, and (when response arrives or timeout fires) task is unblocked and resumes.

**Participants:**

| Component | Role |
|-----------|------|
| Orchestrator | Decides human input is needed, formats question, processes response |
| Safety Layer | Produces `ask_human` verdict (autonomy evaluation), owns timeout policy |
| Task Engine | Transitions task state (Active.Working ↔ Blocked ↔ Queued) |
| Daemon | Routes inbound messages, executes timeout timers, transitions on unblock |
| Comm Plugin | Sends question, delivers response, sends reminders/alerts |
| People Directory | Resolves who to contact and on which channel |

**Preconditions:**
- Task is Active.Working or Active.Integrating
- Orchestrator has identified a need for human input (autonomy check, ambiguity, conflict guidance)

#### Steps

**Entering Blocked State:**

1. **Orchestrator** identifies need for human input. Source is one of:
   - Safety Layer verdict `ask_human` from Gate 2 (see P7 step 7)
   - Ambiguous requirements discovered during intake-analysis or research
   - Merge conflict the Orchestrator cannot resolve (see P6 step 10)
   - Cascade failure requiring human decision (see task-engine.md § Cascade Failure)
2. **Orchestrator** formats the question with context: what it needs, why it needs it, and options if applicable
3. **Orchestrator** adds question to batch (see P12 for batching mechanics)
   - `[if batch window active]` Question queued, Orchestrator continues other work within current phase if possible
   - `[if no other work possible or blocking urgency]` Batch flushes immediately
4. **Orchestrator** requests state transition: `→ TaskEngine.requestTransition(task_id, "Blocked", reason: "awaiting_human_input")`
   - Task Engine populates `task.blocked`: `{ reason, efforts_made, needed, waiting_for: person_id }`
   - `⟹ task.state_changed` { to_state: "Blocked", reason: "awaiting_human_input" }
   - Working slot freed
5. **Orchestrator** resolves contact: `→ PeopleDirectory.resolveContact(task.team[role: "owner"], preferred_channel)`
6. **Orchestrator** sends question batch via `Contract: CommPlugin.sendMessage(target, message)` (see P12 for format)
   - Records `message_id` from `SendResult` for reply threading
   - `⟹ comm.message_sent` { type: "question", task_id }
7. **Daemon** receives `task.state_changed` (to Blocked) → starts timeout timer:
   - Queries `→ SafetyLayer.getTimeoutPolicy()` for current thresholds
   - Schedules: reminder at `blocked.stages[0].after`, self_unblock_check at `blocked.stages[1].after`, alert at `blocked.stages[2].after`

**Human Response Path:**

8. **Comm Plugin** receives human reply → `⟹ comm.message_received` { sender, content, reply_to?, task_id? }
9. **Daemon** receives `comm.message_received`:
   - Checks: is there a task Blocked with `waiting_for` matching this sender?
   - `[yes]` Routes as task response (not a query). Continue to step 10.
   - `[no pending question]` Routes to query handler (see P14)
   - `[ambiguous]` Daemon asks: "Is this a reply to my question about #{task_id}, or a new request?" via `Contract: CommPlugin.sendMessage()`
10. **Daemon** forwards response to Orchestrator (routes the `comm.message_received` event)
11. **Orchestrator** processes the response:
    - Parses response against original questions (see P12 for response parsing)
    - `[full response]` All questions answered. Continue to step 12.
    - `[partial response]` Some questions answered, others remain. Orchestrator processes answered questions, reformulates unanswered ones, sends follow-up (returns to step 6 with remaining questions)
12. **Orchestrator** applies the human's answer to its working context:
    - Logs journal entry: `→ SessionMemory.appendJournal(session_id, { type: "decision", summary: "Human decided: {answer}", detail: question_and_response })`
    - `[if action was deferred by ask_human]` Re-enters Action Pipeline at Gate 2 with updated context (see P7 step 5)
13. **Daemon** cancels timeout timers for this task
14. **Daemon** transitions task: `→ TaskEngine.requestTransition(task_id, "Queued", reason: "unblocked")`
    - `⟹ task.state_changed` { from_state: "Blocked", to_state: "Queued", reason: "unblocked" }
15. **Daemon** dispatches task via P3 (or P9 if checkpoint exists) when working slot is available

**Timeout Ladder (if human does not respond):**

16. `[reminder threshold reached]` **Daemon** emits: `⟹ timeout.reminder` { task_id, blocked_since, elapsed, channel, question_summary } (see event-catalog § timeout.reminder)
    - **Comm Plugin** receives event → sends reminder to human on original channel
    - `[if repeat configured]` Daemon schedules next reminder at `repeat_interval`

17. `[self_unblock_check threshold reached]` **Daemon** emits: `⟹ timeout.self_unblock_check` { task_id, decision_category, can_self_unblock }
    - **Daemon** determines `can_self_unblock` by querying: `→ SafetyLayer.evaluate({ type: "should_i_ask", context: { decision_category } })`
    - `[category is always_ask]` `can_self_unblock: false`. Orchestrator receives event, takes no action. Reminders continue.
    - `[category is threshold or always_decide]` `can_self_unblock: true`. Continue to step 18.

18. `[self-unblock allowed]` **Orchestrator** receives `timeout.self_unblock_check` with `can_self_unblock: true`:
    - Evaluates whether a reasonable default answer exists
    - `[reasonable default exists]` Applies default. Sends notification: "Going with {choice} for #{task_id}. Override if you'd prefer otherwise." via `Contract: CommPlugin.sendMessage()`
    - Logs journal entry: `→ SessionMemory.appendJournal(session_id, { type: "decision", summary: "Self-unblocked: {choice}", detail: "No human response after {elapsed}. Applied default." })`
    - Flow continues at step 13 (cancel timers, unblock)
    - `[no reasonable default]` Stays blocked. Reminders continue.

19. `[alert threshold reached]` **Daemon** emits: `⟹ timeout.alert` { task_id, blocked_since, elapsed, escalation: "all_channels_notified" }
    - **Comm Plugin** receives event → sends alert to ALL configured channels for the task owner
    - Task remains Blocked. Alert is informational escalation, not automatic resolution.

#### Success Outcome

Human response received and applied, task unblocked and re-queued for dispatch. Or: self-unblocked with default answer and human notified of the choice.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 4 | State transition rejected (task no longer Active) | Race condition with preemption or cost limit. Orchestrator defers question -- it will be asked when task resumes. |
| 6 | Comm plugin fails to send question | Daemon retries via alternative channel (if available). Task remains Blocked. Human not notified -- timeout ladder will eventually escalate. |
| 9 | Disambiguation fails (ambiguous message) | Daemon asks clarifying question. If repeated ambiguity: treat as query (safer default). |
| 11 | Response parsing fails (unintelligible answer) | Orchestrator asks for clarification: "I didn't understand your response to question 2. Could you clarify?" Returns to step 6. |
| 18 | Self-unblock produces bad result | Human can override via message at any time. Override triggers re-block and new question flow. |

#### Notes

- **Review-Pending is NOT Blocked.** PR feedback goes through `task.feedback_received` (see event-catalog § task.feedback_received), not the blocking flow. Review-Pending frees the agent the same way Blocked does, but the resolution path is different (PR review, not question/answer).
- **Cost limit blocking follows P10.** The cost limit flow (P10 steps 7-15) transitions to Blocked independently. This protocol handles the general "need human input" case. Cost-blocked tasks do not go through the timeout ladder -- they resolve when budget changes or resets.
- **Multiple blocked tasks.** Each task has its own `waiting_for` and timeout timers. A human can have multiple tasks waiting for them. The Daemon tracks all independently.
- **Connects to P7** (Action Pipeline -- `ask_human` verdict triggers step 1), **P10** (Cost -- cost limit enters Blocked via a different path), **P12** (Question Batching -- step 3), **P9** (Resume -- step 15), **P3** (Dispatch -- step 15).

---

### P12: Question Batching & Response Parsing

**Trigger:** Orchestrator encounters one or more questions that require human input during a single work period.
**Outcome:** Questions are batched into a single numbered message, sent to human, and responses are parsed back to their original questions.

**Participants:**

| Component | Role |
|-----------|------|
| Orchestrator | Accumulates questions, formats batch, parses responses |
| Comm Plugin | Sends formatted batch, delivers human response |
| Daemon | Routes inbound response to Orchestrator |

**Preconditions:**
- Orchestrator is executing a task (Active.Working or Active.Integrating)
- At least one question has been identified (from autonomy check, ambiguity, or decision point)

#### Steps

**Accumulation Phase:**

1. **Orchestrator** encounters a question during work. Creates a question record:
   - `question_id`: unique identifier within this batch
   - `question`: human-readable question text
   - `options`: structured options if applicable (e.g., "(A) option one or (B) option two")
   - `category`: autonomy category (e.g., "architectural", "refactoring")
   - `urgency`: "blocking" (cannot continue without answer) or "informational" (can continue, answer improves quality)
   - `context`: why the question arose (brief explanation)
2. **Orchestrator** checks batch state:
   - `[no active batch]` Creates new batch, starts batch window timer (default: 30 seconds, configurable via `question_batching.batch_window`)
   - `[active batch, under max_batch_size]` Adds question to current batch
   - `[active batch, at max_batch_size]` Flushes current batch immediately (step 4), starts new batch

**Flush Triggers:**

3. Batch is flushed (sent to human) when any of:
   - Batch window timer expires (30 seconds since first question in batch)
   - Orchestrator reaches a point where ALL remaining work requires at least one answer (`urgency: "blocking"` and no parallelizable work)
   - Batch reaches `max_batch_size` (default: 5)
   - Orchestrator is about to transition to Blocked state (flush before blocking)

**Formatting & Sending:**

4. **Orchestrator** formats the batch as a numbered message:
   ```
   Questions on #{task_id} ({task_title}):

   1. {question_1} {options_1}
   2. {question_2} {options_2}
   3. {question_3}

   Reply with numbers, e.g., '1:A 2:B 3:your answer'
   ```
   - Each question gets a sequential number
   - Options are labeled (A), (B), (C) when applicable
   - Reply format hint included at the end
5. **Orchestrator** sends via `Contract: CommPlugin.sendMessage(target, formatted_message)` (see P11 step 5-6 for target resolution)
   - Records: `batch_id`, `message_id` (from SendResult), mapping of `question_number → question_id`
6. **Orchestrator** enters blocking flow (P11 step 4) if all remaining work depends on answers

**Response Parsing (Decision #51 -- LLM fallback):**

7. **Daemon** routes human response to Orchestrator (see P11 steps 8-10)
8. **Orchestrator** parses the response against the batch mapping. Two parsing modes:

   8a. **Structured parsing** (tried first): Response contains number references (e.g., "1:A 2:B 3:batch them in groups of 5")
   - Match each `N:answer` to `question_number → question_id`
   - Extract the answer portion after the colon/number

   8b. **Natural language fallback** (if structured parsing fails): Response is unstructured (e.g., "Go with the first option for the JWT format, use shorter expiry, and batch the endpoints")
   - Orchestrator uses LLM to map natural language responses to original questions
   - Each question resolved with confidence: "high" (clear match), "low" (ambiguous)
   - `[any low confidence]` Orchestrator asks for clarification on specific questions

**Partial Response Handling:**

9. **Orchestrator** evaluates completeness:
   - `[all questions answered]` Applies all answers (P11 step 12). Done.
   - `[some questions answered]` Applies answered questions immediately. For unanswered questions:
     - `[unanswered are informational]` Orchestrator proceeds without them, makes own judgment
     - `[unanswered are blocking]` Reformulates only unanswered questions as a follow-up batch. Sends follow-up: "Thanks! Still need answers on: ..." with only the remaining questions re-numbered.

#### Success Outcome

All blocking questions answered, answers mapped back to original question contexts, Orchestrator can proceed.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 4 | Formatted message too long for platform | Split into multiple messages with continuation markers ("Questions 1-3 of 7:"). Track as single logical batch. |
| 5 | Send fails | Retry via alternative channel. If no channel works, task stays Blocked, timeout ladder handles escalation (P11). |
| 8 | Response completely unparseable | Orchestrator asks: "I couldn't match your response to my questions. Could you reply using numbers? e.g., '1:A 2:B'" |
| 8b | LLM unavailable for natural language parsing | Fall back to structured-only parsing. If response is unstructured, ask human to use numbered format. |

#### Notes

- **Batching is Orchestrator-internal.** The batch window, accumulation, and parsing all happen within the Orchestrator's execution. The Daemon and comm plugins see a single outbound message and a single inbound response.
- **Informational questions may not block.** If the Orchestrator can continue working while waiting for non-blocking answers, it does. Only when all remaining work depends on answers does the task transition to Blocked.
- **Single-question batches are fine.** If only one question arises and the batch window expires or blocking is immediate, a batch of 1 is sent. The numbered format is still used for consistency ("1. {question}").
- **Thread-awareness.** The `message_id` from `SendResult` enables reply threading on platforms that support it (Telegram reply-to, GitHub comment threads). The Daemon uses `reply_to` in `comm.message_received` to correlate responses.
- **LLM fallback for natural language (Decision #51).** Real engineers don't force rigid formats on their teammates. Structured parsing is tried first (cheap, fast). LLM is used only when structured parsing fails. This is the only LLM usage in the communication path -- the Daemon query handler (P14) stays LLM-free.
- **Connects to P11** (Blocking -- this protocol handles the question mechanics within the blocking flow), **P7** (Action Pipeline -- `ask_human` verdict produces questions).

---

### P13: Notification Delivery

**Trigger:** A milestone event occurs, a scheduled digest fires, or an alert condition is detected.
**Outcome:** The right people receive the right notification on the right channel, respecting quiet hours and noise prevention rules.

**Participants:**

| Component | Role |
|-----------|------|
| Orchestrator | Decides what to notify about, composes content, applies noise prevention |
| Daemon | Emits health alerts, handles digest scheduling |
| People Directory | Resolves recipients, provides notification preferences and quiet hours |
| Comm Plugin | Formats for platform and sends |
| Comm Plugin (GitHub) | Specialized: label sync, issue comments, checklist updates |
| Event Bus | Delivers state change events to notification subscribers |

**Preconditions:**
- System startup complete (P1)
- At least one comm plugin registered and healthy

#### Steps

**Milestone Notification Path (primary):**

1. **Orchestrator** reaches a milestone during task execution. Milestone events:
   - Task pickup (entered Active.Working for the first time)
   - Draft PR ready (demo-prep phase complete, PR opened as Draft)
   - PR marked Ready (code review stage entered)
   - Task completed (PR merged, task done)
   - Child completed (sub-task finished)
   - Self-unblocked (applied default answer -- see P11 step 18)
   - Cascade failure (child failed, parent needs decision)

2. **Orchestrator** composes notification content:
   - Uses milestone-specific message template (see orchestrator.md § Milestone-Based Notifications)
   - Includes task reference (#{task_id}), PR reference if applicable, one-line summary
   - `[fast-path task]` Collapses all milestones into single combined notification: "Fixed {summary} (#{task_id}). PR #{pr} is ready for review."

3. **Orchestrator** applies noise prevention rules:
   - **Dedup check**: Was a notification for this task+type sent within `dedup_window` (default: 5 min)? `[yes]` Suppress. `[no]` Continue.
   - **Batching check**: Is this notification low-urgency? `[yes]` Add to batch buffer, wait `batch_window` (default: 2 min) for more. `[no]` Send immediately.

4. **Orchestrator** resolves recipients from `task.team[]`:
   - `→ PeopleDirectory.getPerson(person_id)` for each team member
   - Filters by `preferences.notification_level`:
     - `"all"`: receives all milestones
     - `"milestones"`: receives milestones but not intermediate updates
     - `"critical"`: receives only alerts and blockers

5. **Orchestrator** checks quiet hours for each recipient:
   - `→ PeopleDirectory.getPerson(person_id).preferences.quiet_hours`
   - `[within quiet hours AND notification is not "alert"]` Queue for delivery after quiet hours end
   - `[within quiet hours AND notification is "alert"]` Deliver immediately (alerts bypass quiet hours)
   - `[outside quiet hours]` Deliver immediately

6. **Orchestrator** resolves channel for each recipient:
   - `→ PeopleDirectory.resolveContact(person_id, channel)` -- uses preferred channel
   - Sends via `Contract: CommPlugin.sendMessage(target, message)` with appropriate `MessageType`
   - `⟹ comm.message_sent` { type: "milestone" | "notification" | "alert" }

**GitHub State Sync Path (parallel, event-driven):**

7. **Comm Plugin (GitHub)** receives `task.state_changed` event (Event Bus subscription):
   - Updates label: removes old `engineer:{old_state}`, adds `engineer:{new_state}` via `Contract: GitHubCommPlugin.updateIssue(repo, issue_number, { labels_add, labels_remove })`
   - `[if milestone event]` Adds issue comment with milestone text via `Contract: GitHubCommPlugin.commentOnIssue(repo, issue_number, comment)`
   - `[if child completed]` Updates parent issue checklist: checks off completed child via `Contract: GitHubCommPlugin.updateIssue(parent_repo, parent_issue, { body: updated_checklist })`

**Digest Path (scheduled):**

8. `[if digest configured]` **Daemon** triggers digest on schedule (cron-like, from `notification.digest.schedule`):
   - Queries Task Engine for all non-terminal tasks
   - Queries Safety Layer for cost summary: `→ SafetyLayer.getCostStatus()`
   - Composes digest using template (progress, blockers, upcoming, costs)
   - Sends via comm plugin on configured digest channel

**Health Alert Path:**

9. **Daemon** detects health anomaly (stuck detection, trigger failure):
   - `⟹ health.stuck_detected` or `⟹ health.trigger_failure`
   - **Comm Plugin** receives event (subscriber) → sends alert to owner
   - Alert type: `MessageType: "alert"` -- bypasses quiet hours, goes to all channels

#### Success Outcome

Notification delivered to the right people on the right channels. GitHub state reflects internal state. Noise prevention rules applied. Quiet hours respected.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 6 | Primary comm plugin fails to send | Try alternative channel for the same recipient (if configured). If all channels fail: log error, notification lost (non-critical -- task state is unaffected). |
| 7 | GitHub API failure (label/comment) | GitHub comm plugin retries with backoff. State sync is best-effort -- internal state is authoritative. |
| 8 | Digest data query fails | Send partial digest with available data. Include note: "Some data unavailable." |

#### Notes

- **Orchestrator decides, comm plugin delivers.** The Orchestrator owns all notification intelligence (what, when, who). The comm plugin is dumb transport. Swapping Telegram for Slack changes nothing about notification logic.
- **GitHub sync is independent.** Label and comment updates happen via Event Bus subscription, not Orchestrator-directed. The GitHub comm plugin autonomously keeps GitHub in sync with internal state. This is a different path from direct notifications.
- **No notification for phase transitions.** Phases are Orchestrator-internal. Humans care about milestones (PR ready, task done), not internal phases (entered "planning").
- **Fast-path collapse is critical.** A trivial task that completes in 5 minutes should not generate 3 separate notifications. The single combined message is the right behavior.
- **Connects to P11** (Blocking -- blocked notification is the question itself), **P14** (Status Query -- human can always query instead of waiting for notifications), **P1** (Startup -- notification system must be ready before triggers start).

---

### P14: Status Query

**Trigger:** Human sends a message recognized as a status query (not a response to a pending question).
**Outcome:** Human receives a structured, informative response composed from Task Engine, Session/Memory, and Safety Layer data.

**Participants:**

| Component | Role |
|-----------|------|
| Comm Plugin | Receives inbound message, sends response |
| Daemon | Receives `comm.message_received`, disambiguates, parses query, composes response |
| Task Engine | Provides task state data |
| Session/Memory | Provides journal entries, decision history |
| Safety Layer | Provides cost status |
| People Directory | Identifies sender |

**Preconditions:**
- System startup complete (P1)
- At least one comm plugin with "receive" capability is registered and listening

#### Steps

**Inbound & Disambiguation:**

1. **Comm Plugin** receives human message → `⟹ comm.message_received` { source, sender, content, reply_to?, platform_metadata }
2. **Daemon** receives `comm.message_received` event
3. **Daemon** disambiguates: query or task response?
   - Checks: is there a task Blocked with `waiting_for` matching sender? (queries `→ TaskEngine.getBlockedTasksForPerson(sender)`)
   - `[yes, one task blocked for sender]` Routes as task response to Orchestrator (see P11 step 10). Done (not a query).
   - `[yes, multiple tasks blocked for sender]` Checks `reply_to` field for message threading. If match found, routes to specific task. If no match: asks "Which task is this for? I have questions pending on #{id1} and #{id2}."
   - `[no blocked tasks for sender]` Treat as query. Continue to step 4.
   - `[ambiguous -- could be either]` Daemon asks: "Is this a reply to my question about #{task_id}, or a new request?" via `Contract: CommPlugin.sendMessage()`. Waits for clarification.

**Query Parsing:**

4. **Daemon** parses query intent using keyword matching (no LLM):
   - `"status"`, `"what are you doing"`, `"what's happening"` → query_type: `status_overview`
   - `"progress on #N"`, `"how's #N"`, `"update on #N"` → query_type: `task_progress`, task_id: N
   - `"why did you decide"`, `"why did you choose"` → query_type: `decision_reasoning`
   - `"what errors"`, `"any blockers"`, `"any problems"` → query_type: `error_blockers`
   - `"cost"`, `"how much"`, `"spending"`, `"budget"` → query_type: `cost_status`
   - `[no match]` query_type: `unrecognized`

**Data Retrieval:**

5. **Daemon** queries appropriate data source(s) based on query_type:

   5a. `status_overview`:
   - `→ TaskEngine.getTasksByState()` for all non-terminal tasks
   - Returns: Active tasks (with phase), Blocked tasks (with reason), Review-Pending tasks (with PR number), Queued tasks (count)

   5b. `task_progress`:
   - `→ TaskEngine.getTask(task_id)` for state, phase, cost, timestamps
   - `→ SessionMemory.queryJournal(task_id, { limit: recent_entries })` for latest activity
   - Returns: current state, phase, recent journal entries, time active

   5c. `decision_reasoning`:
   - `→ SessionMemory.queryJournal(task_id, { type: "decision" })` for all decision entries
   - Returns: decision entries with rationale and alternatives considered

   5d. `error_blockers`:
   - `→ TaskEngine.getTasksByState("Blocked")` for blocked tasks
   - `→ SessionMemory.queryJournal(task_id, { type: "error" })` for recent errors
   - Returns: blocked tasks with reasons, recent errors with context

   5e. `cost_status`:
   - `→ SafetyLayer.getCostStatus()` for aggregate cost data
   - Returns: per-task costs, daily/monthly spend, limit utilization percentages

**Response Composition:**

6. **Daemon** composes response using structured templates (no LLM):
   - Templates are per-query-type, filling in data from step 5
   - Example (`status_overview`):
     ```
     Currently working on 1 task:
       #47 (dark mode toggle) -- Active, execution phase. ~60% through.

     1 task in review:
       #42 (API refactor) -- PR #51 waiting for code review (2 hours).

     2 tasks queued.
     No blockers.
     ```
   - Progress is described informally -- approximate language, not formalized percentages

7. **Daemon** sends response via same comm plugin that received the query:
   - `Contract: CommPlugin.sendMessage(target, formatted_response)` with `MessageType: "status_response"`
   - `⟹ comm.message_sent` { type: "status_response" }

**Unrecognized Query Handling:**

8. `[query_type: unrecognized]` **Daemon** responds with:
   - "I didn't understand that. You can ask me: 'status', 'progress on #N', 'why did you decide X', 'any blockers', or 'cost'."
   - Sends via same comm plugin

#### Success Outcome

Human receives accurate, formatted status response within seconds. No LLM call needed. Orchestrator was not interrupted.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 3 | Sender not recognized in People Directory | Daemon responds anyway (status is not sensitive). Logs unknown sender for visibility. |
| 5 | Data source unavailable (Task Engine, Session/Memory, Safety Layer) | Compose partial response with available data. Include note: "Some data unavailable -- {component} unreachable." |
| 6 | Template rendering fails | Fall back to raw data dump (JSON-like format). Functional but ugly. |
| 7 | Comm plugin fails to send response | Retry once. If persistent: log error. Human sees no response and may retry. |

#### Notes

- **No LLM in the query path.** Status queries are structured data retrieval + template formatting. The Daemon handles this entirely -- fast, cheap, predictable. The Orchestrator is never interrupted for queries.
- **Query handler runs in the Daemon's event loop.** It processes `comm.message_received` events alongside other event processing. This means queries are answered even when the Orchestrator is busy with a task.
- **Progress is approximate.** The Daemon does not report explicit percentages. It infers approximate progress from the current phase and describes it in natural language (e.g., "~60% through", "mid-execution"). Phases vary wildly in duration -- formal percentages would create false precision.
- **Cross-platform consistency.** The same query via Telegram, GitHub comment, or (future) Slack produces the same response content, formatted for the specific platform by the comm plugin's `formatMessage()`.
- **Connects to P11** (Blocking -- disambiguation determines query vs task response), **P13** (Notifications -- queries complement push notifications with pull capability).

---

## 4. Resilience Protocols

How the system recovers from crashes, restarts, and degraded states.

---

### P15: Crash Recovery & System Restart

**Trigger:** System process crashes (Daemon, Orchestrator) or full system restart after shutdown/crash.
**Outcome:** System returns to consistent state, all ephemeral state reconstructed, orphaned tasks recovered, work resumes.

**Participants:**

| Component | Role |
|-----------|------|
| Daemon | Detects crashes, orchestrates recovery, rebuilds ephemeral state |
| Task Engine | Source of truth for task state, identifies orphans |
| Event Bus | Provides event history for state reconstruction |
| Safety Layer | Rebuilds cost accumulators from event replay |
| Session/Memory | Provides checkpoints for task resume |
| Workspace Manager | Verifies workspace integrity |
| Registry | Re-initializes plugins |
| Orchestrator | Resumes recovered tasks from checkpoints |

**Preconditions:**
- Persistent storage (Task Engine, Event Bus, Session/Memory) is accessible
- At least one process is starting (Daemon, or full system)

#### Three Recovery Scenarios

| Scenario | What crashed | Detection | Recovery path |
|----------|-------------|-----------|---------------|
| A: Orchestrator crash | Orchestrator process died while executing a task | Daemon detects missing heartbeat | Daemon restarts Orchestrator, identifies orphaned task, dispatches resume |
| B: Daemon crash | Daemon process died | Self-detected on restart (orphaned Active tasks in Task Engine) | Full startup (P1) with orphan detection |
| C: Full system restart | Everything stopped (clean shutdown or power loss) | Process starts fresh | Full startup (P1) with orphan detection + state reconstruction |

---

**Scenario A: Orchestrator Crash**

1. **Daemon** detects Orchestrator is unresponsive:
   - Heartbeat timeout: Orchestrator has not emitted any event (journal, cost, action) within `heartbeat_timeout` (configurable, default: 120 seconds). Specific heartbeat mechanism is a Layer 4 concern.
   - Or: Orchestrator process exited unexpectedly (OS-level signal)
2. **Daemon** logs crash event: `⟹ health.stuck_detected` { task_id, condition: "orchestrator_crash" }
3. **Daemon** identifies the affected task:
   - Queries `→ TaskEngine.getTasksByState("Active")` with sub_state "Working" or "Integrating"
   - The task that was Active.Working at crash time is the orphan
4. **Daemon** transitions orphaned task: `→ TaskEngine.requestTransition(task_id, "Queued", reason: "crash_recovery")`
   - `⟹ task.state_changed` { to_state: "Queued", reason: "crash_recovery" }
   - Working slot freed
5. **Daemon** restarts Orchestrator process (process-level restart)
6. **Daemon** dispatches the recovered task via P9 (Task Resume):
   - Checkpoint from latest `→ SessionMemory.getLatestCheckpoint(task_id)` seeds resume
   - `[checkpoint exists]` Normal resume flow (P9 steps 1-11)
   - `[no checkpoint]` Task dispatched as new. Work since creation may be lost, but branch commits provide partial context.
7. **Comm Plugin** notifies owner: "Task #{task_id} experienced a crash. Resuming from last checkpoint." (via P13)

---

**Scenario B: Daemon Crash (and restart)**

8. **Daemon** starts fresh -- follows P1 (System Startup) steps 1-9 completely
9. At P1 step 7, **Daemon** detects orphaned tasks during queue reconstruction:
   - `→ TaskEngine.getTasksByState("Active")` returns tasks in Active.Working or Active.Integrating
   - These tasks have no running Orchestrator (it was lost with the Daemon)
   - For each orphaned Active.Working/Active.Integrating task:
     - `→ TaskEngine.requestTransition(task_id, "Queued", reason: "crash_recovery")`
     - `⟹ task.state_changed` { to_state: "Queued", reason: "crash_recovery" }
10. **Daemon** rebuilds all ephemeral state from persistent sources:
    - **Priority queue**: populated from all Queued tasks via Task Engine
    - **Timeout timers**: for each Blocked task, queries `→ SafetyLayer.getTimeoutPolicy()` and calculates elapsed time since `task.blocked` timestamp. Sets timers for remaining thresholds.
    - **Dedup set**: populated from `→ TaskEngine.getAllExternalRefs()` (idempotency keys)
    - **Pending preemption**: reset to null (any in-flight preemption is abandoned -- the preempted task is already safe in Active.Working or Queued)
11. **Safety Layer** rebuilds cost accumulators (P1 step 4):
    - `→ EventBus.replay({ type: "cost.incurred", since: billing_window_start })` for each time window
    - Applies each event to restore accumulator state
12. **Daemon** resumes normal operation:
    - Dispatches highest-priority Queued task (which may be the recovered orphan) via P3/P9
    - Notifies owner of restart: "System restarted. Resuming operations."

---

**Scenario C: Full System Restart (clean or crash)**

13. Same as Scenario B (steps 8-12) -- P1 handles full initialization
14. Additional considerations for clean shutdown vs crash:
    - `[clean shutdown]` **Graceful Shutdown Flow** (see below) ensures all work is checkpointed. On restart, all tasks have fresh checkpoints. Resume quality is high.
    - `[crash/power loss]` No graceful shutdown. Tasks have only their last successful checkpoint (may be from a phase transition or periodic checkpoint). Some work since last checkpoint is lost.
15. **Daemon** evaluates system health after startup:
    - Checks plugin health via `Contract: Plugin.healthCheck()` on all registered plugins
    - `[unhealthy plugins]` Logs warnings. If critical plugins (LLM, primary comm) are unhealthy: block task dispatch until healthy, notify via fallback channel.
    - `[comm plugin recovered from prior outage]` Triggers state reconciliation:
      - `→ TaskEngine.getNonTerminalTasks()` returns current task states
      - `→ GitHubCommPlugin.reconcileState(tasks)` compares internal states against GitHub labels/comments for all active tasks. Fixes mismatches (updates labels, posts catch-up comments). Runs once, idempotently (Decision #58).

---

**Graceful Shutdown Flow:**

16. **Daemon** receives shutdown signal (SIGTERM, user command, or `system.shutdown_initiated`)
17. **Daemon** stops accepting new work:
    - Stops trigger polling
    - Stops scheduling evaluation
18. **Daemon** signals active Orchestrator to checkpoint and stop:
    - Same mechanism as preemption (P8 step 4): Orchestrator finishes current atomic operation, creates checkpoint
    - Orchestrator creates checkpoint: `→ SessionMemory.createCheckpoint(session_id, { reason: "system_shutdown", phase, context_summary, key_findings, open_questions, next_action })`
    - Orchestrator ends session: `→ SessionMemory.endSession(session_id, reason: "system_shutdown")`
    - `[if Orchestrator does not checkpoint within shutdown_timeout (default: 30s, Daemon config -- Decision #52)]` Daemon force-terminates. Work since last checkpoint is lost.
19. **Daemon** transitions active tasks:
    - Active.Working tasks → Queued (reason: "system_shutdown")
    - Active.Supervising tasks remain unchanged (no work to checkpoint)
    - Blocked and Review-Pending tasks remain unchanged
20. **Registry** shuts down plugins in reverse initialization order:
    - `Contract: CommPlugin.stopListening()` on each comm plugin with "receive" capability
    - `Contract: Plugin.shutdown()` on each plugin
21. **Event Bus** flushes pending events, closes persistence
22. **Daemon** exits

#### Key Invariant

**All ephemeral state is reconstructable from persistent stores.** This is the foundational guarantee that makes crash recovery safe:

| Ephemeral state | Reconstructed from |
|----------------|-------------------|
| Scheduling priority queue | Task Engine (all Queued tasks + priority) |
| Timeout timers | Task Engine (Blocked tasks + timestamps) + Safety Layer (timeout policy) |
| Cost accumulators | Event Bus replay (`cost.incurred` events within billing window) |
| Dedup set (seen idempotency keys) | Task Engine (`external_ref` fields on all tasks) |
| Pending preemption | Abandoned on restart (safe -- tasks are in valid states) |
| Working slot count | Task Engine (count of Active.Working + Active.Integrating tasks) |

#### Success Outcome

System returns to consistent operation. All orphaned tasks identified and recovered. Ephemeral state fully reconstructed. No data loss beyond work-in-progress since last checkpoint.

#### Failure Paths

| Step | Failure | Handling |
|------|---------|----------|
| 1 | Heartbeat false positive (Orchestrator alive but slow) | Orchestrator detects it was "recovered" when it's actually still running. Detects via stale session: creates a new session, logs "false crash detection." Daemon detects duplicate Active.Working on next health check. |
| 6/12 | Checkpoint corrupted or missing | Task dispatched as new (P3 path, not P9). Work lost. Branch commits provide partial recovery. |
| 9 | Task Engine inaccessible on restart | Fatal: Daemon cannot recover without task state. Abort startup. Alert via stderr. |
| 11 | Event Bus inaccessible for cost replay | Safety Layer starts with zero accumulators. Cost tracking under-counts until next billing window. Log critical warning. |
| 15 | Critical plugin unhealthy after restart | Daemon blocks task dispatch. Retries health checks on interval. Notifies via fallback channel. |
| 18 | Orchestrator fails to checkpoint during graceful shutdown | Daemon waits up to `shutdown_timeout` (default: 30s). If timeout: force-terminates. Work since last checkpoint is lost. |

#### Notes

- **Daemon is the critical process.** If the Daemon crashes, everything stops. But recovery is fast because all Daemon state is ephemeral and reconstructable. The Daemon stores nothing that isn't derivable from persistent components.
- **Orchestrator crashes are isolated.** The Daemon detects and recovers from Orchestrator crashes without affecting other tasks (Blocked, Review-Pending, Supervising). Only the Active.Working task is affected.
- **Double crash is handled.** If the Orchestrator crashes, then the Daemon crashes before recovery completes, the next Daemon restart detects the same orphan via Task Engine. No special case needed.
- **Graceful shutdown preserves all context.** A clean restart after graceful shutdown loses zero work -- every active task has a fresh checkpoint at exactly the point it stopped.
- **Event Bus replay is bounded.** Cost accumulator replay only needs events within the current billing window (daily, monthly). This keeps replay time proportional to the billing period, not total system lifetime.
- **Heartbeat timeout vs stuck detection.** Heartbeat timeout (120s, process-level crash) is distinct from stuck detection (30 min, logical stuck). Heartbeat detects dead processes; stuck detection identifies processes that are alive but not making progress.
- **shutdown_timeout is Daemon config (Decision #52).** Process lifecycle is Daemon's domain. This config lives alongside `tick_interval`, `preemption_timeout`, etc. -- not in Safety Layer.
- **Connects to P1** (System Startup -- Scenario B/C is P1 with additional orphan recovery), **P9** (Task Resume -- recovered tasks resume via P9), **P8** (Preemption -- graceful shutdown uses the same checkpoint-then-yield pattern), **P10** (Cost -- accumulator reconstruction).
