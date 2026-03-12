-- 002_observability.sql
-- Observability tables: action traces, phase metrics, LLM traces.
-- Source of truth: Phase 6.9 plan (War Room Dashboard)

-- ── action_traces ──────────────────────────────────────────────────────────────

CREATE TABLE action_traces (
  id              TEXT PRIMARY KEY,           -- ULID
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  trace_id        TEXT NOT NULL,              -- correlates one executeTask() call
  phase           TEXT NOT NULL,
  iteration       INTEGER NOT NULL,           -- 1-based within the phase
  action_type     TEXT NOT NULL,              -- read_file, write_file, run_command, done, etc.
  action_params   TEXT,                       -- JSON, truncated to 4KB
  result_success  INTEGER NOT NULL,           -- 0 = false, 1 = true
  result_output   TEXT,                       -- truncated to 2KB
  result_error    TEXT,
  duration_ms     INTEGER,                    -- nullable for "done" actions
  timestamp       TEXT NOT NULL               -- ISO 8601
);

CREATE INDEX idx_action_traces_task_id    ON action_traces(task_id);
CREATE INDEX idx_action_traces_trace_id   ON action_traces(trace_id);
CREATE INDEX idx_action_traces_phase      ON action_traces(task_id, phase);
CREATE INDEX idx_action_traces_timestamp  ON action_traces(timestamp);

-- ── phase_metrics ──────────────────────────────────────────────────────────────

CREATE TABLE phase_metrics (
  id              TEXT PRIMARY KEY,           -- ULID
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  trace_id        TEXT NOT NULL,
  phase           TEXT NOT NULL,
  started_at      TEXT NOT NULL,              -- ISO 8601
  ended_at        TEXT,                       -- NULL while phase is running
  duration_ms     INTEGER,
  llm_iterations  INTEGER NOT NULL DEFAULT 0,
  tokens_in       INTEGER NOT NULL DEFAULT 0,
  tokens_out      INTEGER NOT NULL DEFAULT 0,
  spend_usd       REAL,
  actions_executed INTEGER NOT NULL DEFAULT 0,
  actions_failed  INTEGER NOT NULL DEFAULT 0,
  outcome         TEXT                        -- completed, error, preempted, loopback
);

CREATE INDEX idx_phase_metrics_task_id  ON phase_metrics(task_id);
CREATE INDEX idx_phase_metrics_trace_id ON phase_metrics(trace_id);

-- ── llm_traces ─────────────────────────────────────────────────────────────────

CREATE TABLE llm_traces (
  id              TEXT PRIMARY KEY,           -- ULID
  task_id         TEXT NOT NULL REFERENCES tasks(id),
  trace_id        TEXT NOT NULL,
  phase           TEXT NOT NULL,
  iteration       INTEGER NOT NULL,
  prompt_length   INTEGER NOT NULL,           -- character count
  response_length INTEGER NOT NULL,
  tokens_in       INTEGER NOT NULL,
  tokens_out      INTEGER NOT NULL,
  spend_usd       REAL,
  latency_ms      INTEGER NOT NULL,
  provider_id     TEXT NOT NULL,              -- e.g. "claude-code-llm"
  model_id        TEXT,
  finish_reason   TEXT,
  prompt_ref      TEXT,                       -- content-addressable blob reference
  response_ref    TEXT,                       -- content-addressable blob reference
  timestamp       TEXT NOT NULL               -- ISO 8601
);

CREATE INDEX idx_llm_traces_task_id   ON llm_traces(task_id);
CREATE INDEX idx_llm_traces_trace_id  ON llm_traces(trace_id);
CREATE INDEX idx_llm_traces_timestamp ON llm_traces(timestamp);
