-- Add missing end_reason values: 'review_pending' and 'decomposed'
-- SQLite doesn't support ALTER CHECK, so recreate the table.

CREATE TABLE sessions_new (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  end_reason          TEXT CHECK(end_reason IN ('completed','preempted','crashed','new_session','decomposed','review_pending')),
  previous_session_id TEXT,
  resumed_from_checkpoint TEXT
);

INSERT INTO sessions_new SELECT * FROM sessions;

DROP TABLE sessions;

ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX idx_sessions_task_id ON sessions(task_id);
