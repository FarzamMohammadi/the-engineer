# Protocols -- Layer 3

How components coordinate. The step-by-step choreography of every cross-component interaction in the system.

Part of **Layer 3** -- see [`layers.md`](layers.md). The third leg of the Layer 3 triad:
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
