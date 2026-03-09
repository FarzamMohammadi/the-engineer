# Orchestrator -- Layer 2 Design

The Orchestrator is the brain of the system. It owns the agent's reasoning, phase management, decision-making, and communication. It does NOT own task state (Task Engine), scheduling (Daemon), persistence (Session/Memory), or policy enforcement (Safety Layer). It coordinates all of them.

Part of **Layer 2** -- see [`layers.md`](../layers.md). Resolves gaps: #1, #4, #10, #15, #16, #18, #23.

---

## Proven Systems

The Orchestrator derives from three proven systems:

| Proven system | What we take | Applied as |
|---------------|-------------|------------|
| **Compiler front-end (multi-pass)** | Multi-pass processing: lex, parse, analyze, optimize, emit. Each pass produces structured intermediate representation (IR) that feeds the next. Trivial inputs skip passes. | Phases as passes. Each phase produces structured output that seeds the next. Fast-path detects trivial tasks and skips intermediate phases. |
| **Flight Director (NASA Mission Control)** | A single person who coordinates specialists, manages communication cadence, makes real-time judgment calls about escalation vs proceed, and delegates while maintaining full situational awareness. | Orchestrator as flight director: coordinates tools/plugins, manages human notification cadence, makes autonomy judgment calls, supervises children as tech lead. |
| **Senior engineer's cognitive loop** | Research, plan, execute, verify, reflect -- the natural workflow of an experienced developer. | Phase pipeline with judgment-based transitions and loopbacks. |

**Why compiler front-end:**

| Compiler pass | Orchestrator phase | What it produces |
|---------------|-------------------|------------------|
| Lexing (tokenize, classify input) | Intake-analysis (parse task, classify complexity) | Token stream -> complexity assessment |
| Parsing (build structural understanding) | Research (build codebase understanding) | AST -> codebase map, conventions |
| Semantic analysis (validate, type-check) | Planning (validate approach, assess risks) | Typed AST -> technical plan |
| Code generation (emit output) | Execution (write code, tests) | Machine code -> code changes |
| Optimization (refine output) | Self-review (refine quality) | Optimized code -> refactored code |

The key insight: **trivial inputs skip passes.** A constant expression `return 42` doesn't need optimization or complex semantic analysis. A typo fix doesn't need planning or demo-prep. The compiler decides which passes to run based on input analysis -- exactly what intake-analysis does.

Also from compilers: each pass produces **structured output** that seeds the next pass. This prevents coupling between phases -- if you loop back, you re-run from that phase's input, not from hidden state.

**Why flight director:**

| Flight Director behavior | Orchestrator behavior |
|--------------------------|----------------------|
| Coordinates specialists (FIDO, GUIDO, EECOM) without doing their jobs | Coordinates plugins (LLM, tools, comm) without owning their internals |
| Decides communication cadence -- when to update vs stay silent | Decides notification cadence -- when to message the human vs stay quiet |
| Makes real-time "Go/No-go" judgment calls on escalation | Makes autonomy judgments: proceed vs ask human (via Safety Layer) |
| Delegates to specialists while maintaining situational awareness | Delegates to child tasks while supervising as tech lead |
| Manages structured communication protocols with the crew | Manages structured question batching with the human |
| Handles anomalies -- abort, work the problem, or continue | Handles cascade failures -- apply policy, self-resolve, or escalate |

**Why both:** The compiler gives the _phase pipeline_ structure (passes, IR, fast-path). The flight director gives the _coordination and communication_ model (cadence, escalation, supervision). Neither alone covers everything.

---

## What the Orchestrator Owns (and Doesn't)

| Concern | Owner | Why |
|---------|-------|-----|
| **Phase management** (which phase, transitions, loopbacks) | Orchestrator | Phases are reasoning concerns, not lifecycle concerns |
| **Communication decisions** (when/what to notify) | Orchestrator | Flight director role -- judgment about cadence |
| **Question batching** | Orchestrator | Composes and manages question flow |
| **Complexity assessment** (fast-path decision) | Orchestrator | Compiler-inspired input analysis |
| **Decomposition planning** | Orchestrator | Tech lead role -- deciding how to split work |
| **Child completion summaries** (content) | Orchestrator | Generates the narrative and key outputs |
| **Demo artifact strategy** (what to create) | Orchestrator | Decides by change domain |
| **Journal entry generation** | Orchestrator | Decides what merits an entry |
| **Checkpoint context summaries** | Orchestrator | Quality determines resume quality |
| **Knowledge capture** | Orchestrator | Decides what's worth retaining |
| Task state, transitions, permissions | Task Engine | State authority |
| Scheduling, dispatch, preemption timing | Daemon | Kernel role |
| Session storage, journal storage, knowledge storage | Session/Memory | Pure storage |
| Policy evaluation, cost limits, scope, autonomy | Safety Layer | Policy authority |

---

## Phase Pipeline

Phases are Orchestrator-internal concerns. The Task Engine only sees the `phase` string field on the Task object, updated by the Orchestrator for observability. Phases have no permission implications beyond what the current Task Engine state+sub-state already grants.

### Phase Definitions

