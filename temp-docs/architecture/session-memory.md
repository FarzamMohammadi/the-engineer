# Session/Memory -- Layer 2 Design

Session/Memory is the persistence layer for the agent's working context and accumulated knowledge. It does not own task state (Task Engine does that) or raw system events (Event Bus does that). It owns the material the agent needs to resume thinking and the patterns it learns over time.

Part of **Layer 2** -- see [`layers.md`](layers.md). Resolves gaps: #2, #7, #21.

---

## What Session/Memory Is (and Is Not)

Three systems already store information. Session/Memory fills the remaining gap:

| System | What it stores | Analogy |
|--------|---------------|---------|
| **Task Engine** | Task status, decisions, outcomes, hierarchy | The work order |
| **Event Bus** | Every event from every component, raw and exhaustive | The security cameras |
| **Session/Memory** | Agent's reasoning process + learned knowledge | The engineer's notebook + institutional memory |

**Session/Memory stores:**
- The **session journal** -- append-only log of the Orchestrator's reasoning (what it researched, found, tried, decided)
- **Checkpoints** -- named snapshots for crash recovery and session resume
- **Knowledge** -- patterns and conventions learned across tasks, isolated by scope

**Session/Memory does NOT store:**
- Task state, transitions, decisions (Task object owns these)
- Raw system events (Event Bus owns these)
- Workspace state, git branches, files (Workspace Manager owns these)

The boundary: if it's about **the task's status**, it's on the Task object. If it's about **what happened in the system**, it's on the Event Bus. If it's about **how the agent was thinking and what it learned**, it's in Session/Memory.

### Proven Systems

| Proven system | What we take | Applied as |
|---------------|-------------|------------|
| **Write-Ahead Log (WAL)** | Append-only entries, checkpoint + replay for recovery | Session journal: append-only entries, checkpoints for resume |
| **Journaling Filesystem** | Record intent before execution, replay journal on crash | Checkpoints record "where I am and what I was about to do" before costly operations |
| **Content-Addressable Storage (Git)** | Immutable snapshots, content hashing, deduplication | Knowledge entries are immutable -- updated by supersession, not mutation |

---

## Session Journal

The session journal is an append-only sequence of typed entries that captures the Orchestrator's working narrative. It is NOT a raw event log -- it's a curated account of meaningful steps, written from the agent's perspective.

### Journal Entry Schema

```
JournalEntry {
  id:              string          (sequential within session: "j-{session_id}-{seq}")
  session_id:      string
  task_id:         string
  timestamp:       datetime
  phase:           string          (which Orchestrator phase: "research", "planning", "execution", etc.)

  type:            "action" | "finding" | "decision" | "error" | "communication" | "phase_change" | "checkpoint_marker"

  -- Content --
  summary:         string          (human-readable one-liner: "Researched auth module structure")
  detail:          string?         (longer explanation when needed)

  -- Type-specific fields --
  action_type:     string?         (for type=action: "file_read", "test_run", "code_write", "llm_call", etc.)
  finding_type:    string?         (for type=finding: "pattern", "bug", "convention", "dependency")
  decision_key:    string?         (for type=decision: what was decided -- mirrors Task.decisions[].what)
  error_detail:    string?         (for type=error: what went wrong, how it was handled)
  comm_target:     string?         (for type=communication: who was contacted)

  -- Queryability --
  tags:            string[]        (free-form tags for search: ["auth", "css", "migration"])
}
```

### Entry Types

| Type | What it captures | Example |
|------|-----------------|---------|
| **action** | Something the agent did | "Read 12 files in src/auth/" |
| **finding** | Something the agent discovered | "Found inline styles throughout settings page" |
| **decision** | A choice the agent made (or recorded from human) | "Chose CSS variables over React Context" |
| **error** | Something that went wrong | "Test suite failed: 3 assertions in auth.test.ts" |
| **communication** | A message sent or received | "Asked Farzam about refactoring approach via Telegram" |
| **phase_change** | Orchestrator moved to a new phase | "Entering execution phase" |
| **checkpoint_marker** | A checkpoint was created (links to Checkpoint object) | "Checkpoint: research complete" |

The Orchestrator decides what merits a journal entry. The rule of thumb: if a human asking "what have you been doing?" would want to know about it, it's a journal entry. Raw tool invocations (individual file reads, single API calls) are generally too granular -- the journal captures the meaningful aggregate ("Researched the auth module" rather than 15 individual file reads).

---

## Checkpoints (Gap #2 -- Resolved)

Checkpoints are named snapshots that mark safe resume points. Inspired by WAL checkpoints and journaling filesystem recovery.

### Checkpoint Schema

