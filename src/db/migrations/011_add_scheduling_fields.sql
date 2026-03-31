-- Migration 011: Add scheduling fields for retry backoff
-- Adds not_before (ISO 8601 timestamp gate for scheduling eligibility)
-- and consecutive_crash_count (crash retry counter for backoff schedule).

ALTER TABLE tasks ADD COLUMN not_before TEXT;
ALTER TABLE tasks ADD COLUMN consecutive_crash_count INTEGER NOT NULL DEFAULT 0;