```
Phase {
  id:                string           (e.g., "research", "planning", "execution")
  purpose:           string           (what this phase achieves)
  outputs:           string[]         (structured outputs this phase produces)
  reference_docs:    string[]         (docs loaded on-demand per PI minimalism)
  checkpoint_on_exit: boolean         (always true for phase transitions)
}
```

### The Seven Phases

| # | Phase | Purpose | Key Outputs | Reference Docs |
|---|-------|---------|-------------|----------------|
| 1 | **intake-analysis** | Understand the task. Parse requirements, identify gaps, assess complexity. | complexity_assessment, ambiguity_list, estimated_phases | task template, repo knowledge |
| 2 | **research** | Explore the codebase and external resources. Build understanding. | codebase_map, conventions_found, dependencies_identified, knowledge_entries | repo knowledge, codebase conventions |
| 3 | **planning** | Form the technical approach. Decide architecture, identify risks. | technical_plan, file_change_manifest, risk_assessment, decomposition_plan? | architecture docs, past decisions |
| 4 | **execution** | Write code, create tests, build artifacts. | code_changes, test_results, build_status | coding conventions, test patterns |
| 5 | **self-review** | Review own work as a code reviewer. Refactor, fix issues. | self_review_findings, refactoring_applied, quality_assessment | code review checklist |
| 6 | **demo-prep** | Create demo artifacts and Draft PR. | demo_artifacts[], pr_description, pr_number | demo template, artifact guidelines |
| 7 | **integration** | (Parent tasks only) Verify children's combined output, run integration tests. | integration_test_results, conflict_assessment | integration checklist |

### Phase Transitions

Phases are not strictly sequential. The Orchestrator uses judgment to determine transitions:

```
intake-analysis  -->  research  -->  planning  -->  execution  -->  self-review  -->  demo-prep
                  ^       ^             ^               ^
                  |       |             |               |
                  +-------+-------------+---------------+
                        (loopback -- Orchestrator judgment)
```

**Loopback rules:**
- Loopback is a formal transition: the Orchestrator updates the `phase` field on the Task, creates a checkpoint (reason: phase_transition), and logs a journal entry (type: phase_change) with the reason for the loopback.
- When the task returns from Review_Pending to Active.Working, the Orchestrator determines which phase to re-enter based on the feedback received.
- No limit on loopbacks. The Orchestrator uses judgment. A real engineer loops back when their understanding was wrong -- so does the Orchestrator.
- Safety net: if loopbacks exceed `max_loopbacks_before_alert` (configurable, default: 3), the Orchestrator alerts the human -- something may be fundamentally wrong with the approach.

### Phase Output Schema

Each phase produces structured output that feeds into the next phase's context. This is the "intermediate representation" from the compiler analogy.

```
PhaseOutput {
  phase:           string
  task_id:         string
  timestamp:       datetime

  -- Phase-specific structured output --
  data:            object             (varies by phase -- see below)

  -- Meta --
  confidence:      "high" | "medium" | "low"
  open_questions:  string[]           (unresolved items, may trigger human interaction)
}
```

**intake-analysis output:**
```
{
  complexity:           "trivial" | "simple" | "moderate" | "complex" | "epic"
  estimated_phases:     string[]       (which phases this task needs)
  ambiguities:          string[]       (gaps in requirements)
  fast_path:            boolean        (true if trivial -- see Fast-Path section)
  decomposition_likely: boolean        (true if likely too large for one task)
}
```

**research output:**
```
{
  relevant_files:       string[]
  relevant_modules:     string[]
  conventions:          KnowledgeEntry[]  (to be stored via Session/Memory)
  existing_patterns:    string[]       (patterns to follow)
  dependencies:         string[]       (external deps involved)
}
```

**planning output:**
```
{
  approach:             string         (technical plan, narrative)
  file_changes: [{
    file:               string
    change_type:        "create" | "modify" | "delete"
    description:        string
  }]
  risks: [{
    risk:               string
    mitigation:         string
  }]
  decomposition_plan:   DecompositionPlan?  (if task should be split)
}
```

**execution output:**
```
{
  files_changed:        string[]
  tests_written:        string[]
  test_results: {
    passed:             number
    failed:             number
    skipped:            number
  }
  build_status:         "passing" | "failing"
}
```

**self-review output:**
```
{
  findings: [{
    type:               "style" | "logic" | "performance" | "security" | "maintainability"
    file:               string
    description:        string
    fixed:              boolean
  }]
  refactoring_applied:  string[]
  quality_assessment:   "ship_it" | "needs_work" | "fundamental_issues"
}
```

**demo-prep output:**
```
{
  artifacts:            DemoArtifact[]    (registered in task.review.demo_artifacts[])
  pr_number:            number
  pr_description:       string
}
```

**integration output:**
```
{
  children_verified:    string[]       (child IDs that were checked)
  integration_tests: {
    passed:             number
    failed:             number
  }
  conflicts_found:      string[]
  resolution_actions:   string[]
}
```

---

## Fast-Path for Trivial Tasks (Gap #1 -- Resolved)

### What Makes a Task Trivial

The Orchestrator assesses complexity during intake-analysis. Triviality is determined by a combination of signals -- all must be true:

