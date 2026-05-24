# Plan — Slice 7: Workspace & Session

Synthesizes the requirements (slice file) and research doc into a sequenced
implementation plan. Calibrated to **high-stakes refactor** discipline: hard decision
gates, explicit alternatives + why-rejected, panel review, pre-mortem, closing-sweep
session at the end. Five sessions, each green-on-commit.

---

## Decision Record

### D1 — Cut the knowledge layer; preserve as supplementary capability in future-considerations

**Chosen:** Delete `KnowledgeStore`, the `knowledge` table, all schemas, the
`Dispatch.knowledge` field, the 6× prompt-context plumbing, and `buildKnowledgeSection`.
Replace the existing `Hybrid Semantic Memory Search` entry in
`docs/future-considerations.md` with a consolidated entry titled **"Cross-Task &
Cross-Session Memory (supplementary)"** that captures the pivot story (files are
primary; this layer was the unbuilt producer half), the capability (cross-task pattern
recall), and retrieval as an open question (structured fields, embeddings, knowledge
graphs all listed as options, none prescribed).

**Alternatives rejected:**

- *Keep the schema/interface, delete the unused store.* Leaves an interface with
  `throw new Error("not implemented")` semantics — worse than cutting cleanly.
- *Wire a producer in this slice (build out instead of cut).* Designing the producer
  (who extracts, when, with what confidence semantics, with what owner-rejection UX) is
  itself a substantial design problem — not appropriate to smuggle into a workspace +
  session refinement slice. Doing it now locks the shape before the design has earned
  its place.

### D2 — Persist `base_branch`; drop `baseCommit` from `WorkspaceRecord`

**Chosen:** Add `base_branch: string` to `TaskWorkspaceSchema`. Workspace creation
writes it via the existing `taskEngine.updateTaskField("workspace", ...)`. All five
runtime consumers continue to use `record.baseBranch`, but the value is sourced from the
DB. `baseCommit` becomes a local in `createWorkspace` (computed, logged, emitted in
event payload, then discarded) — removed from `WorkspaceRecord` and the interface.

**Alternatives rejected:**

- *Persist both.* `baseCommit` is read nowhere post-creation; persisting an
  immediately-stale snapshot adds noise.
- *Persist neither.* `baseBranch` has five runtime consumers and silently corrupts
  PR/eval/cleanup if a non-default base is ever used. Not optional.

### D3 — Kill the in-memory `workspaces` Map; DB is single source of truth

**Chosen:** Remove `private readonly workspaces = new Map<string, WorkspaceRecord>()`.
Every read (`getWorktreePath`, `getWorkspaceRecord`) goes through `taskEngine.getTask
(taskId)` and constructs the record from `task.workspace`. `registerExistingWorkspace`
is deleted; all three call sites (rework, resume, review-handler) become no-ops. Tests
update accordingly.

**Alternatives rejected:**

- *Keep the Map as a read-through cache.* Two stores, same dual-source-of-truth
  problem — gains nothing.
- *Lazy populate the Map on demand.* Same problem, more complex.

### D4 — Facade as namespace, not forwarder

**Chosen:** `SessionMemory` exposes `sessions`, `journal`, `checkpoints` as public
readonly fields. No pass-through methods. Call sites address the specific store. Store
methods drop the redundant `Journal`/`Session`/`Checkpoint` suffix. `ISessionMemory`
interface deleted (each store class is the implicit contract).

**Alternatives rejected:**

- *Dissolve the facade entirely.* The conceptual grouping is real and useful for a
  human reader navigating the codebase. Three stores sharing a DB, lifetime, and
  purpose belong under one namespace.
- *Keep the forwarder.* 100 lines of pass-through is ceremony, not value. The facade
  earns its keep as a namespace; it does not earn its keep as a forwarder.

### D5 — Relocate session-result to `core/session-result/`

**Chosen:** New module `src/core/session-result/index.ts` exporting the three existing
functions. Both workspace-manager and orchestrator import as peers.

**Alternatives rejected:**

- *Leave in orchestrator and have orchestrator handle initial template writes lazily
  on first phase dispatch.* Architecturally pure but introduces dispatch-time complexity
  (existence check, conditional write) for marginal gain. The relocation is mechanically
  simpler and resolves the smell.
- *Move into workspace-manager.* Wrong direction — session-result is part of the
  orchestrator's CLI-handoff protocol, not a workspace concern. Workspace-manager
  consumes it; it shouldn't own it.

### D6 — Extract skills into `core/skills/`

**Chosen:** New module `src/core/skills/index.ts` with `SkillsManager` class.
Constructor takes `workspaceRoot` and `observer`. Methods: `sync()`, `getDir()`.
Bootstrap constructs it; orchestrator context carries `skillsManager`. `findRepoRoot`
moves with it (or gets replaced — research during planning identifies the simplest
stable approach).

