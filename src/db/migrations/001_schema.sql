-- Core domain schema for The Engineer.
-- Single source of truth — consolidated from all prior migrations.

-- ── tasks ────────────────────────────────────────────────────────────────────────

CREATE TABLE tasks (
  -- Identity
  id                      TEXT PRIMARY KEY,
  external_ref            TEXT,
  idempotency_key         TEXT NOT NULL,

  -- State
  state                   TEXT NOT NULL CHECK(state IN ('requirements_gathering','queued','active','blocked','review_pending','completed','failed')),
  sub_state               TEXT CHECK(sub_state IN ('working','code')),
  phase                   TEXT,

  -- Context
  title                   TEXT NOT NULL,
  description             TEXT NOT NULL DEFAULT '',
  source_text             TEXT NOT NULL DEFAULT '',
  acceptance_criteria     TEXT NOT NULL DEFAULT '[]',
  team                    TEXT NOT NULL DEFAULT '[]',
  related                 TEXT NOT NULL DEFAULT '[]',
  decisions               TEXT NOT NULL DEFAULT '[]',

  -- Workspace
  repo                    TEXT,
  clone_url               TEXT,
  thoughts_id             TEXT,
  workspace               TEXT,

  -- Review
  review                  TEXT,

  -- Blocked
  blocked                 TEXT,

  -- Tracking
  priority                INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 1 AND 100),
  agent_tokens            INTEGER NOT NULL DEFAULT 0,
  agent_cost_usd          REAL NOT NULL DEFAULT 0.0,
  compute_time_ms         INTEGER NOT NULL DEFAULT 0,

  -- Timestamps
  created_at              TEXT NOT NULL,
  started_at              TEXT,
  completed_at            TEXT,
  last_transition_at      TEXT NOT NULL,

  -- Session link
  session_id              TEXT REFERENCES sessions(id),

  -- Optimistic locking
  version                 INTEGER NOT NULL DEFAULT 1,

  -- Pipeline state
  return_to_phase         TEXT,
  loopback_count          INTEGER NOT NULL DEFAULT 0,
  requirements_loop_count INTEGER NOT NULL DEFAULT 0,

  -- Scheduling
  not_before              TEXT,
  consecutive_crash_count INTEGER NOT NULL DEFAULT 0,
  consecutive_agent_unavailable_count INTEGER NOT NULL DEFAULT 0,

  -- Complexity-based phase skipping
  skip_research           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_tasks_state ON tasks(state);
CREATE INDEX idx_tasks_session_id ON tasks(session_id);
CREATE INDEX idx_tasks_priority ON tasks(priority DESC);
CREATE INDEX idx_tasks_state_priority ON tasks(state, priority DESC);
-- Active-scoped dedup: no two non-terminal tasks may share an idempotency_key.
-- A terminal task (completed/failed) frees its key, so a re-triggered source
-- (e.g. a reopened GitHub issue) can spawn a fresh task. Identity/dedup rides on
-- idempotency_key; external_ref is descriptive only.
CREATE UNIQUE INDEX idx_tasks_idempotency_key_active
  ON tasks(idempotency_key)
  WHERE state NOT IN ('completed', 'failed');

-- ── state_transitions ────────────────────────────────────────────────────────────

CREATE TABLE state_transitions (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  from_state      TEXT NOT NULL CHECK(from_state IN ('requirements_gathering','queued','active','blocked','review_pending','completed','failed')),
  to_state        TEXT NOT NULL CHECK(to_state IN ('requirements_gathering','queued','active','blocked','review_pending','completed','failed')),
  from_sub        TEXT CHECK(from_sub IN ('working','code')),
  to_sub          TEXT CHECK(to_sub IN ('working','code')),
  reason          TEXT NOT NULL,
  timestamp       TEXT NOT NULL,
  triggered_by    TEXT NOT NULL
);

CREATE INDEX idx_state_transitions_task_id ON state_transitions(task_id);
CREATE INDEX idx_state_transitions_to_state ON state_transitions(to_state);
CREATE INDEX idx_state_transitions_timestamp ON state_transitions(timestamp);

-- ── events ───────────────────────────────────────────────────────────────────────

CREATE TABLE events (
  id              TEXT NOT NULL,
  sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,
  source          TEXT NOT NULL,
  task_id         TEXT,
  timestamp       TEXT NOT NULL,
  payload         TEXT NOT NULL
);

CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_task_id ON events(task_id);
CREATE INDEX idx_events_task_sequence ON events(task_id, sequence);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE UNIQUE INDEX idx_events_id ON events(id);

-- ── sessions ─────────────────────────────────────────────────────────────────────

CREATE TABLE sessions (
  id                      TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL REFERENCES tasks(id),
  started_at              TEXT NOT NULL,
  ended_at                TEXT,
  end_reason              TEXT CHECK(end_reason IN ('completed','preempted','crashed','review_pending','blocked'))
);

CREATE INDEX idx_sessions_task_id ON sessions(task_id);

-- ── journal_entries ──────────────────────────────────────────────────────────────

CREATE TABLE journal_entries (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  timestamp       TEXT NOT NULL,
  phase           TEXT NOT NULL,
  type            TEXT NOT NULL CHECK(type IN ('error','phase_change','checkpoint_marker')),
  summary         TEXT NOT NULL,
  detail          TEXT,
  error_detail    TEXT,
  tags            TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_journal_session_id ON journal_entries(session_id);
CREATE INDEX idx_journal_task_id ON journal_entries(task_id);
CREATE INDEX idx_journal_type ON journal_entries(type);
CREATE INDEX idx_journal_phase ON journal_entries(phase);
CREATE INDEX idx_journal_timestamp ON journal_entries(timestamp);

-- ── checkpoints ──────────────────────────────────────────────────────────────────

CREATE TABLE checkpoints (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  phase           TEXT NOT NULL,
  phase_progress  TEXT NOT NULL,
  context_summary TEXT NOT NULL,
  key_findings    TEXT NOT NULL DEFAULT '[]',
  open_questions  TEXT NOT NULL DEFAULT '[]',
  next_action     TEXT NOT NULL,
  last_event_id   TEXT NOT NULL,
  workspace_ref   TEXT,
  reason          TEXT NOT NULL CHECK(reason IN ('phase_transition','preemption')),
  timestamp       TEXT NOT NULL,
  journal_offset  INTEGER NOT NULL
);

CREATE INDEX idx_checkpoints_session_id ON checkpoints(session_id);
CREATE INDEX idx_checkpoints_task_id ON checkpoints(task_id);
CREATE INDEX idx_checkpoints_timestamp ON checkpoints(timestamp);

-- ── plugin_state ────────────────────────────────────────────────────────────────

CREATE TABLE plugin_state (
  plugin_id       TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);