```
TrivialCriteria {
  single_file:             boolean    (change affects <= max_files files)
  no_ambiguity:            boolean    (requirements are completely clear)
  no_new_dependencies:     boolean    (no new packages, APIs, or services)
  no_architectural:        boolean    (no module boundary changes)
  no_tests_needed:         boolean    (change is so trivial tests are unnecessary -- typo fix,
                                       comment update -- OR existing tests already cover the case)
  estimated_time:          "< max_estimated_minutes"
}
```

### What Fast-Path Skips

| Phase | Normal | Fast-path |
|-------|--------|-----------|
| intake-analysis | Full | Abbreviated (complexity = trivial, done) |
| research | Full codebase exploration | Targeted: read only the affected files |
| planning | Full plan with risk assessment | Skip entirely -- plan is implicit in the change |
| execution | Full | Full (still write correct code) |
| self-review | Full review pass | Abbreviated: quick sanity check, no refactoring pass |
| demo-prep | Full demo artifacts | Skip entirely. PR goes directly to Ready (no Draft/demo stage) |

### What Fast-Path Does NOT Skip

- Execution (the change still needs to be made correctly)
- Safety Layer consultation (policy still applies)
- Two-gate permission check (still enforced)
- Checkpoint on completion

### Notification on Fast-Path

Trivial tasks send a single combined notification instead of the normal three (pickup / draft ready / done):

```
"Fixed typo in README.md (#47). PR #52 is ready for review."
```

One message. No pickup notification (the task would be done before the human reads it). No demo stage.

### Fast-Path Configuration

```
fast_path: {
  enabled:                 boolean    (default: true)
  max_files:               number     (default: 2)
  skip_demo:               boolean    (default: true)
  max_estimated_minutes:   number     (default: 30)
}
```

Users who want full ceremony for every task can set `fast_path.enabled: false`.

---

## Notification Model (Gaps #4, #15 -- Resolved)

The Orchestrator owns the decision of **what** and **when** to communicate. Comm plugins own the **how**.

### Communication Events

Every outgoing communication from the Orchestrator is typed:

```
CommEvent {
  type:        "milestone" | "question" | "status_update" | "alert" | "digest"
  task_id:     string
  channel:     "telegram" | "github_pr" | "github_issue"
  urgency:     "immediate" | "batched" | "digest"
  content:     string
  metadata:    object                  (type-specific data)
}
```

### Milestone-Based Notifications (Default)

The Orchestrator sends notifications at natural milestones. These are NOT time-based -- they fire when meaningful things happen:

| Milestone | Message pattern | Channel |
|-----------|-----------------|---------|
| Task pickup | "Picked up #{id}: {title}. Starting with {first_action}." | Telegram |
| Draft PR ready | "Draft PR #{pr} ready for #{id}. Demo inside -- {demo_summary}." | Telegram + GitHub |
| PR marked Ready | "PR #{pr} marked Ready for code review." | Telegram + GitHub |
| Task completed | "#{id} done. PR #{pr} merged. {one_line_summary}." | Telegram + GitHub |
| Blocked | "Question on #{id}: {question}" | Telegram |
| Child completed | "Sub-task #{child_id} done. Starting #{next_child_id}." | Telegram |
| Cascade failure | "Problem with #{child_id}: {problem}. Options: ..." | Telegram |
| Self-unblocked | "Going with {choice} for #{id}. Override if you'd prefer otherwise." | Telegram |

