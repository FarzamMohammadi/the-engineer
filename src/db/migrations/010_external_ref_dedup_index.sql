-- Partial index for DB-backed dedup via findByExternalRef().
-- Only indexes non-terminal tasks — smaller, faster, matches the query exactly.
CREATE INDEX IF NOT EXISTS idx_tasks_external_ref_active
  ON tasks(
    json_extract(external_ref, '$.type'),
    json_extract(external_ref, '$.repo'),
    json_extract(external_ref, '$.id')
  )
  WHERE state NOT IN ('completed', 'failed');
