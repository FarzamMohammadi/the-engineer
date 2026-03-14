-- Add optimistic locking version column to tasks table.
-- Existing rows default to version 1. Every state transition increments version
-- and checks WHERE version = ? to detect concurrent modifications.
ALTER TABLE tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
