-- Unified observations table — Langfuse-inspired, immutable rows.
-- Every observation carries full context. Query any dimension directly.

CREATE TABLE observations (
  id                      TEXT PRIMARY KEY,
  trace_id                TEXT,
  parent_observation_id   TEXT,
  type                    TEXT NOT NULL,
  name                    TEXT NOT NULL,
  task_id                 TEXT,
  phase                   TEXT,
  session_id              TEXT,
  start_time              TEXT NOT NULL,
  end_time                TEXT,
  duration_ms             INTEGER,
  input                   TEXT,
  output                  TEXT,
  metadata                TEXT,
  level                   TEXT NOT NULL DEFAULT 'info',
  status                  TEXT NOT NULL DEFAULT 'ok',
  error_message           TEXT
);

CREATE INDEX idx_obs_task ON observations(task_id);
CREATE INDEX idx_obs_trace ON observations(trace_id);
CREATE INDEX idx_obs_type ON observations(type);
CREATE INDEX idx_obs_time ON observations(start_time);
CREATE INDEX idx_obs_type_name ON observations(type, name);
CREATE INDEX idx_obs_parent ON observations(parent_observation_id);
CREATE INDEX idx_obs_task_type ON observations(task_id, type);
CREATE INDEX idx_obs_level ON observations(level);
