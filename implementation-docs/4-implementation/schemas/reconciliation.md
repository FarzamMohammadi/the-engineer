# Reconciliation Queue

Gaps found between L2/L3 designs and concrete schemas during Session 24. Each gap is documented with what changed and why. None are blocking — all resolved forward in the concrete schemas.

---

## Resolved Gaps

### R1: Enum Case Normalization

**L2/L3 used:** Mixed case — `Review_Pending`, `Working`, `Supervising`, `Demo`, `Code`. Hyphens in some identifiers — `pause-siblings`, `fail-fast`, `git-local`, `intake-analysis`, `self-review`.

**Concrete schema uses:** `lowercase_snake_case` everywhere — `review_pending`, `working`, `supervising`, `demo`, `code`, `pause_siblings`, `fail_fast`, `git_local`, `intake_analysis`, `self_review`.

**Why:** TypeScript identifier compatibility. Consistent naming convention. `z.enum()` values are string literals — snake_case works cleanly as both identifiers and serialized values.

**Files affected:** [`task.md`](task.md), [`orchestrator.md`](orchestrator.md), [`events.md`](events.md).

---

### R2: Task `history` Array → Separate Table

**L2 defined:** `history: StateTransition[]` as an embedded array on the Task object.

**Concrete schema:** State transitions live in a separate `state_transitions` table. The Task object does NOT carry a `history` field.

**Why:** Cross-task audit queries (`SELECT * FROM state_transitions WHERE to_state = 'blocked'`) are impossible with embedded arrays. Separate table enables: audit trails, debugging, analytics.

**To get a task's history:** `SELECT * FROM state_transitions WHERE task_id = ? ORDER BY timestamp`.

**Files affected:** [`task.md`](task.md), [`sqlite.md`](sqlite.md).

---

### R3: Event Envelope Simplified

**L2 defined:** Event envelope with `status` ("delivered" | "vetoed") and `veto_reason` fields, plus `priority` on Subscription ("pre_process" | "normal").

**L3 replaced:** Action Pipeline removed Event Bus pre-processing entirely. Pipeline rejections are logged as `action.rejected` events. The Event Bus is pure pub/sub — no vetoing, no priority processing.

**Concrete schema:** Event envelope has no `status` or `veto_reason` fields. Subscription has no `priority`. This follows L3, which superseded L2's pre-processing model.

**Files affected:** [`events.md`](events.md), [`sqlite.md`](sqlite.md).

---

### R4: Duration Representation

**L2 used:** Abstract `duration` type (no concrete format specified).

**Concrete schema:** All durations are milliseconds (`z.number().int().positive()`). Human-readable config values (e.g., `"4h"`, `"30s"`) are parsed at config load time, never stored raw.

**Why:** Consistent arithmetic. No runtime parsing surprises. Config files are the only place humans see durations — everywhere else is integers.

**Files affected:** All schema files that reference timeouts, intervals, or durations.

---

### R5: Session Embedded Arrays

**L2 defined:** `journal: JournalEntry[]` and `checkpoints: Checkpoint[]` as embedded arrays on the Session object. Also `latest_checkpoint_id`.

**Concrete schema:** Journal entries and checkpoints are separate tables linked by `session_id`. `latest_checkpoint_id` is a query: `SELECT * FROM checkpoints WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1`.

**Why:** Same rationale as R2 — cross-session queries, queryability by type/phase/tags.

**Files affected:** [`session-memory.md`](session-memory.md), [`sqlite.md`](sqlite.md).

---

### R6: Journal/Checkpoint ID Format

**L2 defined:** ID formats `j-{session_id}-{seq}` for journal entries and `chk-{session_id}-{seq}` for checkpoints.

**Concrete schema:** ULID for both. Sequential ordering is implicit in the ULID's time component and the `timestamp` field.

**Why:** Consistency with ULID-everywhere convention. Composite IDs add parsing complexity without benefit — ULID gives uniqueness and ordering in one field.

**Files affected:** [`session-memory.md`](session-memory.md).

---

### R7: Safety Interceptor → Action Pipeline

