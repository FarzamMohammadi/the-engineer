-- Add skip_research flag for complexity-based research phase skipping.
-- Persisted for crash recovery: if the daemon restarts mid-pipeline,
-- the phase runner rebuilds the correct (shortened) phase sequence.
ALTER TABLE tasks ADD COLUMN skip_research INTEGER NOT NULL DEFAULT 0;
