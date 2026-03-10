# Data Structures & Schemas

Concrete TypeScript types, Zod schemas, and SQLite table definitions for every data type in Layers 2-3. This is where abstract architecture becomes implementable code.

Part of **Layer 4** — see [`../foundation.md`](../foundation.md) for technology stack. Source types defined in [`../../2-components/`](../../2-components/) and [`../../3-interactions/`](../../3-interactions/).

---

## Files in This Directory

| File | What It Covers | Persistence |
|------|---------------|-------------|
| [`task.md`](task.md) | Task, StateTransition, enums (TaskState, SubState, ActionClass, CascadePolicy) | SQLite: `tasks`, `state_transitions` |
| [`events.md`](events.md) | Event envelope + 30 event payload schemas, event type map | SQLite: `events` |
| [`session-memory.md`](session-memory.md) | Session, JournalEntry, Checkpoint, KnowledgeEntry | SQLite: `sessions`, `journal_entries`, `checkpoints`, `knowledge` |
| [`adapters.md`](adapters.md) | Universal adapter contract, 5 adapter types, Registry, People Directory | Zod only (not persisted) |
| [`orchestrator.md`](orchestrator.md) | 7 phase outputs, CommEvent, QuestionBatch, DecompositionPlan | Zod only (serialized into checkpoint JSON) |
| [`ephemeral.md`](ephemeral.md) | DaemonState, Safety accumulators, Workspace state | In-memory only |
| [`sqlite.md`](sqlite.md) | CREATE TABLE statements, indexes, migration approach | DDL reference |
| [`reconciliation.md`](reconciliation.md) | Gaps found between L2/L3 and concrete schemas | Tracker (resolve before session close) |

---

## Conventions

### Zod-First

Zod schemas are the single source of truth. TypeScript types are **always** derived:

```typescript
// Schema is the source of truth
const TaskSchema = z.object({ ... });

// Type is ALWAYS derived — never hand-written alongside Zod
type Task = z.infer<typeof TaskSchema>;

// Named exports are MANDATORY — no anonymous z.infer in function signatures
export type Task = z.infer<typeof TaskSchema>;
export { TaskSchema };
```

### ID Generation: ULID

