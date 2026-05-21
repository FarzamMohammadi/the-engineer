# SQLite Schema

CREATE TABLE statements, indexes, and migration approach for all 7 tables + `_meta`. Source: all schema files in this directory.

**Engine:** `better-sqlite3` (synchronous API). **Mode:** WAL (Write-Ahead Logging) for concurrent reads during writes. **No ORM** — raw SQL with prepared statements.

---

## Table: `tasks`

The largest and most queried table. Real columns for frequently filtered/sorted fields; JSON columns for nested structures.

```sql
CREATE TABLE tasks (
  -- Identity
  id                  TEXT PRIMARY KEY,           -- ULID
  external_ref        TEXT,                       -- JSON: ExternalRef | null

  -- State
  state               TEXT NOT NULL CHECK(state IN ('intake','queued','active','blocked','review_pending','completed','failed')),
  sub_state           TEXT CHECK(sub_state IN ('working','supervising','integrating','demo','code')),
  phase               TEXT,                       -- Orchestrator phase: "research", "planning", etc.

  -- Hierarchy
  parent_id           TEXT REFERENCES tasks(id),
  children            TEXT NOT NULL DEFAULT '[]', -- JSON: ChildEntry[]
  cascade_policy      TEXT NOT NULL DEFAULT 'pause_siblings' CHECK(cascade_policy IN ('pause_siblings','fail_fast','best_effort','manual')),

  -- Context
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  source_text         TEXT NOT NULL DEFAULT '',   -- original issue body, verbatim
  acceptance_criteria TEXT NOT NULL DEFAULT '[]', -- JSON: string[]
  team                TEXT NOT NULL DEFAULT '[]', -- JSON: TeamMember[]
  related             TEXT NOT NULL DEFAULT '[]', -- JSON: RelatedItem[]
  decisions           TEXT NOT NULL DEFAULT '[]', -- JSON: TaskDecision[]
  child_summaries     TEXT NOT NULL DEFAULT '[]', -- JSON: ChildCompletionSummary[]

  -- Workspace
  workspace           TEXT,                       -- JSON: TaskWorkspace | null

  -- Review
  review              TEXT,                       -- JSON: ReviewState | null

  -- Blocked
  blocked             TEXT,                       -- JSON: BlockedDetails | null

  -- Tracking (real columns — hot-path counters)
  priority            INTEGER NOT NULL DEFAULT 50 CHECK(priority BETWEEN 1 AND 100),
  llm_tokens          INTEGER NOT NULL DEFAULT 0,
  llm_cost_usd        REAL NOT NULL DEFAULT 0.0,
  compute_time_ms     INTEGER NOT NULL DEFAULT 0,

  -- Timestamps
  created_at          TEXT NOT NULL,              -- ISO 8601
  started_at          TEXT,                       -- first time entering Active
  completed_at        TEXT,
  last_transition_at  TEXT NOT NULL,

  -- Session link
  session_id          TEXT                        -- FK to sessions.id
);
```

### Indexes

```sql
CREATE INDEX idx_tasks_state ON tasks(state);
CREATE INDEX idx_tasks_parent_id ON tasks(parent_id);
CREATE INDEX idx_tasks_session_id ON tasks(session_id);
CREATE INDEX idx_tasks_priority ON tasks(priority DESC);
CREATE INDEX idx_tasks_state_priority ON tasks(state, priority DESC); -- scheduler hot path
```

---

## Table: `state_transitions`

Append-only audit trail. Every task state change is recorded.

```sql
CREATE TABLE state_transitions (
  id                  TEXT PRIMARY KEY,           -- ULID
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  from_state          TEXT NOT NULL CHECK(from_state IN ('intake','queued','active','blocked','review_pending','completed','failed')),
  to_state            TEXT NOT NULL CHECK(to_state IN ('intake','queued','active','blocked','review_pending','completed','failed')),
  from_sub            TEXT CHECK(from_sub IN ('working','supervising','integrating','demo','code')),
  to_sub              TEXT CHECK(to_sub IN ('working','supervising','integrating','demo','code')),
  reason              TEXT NOT NULL,
  timestamp           TEXT NOT NULL,              -- ISO 8601
  triggered_by        TEXT NOT NULL               -- component or event ID
);
```