```
Checkpoint {
  id:              string          (unique: "chk-{session_id}-{seq}")
  session_id:      string
  task_id:         string

  -- Position --
  phase:           string          ("research", "planning", "execution", etc.)
  phase_progress:  string          (free-text summary: "researched auth module, found 3 patterns")

  -- Context window reconstruction --
  context_summary: string          (compressed summary of LLM conversation up to this point)
  key_findings:    string[]        (facts the agent discovered and needs to retain)
  open_questions:  string[]        (unresolved questions the agent was pursuing)
  next_action:     string          (what the agent was about to do -- the "intent" from journaling)

  -- References (pointers, not copies) --
  last_event_id:   string          (pointer into Event Bus -- "everything before this is covered")
  workspace_ref: {
    branch:        string
    last_commit:   string          (SHA)
  }

  -- Metadata --
  reason:          "phase_transition" | "preemption" | "pre_costly_op" | "periodic"
  timestamp:       datetime
  journal_offset:  number          (index into journal -- entries before this are covered)
}
```

### Checkpoint Triggers

| Trigger | When | Mandatory? |
|---------|------|-----------|
| **Phase transition** | Orchestrator moves between phases (research -> planning, etc.) | Yes |
| **Preemption** | Task is being preempted (Active -> Queued) | Yes |
| **Pre-costly operation** | Before operations that take significant time/cost (large LLM call, multi-file refactor, test suite run) | No (Orchestrator judgment) |
| **Periodic** | Time-based (configurable interval, e.g., every 15 minutes of active work) | No (safety net) |

Per-tool-invocation checkpointing is too granular. Individual tool invocations are journal entries, not checkpoints.

### Resume: Context Reconstruction

Resume is NOT conversation replay. It is **context reconstruction**.

When a task resumes (from preemption, crash, or new session):

1. Load the latest checkpoint for this session
2. Read `context_summary` -- this seeds the new LLM context window
3. Inject `key_findings` as known facts
4. Inject `open_questions` as active threads
5. Read `next_action` -- this tells the Orchestrator where it was headed
6. Optionally scan journal entries after `journal_offset` for additional context
7. Verify `workspace_ref` -- confirm branch and commit still exist (Workspace Manager check)
8. Resume from `phase` with reconstructed context

Why NOT replay: LLM conversations are expensive, non-deterministic, and often contain exploration paths that were abandoned. A checkpoint summary captures the distilled result -- equivalent context without the noise. The Orchestrator generates `context_summary` at checkpoint time -- summary quality determines resume quality.

### Checkpoints vs Task State

Orthogonal concerns:
- **Task state** (Task object) tracks lifecycle position: Active.Working, Blocked, Review_Pending
- **Checkpoints** (Session/Memory) track reasoning position within a lifecycle state

A phase transition triggers both: a task state change (if applicable) AND a checkpoint. But they happen at different frequencies and serve different purposes.

---

## Knowledge (Gap #7 -- Resolved)

### Knowledge Scopes

Layer 1 defined three knowledge scopes. Two are already handled:

| Scope | Handled by | Session/Memory's role |
|-------|-----------|----------------------|
| **Within-task** | Session journal | Stores the reasoning; dies with the task (journal retained as history) |
| **Sibling-task** | Task Engine (child completion summaries on parent context) | None -- Task Engine owns this |
| **Cross-task** | **Session/Memory** | Stores and retrieves learned knowledge |

Cross-task knowledge has two sub-scopes:

### Repo-Scope Knowledge

Patterns, conventions, and domain knowledge specific to a repository. Isolated by `repo_scope` -- knowledge from `owner/repo-a` is NEVER returned when querying for `owner/repo-b`.

Captured at two natural points:
1. **During research phase**: Orchestrator explores the codebase, discovers patterns and conventions
2. **Post-completion reflection**: After a task completes, Orchestrator asks "what did I learn about this repo?"

### User-Scope Knowledge

Personal preferences and workflow patterns that apply across all repositories. These are things the Engineer **learns** about the user over time -- not things the user explicitly configures (those belong in configuration).

Examples:
- "Farzam prefers functional components over class components"
- "Farzam values thorough PR descriptions"
- "This user always wants tests for new endpoints"

User-scope knowledge is NOT explicit settings (autonomy level, cost caps, notification preferences). Those are configuration. User-scope is observed behavioral patterns.

### Precedence Hierarchy

When knowledge conflicts, precedence determines which wins:

```
1. Repo conventions     (highest -- the repo dictates)
2. User preferences     (fallback -- when repo doesn't specify)
3. Agent defaults       (lowest -- built-in behavior)
```

Like CSS specificity. If a repo uses tabs and the user generally prefers spaces, the Engineer uses tabs in that repo. User-scope is a fallback, not an override.

### Knowledge Entry Schema

