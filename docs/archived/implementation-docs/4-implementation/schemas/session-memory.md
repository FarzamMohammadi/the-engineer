# Session & Memory Domain Schemas

Session, JournalEntry, Checkpoint, and KnowledgeEntry. Source: [`../../2-components/session-memory.md`](../../2-components/session-memory.md).

**Persistence:** SQLite — `sessions`, `journal_entries`, `checkpoints`, `knowledge` tables.

---

## Session

Lightweight metadata linking a task to its working sessions.

```typescript
const SessionEndReasonSchema = z.enum(["completed", "preempted", "crashed", "new_session"]);

const SessionSchema = z.object({
  id: z.string(),                      // ULID
  task_id: z.string(),                 // FK to tasks
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable(), // null if active
  end_reason: SessionEndReasonSchema.nullable(),
  previous_session_id: z.string().nullable(), // for multi-session tasks
  resumed_from_checkpoint: z.string().nullable(), // checkpoint ID used to resume
});
type Session = z.infer<typeof SessionSchema>;
```

### What's NOT on the Session Object

L2 defined `journal: JournalEntry[]` and `checkpoints: Checkpoint[]` as embedded arrays on the Session. In the concrete implementation, these live in their own tables linked by `session_id`. Also removed: `latest_checkpoint_id` — query `SELECT * FROM checkpoints WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1` instead.

---

## JournalEntry

Append-only log of the Orchestrator's working narrative. Human-readable, queryable.

```typescript
const JournalEntryTypeSchema = z.enum([
  "action",
  "finding",
  "decision",
  "error",
  "communication",
  "phase_change",
  "checkpoint_marker",
]);

const JournalEntrySchema = z.object({
  id: z.string(),                      // ULID
  session_id: z.string(),             // FK to sessions
  task_id: z.string(),                // FK to tasks (denormalized for direct queries)
  timestamp: z.string().datetime(),
  phase: z.string(),                  // Orchestrator phase at time of entry

  type: JournalEntryTypeSchema,

  // Content
  summary: z.string(),                // human-readable one-liner
  detail: z.string().nullable(),      // longer explanation when needed

  // Type-specific fields (nullable — only populated for matching type)
  action_type: z.string().nullable(),  // for type=action: "file_read", "test_run", "code_write", "llm_call"
  finding_type: z.string().nullable(), // for type=finding: "pattern", "bug", "convention", "dependency"
  decision_key: z.string().nullable(), // for type=decision: what was decided
  error_detail: z.string().nullable(), // for type=error: what went wrong
  comm_target: z.string().nullable(),  // for type=communication: who was contacted

  // Queryability
  tags: z.array(z.string()),          // free-form: ["auth", "css", "migration"]
});
type JournalEntry = z.infer<typeof JournalEntrySchema>;
```

### SQLite Storage Notes

| Field | SQLite | Notes |
|-------|--------|-------|
| `id` | TEXT PK | ULID |
| `session_id`, `task_id` | TEXT, indexed | FK for queries |
| `type`, `phase` | TEXT | Filtered frequently |
| `tags` | TEXT (JSON) | `json_each()` for tag-based queries |
| All other fields | TEXT | Simple values |

> **Reconciliation:** L2 defined the journal entry ID format as `j-{session_id}-{seq}`. In the concrete implementation, we use ULID for consistency. The sequential ordering is implicit in the ULID's time component and the `timestamp` field.

---

## Checkpoint

Named snapshots for crash recovery and session resume.

```typescript
const CheckpointReasonSchema = z.enum([
  "phase_transition",
  "preemption",
  "pre_costly_op",
  "periodic",
]);

const CheckpointSchema = z.object({
  id: z.string(),                      // ULID
  session_id: z.string(),             // FK to sessions
  task_id: z.string(),                // FK to tasks (denormalized)

  // Position
  phase: z.string(),
  phase_progress: z.string(),         // free-text: "researched auth module, found 3 patterns"

  // Context window reconstruction
  context_summary: z.string(),        // compressed LLM conversation summary
  key_findings: z.array(z.string()),  // facts the agent discovered and needs to retain
  open_questions: z.array(z.string()), // unresolved questions
  next_action: z.string(),            // what the agent was about to do

  // References (pointers, not copies)
  last_event_id: z.string(),          // ULID pointer into Event Bus
  workspace_ref: z.object({
    branch: z.string(),
    last_commit: z.string(),           // SHA
  }).nullable(),

  // Metadata
  reason: CheckpointReasonSchema,
  timestamp: z.string().datetime(),
  journal_offset: z.number().int(),   // index into journal — entries before this are covered
});
type Checkpoint = z.infer<typeof CheckpointSchema>;
```

