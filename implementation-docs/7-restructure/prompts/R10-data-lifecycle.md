# Phase R10: Data Lifecycle + Performance

**Wave 4 (Parallel)** — Can run alongside R9.
**Branch:** `layer7/R10`
**Scope:** Event retention, observability trace pruning, subscriber timeout guards, database tuning.

---

## Worktree Setup (DO THIS FIRST)

This phase runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-R10 -b layer7/R10 main
cd ../engineer-R10
```

**Rules:**
- Work ONLY in this worktree (`../engineer-R10/`)
- Commit your changes to the `layer7/R10` branch
- Do NOT push — the merge prompt will collect this branch
- Do NOT modify files outside the scope listed in this prompt
- When done: commit, verify tests pass, stop. The merge wave handles the rest.

---

## Context

The Engineer is an autonomous software engineering agent with a SQLite-backed event bus, observability traces, and session data. Currently, all data grows unbounded — events, action_traces, phase_metrics, llm_traces, and journal entries accumulate forever. In production, this will cause disk exhaustion and query performance degradation.

The assessment (`implementation-docs/7-restructure/assessment.md`) identifies these resilience gaps:
- "No data retention (events/traces grow unbounded)"
- "No subscriber timeout guard"

This phase adds configurable data lifecycle management and database performance tuning.

---

## Pre-Work: Read These Files

1. `docs/philosophy.md` — core beliefs
2. `docs/persona.md` — project identity
3. `implementation-docs/7-restructure/assessment.md` — resilience gaps motivating this phase
4. `src/core/event-bus/index.ts` — EventBus implementation (events table, subscribe/publish)
5. `src/core/observability/` — trace tables (action_traces, phase_metrics, llm_traces)
6. `src/core/session-memory/index.ts` — journal_entries, checkpoints, knowledge tables
7. `src/core/daemon/index.ts` — tick loop (cleanup step already exists)
8. `src/db/database.ts` — database creation and migration
9. `src/db/migrations/001_initial.sql` — table definitions and indexes
10. `src/schemas/config.ts` — DaemonConfigSchema (look for where retention config should go)
11. `src/schemas/events.ts` — event types (look at existing event groups)

---

## Deliverables

### 1. Event Retention (Configurable, Background Cleanup)

**Config schema addition** — Add retention configuration to the appropriate config schema (likely a new `DataLifecycleConfigSchema` in `src/schemas/config.ts` or embedded in DaemonConfig):

```typescript
// Suggested shape (derive the actual Zod schema):
{
  retention: {
    events: {
      max_age_days: 90,        // Delete events older than this
      max_count: 100_000,      // Keep at most this many events (FIFO)
      cleanup_interval_ms: 3_600_000  // Run cleanup every hour
    }
  }
}
```

All values should have sensible defaults. Make retention configurable but opt-in with generous defaults so nothing surprises users.

**Cleanup implementation** — Create a `DataLifecycleManager` (or similar) in `src/core/` that:
- Runs periodically (configurable interval, default 1 hour)
- Deletes events older than `max_age_days` using `DELETE FROM events WHERE timestamp < ?`
- If `max_count` is set, trims to that count (keep newest)
- Runs within a transaction
- Emits a `system.cleanup_completed` event (or similar) with stats (rows deleted, time taken)
- Is stoppable (for graceful shutdown)
- Logs cleanup activity

**Integration** — Wire into Daemon startup/shutdown. The Daemon's tick loop already has a cleanup step — either extend it or run the lifecycle manager on its own interval.

### 2. Observability Trace Pruning (Per-Table Retention)

Same lifecycle manager handles trace tables with independent retention settings:

```typescript
{
  retention: {
    action_traces: { max_age_days: 30 },
    phase_metrics: { max_age_days: 30 },
    llm_traces: { max_age_days: 14 },  // These are large (blob references)
    journal_entries: { max_age_days: 180 },  // Keep longer for learning
    checkpoints: { max_age_days: 90 }
  }
}
```

For LLM traces, also consider pruning the blob store (`~/.engineer/traces/blobs/`). When an `llm_traces` row is deleted, check if the referenced prompt/response blobs are still referenced by any other row. If not, delete the blob files. This is optional but good hygiene — document it as a future consideration if not implemented.

Each table's cleanup should:
- Use the table's timestamp column for age-based deletion
- Run in its own transaction (don't lock everything at once)
- Log what was pruned

### 3. Event Subscriber Timeout Guard

Currently, if a subscriber callback hangs, it blocks the entire publish pipeline (synchronous delivery). Add a timeout guard:

- Wrap each subscriber callback invocation with a timeout (configurable, default 5 seconds)
- If a subscriber exceeds the timeout, log a warning with the subscriber's pattern and skip it
- Do NOT throw — other subscribers should still receive the event
- Emit a `health.subscriber_timeout` event (or similar) for monitoring
- Add the timeout config to EventBus configuration

**Important:** The EventBus currently uses synchronous delivery. The timeout guard should use `Promise.race()` with a timeout promise if callbacks are async, or `setTimeout` tracking if they're sync. Read the actual EventBus implementation carefully before deciding the approach.

### 4. Database Tuning

Add SQLite PRAGMA tuning to `src/db/database.ts` (or a new `tuning.ts` module):

- `PRAGMA cache_size = -64000` (64MB cache, up from SQLite default of 2MB). Make configurable.
- `PRAGMA auto_vacuum = INCREMENTAL` — set at database creation time (before any tables). This allows `PRAGMA incremental_vacuum` to reclaim space after large deletes.
- Run `PRAGMA incremental_vacuum` as part of the cleanup cycle (after retention deletes)
- `PRAGMA busy_timeout = 5000` — prevent "database is locked" errors under concurrent access
- Verify WAL mode is already set (it should be from the existing migration)

**Config:**
```typescript
{
  database: {
    cache_size_mb: 64,
    busy_timeout_ms: 5000,
    vacuum_on_cleanup: true
  }
}
```

---

## Constraints

- All retention defaults must be generous (no surprise data loss)
- Cleanup must be non-blocking (run in background, don't block the tick loop)
- All cleanup operations must be idempotent
- Must not break existing tests — all current event and trace tests should pass unchanged
- Config must be hot-reloadable where possible (retention intervals can change without restart)

---

## Verification Steps

1. **Unit tests for DataLifecycleManager** — Test that:
   - Events older than max_age_days are deleted
   - Events within max_age_days are preserved
   - max_count trimming keeps the newest events
   - Each trace table respects its own retention config
   - Cleanup is idempotent (running twice does nothing extra)
   - Cleanup emits appropriate events
   - Cleanup respects the interval (doesn't run too often)

2. **Unit tests for subscriber timeout guard** — Test that:
   - Normal subscribers receive events as before
   - Slow subscribers are timed out and skipped
   - Other subscribers still receive the event after a timeout
   - Timeout events are logged/emitted

3. **Unit tests for database tuning** — Test that:
   - PRAGMAs are set correctly after database creation
   - Cache size is configurable
   - Incremental vacuum runs without error

4. **Existing tests pass** — `pnpm test` passes with 0 failures

5. **Lint clean** — `pnpm lint` passes

6. **Typecheck clean** — `pnpm typecheck` passes

7. **Config schema validation** — New config fields have sensible defaults and validate correctly with Zod

8. **Integration test** — Create a test that:
   - Inserts many events
   - Runs cleanup with a short max_age
   - Verifies old events are gone, new events remain
   - Verifies cleanup event was emitted

---

## Commit

When complete, commit on branch `layer7/R10` with message:

```
R10: Add data lifecycle management and database tuning

Event retention, trace pruning, subscriber timeout guard,
SQLite cache/vacuum configuration
```