### Indexes

```sql
CREATE INDEX idx_state_transitions_task_id ON state_transitions(task_id);
CREATE INDEX idx_state_transitions_to_state ON state_transitions(to_state);
CREATE INDEX idx_state_transitions_timestamp ON state_transitions(timestamp);
```

---

## Table: `events`

Append-only event log. The Event Bus persists every event for replay and audit.

```sql
CREATE TABLE events (
  id                  TEXT NOT NULL,              -- ULID — correlation key
  sequence            INTEGER PRIMARY KEY AUTOINCREMENT, -- monotonic ordering key
  type                TEXT NOT NULL,              -- "task.state_changed", "git.pushed", etc.
  source              TEXT NOT NULL,              -- emitting component
  task_id             TEXT,                       -- null for system-level events
  timestamp           TEXT NOT NULL,              -- ISO 8601
  payload             TEXT NOT NULL               -- JSON blob — type-specific payload
);
```

### Indexes

```sql
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_task_id ON events(task_id);
CREATE INDEX idx_events_task_sequence ON events(task_id, sequence); -- per-task ordered event retrieval
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE UNIQUE INDEX idx_events_id ON events(id);  -- ULID uniqueness (id is NOT the PK)
```

> **Note on `id` vs `sequence`:** `sequence` is the PRIMARY KEY (auto-increment integer) used for ordering and replay queries (`WHERE sequence > ?`). `id` (ULID) is the globally unique correlation key referenced from checkpoints and journal entries. Both exist because they serve different purposes — `sequence` for ordering, `id` for cross-system references.

---

## Table: `sessions`

Lightweight metadata linking a task to its working sessions.

```sql
CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,           -- ULID
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  started_at          TEXT NOT NULL,              -- ISO 8601
  ended_at            TEXT,                       -- null if active
  end_reason          TEXT CHECK(end_reason IN ('completed','preempted','crashed','new_session')),
  previous_session_id TEXT,                       -- for multi-session tasks
  resumed_from_checkpoint TEXT                    -- checkpoint ID used to resume
);
```

### Indexes

```sql
CREATE INDEX idx_sessions_task_id ON sessions(task_id);
```

---

## Table: `journal_entries`

Append-only log of the Orchestrator's working narrative.

```sql
CREATE TABLE journal_entries (
  id                  TEXT PRIMARY KEY,           -- ULID
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  task_id             TEXT NOT NULL REFERENCES tasks(id), -- denormalized for direct queries
  timestamp           TEXT NOT NULL,              -- ISO 8601
  phase               TEXT NOT NULL,              -- Orchestrator phase at time of entry

  type                TEXT NOT NULL CHECK(type IN ('action','finding','decision','error','communication','phase_change','checkpoint_marker')),

  -- Content
  summary             TEXT NOT NULL,              -- one-liner
  detail              TEXT,                       -- longer explanation

  -- Type-specific (nullable — only populated for matching type)
  action_type         TEXT,                       -- "file_read", "test_run", "code_write", "llm_call"
  finding_type        TEXT,                       -- "pattern", "bug", "convention", "dependency"
  decision_key        TEXT,                       -- what was decided
  error_detail        TEXT,                       -- what went wrong
  comm_target         TEXT,                       -- who was contacted

  -- Queryability
  tags                TEXT NOT NULL DEFAULT '[]'  -- JSON: string[]
);
```

### Indexes

```sql
CREATE INDEX idx_journal_session_id ON journal_entries(session_id);
CREATE INDEX idx_journal_task_id ON journal_entries(task_id);
CREATE INDEX idx_journal_type ON journal_entries(type);
CREATE INDEX idx_journal_phase ON journal_entries(phase);
CREATE INDEX idx_journal_timestamp ON journal_entries(timestamp);
```