### SQLite Storage Notes

| Field | SQLite | Notes |
|-------|--------|-------|
| `id` | TEXT PK | ULID |
| `session_id`, `task_id` | TEXT, indexed | FK |
| `key_findings`, `open_questions` | TEXT (JSON) | String arrays |
| `workspace_ref` | TEXT (JSON) | Nullable object |
| All other fields | TEXT or INTEGER | Simple values |

> **Reconciliation:** L2 defined checkpoint ID format as `chk-{session_id}-{seq}`. Normalized to ULID.

---

## KnowledgeEntry

Persistent learnings isolated by scope. Content-hashed IDs for immutability.

```typescript
const KnowledgeScopeSchema = z.enum(["repo", "user"]);

const KnowledgeConfidenceSchema = z.enum(["observed", "inferred", "told"]);

const KnowledgeDomainSchema = z.enum([
  "conventions",
  "patterns",
  "gotchas",
  "domain",
  "tooling",
  "preferences",
]);

const KnowledgeEvidenceSchema = z.object({
  task_id: z.string(),
  description: z.string(),            // "saw this pattern in 5 files during task #42"
});

const KnowledgeEntrySchema = z.object({
  // Identity — content hash, NOT ULID
  id: z.string(),                      // hash(scope + key + body)

  // Scope
  scope: KnowledgeScopeSchema,
  repo_scope: z.string().nullable(),   // "owner/repo" — required when scope="repo"
  domain: KnowledgeDomainSchema,

  // Content
  key: z.string(),                     // what this is about: "test framework", "auth pattern"
  body: z.string(),                    // the actual knowledge, concise
  confidence: KnowledgeConfidenceSchema,
  evidence: z.array(KnowledgeEvidenceSchema),

  // Lifecycle
  created_at: z.string().datetime(),
  last_confirmed: z.string().datetime(),
  superseded_by: z.string().nullable(), // ID of newer entry that replaces this

  // Provenance
  source_task_id: z.string(),
  source_phase: z.string(),           // usually "research" or post-completion
});
type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;
```

### Natural Key + Content Hash

The **stable logical key** is `(scope, repo_scope, key)` — this uniquely identifies a knowledge concept. Multiple entries can share this logical key (different versions with different content hashes).

**Common queries:**
- Latest version: `WHERE scope=? AND repo_scope=? AND key=? AND superseded_by IS NULL`
- All active repo knowledge: `WHERE scope='repo' AND repo_scope=? AND superseded_by IS NULL`
- All active user knowledge: `WHERE scope='user' AND superseded_by IS NULL`

### ID Generation

The `id` is a content hash, not a ULID. This is the **only exception** to the ULID-everywhere convention.

```typescript
import { createHash } from "node:crypto";

function knowledgeId(scope: string, key: string, body: string): string {
  return createHash("sha256")
    .update(`${scope}:${key}:${body}`)
    .digest("hex")
    .slice(0, 32); // 32-char hex string
}
```

**Why content hash:** Immutable entries. Updating a knowledge entry's body creates a new entry with a new ID. The old entry gets `superseded_by` pointing to the new one. This creates a clean audit trail — you can always see what the system used to know.

### SQLite Storage Notes

| Field | SQLite | Notes |
|-------|--------|-------|
| `id` | TEXT PK | Content hash (32-char hex) |
| `scope`, `repo_scope`, `domain`, `key` | TEXT | Indexed — forms the natural key |
| `evidence` | TEXT (JSON) | Array of objects |
| `superseded_by` | TEXT, nullable | Points to newer entry's ID |
| All other fields | TEXT | Simple values |