**L2 defined:** Safety Layer as an Event Bus pre-processor (`intercept()` on events before delivery).

**L3 replaced:** Gate 2 in the Action Pipeline calls Safety Layer as a synchronous middleware before action execution. The Event Bus is no longer involved in safety checks.

**Concrete schema:** Safety Layer types (`SafetyQuery`, `SafetyVerdict`) remain as passive consultation types. No interceptor registration on the Event Bus. The `intercepted_event_types` field on `SafetyState` is vestigial — it lists event types the Safety Layer monitors (subscribes to), not pre-processes.

**Files affected:** [`ephemeral.md`](ephemeral.md), [`orchestrator.md`](orchestrator.md).

---

### R8: TriggerEvent Schema Divergence

**L2 defined:** `TriggerEvent { idempotency_key, source, payload: object, received_at }` with a generic `payload` field.

**L3/Concrete schema:** `TriggerEvent { idempotency_key, source, event_type, external_ref, title, body, repo, metadata }` with structured fields instead of a generic payload.

**Why:** The generic `payload` required every consumer to know how to extract fields. Structured fields make the trigger event self-describing and type-safe.

**Files affected:** [`adapters.md`](adapters.md).

---

### R9: Cost Field Decomposition

**L2 defined:** `cost: { llm_tokens, llm_cost_usd, compute_time_ms }` as a single nested object on the Task.

**Concrete schema:** Three separate real columns on the tasks table: `llm_tokens INTEGER`, `llm_cost_usd REAL`, `compute_time_ms INTEGER`.

**Why:** Hot-path optimization. These counters are updated on every LLM call. Storing as JSON means deserializing the entire task row, modifying the JSON, and writing it back — for a simple counter increment. Real columns allow `UPDATE tasks SET llm_tokens = llm_tokens + ? WHERE id = ?`.

**Files affected:** [`task.md`](task.md), [`sqlite.md`](sqlite.md).

---

### R10: Safety Accumulator Snapshot (New)

**L2 defined:** Safety accumulators as ephemeral — "reconstructable from Event Bus history on restart."

**Concrete schema:** Adds a periodic snapshot mechanism. Snapshots stored in `_meta` table. On startup: load snapshot, replay only events since snapshot.

**Why:** Pure event replay is an anti-pattern at scale. Volume grows linearly with usage. Snapshots provide O(1) startup with incremental replay. Full replay is the safe fallback if snapshot is missing/corrupt.

**Files affected:** [`ephemeral.md`](ephemeral.md), [`sqlite.md`](sqlite.md).

---

### R11: ChildCompletionSummary Enrichment

**L2 defined:** `child_summaries` entries with 3 fields: `child_id`, `summary`, `key_outputs: string[]`.

**Concrete schema:** Expanded to 9 fields: `child_id`, `child_title`, `summary`, `key_outputs` (now array of typed objects with type/path/description), `patterns_introduced`, `gotchas`, `decisions_made`, `pr_number`, `branch`, `test_status`.

**Why:** The minimal L2 definition was insufficient for the integration phase. A parent task resuming after children complete needs structured context about what each child did — not just a summary string. The enriched schema captures what the Orchestrator actually needs to integrate children's work effectively.

**Files affected:** [`task.md`](task.md).

---

### R12: Full Workspace Object Deferred

**L2 defined:** A rich `Workspace {}` object on Workspace Manager with `base_branch`, `base_commit`, `last_commit`, `pr` sub-object (number/state/url/merge_strategy), `parent_workspace`, `child_branches`, `multi_repo`, `created_at`, `last_activity`, `status`.

**Concrete schema:** Only `TaskWorkspace` (3 fields: repo, branch, worktree_path) on the Task, and `WorktreeInfo` (6 fields) in ephemeral state. The full Workspace Manager internal state is not concretized.

**Why:** The full Workspace state is the Workspace Manager's internal concern. The Task only needs a reference to its workspace. The Workspace Manager's complete internal data model is implementation-specific and will be designed when the component is built. The current schemas capture what flows across component boundaries (which is what schemas are for).

**Status:** Intentionally deferred. The Workspace Manager's internal types will be defined during implementation, not in this schema phase.