```
KnowledgeEntry {
  id:              string          (content hash of scope + key + body)

  -- Scope --
  scope:           "repo" | "user"
  repo_scope:      string?         (e.g., "owner/repo" -- required when scope="repo", null when scope="user")
  domain:          string          (category: "conventions", "patterns", "gotchas", "domain", "tooling", "preferences")

  -- Content --
  key:             string          (what this is about: "test framework", "auth pattern", "PR style")
  body:            string          (the actual knowledge, concise)
  confidence:      "observed" | "inferred" | "told"
  evidence: [{
    task_id:       string
    description:   string          ("saw this pattern in 5 files during task #42")
  }]

  -- Lifecycle --
  created_at:      datetime
  last_confirmed:  datetime        (updated when knowledge is re-observed)
  superseded_by:   string?         (ID of newer entry that replaces this one)

  -- Provenance --
  source_task_id:  string          (which task produced this knowledge)
  source_phase:    string          (which phase: usually "research" or post-completion)
}
```

### Staleness and Correctness

Knowledge can become stale or wrong. Three mechanisms:

1. **Confirmation**: When the Orchestrator re-observes existing knowledge, it updates `last_confirmed`. Long-unconfirmed knowledge is flagged as potentially stale (configurable threshold).

2. **Supersession**: When the Orchestrator observes a contradiction (e.g., repo switched from Jest to Vitest), it creates a new entry and sets `superseded_by` on the old one. Old entries are retained for history but excluded from active queries.

3. **Confidence levels**: `observed` (agent saw it directly), `inferred` (agent concluded from evidence), `told` (human stated it). Lower confidence is treated with less weight and subject to more frequent re-verification.

No automatic expiration. Knowledge is actively superseded or re-confirmed. The Orchestrator judges -- Session/Memory is passive storage.

### Knowledge Retrieval

When the Orchestrator starts a new task, it queries Session/Memory:

1. `queryKnowledge(scope="repo", repo_scope="owner/repo")` -- all active repo knowledge
2. `queryKnowledge(scope="user")` -- all active user knowledge

"Active" means `superseded_by` is null. The Orchestrator filters by relevance to the current task (by domain, keywords, or its own judgment). When repo and user knowledge conflict on the same topic, repo wins per the precedence hierarchy. This filtering is an Orchestrator concern, not Session/Memory's.

---

## Session Log Queryability (Gap #21 -- Resolved)

### Query Patterns

The session journal's typed entries enable structured queries:

| Human question | Query mapping | What's returned |
|---------------|--------------|-----------------|
| "What have you tried on #47?" | Filter by task_id, type=action, chronological | "1. Researched settings page. 2. Identified inline styles. 3. Refactored 12 components. 4. Implementing toggle." |
| "Why did you decide X?" | Filter by task_id, type=decision, match decision_key or search summary/detail | "Chose CSS vars over React Context: no re-render overhead, works with third-party components, simpler." |
| "Status" | Task Engine state + latest journal entries (since last phase change) | Composite: "Active, execution phase, ~60% through. Currently implementing toggle component." |
| "What errors have you hit?" | Filter by task_id, type=error | Chronological list of errors and resolutions |
| "What did you find during research?" | Filter by task_id, phase="research", type=finding | Research findings list |
| "Who have you talked to?" | Filter by task_id, type=communication | Communication log with targets and content |

Session/Memory provides the structured data and filtering primitives. The Orchestrator / Comm Plugin parses the human's question, maps it to a query, and composes the human-readable answer.

### Journal vs Event Bus

| Aspect | Event Bus | Session Journal |
|--------|-----------|-----------------|
| **Granularity** | Every event, every component | Meaningful steps, Orchestrator's perspective |
| **Audience** | System internals, debugging, audit, compliance | Human queries, context reconstruction |
| **Content** | Raw event payloads | Summarized, human-readable entries |
| **Retention** | Everything, forever (audit requirement) | Everything per session, knowledge distilled cross-session |
| **Queryability** | By event type, component, task_id, time range | By entry type, phase, tags, semantic content |

Complementary, not redundant. The Event Bus answers "what happened in the system?" The journal answers "what was the agent thinking and doing?"

---

## Session Object Schema

```
Session {
  id:              string          (unique session ID, referenced by Task.session_id)
  task_id:         string          (the task this session belongs to)

  -- Lifecycle --
  started_at:      datetime
  ended_at:        datetime?       (null if active)
  end_reason:      "completed" | "preempted" | "crashed" | "new_session" | null

  -- Journal --
  journal:         JournalEntry[]  (append-only, ordered by timestamp)

  -- Checkpoints --
  checkpoints:     Checkpoint[]    (ordered by timestamp)
  latest_checkpoint_id: string?    (shortcut to most recent)

  -- Continuation --
  previous_session_id: string?     (for multi-session tasks -- links to prior session)
  resumed_from_checkpoint: string? (which checkpoint was used to resume)
}
```