**Alternatives rejected:**

- *Leave in workspace-manager.* The colocation is incidental (skills happen to live
  under `workspace_root`). The conceptual coupling is zero.
- *Defer to a later slice.* Skills extraction is part of bringing workspace-manager to
  its right shape; deferring leaves a known smell sitting through the slice's closing
  sweep.

### D7 — Move `removeThoughtsAndPush` to `pr-manager`; look for unification

**Chosen:** Move the method to pr-manager. Called only from review-handler immediately
before merge — pr-manager owns PR-prep. During the move, audit adjacent operations in
pr-manager (`pushBranch`, `deleteRemoteBranch`, base-diff at line 196) for natural
consolidation. Decide based on what surfaces — do not pre-bake a "git PR operations"
abstraction without confirming it earns its place.

**Alternatives rejected:**

- *Leave in workspace-manager.* The method does PR-prep work (diff vs base, commit,
  push to remote) — wrong module home.
- *New `core/pr-prep/` module.* Premature abstraction — pr-manager already exists and
  has the right scope.

### D8 — Cut every other dead surface item

Batched (same defect class): `getSessionChain`, **`previous_session_id` /
`resumed_from_checkpoint` columns on `sessions`** (written by `createSession`, read by
nothing — the journal `phase_change` entry at resume time is the authoritative audit
trail), 4 dead `JournalEntryType` values + 4 unused columns, `JournalQueryFilters`
machinery (collapse to static prepared statement), 2 dead `CheckpointReason` values, 2
dead `SessionEndReason` values, "backwards compatibility" re-exports, `injectAuth`
re-export, dead `push` branch in `gitExecWithAuth`.

**No alternative — these are the principle in approach.md § "What Each RRP Must Hunt
For" applied.** Defer is not an option pre-v1.

### D9 — Resume flow audit, observability audit, and coding-standards application are first-class slice tasks

The slice scope names "session resume" explicitly. The cuts and refactors touch every
piece of the resume flow but do not intend to change its behavior. The slice owns the
gate that proves the flow still composes — Session 4 does the integration check, Session
5's closing sweep re-walks it.

Observability follows the same logic but broader than just logs: per
`coding-standards.md` § 14, observability covers logs, spans (tracing), `recordDecision`
for non-obvious choices, structured events, and `trace_id` correlation. Every observer
call in the change set — info/warn/debug logs AND `startSpan`/`recordDecision` —  gets
audited for accuracy. Specific pre-identified items in slice file Decision #11.

Coding-standards application follows the principle established in
`approach.md` § "What Each RRP Must Hunt For" → coding-standards alignment is planned
in from the start, not deferred to the closing sweep. Slice file Decision #11
enumerates the sections that actively apply to Slice 7's change set: § 2 Naming, § 5
Error Handling, § 6 Imports, § 7 Module Boundaries, § 8 Comments, § 12 Logging, § 13
Async Discipline, § 14 Observability & Tracing, § 15 Graceful Degradation. Each
implementation session applies the relevant subset to its own scope.

**Alternatives rejected:**

- *Defer resume audit to closing sweep only.* Too late — if a step in the flow no
  longer composes, the closing sweep catches it but the fix lands in the sweep session
  rather than in the session that broke it. Better to gate during Session 4.
- *Defer standards application to closing sweep only.* Process gap — the sweep is the
  final inspection, not the only one. Catching a standards gap at sweep time means the
  fix lands at sweep time, not at write time. The principle: apply standards
  continuously, sweep verifies.
- *Skip log/observer audit because "no behavior change."* The strings describe what
  the code does. When code moves, descriptions can rot. The audit is part of the
  refinement bar.

---

## Session Breakdown

Each session ends green (lint, typecheck, tests). Each session commits as a coherent
package. Per the RRP discipline, each session also surfaces and resolves smells found
during line-by-line audit of its own files — not just the smells named upfront.

### Session 1 — Knowledge layer cut + future-considerations consolidation

**Goal:** Delete the entire knowledge layer cleanly. Leave the codebase passing all
existing tests at the end (with knowledge tests removed).

**Tasks (rough order, plan may adjust during implementation):**

1. Delete `src/core/session-memory/knowledge.ts`.
2. Delete `KnowledgeNotFoundError` from `session-memory/errors.ts`.
3. Delete `KnowledgeEntryRow` interface + `rowToKnowledgeEntry` from
   `session-memory/row-mappers.ts`.
4. Delete knowledge schemas from `src/schemas/session-memory.ts`:
   `KnowledgeScope*`, `KnowledgeConfidence*`, `KnowledgeDomain*`, `KnowledgeEvidence*`,
   `KnowledgeEntry*`, `knowledgeId()`.
