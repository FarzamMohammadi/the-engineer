-- 001_initial.sql
-- All 7 domain tables + indexes for The Engineer.
-- Source of truth: implementation-docs/4-implementation/schemas/sqlite.md

-- ── tasks ────────────────────────────────────────────────────────────────────────

CREATE TABLE tasks (
  -- Identity
  id                  TEXT PRIMARY KEY,           -- ULID
  external_ref        TEXT,                       -- JSON: ExternalRef | null

  -- State
  state               TEXT NOT NULL CHECK(state IN ('intake','queued','active','blocked','review_pending','completed','failed')),
  sub_state           TEXT CHECK(sub_state IN ('working','supervising','integrating','demo','code')),
  phase               TEXT,                       -- Orchestrator phase: "research", "planning", etc.

  -- Hierarchy
  parent_id           TEXT REFERENCES tasks(id),
  children            TEXT NOT NULL DEFAULT '[]', -- JSON: ChildEntry[]
  cascade_policy      TEXT NOT NULL DEFAULT 'pause_siblings' CHECK(cascade_policy IN ('pause_siblings','fail_fast','best_effort','manual')),

  -- Context
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  source_text         TEXT NOT NULL DEFAULT '',   -- original issue body, verbatim
  acceptance_criteria TEXT NOT NULL DEFAULT '[]', -- JSON: string[]
  team                TEXT NOT NULL DEFAULT '[]', -- JSON: TeamMember[]
  related             TEXT NOT NULL DEFAULT '[]', -- JSON: RelatedItem[]
  decisions           TEXT NOT NULL DEFAULT '[]', -- JSON: TaskDecision[]
  child_summaries     TEXT NOT NULL DEFAULT '[]', -- JSON: ChildCompletionSummary[]

  -- Workspace
  workspace           TEXT,                       -- JSON: TaskWorkspace | null

  -- Review
  review              TEXT,                       -- JSON: ReviewState | null

  -- Blocked
  blocked             TEXT,                       -- JSON: BlockedDetails | null

  -- Tracking (real columns — hot-path counters)
  priority            INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 1 AND 100),
  llm_tokens          INTEGER NOT NULL DEFAULT 0,
  llm_cost_usd        REAL NOT NULL DEFAULT 0.0,
  compute_time_ms     INTEGER NOT NULL DEFAULT 0,

  -- Timestamps
  created_at          TEXT NOT NULL,              -- ISO 8601
  started_at          TEXT,                       -- first time entering Active
  completed_at        TEXT,
  last_transition_at  TEXT NOT NULL,

  -- Session link (nullable — task may not have a session yet)
  session_id          TEXT REFERENCES sessions(id)
);

CREATE INDEX idx_tasks_state ON tasks(state);
CREATE INDEX idx_tasks_parent_id ON tasks(parent_id);
CREATE INDEX idx_tasks_session_id ON tasks(session_id);
CREATE INDEX idx_tasks_priority ON tasks(priority DESC);
CREATE INDEX idx_tasks_state_priority ON tasks(state, priority DESC);

-- ── state_transitions ────────────────────────────────────────────────────────────

CREATE TABLE state_transitions (
  id                  TEXT PRIMARY KEY,           -- ULID
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  from_state          TEXT NOT NULL CHECK(from_state IN ('intake','queued','active','blocked','review_pending','completed','failed')),
  to_state            TEXT NOT NULL CHECK(to_state IN ('intake','queued','active','blocked','review_pending','completed','failed')),
  from_sub            TEXT CHECK(from_sub IN ('working','supervising','integrating','demo','code')),
  to_sub              TEXT CHECK(to_sub IN ('working','supervising','integrating','demo','code')),
  reason              TEXT NOT NULL,
  timestamp           TEXT NOT NULL,              -- ISO 8601
  triggered_by        TEXT NOT NULL               -- component or event ID
);

CREATE INDEX idx_state_transitions_task_id ON state_transitions(task_id);
CREATE INDEX idx_state_transitions_to_state ON state_transitions(to_state);
CREATE INDEX idx_state_transitions_timestamp ON state_transitions(timestamp);

-- ── events ───────────────────────────────────────────────────────────────────────

CREATE TABLE events (
  id                  TEXT NOT NULL,              -- ULID — correlation key
  sequence            INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic ordering key
  type                TEXT NOT NULL,              -- "task.state_changed", "git.pushed", etc.
  source              TEXT NOT NULL,              -- emitting component
  task_id             TEXT,                       -- null for system-level events
  timestamp           TEXT NOT NULL,              -- ISO 8601
  payload             TEXT NOT NULL               -- JSON blob — type-specific payload
);

CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_task_id ON events(task_id);
CREATE INDEX idx_events_task_sequence ON events(task_id, sequence);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE UNIQUE INDEX idx_events_id ON events(id);

-- ── sessions ─────────────────────────────────────────────────────────────────────

CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,           -- ULID
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  started_at          TEXT NOT NULL,              -- ISO 8601
  ended_at            TEXT,                       -- null if active
  end_reason          TEXT CHECK(end_reason IN ('completed','preempted','crashed','new_session')),
  previous_session_id TEXT,                       -- for multi-session tasks
  resumed_from_checkpoint TEXT                    -- checkpoint ID used to resume
);

CREATE INDEX idx_sessions_task_id ON sessions(task_id);

-- ── journal_entries ──────────────────────────────────────────────────────────────

CREATE TABLE journal_entries (
  id                  TEXT PRIMARY KEY,           -- ULID
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  task_id             TEXT NOT NULL REFERENCES tasks(id), -- denormalized for direct queries
  timestamp           TEXT NOT NULL,              -- ISO 8601
  phase               TEXT NOT NULL,              -- Orchestrator phase at time of entry

  type                TEXT NOT NULL CHECK(type IN ('action','finding','decision','error','communication','phase_change','checkpoint_marker')),

  -- Content
  summary             TEXT NOT NULL,              -- one-liner
  detail              TEXT,                       -- longer explanation

  -- Type-specific (nullable — only populated for matching type)
  action_type         TEXT,                       -- "file_read", "test_run", "code_write", "llm_call"
  finding_type        TEXT,                       -- "pattern", "bug", "convention", "dependency"
  decision_key        TEXT,                       -- what was decided
  error_detail        TEXT,                       -- what went wrong
  comm_target         TEXT,                       -- who was contacted

  -- Queryability
  tags                TEXT NOT NULL DEFAULT '[]'  -- JSON: string[]
);

CREATE INDEX idx_journal_session_id ON journal_entries(session_id);
CREATE INDEX idx_journal_task_id ON journal_entries(task_id);
CREATE INDEX idx_journal_type ON journal_entries(type);
CREATE INDEX idx_journal_phase ON journal_entries(phase);
CREATE INDEX idx_journal_timestamp ON journal_entries(timestamp);

-- ── checkpoints ──────────────────────────────────────────────────────────────────

CREATE TABLE checkpoints (
  id                  TEXT PRIMARY KEY,           -- ULID
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  task_id             TEXT NOT NULL REFERENCES tasks(id), -- denormalized

  -- Position
  phase               TEXT NOT NULL,
  phase_progress      TEXT NOT NULL,              -- free-text progress description

  -- Context reconstruction
  context_summary     TEXT NOT NULL,              -- compressed LLM conversation summary
  key_findings        TEXT NOT NULL DEFAULT '[]', -- JSON: string[]
  open_questions      TEXT NOT NULL DEFAULT '[]', -- JSON: string[]
  next_action         TEXT NOT NULL,              -- what the agent was about to do

  -- References
  last_event_id       TEXT NOT NULL,              -- ULID pointer into events
  workspace_ref       TEXT,                       -- JSON: { branch, last_commit } | null

  -- Metadata
  reason              TEXT NOT NULL CHECK(reason IN ('phase_transition','preemption','pre_costly_op','periodic')),
  timestamp           TEXT NOT NULL,              -- ISO 8601
  journal_offset      INTEGER NOT NULL            -- index into journal — entries before this are covered
);

CREATE INDEX idx_checkpoints_session_id ON checkpoints(session_id);
CREATE INDEX idx_checkpoints_task_id ON checkpoints(task_id);
CREATE INDEX idx_checkpoints_timestamp ON checkpoints(timestamp);

-- ── knowledge ────────────────────────────────────────────────────────────────────

CREATE TABLE knowledge (
  -- Identity (content hash, not ULID)
  id                  TEXT PRIMARY KEY,           -- hash(scope + key + body), 32-char hex

  -- Scope
  scope               TEXT NOT NULL CHECK(scope IN ('repo','user')),
  repo_scope          TEXT,                       -- "owner/repo" — required when scope='repo'
  domain              TEXT NOT NULL CHECK(domain IN ('conventions','patterns','gotchas','domain','tooling','preferences')),

  -- Content
  key                 TEXT NOT NULL,              -- what this is about
  body                TEXT NOT NULL,              -- the actual knowledge
  confidence          TEXT NOT NULL CHECK(confidence IN ('observed','inferred','told')),
  evidence            TEXT NOT NULL DEFAULT '[]', -- JSON: KnowledgeEvidence[]

  -- Lifecycle
  created_at          TEXT NOT NULL,              -- ISO 8601
  last_confirmed      TEXT NOT NULL,              -- ISO 8601
  superseded_by       TEXT,                       -- ID of newer entry

  -- Provenance
  source_task_id      TEXT NOT NULL,
  source_phase        TEXT NOT NULL
);

CREATE INDEX idx_knowledge_natural_key ON knowledge(scope, repo_scope, key);
CREATE INDEX idx_knowledge_active ON knowledge(scope, repo_scope, superseded_by);
CREATE INDEX idx_knowledge_domain ON knowledge(domain);