> **Tag queries:** Use `json_each()` for tag-based filtering: `SELECT * FROM journal_entries, json_each(tags) WHERE json_each.value = 'auth'`.

---

## Table: `checkpoints`

Named snapshots for crash recovery and session resume.

```sql
CREATE TABLE checkpoints (
  id                  TEXT PRIMARY KEY,           -- ULID
  session_id          TEXT NOT NULL REFERENCES sessions(id),
  task_id             TEXT NOT NULL REFERENCES tasks(id), -- denormalized

  -- Position
  phase               TEXT NOT NULL,
  phase_progress      TEXT NOT NULL,              -- free-text progress description

  -- Context reconstruction
  context_summary     TEXT NOT NULL,              -- compressed LLM conversation summary
  key_findings        TEXT NOT NULL DEFAULT '[]', -- JSON: string[]
  open_questions      TEXT NOT NULL DEFAULT '[]', -- JSON: string[]
  next_action         TEXT NOT NULL,              -- what the agent was about to do

  -- References
  last_event_id       TEXT NOT NULL,              -- ULID pointer into events
  workspace_ref       TEXT,                       -- JSON: { branch, last_commit } | null

  -- Metadata
  reason              TEXT NOT NULL CHECK(reason IN ('phase_transition','preemption','pre_costly_op','periodic')),
  timestamp           TEXT NOT NULL,              -- ISO 8601
  journal_offset      INTEGER NOT NULL            -- index into journal — entries before this are covered
);
```

### Indexes

```sql
CREATE INDEX idx_checkpoints_session_id ON checkpoints(session_id);
CREATE INDEX idx_checkpoints_task_id ON checkpoints(task_id);
CREATE INDEX idx_checkpoints_timestamp ON checkpoints(timestamp);
```

---

## Table: `knowledge`

Persistent learnings. Content-hashed IDs for immutability.

```sql
CREATE TABLE knowledge (
  -- Identity (content hash, not ULID)
  id                  TEXT PRIMARY KEY,           -- hash(scope + key + body), 32-char hex

  -- Scope
  scope               TEXT NOT NULL CHECK(scope IN ('repo','user')),
  repo_scope          TEXT,                       -- "owner/repo" — required when scope='repo'
  domain              TEXT NOT NULL CHECK(domain IN ('conventions','patterns','gotchas','domain','tooling','preferences')),

  -- Content
  key                 TEXT NOT NULL,              -- what this is about
  body                TEXT NOT NULL,              -- the actual knowledge
  confidence          TEXT NOT NULL CHECK(confidence IN ('observed','inferred','told')),
  evidence            TEXT NOT NULL DEFAULT '[]', -- JSON: KnowledgeEvidence[]

  -- Lifecycle
  created_at          TEXT NOT NULL,              -- ISO 8601
  last_confirmed      TEXT NOT NULL,              -- ISO 8601
  superseded_by       TEXT,                       -- ID of newer entry

  -- Provenance
  source_task_id      TEXT NOT NULL,
  source_phase        TEXT NOT NULL
);
```

### Indexes

```sql
-- Natural key query: latest version of a knowledge entry
CREATE INDEX idx_knowledge_natural_key ON knowledge(scope, repo_scope, key);

-- Active entries (not superseded)
CREATE INDEX idx_knowledge_active ON knowledge(scope, repo_scope, superseded_by);

-- Domain browsing
CREATE INDEX idx_knowledge_domain ON knowledge(domain);
```

> **Common queries:**
> - Latest version: `WHERE scope=? AND repo_scope=? AND key=? AND superseded_by IS NULL`
> - All active repo knowledge: `WHERE scope='repo' AND repo_scope=? AND superseded_by IS NULL`
> - All active user knowledge: `WHERE scope='user' AND superseded_by IS NULL`

---

## Table: `_meta`

Schema version tracking and system-level key-value storage.