5. Drop knowledge from `src/core/interfaces/session-memory.interface.ts`:
   `StoreKnowledgeInput`, four method declarations on `ISessionMemory`.
6. Drop knowledge from `src/core/session-memory/index.ts` facade (field +
   pass-throughs + the row-mapper re-export of `rowToKnowledgeEntry` if it lingers).
7. Drop the `knowledge` field from `DispatchSchema` in `src/schemas/ephemeral.ts`.
8. Drop the `repoKnowledge` / `userKnowledge` reads + `Dispatch` packing + log field in
   `src/core/daemon/task-scheduler.ts`.
9. Drop `repoKnowledge` / `userKnowledge` parameters from every prompt builder in
   `src/core/orchestrator/prompts/{requirements-gathering,research,planning,execution,
   review,demo-prep}.ts`.
10. Delete `buildKnowledgeSection` + `formatKnowledge` from
    `src/core/orchestrator/prompts/format.ts`.
11. Update every site in `src/core/orchestrator/phase-handlers.ts` that passes
    `dispatch.knowledge.repo` / `dispatch.knowledge.user` (6 phases, ~8 sites).
12. Drop the `knowledge` table + 3 indexes from `src/db/migrations/001_schema.sql`.
13. Delete `tests/unit/core/session-memory/knowledge.test.ts`. Surgically remove
    knowledge sections from `tests/unit/core/session-memory/index.test.ts`.
14. Consolidate `Hybrid Semantic Memory Search` into the new
    `Cross-Task & Cross-Session Memory (supplementary)` entry in
    `docs/future-considerations.md`. Delete the old entry.
15. Run lint, typecheck, full test suite. Commit.

**Acceptance:**
- Zero remaining references to `KnowledgeStore`, `KnowledgeEntry`, `knowledgeId`,
  `buildKnowledgeSection`, `Dispatch.knowledge` across src/ and tests/.
- `knowledge` table dropped from migration.
- New consolidated future-considerations entry reads as a self-contained story (pivot
  → capability → producer-first framing → retrieval-open-ended).
