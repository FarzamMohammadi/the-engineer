-- Add loopback count columns to persist pipeline loop counters across crashes.
-- Without these, a crash mid-pipeline resets both counters to 0, allowing infinite loops.
ALTER TABLE tasks ADD COLUMN loopback_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN requirements_loop_count INTEGER NOT NULL DEFAULT 0;