**Notably absent from milestones:**
- Phase transitions (too granular -- the human doesn't care that the agent entered "planning" phase)
- Individual file operations
- Test runs (unless they reveal a blocker)

**Fast-path tasks collapse milestones** into a single combined notification.

### Optional Digest Mode

Configurable on top of milestones. The Orchestrator accumulates a periodic summary:

```
notification: {
  milestone_based:   boolean          (default: true, always on)
  digest: {
    enabled:         boolean          (default: false)
    schedule:        string           (cron-like: "0 18 * * *" for 6pm daily)
    channel:         string           (default: "telegram")
    include:         string[]         (what to include: ["progress", "blockers", "upcoming", "costs"])
  }
}
```

Digest example:
```
"Daily summary:
- #47 (dark mode): Completed and merged today.
- #50 (JWT migration): 3/5 sub-tasks done. #53 in progress.
- #61 (dependency update): Queued, priority 50.
Total LLM cost today: $2.14."
```

### Noise Prevention

The Orchestrator suppresses noise using these rules:

1. **Deduplication window**: If a notification for the same task+type was sent within `suppress_window` (default: 5 min), suppress the duplicate.
2. **Quiet hours**: Configurable hours during which only `alert`-urgency messages are sent. Non-urgent messages queue for delivery after quiet hours end.
3. **Batching window**: Messages with `urgency: "batched"` accumulate for `batch_window` (default: 2 min) before sending, to avoid rapid-fire messages during fast operations.

```
notification: {
  suppress_window:     duration       (default: 5 min)
  batch_window:        duration       (default: 2 min)
  quiet_hours: {
    enabled:           boolean        (default: false)
    start:             string         (e.g., "22:00")
    end:               string         (e.g., "08:00")
    timezone:          string
    allow_alerts:      boolean        (default: true)
  }
}
```

---

## Question Batching (Gap #18 -- Resolved)

When the Orchestrator encounters multiple questions during a single phase, it batches them into one message. Fewer interruptions for the human, questions are often related, and the human can answer all at once.

### Question Batch Schema

```
QuestionBatch {
  task_id:       string
  questions: [{
    id:           string
    question:     string
    options:      string[]?           (if multiple-choice)
    category:     string              (autonomy category)
    urgency:      "blocking" | "informational"
  }]
  batch_window:  duration             (how long to accumulate before sending)
}
```

### Batching Rules

1. **Accumulation phase**: When the Orchestrator hits a question, it starts a batch window (default: 30 seconds). Additional questions encountered within that window are added to the batch.
2. **Flush trigger**: The batch is sent when either (a) the batch window expires, (b) the Orchestrator reaches a point where it cannot proceed without at least one answer, or (c) a question is marked `urgency: "blocking"` and no other work can continue.
3. **Maximum batch size**: Configurable (default: 5 questions). If the batch grows beyond this, it splits into multiple messages for readability.
4. **Numbering**: Batched questions are numbered so the human can reply with structured responses.

### Message Format

```
"Questions on #50 (JWT migration):

1. JWT token format: (A) match mobile app's format or (B) use standard claims?
2. Token expiry: (A) 15 min access + 7 day refresh, or (B) 1 hour access + 30 day refresh?
3. Should I migrate all 15 endpoints at once or in batches?

Reply with numbers, e.g., '1:A 2:B 3:batches'"
```

### Response Parsing

The Orchestrator parses structured replies (numbered) and also handles natural language ("Go with A for the first one, B for the second, and batch the endpoints into groups of 5"). The LLM enables flexible response interpretation.

### Configuration

```
question_batching: {
  enabled:              boolean       (default: true)
  batch_window:         duration      (default: 30 seconds)
  max_batch_size:       number        (default: 5)
}
```

---

## Parent Task as Tech Lead (Gap #10 -- Resolved)

When a task enters Active.Supervising, the Orchestrator shifts into tech lead mode. The parent is NOT dormant -- it actively monitors, coordinates, and makes decisions. But it does NOT consume the working slot (established in Daemon design).

### Supervision Behavior

The Orchestrator, while supervising, runs a lightweight event-driven loop:

**On child completion (`task.state_changed` where `to=Completed` for a child):**

1. Generate child completion summary (content is the Orchestrator's responsibility)
2. Task Engine handles progressive merge and attaches summary (see `task-engine.md` § Progressive Merge on Child Completion)
3. Task Engine checks all children — if all done, emits `task.children_all_done` (Orchestrator does NOT independently check)
4. If not all done: Daemon schedules next eligible children per priority queue
5. Send milestone notification to human (configurable)

**On merge conflict (`workspace.merge_conflict` event during progressive merge):**

1. Parent task transitions Active.Supervising → Active.Working (consumes slot)
2. Orchestrator resolves the conflict (has write/git permissions in Working state)
3. Parent task transitions Active.Working → Active.Supervising (frees slot)
4. Progressive merge continues

**On child failure (`task.failed` event for a child):**

1. Read the `cascade_policy` from the parent Task object
2. Apply policy (pause-siblings, fail-fast, best-effort, or manual -- see Task Engine design)
3. For pause-siblings / manual: evaluate the failure -- can the parent resolve it?
4. If self-resolvable: adjust the plan, resume affected children
5. If not: compose precise question to human, transition parent to Blocked
6. Send alert notification

**On child blocked (`task.blocked` event for a child):**

1. Read the child's `blocked.reason`
2. Determine: is this something the parent can resolve?
   - If the child needs context from a sibling: provide via parent's `child_summaries`
   - If the child needs a decision the parent can make: make it (within autonomy bounds)
   - If the child needs human input: the child's own blocked flow handles escalation
3. Log journal entry about the child's block

**Periodic (on Daemon health tick):**

1. Review overall progress against the original decomposition plan
2. Update the parent GitHub issue with child progress (if configured)
3. Evaluate: should the plan be adjusted? (a child took much longer than expected, or a child's output changes the approach for remaining children)
4. Generate journal entry summarizing current supervision state

### Child Completion Summary Schema

The Orchestrator generates this when a child completes. Quality matters -- subsequent siblings and the integration phase depend on it:

```
ChildCompletionSummary {
  child_id:            string
  child_title:         string

  -- What was built --
  summary:             string         (narrative: what the child accomplished)
  key_outputs: [{
    type:              "file" | "endpoint" | "module" | "config" | "schema" | "test"
    path:              string         (file path, API path, etc.)
    description:       string         (what this output is/does)
  }]

  -- Knowledge for siblings --
  patterns_introduced:    string[]   (patterns/conventions introduced that siblings should follow — informal strings, not KnowledgeEntry objects)
  gotchas:             string[]       (problems encountered that siblings should know about)
  decisions_made:      string[]       (decisions that affect remaining work)

  -- Integration context --
  pr_number:           number?
  branch:              string
  test_status:         "passing" | "failing" | "no_tests"
}
```

### Supervision Journal Entries

The Orchestrator generates journal entries during supervision at a lower frequency than during active work:

- **On child completion**: type=action, summary="Child #51 (JWT utils) completed. Key outputs: token generation, validation middleware."
- **On child failure**: type=error, summary="Child #53 (endpoint migration) failed: JWT format incompatible with mobile app."
- **On plan adjustment**: type=decision, summary="Adjusted plan: splitting #54 into two sub-tasks due to scope."
- **Periodic**: type=action, summary="Supervision update: 3/5 children done, on track."

---

## Decomposition Decision and Approval (Gap #23 -- Resolved)

The Orchestrator determines whether to decompose during the intake-analysis and planning phases. Two parts: (1) should this be decomposed? and (2) should I ask for approval?

### When to Decompose

The Orchestrator uses judgment guided by heuristics:

```
DecompositionSignals {
  -- Signals suggesting decomposition --
  multiple_independent_concerns:   boolean   (e.g., "migrate auth AND update UI AND add tests")
  estimated_duration:              duration  (> auto_threshold suggests splitting)
  multiple_modules_affected:       number    (> module_threshold)
  sequential_dependencies:         boolean   (work has natural phases that could be parallel)

  -- Signals against decomposition --
  tight_coupling:                  boolean   (changes are deeply interdependent)
  small_scope:                     boolean   (would produce trivially small children)
  overhead_exceeds_benefit:        boolean   (decomposition overhead > benefit in single-core)
}
```

### Decomposition Plan Schema

```
DecompositionPlan {
  parent_task_id:     string
  rationale:          string          (why decomposition is needed)

  children: [{
    title:            string
    description:      string
    estimated_time:   duration
    depends_on:       number[]        (indices into this array)
    acceptance_criteria: string[]
  }]

  dependency_graph:   string          (human-readable: "1->2->(3,4 parallel)->5")
  total_estimated:    duration
  parallelizable:     boolean         (whether any children can run simultaneously)
}
```

### Approval Flow

**Default: always ask.** The Orchestrator creates a decomposition plan and sends it to the human for approval before creating child tasks. This matches the user flow established in Flow 5.

Decomposition approval integrates into the Safety Layer's existing autonomy boundary system as a new decision category:

```
autonomy.decisions.task_decomposition: {
  level:        "always_ask"          (default)
  threshold:    "children > 3"        (when level="threshold")
  description:  "Splitting a task into sub-tasks"
}
```

The Orchestrator calls `SafetyLayer.evaluate({ type: "should_i_ask", context: { decision_category: "task_decomposition", details: { children_count: 5 } } })` and follows the verdict.

**Three configurable levels:**

| Level | Behavior |
|-------|----------|
| `always_ask` (default) | Always ask before decomposing, regardless of plan size |
| `threshold` | Ask only when decomposition produces more than N children |
| `always_decide` | Orchestrator has full authority to decompose (maximum autonomy) |

### Decomposition Execution

When the human approves (or when the Orchestrator has authority):

1. Orchestrator creates child tasks via Task Engine, each with title, description, dependencies, acceptance criteria (gets internal IDs)
2. Orchestrator creates GitHub issues for each child via GitHub comm plugin:
   `createIssue(repo, { title, body, parent_issue, labels: ["engineer:queued"] })` → `{ number, url }`
3. Orchestrator updates each child task's `external_ref` via Task Engine:
   `updateTaskField(child_id, "external_ref", { type: "github_issue", repo, number })`
4. GitHub comm plugin adds checklist comment to parent issue: "Decomposed into #51, #52, ..."
5. Task Engine: Parent transitions Active.Working -> Active.Supervising
6. Children enter Intake, then Queued
7. Daemon picks up eligible children per scheduling algorithm
8. Parent monitors via supervision behavior (see above)

Note: There is a brief window between step 1 (children created in Task Engine) and steps 2-3 (GitHub issues created). If the Daemon schedules a child before its GitHub issue exists, the child works without an `external_ref` temporarily — this is acceptable. The Orchestrator creates GitHub issues promptly after Task Engine creation.

When the human requests changes to the plan:

1. Orchestrator adjusts the decomposition plan based on feedback
2. Sends updated plan for re-approval (or proceeds if changes are minor and autonomy allows)
3. Repeat until approved

### Decomposition Configuration

```
decomposition: {
  auto_threshold:       duration      (default: 4 hours -- tasks estimated above this are candidates)
  suggest_threshold:    duration      (default: 2 hours -- mention decomposition possibility to human)
  min_child_size:       duration      (default: 30 min -- don't create trivially small children)
}
```

Note: `approval_required` is in Safety Layer autonomy config as the `task_decomposition` category, not here. Single source of truth.

---

## Demo Artifact Lifecycle (Gap #16 -- Resolved)

The Task Engine tracks artifacts in `review.demo_artifacts[]` with a `permanent` flag (see Task Engine design). The Orchestrator is responsible for deciding what artifacts to create and managing cleanup.

### Artifact Strategy by Domain

The Orchestrator decides based on the task's change domain:

| Change domain | Artifacts | Permanent? |
|--------------|-----------|------------|
| **Frontend** | Screenshots (before/after), screen recordings, preview URL | All permanent (in PR description) |
| **Backend** | TUI demo, API response examples, screen recording of TUI | TUI temporary; examples + recording permanent |
| **Infrastructure** | Before/after config diff, dry-run output, architecture diagram | All permanent |
| **Data** | Sample output, migration dry-run | Sample permanent; dry-run temporary |
| **Trivial** | None (fast-path) | N/A |

This is a default guide, not a rigid mapping. The Orchestrator uses judgment. Knowledge entries about the repo's demo preferences (learned over time) override these defaults.

### Artifact Creation (during demo-prep phase)

1. Orchestrator determines artifact strategy based on change domain
2. For each artifact:
   - Creates the artifact (screenshot, recording, TUI code, etc.)
   - Registers it in `task.review.demo_artifacts[]` via Task Engine with `permanent` flag
   - Places visual artifacts in PR description (permanent)
   - Places code artifacts on the branch (temporary)
3. Opens Draft PR with demo section at the top of the description
4. Task transitions to Review_Pending.Demo

### Artifact Cleanup (on Demo -> Code transition)

When Demo is approved (Review_Pending.Demo -> Review_Pending.Code):

1. Orchestrator reads `task.review.demo_artifacts[]`
2. For each artifact where `permanent == false`:
   - File on branch: delete the file, commit "Clean up demo artifacts"
   - Running service (preview URL): tear it down
   - Update artifact entry to indicate cleanup
3. For each artifact where `permanent == true`:
   - Leave in place (PR description, committed files that should stay)
4. Mark PR as Ready
5. Log journal entry: type=action, summary="Cleaned up N demo artifacts, marked PR Ready"

### TUI Base Project Pattern

For backend demos, the Orchestrator uses the base TUI project (DevEx for the Engineer, per `decisions.md`) in an isolated worktree. It extends the base for the specific task and tears it down during cleanup. The base project persists; the task-specific extension is temporary.

---

## Entry Point: Handling the Dispatch Package

The Orchestrator receives the Dispatch package from the Daemon:

```
Dispatch {
  task:           Task               (full Task object from Task Engine)
  resume_from:    Checkpoint?        (null for new tasks, checkpoint for resumed tasks)
  knowledge: {
    repo:         KnowledgeEntry[]   (from Session/Memory, filtered by repo)
    user:         KnowledgeEntry[]   (from Session/Memory, user-scope)
  }
}
```

### New Task Flow (resume_from is null)

```
1. Create new session via Session/Memory. Update `task.session_id` via Task Engine.
2. Load knowledge into context (repo + user, apply precedence: repo > user > defaults)
3. Enter intake-analysis phase:
   a. Parse task.source_text, task.description, task.acceptance_criteria
   b. Assess complexity -> trivial / simple / moderate / complex / epic
   c. Identify ambiguities
   d. If ambiguities exist AND cannot be resolved by reading code:
      -> Compose questions, check Safety Layer for autonomy
      -> If must ask: batch questions, send, transition to Blocked
   e. If fast_path == true: abbreviated pipeline (see Fast-Path section)
   f. If decomposition_likely == true: proceed to research, then planning with decomposition
4. Phase output -> feed into next phase
5. Continue through pipeline, creating checkpoints at each phase transition
6. On completion: post-completion reflection (capture knowledge), transition task
```

### Resumed Task Flow (resume_from is a Checkpoint)

```
1. Create new session via Session/Memory (previous_session_id links to prior). Update `task.session_id` via Task Engine.
2. Load checkpoint:
   a. Read context_summary -> seed LLM context
   b. Read key_findings -> inject as known facts
   c. Read open_questions -> inject as active threads
   d. Read next_action -> this is what we were about to do
3. Verify workspace_ref (branch and commit still exist via Workspace Manager)
4. Load knowledge (may have new entries since last session)
5. Resume from checkpoint.phase:
   a. If mid-phase: re-enter the phase at the checkpoint's progress point
   b. If between phases: enter the next phase
6. Continue normal pipeline from there
```

---

## Responding to Preemption

When the Orchestrator receives a `preemption.requested` event:

1. Identify current atomic operation (file write, test run, LLM call, git commit)
2. Finish the atomic operation (let it complete naturally)
3. Create checkpoint via Session/Memory:
   - reason: "preemption"
   - context_summary: LLM self-summarization of current state
   - key_findings: accumulated findings from current phase
   - next_action: what the Orchestrator was about to do
   - workspace_ref: current branch + last commit SHA
4. Log journal entry: type=checkpoint_marker, summary="Preempted for higher-priority task"
5. Emit `preemption.ready` event on Event Bus
6. Release -- the Daemon handles the rest

---

## Responding to Self-Unblock Evaluation

When the Daemon triggers `timeout.self_unblock_check` (after blocked_self_unblock_threshold):

1. Read the blocked reason from the Task object
2. Look up the autonomy category of the pending decision
3. Call Safety Layer: `evaluate({ type: "should_i_ask", context: { decision_category, ... } })`
4. If verdict is `always_ask`: cannot self-unblock. Log journal entry. Continue waiting.
5. If verdict allows self-decision:
   a. Evaluate: does a reasonable default exist?
   b. If yes: compose proposal ("Going with {choice} since {reason}. Override if you'd prefer otherwise.")
   c. Send via comm plugin
   d. Apply the default choice
   e. Transition task: Blocked -> Active.Working
   f. Log decision in `task.decisions[]` with `decided_by: "agent"`
6. If no reasonable default: cannot self-unblock. Log journal entry. Continue waiting.

---

## Post-Completion Reflection

After a task transitions to Completed, the Orchestrator performs a brief reflection pass:

1. Review what was learned about the repo during this task
2. For each new pattern/convention discovered:
   - Create or confirm a KnowledgeEntry via Session/Memory
   - scope: "repo", domain: appropriate category
3. Review interactions with the human:
   - Any observed preferences? Create/confirm user-scope KnowledgeEntry
4. Log final journal entry summarizing the task outcome
5. End the session (Session/Memory: `endSession` with reason "completed")

This is the post-completion knowledge capture described in Session/Memory design. The Orchestrator decides what's worth retaining.

---

## Journal and Checkpoint Generation

These were flagged as open questions in the Session/Memory design. Here are the answers.

### Journal Entry Generation

The Orchestrator logs a journal entry when an action, finding, or decision would be relevant to someone asking "what have you been doing?" Specifically:

| What | Journal entry? | Why |
|------|---------------|-----|
| Phase change | Always | Meaningful milestone |
| Human communication | Always | Important for audit and queryability |
| Decision (agent or human) | Always | Critical for "why did you decide X?" queries |
| Error | Always | Important for debugging and learning |
| Groups of related actions | Aggregate | "Researched auth module: read 12 files" not 12 separate entries |
| Individual tool calls | Never | Too granular |
| LLM reasoning steps | Never | Internal to the Orchestrator |

**Aggregation rule:** The Orchestrator accumulates related low-level actions and writes a single journal entry when the aggregate is meaningful. This is configurable: `journal.aggregate_file_reads: true` (default).

### Checkpoint Context Summary

The Orchestrator generates `context_summary` via LLM self-summarization at checkpoint time. The prompt:

```
"Summarize the current state of work on task '{title}' for context reconstruction.
Include: what you've done, what you've found, what decisions were made, and what you're
about to do. This summary will be used to seed a fresh context window -- include
everything needed to resume without re-reading the full history. Be concise but complete."
```

Quality control: The summary is validated against the current phase's outputs. If the summary omits key findings or decisions, the Orchestrator regenerates it. This is a self-check.

---

## Component Interactions

| Component | How Orchestrator Interacts | Direction |
|-----------|---------------------------|-----------|
| **Task Engine** | Updates task.phase. Requests state transitions (Working->Blocked, Working->Review_Pending). Reads task state. Creates child tasks for decomposition. Attaches child completion summaries. | Bidirectional via Event Bus |
| **Session/Memory** | Creates sessions (updates task.session_id). Appends journal entries. Creates checkpoints. Stores knowledge entries. Queries knowledge on task start. | Orchestrator -> Session/Memory |
| **Daemon** | Receives Dispatch package. Responds to preemption.requested by checkpointing and yielding. Receives timeout escalation events. | Daemon -> Orchestrator (dispatch), Orchestrator -> Event Bus (signals) |
| **Safety Layer** | Passive consultation: should_i_ask (autonomy), can_i (scope), cost_check (budget). Receives veto events from active interceptor. | Orchestrator -> Safety Layer (queries), Safety Layer -> Event Bus (vetoes) |
| **Registry** | Looks up LLM providers, tools, comm channels. | Orchestrator -> Registry (lookup) |
| **People Directory** | Looks up who to contact. Reads from task.team[] which references People Directory entries. | Orchestrator -> People Directory (lookup) |
| **Workspace Manager** | Requests workspace creation (branch, worktree). Commits, pushes. Opens/updates PRs. Cleans up demo artifacts. | Orchestrator -> Workspace Manager |
| **Event Bus** | Emits all events (action.requested, cost.incurred, comm.sent, etc.). Subscribes to events for current task (feedback, approval, child state changes). | Bidirectional |
| **Comm Plugins** | Sends messages (questions, status, milestones). Receives human responses. | Orchestrator -> Comm (send), Comm -> Event Bus -> Orchestrator (receive) |

---

## Orchestrator State

The Orchestrator is stateless across sessions -- all persistent state lives in Session/Memory (journal, checkpoints, knowledge) and Task Engine (task state). Runtime state is ephemeral:

```
OrchestratorRuntime {
  -- Current execution context --
  current_task_id:     string?
  current_phase:       string?
  current_session_id:  string?

  -- Pending communication --
  question_batch: {
    questions:         QuestionBatch?
    batch_started_at:  datetime?
  }

  -- Notification state --
  last_notification: {
    [task_id]: {
      type:            string
      timestamp:       datetime
    }
  }

  -- Supervision state (when in Supervising mode) --
  supervision: {
    children_status:   { [child_id]: string }  (cached from task.children)
    plan_adjustments:  number                   (how many times the plan was adjusted)
  }?

  -- Configuration --
  config:              OrchestratorConfig
}
```

On crash, the Orchestrator loses its runtime state. The Daemon detects the crash, restarts the Orchestrator, and dispatches the task with `resume_from` pointing to the latest checkpoint. The Orchestrator reconstructs everything from the checkpoint and knowledge.

**Single-instance assumption:** The current design assumes one Orchestrator instance handling one task. The runtime state schema (`current_task_id: string?`) is singular. For multi-core evolution (multiple concurrent Orchestrator instances), each instance would be isolated — one instance per task, no shared runtime state. The runtime state is already per-task, so the main gap would be notification deduplication (the `last_notification` map would need per-instance isolation or a shared store). This is a known limitation with a clear evolution path.

---

## Configuration Schema

```
OrchestratorConfig {
  -- Fast path (Gap #1) --
  fast_path: {
    enabled:                    boolean    (default: true)
    max_files:                  number     (default: 2)
    skip_demo:                  boolean    (default: true)
    max_estimated_minutes:      number     (default: 30)
  }

  -- Notification (Gaps #4, #15) --
  notification: {
    milestone_based:            boolean    (default: true)
    suppress_window:            duration   (default: 5 min)
    batch_window:               duration   (default: 2 min)
    quiet_hours: {
      enabled:                  boolean    (default: false)
      start:                    string
      end:                      string
      timezone:                 string
      allow_alerts:             boolean    (default: true)
    }
    digest: {
      enabled:                  boolean    (default: false)
      schedule:                 string     (cron expression)
      channel:                  string     (default: "telegram")
      include:                  string[]
    }
    fast_path_collapse:         boolean    (default: true)
  }

  -- Question batching (Gap #18) --
  question_batching: {
    enabled:                    boolean    (default: true)
    batch_window:               duration   (default: 30 seconds)
    max_batch_size:             number     (default: 5)
  }

  -- Decomposition (Gap #23) --
  decomposition: {
    auto_threshold:             duration   (default: 4 hours)
    suggest_threshold:          duration   (default: 2 hours)
    min_child_size:             duration   (default: 30 min)
  }
  -- Note: approval_required is in Safety Layer autonomy config
  -- as "task_decomposition" category. Single source of truth.

  -- Demo artifacts (Gap #16) --
  demo: {
    always_create:              boolean    (default: true)
    tui_base_project:           string?    (path to base TUI project)
  }

  -- Phases --
  phases: {
    checkpoint_on_transition:   boolean    (default: true)
    periodic_checkpoint_interval: duration (default: 15 min)
    max_loopbacks_before_alert: number     (default: 3)
  }

  -- Journal --
  journal: {
    aggregate_file_reads:       boolean    (default: true)
  }
}
```

---

## Gaps Resolved

| # | Gap | Resolution |
|---|-----|-----------|
| 1 | Fast-path for trivial tasks | Compiler-inspired: intake-analysis determines complexity. Trivial tasks (<=2 files, no ambiguity, no architectural changes, <30 min) skip planning, abbreviate self-review, skip demo (PR goes directly to Ready). Single notification instead of three. All thresholds configurable. |
| 4 | Proactive status communication | Milestone-based notifications (default): meaningful events trigger messages, not timers. Optional daily digest on top. Configurable suppression, quiet hours, batching window. Fast-path tasks collapse to one message. |
| 10 | Parent task as "tech lead" role | Event-driven supervision loop: responds to child completion (generates summaries, queues next children), child failure (applies cascade policy, evaluates self-resolution, escalates if needed), child blocked (provides sibling context or escalates). Periodic progress tracking. Does not consume working slot. |
| 15 | Notification cadence | Milestone-based cadence with configurable noise prevention. Deduplication window, quiet hours, batching window. CommEvent schema with urgency levels (immediate/batched/digest). Fast-path collapse for trivial tasks. |
| 16 | Demo artifact lifecycle | Orchestrator determines artifact strategy by change domain (frontend, backend, infra, data). Visual artifacts permanent (PR description), code artifacts temporary (branch). Cleanup on Demo->Code transition: delete non-permanent files, tear down services, keep PR description content. TUI base project pattern. |
| 18 | Question batching | Batch by default. 30-second accumulation window, max 5 questions per batch. Numbered format for easy response parsing. Flush on window expiry, blocking need, or max size. Handles structured replies and natural language. |
| 23 | Decomposition approval threshold | Default: always ask (matches Flow 5). Integrates into Safety Layer's autonomy system as `task_decomposition` category. Three configurable levels: always_ask (default), threshold (above N children), always_decide (full autonomy). DecompositionPlan schema with dependency graph. |

---

## Open Questions for Layer 3

- **LLM context window management**: How does the Orchestrator manage context window size during long phases? Summarization strategies, context pruning, reference doc loading/unloading.
- **Phase reference doc loading**: Which reference docs are loaded per phase? How? (Injected into system prompt? Tool-accessible files? RAG?)
- **Comm plugin message formatting**: How do comm plugins format messages for different channels? (Markdown for GitHub, plain text for Telegram? Templates?)
- **Event subscription management**: How does the Orchestrator subscribe to events for its current task and unsubscribe when done? Per-task event filtering.
- **Complexity assessment calibration**: How does the Orchestrator's complexity assessment improve over time? Feedback loop from actual vs estimated duration?
- **Multi-question response parsing**: Full spec for parsing batched question responses -- structured and natural language.