```sql
CREATE TABLE _meta (
  key                 TEXT PRIMARY KEY,
  value               TEXT NOT NULL
);

-- Initial rows
INSERT INTO _meta (key, value) VALUES ('schema_version', '1');
```

### Known Keys

| Key | Value | Purpose |
|-----|-------|---------|
| `schema_version` | Integer as string (e.g., `"1"`) | Current schema version. Compared against migration files on startup. |
| `safety_snapshot` | JSON: `SafetySnapshot` | Safety accumulator snapshot for fast startup. See [`ephemeral.md`](ephemeral.md). |

---

## Index Strategy

### Principles

1. **Index what's queried.** Every `WHERE` clause and `ORDER BY` in a hot path gets an index.
2. **Compound indexes for hot paths.** The scheduler queries `WHERE state = 'queued' ORDER BY priority DESC` — compound index `(state, priority DESC)`.
3. **No over-indexing.** JSON columns are not indexed (too complex, rarely queried independently). Use `json_extract()` when needed.
4. **Append-only tables get timestamp indexes.** Events, journal entries, state transitions, and checkpoints are always queried with time-range filters.

### Hot-Path Queries

| Query | Table | Index Used |
|-------|-------|-----------|
| `SELECT ... FROM tasks WHERE state = 'queued' ORDER BY priority DESC` | tasks | `idx_tasks_state_priority` |
| `SELECT ... FROM tasks WHERE parent_id = ?` | tasks | `idx_tasks_parent_id` |
| `UPDATE tasks SET llm_tokens = llm_tokens + ?, llm_cost_usd = llm_cost_usd + ? WHERE id = ?` | tasks | PRIMARY KEY |
| `SELECT ... FROM events WHERE sequence > ? ORDER BY sequence` | events | PRIMARY KEY (sequence) |
| `SELECT ... FROM events WHERE task_id = ? ORDER BY sequence` | events | `idx_events_task_sequence` |
| `SELECT ... FROM events WHERE type = ? AND task_id = ?` | events | `idx_events_type` + `idx_events_task_id` |
| `SELECT ... FROM journal_entries WHERE task_id = ? ORDER BY timestamp` | journal_entries | `idx_journal_task_id` |
| `SELECT ... FROM checkpoints WHERE task_id = ? ORDER BY timestamp DESC LIMIT 1` | checkpoints | `idx_checkpoints_task_id` |
| `SELECT ... FROM knowledge WHERE scope = ? AND repo_scope = ? AND superseded_by IS NULL` | knowledge | `idx_knowledge_active` |

---

## Migration Approach

### File-Based Migrations

```
src/db/migrations/
  001_initial.sql       -- all CREATE TABLE statements above
  002_*.sql             -- future additions
  ...
```

### Startup Flow

```
1. Open database (create if not exists)
2. Ensure _meta table exists (bootstrap: CREATE TABLE IF NOT EXISTS _meta ...)
3. Read schema_version from _meta (default: 0 if not found)
4. List migration files, sorted by number
5. Apply unapplied migrations (number > schema_version) in a transaction
6. Update schema_version in _meta
7. Enable WAL mode: PRAGMA journal_mode=WAL
8. Set synchronous mode: PRAGMA synchronous=NORMAL (safe with WAL)
```

### Transaction Safety

Each migration file runs in a single transaction. If a migration fails, the transaction is rolled back and the system halts with an error — no partial migrations.

```typescript
// Pseudocode — actual implementation in Session 25
for (const migration of unapplied) {
  db.transaction(() => {
    db.exec(migration.sql);
    db.prepare("UPDATE _meta SET value = ? WHERE key = 'schema_version'")
      .run(migration.version.toString());
  })();
}
```

### Design Constraints

- **No down migrations.** Rollbacks are handled by restoring the database file from backup, not by SQL reverse scripts. Keeps the migration system simple.
- **No migration ORM.** Migrations are raw SQL files. The migration runner is ~30 lines of code.
- **Additive preferred.** New columns with defaults, new tables, new indexes. Avoid column removals or renames — they're harder in SQLite (requires table recreation).
