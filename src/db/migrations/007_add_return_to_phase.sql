-- Add return_to_phase column to persist which phase to resume after
-- a blocked task is re-dispatched through requirements_gathering.
ALTER TABLE tasks ADD COLUMN return_to_phase TEXT;