**Files affected:** [`task.md`](task.md), [`ephemeral.md`](ephemeral.md).

---

### R13: WorkspaceVerification Return Type Deferred

**L2 defined:** `WorkspaceVerification { worktree_exists, branch_exists, commit_exists, current_commit, diverged, status }` as a return type from verification operations.

**Concrete schema:** Not concretized. The `workspace.verified` event payload captures `status`, `current_commit`, and `recovery_action`, which is the cross-component interface.

**Why:** Same rationale as R12 — this is Workspace Manager internal return type. The event payload is the interface contract; the internal return type is implementation detail.

**Status:** Intentionally deferred to implementation.

---

### R14: Config Types Deferred to Session 25

**L2 defined:** Various config schemas across components: Orchestrator notification config (`suppress_window`, `batch_window`, `quiet_hours`, `digest` config), fast-path config, full WorkspaceConfig (with `slug_max_length`, `fetch_before_create`, `default_base_branch`, PR sub-config, cleanup sub-config, `child_pr_strategy`, `multi_repo`).

**Concrete schema:** Safety config types are concretized in [`ephemeral.md`](ephemeral.md). Other component configs (Orchestrator, Workspace Manager, Daemon beyond what's in `DaemonConfig`) are not.

**Why:** Config schemas are Session 25 scope (Project layout & config format). Session 24 focused on domain data types and persistence schemas. Config files are a separate concern — format (YAML/TOML/JSON), validation, hot-reload mechanism, and default values are all Session 25 topics.

**Status:** Explicitly deferred to Session 25.

---

### R15: CostStatus Return Type

**L2 referenced:** `getCostStatus(task_id?, repo?) -> CostStatus` as a Safety Layer operation return type. `CostStatus` was never defined in L2 or L3.

**Concrete schema:** Not defined. At runtime, this will return a projection of `CostAccumulators` filtered by task/repo — the shape is derivable from the existing accumulator types.

**Status:** Will be defined during Safety Layer implementation. The accumulator types provide the foundation.

---

### R16: DaemonHealth.uptime Computed

**L2 defined:** `uptime: duration` as a field on DaemonState.health.

**Concrete schema:** Omitted. Uptime is computed at runtime as `Date.now() - started_at`. Storing a computed value that immediately becomes stale is an anti-pattern.

**Files affected:** [`ephemeral.md`](ephemeral.md) (comment added).

---

## Summary

| # | Gap | Severity | Resolution |
|---|-----|----------|------------|
| R1 | Enum case normalization | Cosmetic | Normalize to `lowercase_snake_case` |
| R2 | Task history → separate table | Structural | Separate `state_transitions` table |
| R3 | Event envelope simplified | Structural | Follow L3 (remove status/veto_reason) |
| R4 | Duration representation | Convention | Milliseconds everywhere |
| R5 | Session embedded arrays | Structural | Separate tables |
| R6 | Journal/Checkpoint ID format | Convention | ULID everywhere |
| R7 | Safety interceptor → pipeline | Structural | Follow L3 Action Pipeline |
| R8 | TriggerEvent schema | Structural | Structured fields, not generic payload |
| R9 | Cost field decomposition | Optimization | Real columns for hot-path counters |
| R10 | Safety accumulator snapshot | New addition | Periodic snapshots for fast startup |
| R11 | ChildCompletionSummary enrichment | Enhancement | 3 fields → 9 fields for integration needs |
| R12 | Full Workspace object deferred | Scope | Internal WM type, deferred to implementation |
| R13 | WorkspaceVerification deferred | Scope | Internal return type, event payload is the contract |
| R14 | Config types deferred | Scope | Session 25 scope (config format & layout) |
| R15 | CostStatus return type | Scope | Derivable from accumulator types, define at implementation |
| R16 | DaemonHealth.uptime computed | Cosmetic | Computed at runtime, not stored |

**None of these gaps are blocking.** R1-R10 were resolved forward in the concrete schemas. R11-R16 are either intentional enhancements, scope deferrals to future sessions, or trivially computed values. The L2/L3 documents remain as the conceptual models.