All entity IDs use [ULID](https://github.com/ulid/spec) (Universally Unique Lexicographically Sortable Identifier).

- **Format:** 26-character Crockford Base32 string (e.g., `01ARZ3NDEKTSV4RRFFQ69G5FAV`)
- **Properties:** Time-sortable, globally unique, case-insensitive
- **Why:** `ORDER BY id` = chronological order. One format everywhere. Works if we ever go distributed.
- **Exception:** KnowledgeEntry uses content hash as ID (see [`session-memory.md`](session-memory.md)). This is the only exception — explicitly noted because "ULID everywhere" is the default.

### Timestamps: ISO 8601

All timestamps are ISO 8601 strings, stored as TEXT in SQLite.

```typescript
// In Zod
z.string().datetime()  // "2026-03-09T14:30:00.000Z"

// In SQLite
created_at TEXT NOT NULL  -- ISO 8601
```

SQLite's built-in date functions (`datetime()`, `julianday()`, comparison operators) work with ISO 8601 strings.

### Durations

Duration values (poll intervals, timeouts, batch windows) are stored as **milliseconds** (INTEGER in SQLite, `number` in TypeScript). Human-readable config values (e.g., `"4h"`, `"30s"`) are parsed at config load time — never stored raw.

```typescript
// In Zod
z.number().int().positive()  // milliseconds

// Examples
30_000       // 30 seconds
14_400_000   // 4 hours
86_400_000   // 24 hours
```

### Enums: String Literals

All enums are TypeScript string literal unions, stored as TEXT in SQLite. Never integer codes.

```typescript
// In Zod
const TaskStateSchema = z.enum([
  "intake", "queued", "active", "blocked",
  "review_pending", "completed", "failed"
]);
type TaskState = z.infer<typeof TaskStateSchema>;

// In SQLite
state TEXT NOT NULL CHECK(state IN ('intake','queued','active','blocked','review_pending','completed','failed'))
```

**Naming:** lowercase_snake_case for enum values (e.g., `review_pending`, not `Review_Pending`). L2 docs used mixed case — we normalize here. See [`reconciliation.md`](reconciliation.md).

### Nullable vs. Optional

- **Nullable** (`z.nullable()`): Field exists but can be `null`. Used for fields that are always present but sometimes empty (e.g., `parent_id` on a top-level task).
- **Optional** (`z.optional()`): Field may not exist at all. Used for fields that are only relevant in certain states (e.g., `blocked` details only when state = "blocked").

In SQLite, both map to nullable columns. The distinction matters in TypeScript for API ergonomics.

### Schema Versioning

A `_meta` table tracks schema version. Migrations are sequential SQL files applied on startup.

```
_meta table:
  key TEXT PRIMARY KEY
  value TEXT

Rows:
  schema_version = "1"
  safety_snapshot = '{"accumulators": {...}, "last_event_sequence": 42}'

Migration files:
  migrations/001_initial.sql
  migrations/002_add_index.sql
  ...
```

On startup: read `schema_version`, apply unapplied migrations, update version.

### No ORM

Raw SQL via `better-sqlite3` synchronous API. `json_extract()` and `json_each()` for JSON column queries. Prepared statements for all queries (performance + SQL injection prevention).

---

## Decisions Made This Session

| # | Decision | Rationale |
|---|----------|-----------|
| 75 | ULID for all entity IDs (except knowledge content hash) | Time-sortable, globally unique, one format. Knowledge is the explicit exception. |
| 76 | ISO 8601 strings for all timestamps | Standard, human-readable, SQLite-compatible. |
| 77 | String literal enums, lowercase_snake_case | Readability over micro-optimization. Normalize L2's mixed case. |
| 78 | Zod-first with mandatory named type aliases | Single source of truth. No anonymous `z.infer` in function signatures. |
| 79 | 7 SQLite tables + `_meta` | tasks, state_transitions, events, sessions, journal_entries, checkpoints, knowledge, _meta. |
| 80 | Task cost as real columns (not JSON) | Hot-path counters updated on every LLM call. Avoids deserializing entire task JSON. |
| 81 | State transitions in separate table | Enables cross-task audit queries. L2's `history` array is the conceptual model; the separate table is the concrete implementation. |
| 82 | Event payloads as JSON blob + mapped type | Single `events` table for all 30 types. Zod schemas per event type, mapped type for type-safe access. |
| 83 | Knowledge: natural key + content hash | `(scope, repo_scope, key)` is the stable logical key. Content hash is the version discriminator. |
| 84 | Safety accumulator snapshots in `_meta` | Periodic snapshots for fast startup. Full event replay as fallback. |
| 85 | Phase outputs use `.safeParse()` | LLM output is unreliable. Schemas document expected shape; validation is graceful, not hard gates. |
| 86 | Durations as milliseconds | Parsed from human-readable config at load time. Stored as integers internally. |
| 87 | Event envelope simplified per L3 | `status` and `veto_reason` fields removed — Action Pipeline replaced Event Bus pre-processing. |
| 88 | Enum values normalized to lowercase_snake_case | L2 used mixed case (`Review_Pending`, `Working`). Concrete schemas normalize to `review_pending`, `working`. |
| 89 | Strictest enforcement through tooling | Every rule enforced by automated tooling (Biome, hooks, Zod validation). Agents cannot bypass. Detailed design in Sessions 25 and 28. |

---

## Persistence Tiers

Every type in the system belongs to exactly one persistence tier:

| Tier | Where It Lives | Examples |
|------|---------------|---------|
| **SQLite** | `better-sqlite3` database, WAL mode | Task, Event, Session, JournalEntry, Checkpoint, KnowledgeEntry, StateTransition |
| **Zod only** | Runtime validation + type inference, not persisted directly | Adapter contracts, event payloads (stored as JSON inside events.payload), phase outputs (stored inside checkpoint JSON) |
| **Ephemeral** | In-memory, rebuilt on startup | DaemonState, Safety accumulators, Event Bus subscriptions |
| **Config files** | File-based, hot-reloadable (format TBD Session 25) | SafetyConfig, WorkspaceConfig, PeopleDirectory, plugin configs |
