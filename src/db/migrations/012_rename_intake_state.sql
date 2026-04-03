-- Migration 012: Rename task state 'intake' → 'requirements_gathering'
-- SQLite CHECK constraints require full table recreation.
-- Fresh project — no data transform needed, just constraint update.

-- ── tasks table ─────────────────────────────────────────────────────────────────

CREATE TABLE tasks_new (
  -- Identity
  id                  TEXT PRIMARY KEY,
  external_ref        TEXT,

  -- State
  state               TEXT NOT NULL CHECK(state IN ('requirements_gathering','queued','active','blocked','review_pending','completed','failed')),
  sub_state           TEXT CHECK(sub_state IN ('working','supervising','integrating','code')),
  phase               TEXT,

  -- Hierarchy
  parent_id           TEXT REFERENCES tasks_new(id),
  children            TEXT NOT NULL DEFAULT '[]',
  cascade_policy      TEXT NOT NULL DEFAULT 'pause_siblings' CHECK(cascade_policy IN ('pause_siblings','fail_fast','best_effort','manual')),

  -- Context
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  source_text         TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  team                TEXT NOT NULL DEFAULT '[]',
  related             TEXT NOT NULL DEFAULT '[]',
  decisions           TEXT NOT NULL DEFAULT '[]',
  child_summaries     TEXT NOT NULL DEFAULT '[]',

  -- Workspace
  repo                TEXT,
  clone_url           TEXT,
  thoughts_id         TEXT,
  workspace           TEXT,

  -- Review
  review              TEXT,

  -- Blocked
  blocked             TEXT,

  -- Tracking
  priority            INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 1 AND 100),
  llm_tokens          INTEGER NOT NULL DEFAULT 0,
  llm_cost_usd        REAL NOT NULL DEFAULT 0.0,
  compute_time_ms     INTEGER NOT NULL DEFAULT 0,

  -- Timestamps
  created_at          TEXT NOT NULL,
  started_at          TEXT,
  completed_at        TEXT,
  last_transition_at  TEXT NOT NULL,

  -- Session link
  session_id          TEXT REFERENCES sessions(id),

  -- Added by later migrations
  version             INTEGER NOT NULL DEFAULT 1,
  return_to_phase     TEXT,
  loopback_count      INTEGER NOT NULL DEFAULT 0,
  requirements_loop_count INTEGER NOT NULL DEFAULT 0,
  not_before          TEXT,
  consecutive_crash_count INTEGER NOT NULL DEFAULT 0
);

INSERT INTO tasks_new SELECT * FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_tasks_state ON tasks(state);
CREATE INDEX idx_tasks_parent_id ON tasks(parent_id);
CREATE INDEX idx_tasks_session_id ON tasks(session_id);
CREATE INDEX idx_tasks_priority ON tasks(priority DESC);
CREATE INDEX idx_tasks_state_priority ON tasks(state, priority DESC);
CREATE INDEX idx_tasks_external_ref_active
  ON tasks(
    json_extract(external_ref, '$.type'),
    json_extract(external_ref, '$.repo'),
    json_extract(external_ref, '$.id')
  )
  WHERE state NOT IN ('completed', 'failed');

-- ── state_transitions table ─────────────────────────────────────────────────────

CREATE TABLE state_transitions_new (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  from_state          TEXT NOT NULL CHECK(from_state IN ('requirements_gathering','queued','active','blocked','review_pending','completed','failed')),
  to_state            TEXT NOT NULL CHECK(to_state IN ('requirements_gathering','queued','active','blocked','review_pending','completed','failed')),
  from_sub            TEXT CHECK(from_sub IN ('working','supervising','integrating','code')),
  to_sub              TEXT CHECK(to_sub IN ('working','supervising','integrating','code')),
  reason              TEXT NOT NULL,
  timestamp           TEXT NOT NULL,
  triggered_by        TEXT NOT NULL
);

INSERT INTO state_transitions_new SELECT * FROM state_transitions;
DROP TABLE state_transitions;
ALTER TABLE state_transitions_new RENAME TO state_transitions;

CREATE INDEX idx_state_transitions_task_id ON state_transitions(task_id);
CREATE INDEX idx_state_transitions_to_state ON state_transitions(to_state);
CREATE INDEX idx_state_transitions_timestamp ON state_transitions(timestamp);