- All tests pass.
- **Observability audit:** any observer log strings referencing knowledge ("`Known
  Context`", "`knowledgeEntries`", etc.) are deleted with their code paths, not left
  dangling.

### Session 2 — Session-memory hygiene + facade → namespace refactor

**Goal:** Cut every dead enum value, column, filter, re-export; reshape facade as
namespace; rename store methods to drop redundant prefixes; update every call site.

**Tasks:**

1. **Schema cuts** in `src/schemas/session-memory.ts`:
   - Trim `SessionEndReason` enum: drop `new_session`, `decomposed`.
   - Trim `JournalEntryType` enum: drop `action`, `finding`, `decision`,
     `communication`.
   - Trim `JournalEntry` shape: drop `action_type`, `finding_type`, `decision_key`,
     `comm_target` fields.
   - Trim `Session` shape: drop `previous_session_id`, `resumed_from_checkpoint`.
   - Trim `CheckpointReason` enum: drop `pre_costly_op`, `periodic`.
2. **Migration updates** in `src/db/migrations/001_schema.sql`:
   - Update `sessions.end_reason` CHECK constraint.
   - Drop `previous_session_id`, `resumed_from_checkpoint` columns from `sessions`.
   - Update `journal_entries.type` CHECK constraint.
   - Drop the four type-specific columns from `journal_entries`.
   - Update `checkpoints.reason` CHECK constraint.
3. **Row mapper updates** in `session-memory/row-mappers.ts`:
   - Drop the four columns from `JournalEntryRow` interface.
   - Drop the four fields from `rowToJournalEntry`.
   - Drop `previous_session_id`, `resumed_from_checkpoint` from `SessionRow` interface
     and `rowToSession`.
4. **Store changes:**
   - `SessionStore`: drop `getSessionChain` method, drop `getSessionsByTaskStmt`
     prepared statement. Drop `previousSessionId` / `resumedFromCheckpoint` parameter
     handling from `createSession` and the prepared statement. Rename methods:
     `createSession` → `create`, `endSession` → `end`.
   - `JournalStore`: drop dynamic-SQL `queryJournal`; replace with a single static
     prepared statement (`SELECT * FROM journal_entries WHERE task_id = ? ORDER BY
     timestamp ASC`). Drop `JournalQueryFilters` parameter handling. Drop column
     handling for the four dead fields in `addJournalEntry`. Rename methods:
     `addJournalEntry` → `addEntry`, `queryJournal` → `query`,
     `getLatestJournalTimestamp` → `getLatestTimestamp`.
   - `CheckpointStore`: rename `createCheckpoint` → `create`, `getLatestCheckpoint` →
     `getLatest`.
5. **Drop `JournalQueryFilters` interface** from
   `src/core/interfaces/session-memory.interface.ts`. Drop `previousSessionId` and
   `resumedFromCheckpoint` from `CreateSessionInput`.
6. **Drop `ISessionMemory` interface** entirely — the namespace IS the contract.
   Update `workspace-lifecycle.ts:65-73` accordingly: `sessions.create({ taskId })`
   for both fresh and resume dispatches (the previous-session-id branch in the call
   site is gone with the cut).
7. **Facade refactor** in `src/core/session-memory/index.ts`:
   - Expose `sessions`, `journal`, `checkpoints` as `public readonly` fields.
   - Delete every pass-through method.
   - Delete both "backwards compatibility" re-export blocks.
8. **Update every call site:**
   - `phase-runner.ts` (many sites — see research § 3.3 for the inventory).
   - `orchestrator/index.ts:166, 240`.
   - `pr-manager.ts:117`.
   - `daemon/health-monitor.ts:80`.
   - `daemon/task-scheduler.ts:133`.
   - `workspace-lifecycle.ts:65, 71`.
   - Test helpers + every session-memory test file.
9. Update `tests/unit/core/session-memory/sessions.test.ts` (drop getSessionChain),
   `journal.test.ts` (drop dynamic-filter cases, drop dead-enum cases, drop dead-column
   cases), `checkpoints.test.ts` (drop dead-reason cases), `index.test.ts` (update for
   namespace shape).
10. Run lint, typecheck, full test suite. Commit.

**Acceptance:**
- No call site uses `sessionMemory.addJournalEntry` / `createSession` / etc — all go
  through `sessionMemory.journal.addEntry` / `sessions.create` / etc.
- `ISessionMemory` is gone.
- Migration CHECK constraints reflect only enum values that are written.
- `previous_session_id` / `resumed_from_checkpoint` columns and schema fields are
  gone; `workspace-lifecycle.ts` calls `sessions.create({ taskId })` for both fresh
  and resume dispatches.
- `JournalQueryFilters` is gone; `queryJournal` is a single static query.
- All tests pass.
- **Observability audit:** journal entries written at resume time (`phase-runner.ts`
  line ~140) still capture the resume reason cleanly — they are now the only
  authoritative resume audit trail.

### Session 3 — Workspace-manager extractions (session-result, skills, removeThoughts)

**Goal:** Resolve the leaky module boundaries by moving misplaced concerns out of
workspace-manager. No behavior changes — pure relocation + import-graph cleanup. Also
cut `injectAuth` re-export and dead `push` branch.

**Tasks:**

1. **Naming check (per § 2).** Before writing code: decide the public name for the
   new skills module. `SkillsManager` works as a class name when paired with precise
   methods (`sync`, `getDir`) — the test from § 2 is "can you describe what it does
   without repeating the suffix?" Answer for skills: "syncs skill resources from
   source to runtime and exposes the runtime path" — passes. Confirm. Same check for
   session-result: not a class — module-level named functions. No -Manager.
2. **`core/session-result/` extraction:**
   - Create `src/core/session-result/index.ts` (barrel, named exports per § 6) —
     move `writeSessionResultTemplate`, `readSessionResult`, `backupSessionResult`.
     Each exported function gets a one-line JSDoc (§ 8).
   - Delete `src/core/orchestrator/session-result.ts`.
   - Update `workspace-manager/index.ts:28` (import path).
   - Update orchestrator's `llm-caller.ts` and any other consumer.
   - Move corresponding tests to
     `tests/unit/core/session-result/` (rename existing
     `tests/unit/core/orchestrator/session-result.test.ts`). Use behavior-as-fact
     test naming (§ 9 — no "should").
3. **`core/skills/` extraction:**
   - Create `src/core/skills/index.ts` (barrel, named exports per § 6) with
     `SkillsManager` class.
   - JSDoc on the class and every exported method (§ 8).
   - Move `syncSkills`, `getSkillsDir`, `findRepoRoot` out of WorkspaceManager.
   - Decide during implementation: does `findRepoRoot` move with skills or get
     replaced by a constructor-injected `repoRoot`? Default: inject repo root from
     bootstrap, drop the walk-up.
   - Preserve graceful degradation (§ 15) — `sync()` continues to log a warn and
     return when the source dir is missing; no throw.
   - Add a span (§ 14) around `sync()` — startup-time filesystem operation, span
     name `"skills_sync"`, metadata `{ source, target }`.
   - Add `SkillsManager` to bootstrap construction in
     `src/cli/commands/start/bootstrap.ts`. Update lines 95 and 120 to enumerate it.
   - Add `skillsManager: SkillsManager` to `OrchestratorContext` (in
     `orchestrator/types.ts`).
   - Update `orchestrator/index.ts:121` — call `skillsManager.sync()` instead of
     `workspaceManager.syncSkills()`.
   - Update `orchestrator/phase-handlers.ts:32` — call `skillsManager.getDir()`.
   - Delete `syncSkills`, `getSkillsDir`, `findRepoRoot` from WorkspaceManager + its
     interface.
   - Add `tests/unit/core/skills/index.test.ts`.
4. **`removeThoughtsAndPush` move to pr-manager:**
   - Move the method into `pr-manager.ts` (with whatever helper structure
     pr-manager wants).
   - Wrap the method in a span (§ 14) — pr-manager already uses spans at lines 144,
     248; the new method matches the pattern. Span name `"remove_thoughts_and_push"`,
     metadata `{ taskId, branch, fileCount }`. Use `recordDecision` for the
     "no files to remove" early-return path (§ 14 → Record Decisions Explicitly).
   - Update `review-handler.ts:652` to call `prManager.removeThoughtsAndPush(...)`.
   - Drop `removeThoughtsAndPush` from `WorkspaceManager` + its interface.
   - Audit pr-manager for unification: `pushBranch`, `deleteRemoteBranch`, the
     base-diff at line 196 — if a coherent surface emerges naturally, consolidate;
     otherwise leave as-is.
   - Move/expand tests for `removeThoughtsAndPush` into pr-manager test file.
5. **Cut `injectAuth` re-export** at `workspace-manager/index.ts:93-94`.
6. **Simplify `gitExecWithAuth`** at `workspace-manager/index.ts:665-675`:
   - Drop the unreachable `push` branch.
   - Consider renaming to `fetchWithAuth` (taking no args, hardcoded for fetch).
7. **Bootstrap log + comment audit:** update `src/cli/commands/start/bootstrap.ts`
   lines 95, 120 to enumerate `SkillsManager` alongside the existing Core components.
   Decide during implementation whether `core/session-result/` rises to the
   "Core components" log (it's a stateless utility module, not a service — likely
   omitted, but document the omission).
8. **Observability audit (Session 3 scope, covers § 12 + § 14):** confirm log
   strings on the relocated methods (skills sync, removeThoughtsAndPush) still
   describe what happens accurately from their new home. Observer scope names update
   if they no longer match the module. Span names use the new module's domain
   language.
9. Run lint, typecheck, full test suite. Commit.

**Acceptance:**
- `src/core/session-result/` exists; `src/core/orchestrator/session-result.ts` is gone.
- `src/core/skills/` exists with `SkillsManager`; workspace-manager has no skills
  methods.
- `removeThoughtsAndPush` is in pr-manager; review-handler calls it via pr-manager.
- `injectAuth` re-export is gone from workspace-manager; github-hosting still imports
  directly from utils.
- `gitExecWithAuth` is simplified (or renamed to `fetchWithAuth`).
- All tests pass.

### Session 4 — Workspace-manager state simplification (persist baseBranch, drop Map, drop baseCommit)

**Goal:** Single-source-of-truth the workspace state. Persist what needs to survive
restart, drop what doesn't earn persistence, kill the in-memory cache.

**Tasks:**

1. **Add `base_branch` to `TaskWorkspaceSchema`** in `src/schemas/task.ts`. (No SQL
   migration needed — `tasks.workspace` is a JSON `TEXT` column.)
2. **Update `task-engine/row-mapper.ts`** and any task creation/update paths to handle
   the new field.
3. **`createWorkspace` change:**
   - Compute `baseCommit` as a local; emit it in the event payload; do not store in
     `WorkspaceRecord`.
   - Pass `base_branch: resolvedBase` in the `taskEngine.updateTaskField("workspace",
     {...})` call.
4. **Drop `baseCommit` from `WorkspaceRecord`** (interface + class).
5. **Kill the `workspaces` Map:**
   - Remove the field.
   - `createWorkspace` no longer does `this.workspaces.set(...)`.
   - `cleanupWorkspace` no longer does `this.workspaces.delete(...)` — decide explicit
     behavior: either null `task.workspace` on cleanup, or leave the field alone for
     audit. Recommendation: leave alone — the worktree is gone physically; the record
     stays as audit. Verify no caller assumes `getWorkspaceRecord` returns null
     post-cleanup (today: returns null because Map is cleared).
     - **If callers DO rely on null-post-cleanup semantics:** add an explicit
       `cleaned_at: string | null` field on `TaskWorkspace`, set it on cleanup, and
       have `getWorkspaceRecord` return null when set. Verify during implementation.
   - `registerExistingWorkspace` — delete the method.
   - `getWorktreePath`, `getWorkspaceRecord` — implement by `taskEngine.getTask(taskId)
     ?.workspace ?? null`, constructing the record from the DB.
   - All other methods that did `this.workspaces.get(taskId)` for read — same change.
6. **Drop `registerExistingWorkspace` from the interface.**
7. **Update all `registerExistingWorkspace` callers:**
   - `workspace-lifecycle.ts:37, 59` — delete the calls (they become no-ops; the
     subsequent code that uses the workspace record now hits the DB).
   - `review-handler.ts:650` — same.
8. **`WorkspaceManager` constructor signature change:**
   - Add `taskEngine: ITaskEngine` (or whatever the type is — verify during
     implementation).
   - Update bootstrap construction.
9. **Tests:**
   - Update `tests/helpers/test-workspace-manager.ts` for the stateless model.
   - Update `tests/unit/core/workspace-manager/index.test.ts` for removed methods,
     removed Map semantics, new DB-backed reads, persisted `base_branch`.
10. **Resume flow verification (end-to-end check).** After the Map kill +
    base_branch persistence land, walk an integration-level test (or a focused unit
    test exercising `workspace-lifecycle.setupWorkspace` + `verifyWorkspace` +
    journal entry on resume) that exercises:
    - Fresh dispatch creates workspace, persists base_branch.
    - Daemon restart simulated (rebuild context from DB without touching the Map —
      it's gone).
    - Resume dispatch finds workspace via `getWorktreePath`, reads correct
      `baseBranch` from `task.workspace`, runs `verifyWorkspace` cleanly, writes the
      resume journal entry.
    - The session row created on resume has no `previous_session_id` field (cut in
      Session 2) — confirm the journal entry is the audit trail.
11. **Observability audit (Session 4 scope):** confirm `cleanupWorkspace`'s log
    line still describes the right thing after Map removal. Confirm error messages
    on `taskEngine.getTask` failures inside workspace-manager reads fail loud
    (Resilience lens — see Lens Check at the end of this plan).
12. Run lint, typecheck, full test suite. Commit.

**Acceptance:**
- `WorkspaceManager` has no `workspaces` field, no `registerExistingWorkspace` method.
- `TaskWorkspace.base_branch` persists.
- `WorkspaceRecord.baseCommit` is gone.
- All five `baseBranch` consumers (pr-manager × 2, evaluation × 2, removeThoughtsAndPush
  if still around) survive a daemon restart with the correct base.
- Resume flow verification passes end-to-end.
- All tests pass.

### Session 5 — Closing standards sweep

**Goal:** The slice does not close until every changed file has been read line-by-line
against `docs/coding-standards.md`, `docs/anti-patterns.md`, `docs/philosophy.md`, and
the principle-driven checks in `approach.md` § "Closing Standards Sweep". Apply the
same hunting discipline the RRP applied at slice start.

**Tasks:**

1. **File inventory.** `git diff <slice-start>..HEAD` enumerates every file changed by
   Sessions 1–4. Tier into Tier 1 (new modules + core surfaces) and Tier 2 (mechanical
   call-site updates + tests).
2. **Tier 1 line-by-line read.** Open each file in full. Walk the checklist:
   - Every documented reference matches code as-is (paths, names, defaults).
   - Plugin manifests match implementation behavior (N/A for this slice — no plugin
     surface changes).
   - Every swallowed error has a `warn` or `info` log.
   - `manifest` is read-only to the plugin (N/A — same reason).
   - Every constant lives in one place; no duplicated literal across files.
   - No stale counts in any new doc text.
   - No vestigial scaffolding (function exported but only used by tests; config field
     parsed but never read; event type declared but never published).
   - JSDoc and inline comments do not reference deleted features (post-Session 6
     defect class).
3. **Resume flow re-walk.** Open the final post-refactor code. Trace the resume flow
   from daemon boot → scheduler dispatch → workspace re-read → session create →
   verifyWorkspace → journal entry → phase resume. Each step uses the new shapes
   (statelesss workspace-manager, namespace-style sessionMemory, cut session fields).
   Confirm the flow composes cleanly.
4. **Observability sweep (§ 12 + § 14).** Read every observer call in the change
   set — logs (`info`/`warn`/`debug`), spans (`startSpan`), decisions
   (`recordDecision`). Confirm:
   - Every log describes what the code actually does after the refactor.
   - Every span name uses domain language consistent with its new module.
   - Every error path surfaces enough information for diagnosis.
   - `trace_id` correlation still works across the new module boundaries.
   - Structured fields over free-text (§ 14 → Structured Events).
5. **Coding-standards re-verification.** Confirm the sections enumerated in slice
   Decision #11 (§ 2, 5, 6, 7, 8, 12, 13, 14, 15) hold across the final code:
   - § 2 — new module names pass the no-vague-suffix test.
   - § 6 — both new modules have barrel `index.ts`, named exports, `import type`
     used.
   - § 7 — each new module is one cohesive concept in one file.
   - § 8 — every export has a one-line JSDoc.
   - § 13 — no floating promises introduced.
   - § 15 — skills sync still degrades gracefully on missing source.
6. **Workspace events documentation check.** Confirm the one-line comment on the
   `EVENTS` declaration explaining audit-only intent (Decision #12) is in place and
   reads cleanly.
7. **Tier 2 fast scan.** Confirm mechanical changes do not regress anything subtle.
8. **Defect fixes.** Each defect becomes its own commit with a one-line title naming
   the defect class.
9. **Update memory** if a new defect class surfaces — append to
   `feedback_slice_closing_standards_sweep.md` so the next sweep starts from this
   baseline.
10. **Slice close.** Move Slice 7 from Current to Completed Slices in `active.md`.
    Move Current pointer to Slice 8. Write the session log.

**Acceptance:**
- Every Tier 1 file walked line-by-line.
- Resume flow re-walked end-to-end against final code.
- Observability sweep complete; every log, span, and decision in the change set is
  accurate and uses structured data per § 14.
- Coding-standards re-verification complete across the sections in Decision #11.
- Workspace events comment in place.
- Every defect found has a corresponding fix commit.
- Memory updated if a new defect class surfaced.
- `active.md` advanced.

---

## Cross-Slice Handoffs Created by Slice 7

None expected. The slice is self-contained inside its surface. Inherited handoffs from
Slices 5 / 6 remain parked for their target slices (8 / 10 / 12 / 15).

---

## Verification Contract

End-of-slice gate (before marking slice done):

- `pnpm run lint` — zero warnings, zero errors.
- `pnpm run typecheck` — zero errors.
- `pnpm test` — all unit tests pass.
- `pnpm test:all` — all integration + e2e tests pass.
- `pnpm run build` — production build succeeds.
- Closing sweep session completed (Session 5).
- No file in the change set has a known defect against coding-standards / anti-patterns
  / philosophy.
- `docs/future-considerations.md` consolidated entry reads as a coherent self-contained
  story.

Per-session gate (every session): same `lint + typecheck + test` triad before commit.
Mid-session breakage is fine; commit-time breakage is not.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Migration CHECK update vs existing DB rows containing dead enum values (e.g., `decomposed` in `sessions.end_reason` from an old session). | Low | Medium | Migrations are consolidated — there are no production DBs to migrate. Local dev DBs get wiped via `scripts/reset.sh`. Verify the consolidated migration loads cleanly on a fresh DB. |
| Workspace-manager Map removal exposes a race or stale-read in `workspace-lifecycle.ts`. | Low | Medium | The atomic ordering check in research § 10 — `taskEngine.updateTaskField` must complete before any read. Verify with a focused test. |
| `cleanupWorkspace` post-Map semantics: today `getWorkspaceRecord(taskId)` returns null after cleanup (Map is empty); after refactor it returns the record from DB unless we explicitly null it. Behavioral change. | Medium | Medium | Surface and resolve during Session 4. Either null `task.workspace` on cleanup, add `cleaned_at`, or accept the change (verify no caller relies on null). |
| Six prompt builders editing in parallel produces merge friction. | Low | Low | Single-session work, no concurrent edits. Just discipline. |
| Skills extraction surfaces a missing test (no skills coverage exists today). | Medium | Low | Plan for it — Session 3 writes basic SkillsManager tests for `sync()` (idempotency + source-missing warn) and `getDir()`. |
| Removing the `ISessionMemory` interface breaks test mocks. | Medium | Low | Adapt mocks to mock the concrete `SessionMemory` class with public store fields. Test helpers (`tests/helpers/test-session-memory.ts`) already construct a real `SessionMemory` — no mock change there. |
| `gitExecWithAuth` rename touches the only call site (`fetch origin` at line 201); the alternative (leave the helper named, just drop the dead branch) is also fine. | Trivial | Trivial | Decide during Session 3. Default: simplify in place without rename to minimize churn. |
| `removeThoughtsAndPush` relocation to pr-manager pulls in `gitExec` dependency. | Low | Low | Either pr-manager grows its own `execFileSync` wrapper (cleaner), or it imports `gitExec` from a shared location. Decide during Session 3 based on what surfaces. |

---

## Pre-mortem — "Slice 7 shipped with a subtle bug"

Three most likely failure modes if we miss something:

1. **Concurrent dispatch races on the now-stateless workspace-manager.** The Map was
   accidentally synchronous within a process — every read after every write saw the
   latest value. After removal, the DB becomes the source of truth, but
   `task-engine.updateTaskField` writes to SQLite (better-sqlite3 is synchronous, so
   this is actually still safe within a process). **Mitigation:** verify with a
   focused integration test that creates a workspace, then immediately reads
   `getWorktreePath` from a different code path — must return the just-written value.

2. **`base_branch` persistence path is incomplete.** Tasks are created via several
   paths (trigger event → task creation, rework re-queue, manual retry). If any path
   doesn't carry `base_branch` through to `task.workspace`, the silent-wrong-base bug
   we're fixing actually persists. **Mitigation:** every `createWorkspace` call site
   gets audited; every `updateTaskField("workspace", ...)` write includes `base_branch`;
   the row mapper test asserts it round-trips.

3. **A prompt builder loses a reference that wasn't just `repoKnowledge`/`userKnowledge`
   but was actually load-bearing.** When stripping the knowledge plumbing across six
   prompt files, a near-miss edit could touch adjacent context (the section assembly
   logic, the repo overview, the task brief). **Mitigation:** for each prompt builder,
   run the existing tests post-edit (they assert the output structure); also one
   end-to-end smoke test that generates a real prompt with no knowledge and verifies it
   builds cleanly.

---

## Panel Review

Four perspectives, brief verdicts.

- **Linus (kernel/Git):** "Kill the dead code. Stop building infrastructure no one
  uses." Verdict: ✅ slice is shaped right. Concern: the `cleanupWorkspace` semantics
  question is real — pick one behavior and document it; do not punt.

- **Plugin author:** "Does this affect what I have to know to write a plugin?"
  Verdict: ✅ no. The plugin surface (adapter contracts) is untouched. The internal
  refactor cleans up Core's house without changing the plugin SDK shape.

- **Maintainer reviewing the PR a year from now:** "Can I tell what each commit did and
  why?" Verdict: ✅ if the session structure is followed — each session is one
  conceptual unit; each commit message names the slice + the unit clearly. Concern:
  Session 2 is large (touches many call sites); the commit message must enumerate the
  scope. Mitigation: write the commit body as a bulleted list of changes.

- **The Engineer persona itself:** "Every line earns its place. Every abstraction is
  justified. No dead code, no speculative abstractions, no 'just in case'
  complexity." Verdict: ✅ this is the slice that brings two large Core surfaces to
  that bar. Concern: the slice is mostly subtractive — make sure we don't leave any
  half-cut surface (a method removed but its tests still imported; a column dropped
  but a Zod field still declared). The closing sweep is the gate that catches that.

---

## Lens Check

Per `approach.md` § "Lenses" — every slice is evaluated through these perspectives.

- **Resilience.** Net positive. The `base_branch` persistence kills the silent
  wrong-base bug on daemon restart. The Map → DB read transition has one resilience
  question: if `taskEngine.getTask` throws (DB locked, task row missing), the
  workspace-manager reads (`getWorktreePath`, `getWorkspaceRecord`) must either
  return `null` (matching today's Map-based contract for missing keys) or throw a
  named error. Today's Map returns `null` silently on miss. **Recommendation
  during Session 4:** match the existing contract — `getWorktreePath(taskId)` returns
  `null` when `task.workspace` is null OR `taskEngine.getTask` returns null. Bubble
  unexpected exceptions from `taskEngine.getTask` (not "task missing" — actual DB
  errors).
- **Plugin Integrity.** Untouched. Every Slice 7 change is Core-internal. No adapter
  contract shifts, no plugin manifest fields change, no plugin SDK surface moves.
  Core would still compile and function if every plugin were deleted.
- **Plugin Authoring Simplicity.** Untouched. The two new modules (`core/skills/`,
  `core/session-result/`) live in Core. Plugin authors do not interact with them.
- **UX Quality.** Net neutral by intent, guarded by Decision #11 (log audit). The
  slice does not improve user-facing UX directly — the closest things to UX surface
  in this change set are observer log lines (developer UX) and error messages
  (`WorkspaceCreationError`, `WorkspaceNotFoundError`, `SessionNotFoundError`,
  `KnowledgeNotFoundError`). The first two stay; `SessionNotFoundError` stays;
  `KnowledgeNotFoundError` gets deleted with the knowledge layer. No new error class
  needed for the new modules unless behavior demands it.

## Closing Sweep Call-Out

Per `approach.md` § "Closing Standards Sweep":

- Session 5 is dedicated to the sweep. It is not optional.
- Apply the principle-driven checks, not just line-by-line reading.
- Special focus this slice: **deleted features leaving residue.** With knowledge cut,
  enum values cut, methods cut, modules moved — the risk surface is "code that
  references a thing that no longer exists." Comments, JSDoc, log strings, doc
  references, test imports — all must be audited.
- Update `feedback_slice_closing_standards_sweep.md` if a new defect class surfaces
  that the existing sweep principles wouldn't have caught.
