# Task Intake — Trigger to Task

This is how external work becomes a task. Trigger plugins poll their sources; the daemon
turns each new event into exactly one task — even across crashes and restarts. This document
covers the polling loop, the two-tier deduplication that guarantees exactly-once, and the
contract every trigger plugin relies on.

## Key Files

| Component | File | Role |
|---|---|---|
| Polling loop + dedup | `src/core/daemon/trigger-poller.ts` | Poll each trigger, suppress duplicates, create tasks |
| Durable dedup query | `src/core/task-engine/queries.ts` | `findByIdempotencyKey` — does a live task already own this key? |
| Task creation | `src/core/task-engine/index.ts` | `createTask` stores `idempotency_key` on the row |
| Schema + index | `src/db/migrations/001_schema.sql` | `idempotency_key` column + `idx_tasks_idempotency_key_active` |
| Trigger event shape | `src/schemas/adapters.ts` | `TriggerEventSchema` (`idempotency_key`, `external_ref`) |
| Reference plugin | `src/plugins/trigger/github-trigger/github-trigger.ts` | Builds keys like `github:issue:owner/repo:42` |

---

## 1. The Flow

```
daemon tick
  |
  +-- for each trigger plugin (in parallel):
  |     |
  |     +-- interval elapsed?  → no: skip this tick
  |     +-- trigger.poll()     → [TriggerEvent, ...]
  |
  +-- for each event:
        |
        +-- 1. Hot cache hit?      (seen this key recently, in memory)
        |        → yes: suppress, done
        |
        +-- 2. DB cold path:  findByIdempotencyKey(event.idempotency_key)
        |        → a live task already owns this key?  yes: suppress, cache it, done
        |
        +-- 3. New work:
              +-- publish trigger.new_event (audit trail)
              +-- createTask({ idempotency_key, external_ref, ... })
              +-- requestTransition → queued
              +-- cache the key with a TTL
```

## 2. Two-Tier Deduplication

A trigger returns the same item on every poll (an open issue is still open 30 seconds later),
so the daemon must recognise what it has already turned into a task. It does this twice:

- **Hot cache (fast, per-process).** An in-memory map of recently-seen keys with a TTL
  (`seen_keys_ttl_ms`). Cheap, but lost on restart.
- **DB cold path (durable, crash-safe).** `findByIdempotencyKey` asks the database whether a
  **non-terminal** task already owns the key. This survives restarts, so a daemon that crashes
  after creating a task never creates a duplicate when it comes back and re-polls.

The cold path runs for **every** event, regardless of whether the event carries an
`external_ref`. That is the crash-safe guarantee for all trigger plugins, not just GitHub.

## 3. The Dedup Contract

Each `TriggerEvent` carries two related-but-distinct fields. Keeping them distinct is the whole
contract.

| Field | Required | Role |
|---|---|---|
| `idempotency_key` | yes | **Identity / dedup.** Stable, deterministic key for "this logical piece of work." Stored `NOT NULL` on every task. |
| `external_ref` | no (`null` ok) | **Descriptive only.** Link back to the source (URL, PR-decoration strings, dashboard link-back). Never used for dedup. |

**`idempotency_key` rules:**

- **Deterministic.** The same logical event must produce the same key on every poll. GitHub's
  `github:issue:{owner}/{repo}:{number}` does this — reopen, comment, or edit, the key is the same.
- **Globally unique by convention.** Encode the source in the key (the `github:issue:` prefix),
  so the dedup index needs only the key itself — no separate source column.
- **Uniqueness is active-scoped.** No two **non-terminal** tasks may share a key. A
  `completed` or `cancelled` task **frees** its key, so a re-triggered source (a reopened issue
  with new context) correctly spawns a fresh task. A `failed` task **holds** its key — the next
  trigger for that source is a retry of the failed work, not a fresh clone of it. Strict where it
  matters — two live tasks for one issue are impossible — permissive exactly where a second pass is
  legitimate.

### Re-trigger walkthrough

```
issue #42 opens        → task A created  (key github:issue:owner/repo:42)
task A completes        → key freed (A is terminal, out of the active index)
issue #42 reopened      → task B created  (same key, now available)   ✓

issue #42 still active  → re-emitted while task A is live → suppressed  ✓
```

The inverse case — the source is closed/resolved while a task is still in flight, so the work
goes stale — is **not** handled in v1. See `docs/future-considerations.md`.

## 4. What a Plugin Author Must Guarantee

To get crash-safe exactly-once for free, a trigger plugin only has to:

1. Emit a **stable, deterministic** `idempotency_key` for each logical event.
2. Encode its source in the key so it is globally unique.

Everything else — the hot cache, the durable DB check, task creation, restart safety — is
Core's job. See [`../../plugins/trigger/README.md`](../../plugins/trigger/README.md) for the
full adapter contract and [`../../plugins/plugin-context.md`](../../plugins/plugin-context.md)
for why watermarks are an efficiency optimisation, not a correctness requirement.
