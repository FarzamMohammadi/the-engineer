-- Unified observations table — Langfuse-inspired, immutable rows, no joins needed.
-- Every observation carries full context. Query any dimension directly.
-- Powers the War Room dashboard (Phase R-0).

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,                    -- ULID
  trace_id TEXT,                          -- Correlation ID (per executeTask call)
  parent_observation_id TEXT,             -- For span nesting (NULL = root)
  type TEXT NOT NULL,                     -- ObservationType enum
  name TEXT NOT NULL,                     -- Specific event name
  task_id TEXT,                           -- Context: which task
  phase TEXT,                             -- Context: which orchestrator phase
  session_id TEXT,                        -- Context: which session
  start_time TEXT NOT NULL,               -- ISO 8601
  end_time TEXT,                          -- NULL for instant observations
  duration_ms INTEGER,                    -- Auto-computed on span.end()
  input TEXT,                             -- JSON: what went in
  output TEXT,                            -- JSON: what came out
  metadata TEXT,                          -- JSON: extra context, cost snapshots, etc.
  level TEXT NOT NULL DEFAULT 'info',     -- debug/info/warn/error
  status TEXT NOT NULL DEFAULT 'ok',      -- ok/error
  error_message TEXT                      -- Sanitized error message if status=error
);

-- Query patterns the War Room needs:
CREATE INDEX IF NOT EXISTS idx_obs_task ON observations(task_id);
CREATE INDEX IF NOT EXISTS idx_obs_trace ON observations(trace_id);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_time ON observations(start_time);
CREATE INDEX IF NOT EXISTS idx_obs_type_name ON observations(type, name);
CREATE INDEX IF NOT EXISTS idx_obs_parent ON observations(parent_observation_id);
CREATE INDEX IF NOT EXISTS idx_obs_task_type ON observations(task_id, type);
CREATE INDEX IF NOT EXISTS idx_obs_level ON observations(level);