### Multi-Session Task Flow

A task that spans multiple sessions (e.g., OAuth2 migration over 2 days) creates a chain of Session objects linked by `previous_session_id`. The Task object's `session_id` always points to the most recent session.

```
Day 1 morning: Task #50 starts
  Session S1 created (task_id=#50)
  Journal entries accumulate
  Checkpoint C1 (reason: phase_transition, phase: research complete)
  Checkpoint C2 (reason: phase_transition, phase: planning complete)
  Checkpoint C3 (reason: periodic, mid-execution)
  Agent preempted for higher-priority task
  Checkpoint C4 (reason: preemption)
  Session S1 ends (end_reason: "preempted")

Day 1 afternoon: Higher-priority task finishes
  Session S2 created (task_id=#50, previous_session_id: S1, resumed_from: C4)
  Context reconstructed from C4
  Work continues
  Session S2 ends (end_reason: "new_session")

Day 2: Agent resumes
  Session S3 created (task_id=#50, previous_session_id: S2)
  Work continues to completion
  Session S3 ends (end_reason: "completed")
```

To query the full history: follow the session chain S3 -> S2 -> S1.

---

## Dashboard Vision

The Event Bus audit trail, Session Journal, and Task history together form the data foundation for a comprehensive **Engineer Dashboard**. The goal: runners of The Engineer can see EVERYTHING in one place -- past work, live status, and thorough analytics.

This is a downstream goal that Session/Memory enables but does not implement at this layer. The key architectural enabler: by keeping Event Bus (system-level) and Session Journal (agent-level) as separate, complementary data sources, we preserve maximum analytical flexibility. Both can be aggregated, correlated, and visualized in ways that neither could support alone.

What the dashboard would surface:
- Live task status and agent activity
- Full history of completed tasks with decision trails
- Performance analytics (time per phase, review rounds, error rates)
- Knowledge accumulation over time
- Cost tracking and resource utilization
- Predictive insights (future possibility -- e.g., estimating task complexity from historical data)

---

## Operations

Session/Memory is pure storage. It provides these operations:

**Session lifecycle:**
- `createSession(task_id, previous_session_id?) -> Session`
- `endSession(session_id, reason)`

**Journal:**
- `appendJournal(session_id, entry: JournalEntry)`

**Checkpoints:**
- `createCheckpoint(session_id, checkpoint: Checkpoint)`
- `getLatestCheckpoint(session_id) -> Checkpoint`

**Queries:**
- `queryJournal(task_id, filters: {type?, phase?, tags?, since?}) -> JournalEntry[]`
- `getSessionChain(task_id) -> Session[]` (full history across all sessions)

**Knowledge:**
- `storeKnowledge(entry: KnowledgeEntry)`
- `queryKnowledge(scope, repo_scope?, domain?, keywords?) -> KnowledgeEntry[]`
- `supersedeKnowledge(old_id, new_id)`
- `confirmKnowledge(id)` (updates last_confirmed)

---

## Gaps Resolved

| # | Gap | Resolution |
|---|-----|-----------|
| 2 | Mid-phase checkpointing and resume | WAL-inspired session journal with explicit checkpoints. Four triggers (phase transition, pre-costly-op, preemption, periodic). Resume via context reconstruction, not conversation replay. Multi-session tasks linked by session chain. |
| 7 | Cross-task knowledge sharing | Two knowledge scopes: repo (isolated per repository) and user (global preferences). Immutable KnowledgeEntry objects with confidence levels and supersession. Precedence: Repo > User > Defaults. |
| 21 | Session log queryability | Typed JournalEntry objects (7 types) in append-only journal. Structured filtering by type, phase, tags. Supports "what have you tried?", "why did you decide X?", and status queries. Complementary to Event Bus. |

---

## Open Questions for Layer 3

- **Journal entry generation**: How does the Orchestrator decide what merits a journal entry vs what's too granular? (Orchestrator design)
- **Context summary quality**: How are checkpoint `context_summary` values generated? LLM self-summarization? Template-based? (Orchestrator design)
- **Knowledge retrieval ranking**: When there are many entries for a repo, how does the Orchestrator determine relevance? Keyword match? Embedding similarity? (Layer 3 or 4)
- **Storage backend**: File-based? SQLite? Postgres? The schema is backend-agnostic. (Layer 4: Implementation Design)
- **Session journal compaction**: For very long tasks, the journal could grow large. Summarization of old entries? (Layer 3)
- **Event Bus cross-reference**: Should individual journal entries reference specific event IDs for drill-down? (Layer 3: Interactions & Protocols)
