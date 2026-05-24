# Slice 7: Workspace & Session

## Requirements

Gathered through Q&A (Session 31). Code reality verified through direct grounding of every
related flow; deep research saved to `.claude/temp/research/slice-07-workspace-session.md`
with exact file paths and line numbers per decision area. Implementation plan saved to
`.claude/temp/create-plan/slice-07-workspace-session.md`.

### Scope Framing

This is an **audit / refactor / cut + consolidate** slice covering everything that gives a
task its physical home and its memory of itself: the git worktree lifecycle, the
`thoughts/` directory protocol, the session/journal/checkpoint persistence layer, the
knowledge layer (which turns out to never have been wired), and the seams between these
concerns and the orchestrator.

Two halves:

1. **The session-memory surface** — `src/core/session-memory/` (four sub-stores behind a
   facade) plus the schemas (`schemas/session-memory.ts`), the SQL tables in
   `001_schema.sql`, and the orchestrator + scheduler + health-monitor consumers.
2. **The workspace-manager surface** — `src/core/workspace-manager/` (a 700-line class
   that owns worktree lifecycle, clone/push, thoughts directory setup, thoughts cleanup,
   and skills syncing), plus the orchestrator's `workspace-lifecycle.ts` and the
   `TaskWorkspace` persistence field.

Out of scope (handed off to other slices):

- Decomposition handler deletion, planning-prompt cleanup, trivial-skip, signal honoring
  through phase-runner → llm-caller → LLM plugins → Slice 8.
- Review polling, feedback rework loop → Slice 10.
- Notification-kind audit, reply-token correlation, unblock-check semantics → Slice 12.
- Dashboard UI updates that follow from the changes here → Slice 15.

### Goals (priority order)

1. **Cut the knowledge layer in full.** It has been wired as a read-only consumer for
   thirty sessions with no producer. Per-task continuity is already solved by the file-
   based `thoughts/` protocol; the knowledge layer was the unrealized cross-task half of
   a two-half design. Preserve the *idea* in `docs/future-considerations.md` —
   consolidated with `Hybrid Semantic Memory Search` into a single forward-looking entry
   that captures cross-task memory as a *supplementary* capability on top of files.
2. **Refine the session-memory surface to its actual shape.** Cut every enum value with
   no writer (4 of 7 `JournalEntryType`s, 2 of 4 `CheckpointReason`s, 2 of 7
   `SessionEndReason`s), cut the four `JournalEntry` columns that are never populated,
   collapse the dynamic-SQL filter machinery (no caller passes filters), drop the
   `getSessionChain` method (zero callers), and dissolve the facade's pass-through layer
   in favour of a namespace exposing the stores directly.
3. **Refine the workspace-manager surface to its actual shape.** Cut the
   "for backwards compatibility" `injectAuth` re-export. Cut the dead `push` branch in
   `gitExecWithAuth`. Persist `baseBranch` into `task.workspace` (currently lost on
   restart, silently corrupting PR/eval/cleanup against non-default bases). Drop
   `baseCommit` from `WorkspaceRecord` (read nowhere post-creation). Kill the in-memory
   `workspaces` Map and `registerExistingWorkspace`; the DB-persisted `task.workspace`
   becomes the single source of truth.
4. **Resolve the leaky module boundaries.** Move `session-result.ts` out of
   `orchestrator/` into its own `core/session-result/` module so workspace-manager and
   orchestrator both consume it as peers. Extract skills concerns (`syncSkills`,
   `getSkillsDir`, `findRepoRoot`) out of workspace-manager into a new `core/skills/`
   module. Move `removeThoughtsAndPush` out of workspace-manager into `pr-manager` where
   it belongs (it is PR-prep work, called only from `review-handler` immediately before
   merge), and look for adjacent unification opportunities in pr-manager while doing so.
5. **Docs and tests in sync.** Every changed surface gets corresponding docs. Tests for
   cut code get deleted. New tests for new module boundaries. Closing standards sweep at
   the end of the slice.
6. **Resume flow stays coherent end-to-end.** The session brief names "session resume"
   in scope. The cuts and refactors touch every piece of the resume flow (sessions table,
   facade, workspace state, `verifyWorkspace`, `dispatch.resume_from`). The slice owns
   verifying that the flow still composes cleanly after the changes — not just the
   individual pieces.

## Decisions

### #1 — Cut the knowledge layer in full

`KnowledgeStore` has been wired as a read-only consumer since its introduction: the
scheduler reads `getKnowledge("repo", task.workspace.repo)` and `getKnowledge("user")` on
every dispatch, threads the (always empty) results through `Dispatch.knowledge`, and
every RRPIR phase prompt builder calls `buildKnowledgeSection(repoKnowledge,
userKnowledge)` which returns `null` because the table is always empty. `storeKnowledge`,
`supersedeKnowledge`, and `confirmKnowledge` have **zero callers in src/** — no extractor
ever runs.

**Pivot story:** per-task continuity between phases is already solved by the file-based
`thoughts/` protocol. Every phase prompt embeds the previous phases' deliverable paths
with explicit "read this before you start" instructions; the LLM uses its native Read
tool to pull content. Files are filesystem-resident, survive crashes, ship with the PR,
and get cleanly removed before merge. The knowledge layer was the unrealized cross-task
half — a different problem (cross-task pattern accumulation) that we never had a
producer for.

**Blast radius:**

- `src/core/session-memory/knowledge.ts` — delete.
- `src/core/session-memory/index.ts` — drop `knowledge: KnowledgeStore` field, drop
  `storeKnowledge` / `getKnowledge` / `supersedeKnowledge` / `confirmKnowledge` pass-
  through methods, drop knowledge re-exports.
- `src/core/interfaces/session-memory.interface.ts` — drop `storeKnowledge` /
  `getKnowledge` / `supersedeKnowledge` / `confirmKnowledge` from `ISessionMemory`. Drop
  `StoreKnowledgeInput` interface.
- `src/schemas/session-memory.ts` — delete `KnowledgeScope*`, `KnowledgeConfidence*`,
  `KnowledgeDomain*`, `KnowledgeEvidence*`, `KnowledgeEntry*`, `knowledgeId()` function.
- `src/core/session-memory/row-mappers.ts` — drop `KnowledgeEntryRow` interface and
  `rowToKnowledgeEntry` function. Drop `KnowledgeNotFoundError` from
  `session-memory/errors.ts`.
- `src/db/migrations/001_schema.sql` — drop `knowledge` table + 3 indexes (per universal
  rule "consolidate migrations").
- `src/core/daemon/task-scheduler.ts` — drop `repoKnowledge` / `userKnowledge` reads,
  drop the `knowledge` field on the `Dispatch` package, drop the
  `knowledgeEntries` log field on the dispatch info log.
- `src/schemas/ephemeral.ts` — drop `knowledge: { repo: KnowledgeEntry[]; user:
  KnowledgeEntry[] }` from `DispatchSchema` (verify location during research).
- `src/core/orchestrator/phase-handlers.ts` — drop `repoKnowledge` / `userKnowledge` from
  every phase prompt context (6 phases × 1–2 sites each).
- `src/core/orchestrator/prompts/format.ts` — delete `buildKnowledgeSection` and
  `formatKnowledge`.
- `src/core/orchestrator/prompts/{requirements-gathering,research,planning,execution,review,demo-prep}.ts`
  — drop `repoKnowledge` / `userKnowledge` parameters, drop "Known Context" section assembly,
  drop the `KnowledgeEntry` import.
- **Tests** — delete `tests/unit/core/session-memory/knowledge.test.ts`. Trim
  `tests/unit/core/session-memory/index.test.ts` knowledge sections. Update any tests
  that mock `Dispatch.knowledge` to drop the field.

**Cross-slice handoff:** none — knowledge layer is self-contained inside Slice 7's scope.

**Future-considerations consolidation:** merge `Hybrid Semantic Memory Search` into a new
single entry titled **"Cross-Task & Cross-Session Memory (supplementary)"**. The
consolidated entry captures (a) the pivot story (files are primary; knowledge layer was
the unbuilt producer half), (b) the capability (cross-task pattern recall, cross-session
continuity), (c) the producer-is-the-hard-problem framing, and (d) retrieval as
open-ended — structured fields, embeddings, knowledge graphs, hybrid scoring all
optional implementations, none prescribed.

### #2 — Cut every dead enum value, column, filter, and re-export in session-memory

Same principle, applied to whatever the codebase shows zero consumers for. All sub-cuts
batched into one decision because they share the defect class.

- **`getSessionChain` method** — zero callers. Drop from interface, store, facade.
- **`previous_session_id` and `resumed_from_checkpoint` columns on `sessions`** — written
  by `SessionStore.createSession` (via `workspace-lifecycle.ts:67-68`), never read by any
  production code path. Same defect class as `getSessionChain`. Drop the columns, drop
  the schema fields, drop the row-mapper handling, drop the `previousSessionId` /
  `resumedFromCheckpoint` parameters from `CreateSessionInput`. The audit trail "this
  dispatch was a resume" is already captured by the journal `phase_change` entry the
  resume path writes at `phase-runner.ts:140`.
- **`JournalEntryType` enum values** — keep `phase_change`, `error`,
  `checkpoint_marker` (the only three written). Cut `action`, `finding`, `decision`,
  `communication`. Update CHECK constraint in migration.
- **`JournalEntry` type-specific columns** — `action_type`, `finding_type`,
  `decision_key`, `comm_target` are never populated (no call site passes them). Drop
  from schema, row mapper, `AddJournalEntryInput`, and migration. `error_detail` stays
  (used for errors).
- **`JournalQueryFilters` machinery** — no call site passes any filter. Drop the
  interface, drop the dynamic-SQL builder in `JournalStore.queryJournal`, collapse to a
  single static prepared statement: `SELECT * FROM journal_entries WHERE task_id = ?
  ORDER BY timestamp ASC`.
- **`CheckpointReason` enum values** — keep `phase_transition`, `preemption`. Cut
  `pre_costly_op`, `periodic`. Update CHECK constraint in migration.
- **`SessionEndReason` enum values** — keep `completed`, `preempted`, `crashed`,
  `review_pending`, `blocked`. Cut `new_session`, `decomposed` (`decomposed` is residue
  from Slice 6's decomposition delete). Update CHECK constraint in migration.
- **"Backwards compatibility" re-exports in `session-memory/index.ts`** — the comments
  literally cite backward compat; pre-v1 says delete. Both re-export blocks go (interface
  types and row mappers).

### #3 — Reshape the SessionMemory facade as a namespace, not a forwarder

The facade provides real conceptual grouping — three stores share a DB, lifetime, and
purpose. A reader seeing `SessionMemory` in bootstrap immediately understands the
conceptual area. Dissolving it scatters that.

The 100 lines of pass-through methods are the actual smell. Replace them by exposing the
stores as public readonly fields and letting call sites address the specific store they
need.

**Shape after refactor:**

```typescript
export class SessionMemory {
  readonly sessions: SessionStore;
  readonly journal: JournalStore;
  readonly checkpoints: CheckpointStore;

  constructor(db: Database.Database) {
    this.sessions = new SessionStore(db);
    this.journal = new JournalStore(db);
    this.checkpoints = new CheckpointStore(db);
  }
}
```

Call sites go from `ctx.sessionMemory.addJournalEntry(...)` to
`ctx.sessionMemory.journal.addEntry(...)`. Each call says which store it touches.

**Rename opportunity:** drop the redundant `Journal` / `Session` / `Checkpoint`
suffix from store methods now that the parent namespace carries the context.
`addJournalEntry` → `journal.addEntry`. `createSession` → `sessions.create`.
`endSession` → `sessions.end`. `createCheckpoint` → `checkpoints.create`.
`getLatestCheckpoint` → `checkpoints.getLatest`. `getLatestJournalTimestamp` →
`journal.getLatestTimestamp`. `queryJournal` → `journal.query`.

**`ISessionMemory` interface** — the namespace shape is the contract. Drop the interface
entirely (each store has its own implicit contract via its class). If a future
implementation swap is ever needed, the contract can be reintroduced as separate
interfaces per store.

### #4 — Persist `baseBranch`, drop `baseCommit` from `WorkspaceRecord`

`baseBranch` is consumed in five runtime paths after creation:

- `pr-manager.ts:196` — counts commits ahead of base for PR description.
- `pr-manager.ts:354` — sets PR base on creation.
- `evaluation/snapshot.ts:59-60` — diffs and logs against base for evaluation.
- `workspace-manager.ts:581` (`removeThoughtsAndPush`) — diffs against base.
- `evaluation/prompts.ts` — embeds base branch in eval prompts.

After daemon restart, `registerExistingWorkspace` hardcodes `baseBranch:
this.config.default_base_branch`. If a task created its workspace with a custom base
(via `createWorkspace`'s `baseBranch` option), every one of those five consumers reads
the *wrong* base post-restart — silent correctness bug masked by the fact that nothing
in production uses a non-default base today.

**Fix:** add `base_branch: string` to `TaskWorkspaceSchema`. Workspace creation persists
it via the same `taskEngine.updateTaskField("workspace", ...)` call that already writes
`worktree_path` / `branch`. Reads load it from `task.workspace.base_branch`. `Workspace
Record.baseBranch` becomes a view over `task.workspace.base_branch`.

`baseCommit` is read nowhere post-creation. It is computed at creation, logged once, and
emitted in the `workspace.created` event payload. Persisting it would store an
immediately-stale snapshot — the actual base ref keeps moving as new commits land. Drop
it from `WorkspaceRecord` and `IWorkspaceManager.WorkspaceRecord`; keep it as a local
in `createWorkspace` purely to populate the event payload, then discard.

### #5 — Kill the in-memory `workspaces` Map; DB is single source of truth

Today the workspace-manager holds `private readonly workspaces = new Map<string,
WorkspaceRecord>()`, mutated by `createWorkspace`, `cleanupWorkspace`, and
`registerExistingWorkspace`. On daemon restart, `registerExistingWorkspace` rebuilds the
Map from `task.workspace`. Two stores; manually kept in sync; the rebuild loses
`baseCommit` (set to `""`) and silently coerces `baseBranch` (see #4).

**Fix:** kill the Map. `WorkspaceManager` becomes effectively stateless — every read
goes through `taskEngine.getTask(taskId)` and constructs the record from
`task.workspace`. `registerExistingWorkspace` disappears (nothing to register).
`getWorktreePath(taskId)` and `getWorkspaceRecord(taskId)` query the DB.

**Call sites that change:** `orchestrator/workspace-lifecycle.ts` (no longer calls
`registerExistingWorkspace`), tests, anywhere else that depends on Map presence
semantics. Lookup is now uniform regardless of daemon-restart state.

### #6 — Cut the dead `injectAuth` re-export and the dead `push` branch

- **`injectAuth` re-export at line 93–94 of `workspace-manager/index.ts`** — comment
  cites backwards compatibility. The one consumer (`plugins/git-hosting/github-hosting`)
  imports from the canonical `utils/git-url.js` directly. Delete the re-export.
- **`gitExecWithAuth` `push` branch (line 666)** — `if (args[0] === "fetch" || args[0]
  === "push")`. Every push call site builds the auth URL explicitly and goes through the
  plain `gitExec` path (lines 503, 528). The `push` branch is never taken. Simplify the
  helper to "fetch with auth" semantics (or rename to make that explicit).

### #7 — Relocate session-result code to `core/session-result/`

`src/core/orchestrator/session-result.ts` exports `writeSessionResultTemplate`,
`readSessionResult`, and `backupSessionResult`. Workspace-manager imports
`writeSessionResultTemplate` to populate phase directories at workspace creation;
orchestrator imports the read + backup functions to manage the LLM-CLI handoff.

Workspace-manager and orchestrator are both Core services at the same architectural
layer; one importing from the other's directory is the boundary smell. Resolve by
relocating session-result to its own neutral module that both depend on as peers.

Move to `src/core/session-result/index.ts` (or `core/session-result/session-result.ts`
with a barrel). Update both call sites. The `PHASE_DIRECTORIES` constant currently in
`schemas/orchestrator.ts` stays where it is (it's an enum-like constant about phase
shape, not a session-result concern).

### #8 — Extract skills concerns to `core/skills/`

`WorkspaceManager.syncSkills()`, `getSkillsDir()`, and `findRepoRoot()` (private helper
that exists solely to locate `resources/skills/` for the sync) have nothing to do with
git worktrees, branches, or PR-prep. Their colocation in workspace-manager is incidental
— skills happen to live under `workspace_root`.

**Extract** to `src/core/skills/index.ts`:

- `SkillsManager` class with `sync()` and `getDir()` methods.
- Bootstrap constructs it alongside other Core services.
- Orchestrator constructor receives it on `OrchestratorContext`; orchestrator init calls
  `skillsManager.sync()` instead of `workspaceManager.syncSkills()`.
- Phase-handlers capture `skillsManager.getDir()` instead of
  `workspaceManager.getSkillsDir()`.

`findRepoRoot()` either moves with it or gets replaced by a cleaner resolver — research
to find the simplest stable approach.

### #9 — Move `removeThoughtsAndPush` to `pr-manager`; look for unification

`removeThoughtsAndPush(taskId)` (line 574 of workspace-manager) does git operations
tightly coupled to PR-prep — diffs the worktree against the base branch, removes added
thoughts files, commits, and pushes. Called only from `review-handler.ts:652`,
immediately before merge.

This is PR-prep work, not workspace-manager work. Relocate to `pr-manager`. While
relocating, audit pr-manager for adjacent git operations that consolidate naturally
(`pushBranch`, `deleteRemoteBranch`, the base-diff logic in `pr-manager.ts:196`) — there
may be a coherent "git PR operations" surface that emerges.

Workspace-manager retains the canonical `gitExec` helper if pr-manager needs it; or
pr-manager grows its own. Decide during planning based on what surfaces.

### #10 — Verify the resume flow composes cleanly end-to-end

The slice cuts and reshapes touch every link in the resume chain. None of the changes
intend to alter resume behavior, but the slice owns the gate that confirms it.

**The resume flow:**

1. Daemon restart (or crash-recovery boot) — scheduler iterates queued + active tasks.
2. `task-scheduler.ts` builds the `Dispatch` package — `resume_from: getLatestCheckpoint
   (task.id)` carries the checkpoint object.
3. `workspace-lifecycle.ts:setupWorkspace` sees `dispatch.resume_from` is non-null →
   after Slice 7's Map removal, it relies on `task.workspace` being present in the DB
   (which is the same source of truth `getWorktreePath` reads). No `registerExistingWorkspace`
   call.
4. `workspace-lifecycle.ts:createSession` creates a new session — after Slice 7's
   session field cuts, the call is just `sessions.create({ taskId })`. The "resumed
   from X" audit lives in the journal entry written at step 6, not in the session row.
5. `phase-runner.ts:startupResume` calls `verifyWorkspace(taskId)` — still works
   statelessly via the DB read.
6. `phase-runner.ts` writes a journal `phase_change` entry summarizing
   "Resumed from checkpoint in `<phase>` phase. Reason: `<reason>`."
7. Pipeline resumes from `checkpoint.phase`.

**Verification:** Session 4 explicitly walks an end-to-end resume integration test
(real or as-close-as-feasible) after the Map kill + base_branch persistence land.
Session 5's closing sweep re-walks the flow against the final code state.

### #11 — Apply coding-standards.md continuously, not just at the closing sweep

Per `approach.md` § "What Each RRP Must Hunt For" → coding-standards alignment is a
planning concern. The sections that actively apply to Slice 7's change set, with the
specific items each one surfaces:

**§ 2 Naming.** "No vague -ER suffixes" — the new module names need a real check.
`SkillsManager` is borderline; `SkillsSync` loses the path-resolution responsibility.
Plan target: name it precisely or pick a different shape (a small object with named
exports, no class). Decide during planning of Session 3, not implementation.

**§ 5 Error Handling.** New modules (skills, session-result) need error categorization
decisions. Likely: no new error classes required (skills sync failures degrade
gracefully per § 15; session-result already throws `WorkspaceCreationError` paths from
its callers). Confirm during planning of Session 3.

**§ 6 Imports & Dependencies.** New modules `core/skills/` and `core/session-result/`
each get a barrel `index.ts` (§ 6 → Barrel Files). Named exports only (§ 6 → No Default
Exports). `import type` for type-only imports (§ 6 → Type Imports). Acceptance check on
both new modules.

**§ 7 Module Boundaries.** "One concept per file" — verify the new modules don't grow
beyond one cohesive concept. Today's plan: skills = sync + getDir (one concept: skill
runtime resource), session-result = read + write template + backup (one concept:
session-result file lifecycle). Both fit in one file each.

**§ 8 Comments & Documentation.** Every exported function/class/type in the new modules
gets a one-line JSDoc. Acceptance check on both new modules.

**§ 12 Logging.** "Log decisions, not actions." The audit covers every observer.info /
observer.warn / observer.debug in the change set. Specific items:

- **Bootstrap log + comment strings** — `src/cli/commands/start/bootstrap.ts:95, 120`
  enumerate Core components by name. Add the new modules (or document a deliberate
  omission for stateless utility modules).
- **`registerExistingWorkspace`'s observer debug logs** — deleted with the method;
  ensure no caller relied on the log lines for diagnostics.
- **`removeThoughtsAndPush` log strings** — `observer.info("Removing branch-introduced
  thoughts files before merge", ...)` follows the method to pr-manager; confirm the
  observer scope name still makes sense after the move.
- **Skills sync log** — `observer.info("Skills synced", { source, target })` follows
  the method to the new module; ensure observer scope reflects the new home.
- **Knowledge-related log fields** — any `knowledgeEntries: { ... }` log fields die
  with the knowledge layer in Session 1.

**§ 13 Async Discipline.** No floating promises. New code paths in skills-manager (sync
is sync — `cpSync`) and session-result (file I/O is sync — `writeFileSync`/`readFileSync`)
don't introduce async hygiene risks, but verify during implementation.

**§ 14 Observability & Tracing.** The neglected surface that flagged this entire fix.
Span coverage of refactored operations:

- **`removeThoughtsAndPush` in its new pr-manager home** — non-trivial multi-step git
  operation (diff + rm + commit + push). pr-manager already uses spans at lines 144,
  248; this method gets one too when it lands. Span name: e.g.,
  `"remove_thoughts_and_push"`, with `taskId`, `branch`, `fileCount` in metadata. Per
  § 14 → Record Decisions Explicitly, the "no files to remove" early-return path may
  also warrant a `recordDecision` (skip vs. proceed).
- **`SkillsManager.sync()`** — startup-time filesystem copy. Span-worthy as an
  observable startup operation.
- **`session-result` module** — three short pure-ish functions; no span needed
  (covered by the parent phase span in orchestrator).
- **`trace_id` correlation** — automatic via the observer facade. No code change
  needed, but verify the refactored code paths still carry the right scope.
- **Structured events over free text** (§ 14 → Structured Events) — every span
  passes structured `input`/`output`/`metadata`, never just a string message.

**§ 15 Graceful Degradation.** `SkillsManager.sync()` currently logs a warn and returns
if the source directory doesn't exist (`workspace-manager/index.ts:635-638`). Preserve
that behavior in the new module — failed skills sync is a degraded capability, not a
crash.

Per the principle: each implementation session applies these checks to its own change
set as it writes the code. Session 5's closing sweep re-verifies everything against the
final code state. The sweep is the gate, not the first inspection.

### #12 — Document workspace events as audit-trail-only

`workspace-manager/index.ts:38-60` declares three events (`workspace.created`,
`workspace.verified`, `workspace.cleaned`) with `subscribers: []`. The empty
subscribers array is intentional — they're consumed by the EventBus persistence layer
for audit, not by any runtime subscriber. Add a one-line comment to the `EVENTS`
declaration making this intent explicit so a future reader doesn't flag it as dead.

### #13 — Tests, docs, closing sweep

- **Tests:** delete knowledge tests in full. Delete dead-enum-value test cases. Delete
  dynamic-SQL filter test cases. Update facade tests to the namespace shape. Update
  workspace-manager tests for the stateless model and removed methods. Add tests for the
  new `core/skills/` and `core/session-result/` modules. Add tests for the relocated
  `removeThoughtsAndPush` in pr-manager.
- **Docs:** update `docs/configuration/workspace.md` if any config-surface change lands.
  Update `docs/architecture/` if module boundaries change (skills extraction,
  session-result relocation, workspace-manager scope reduction). Update
  `docs/future-considerations.md` with the consolidated entry. No prescriptive
  references — describe by capability, not by file path.
- **Closing sweep:** the slice closes with a full-file line-by-line audit of every file
  in the change set against `docs/coding-standards.md`, `docs/anti-patterns.md`,
  `docs/philosophy.md`, and the principle-driven checks in
  `approach.md` § "Closing Standards Sweep". Apply the same hunting discipline the
  RRP applied at slice start. Update memory if a new defect class surfaces.

## Lens Check

Per `approach.md` § "Lenses" — every slice is evaluated through these perspectives.

- **Resilience.** Net positive. The `base_branch` persistence kills a silent
  correctness bug (wrong-base on restart). The Map-to-DB read transition needs a
  resilience check during Session 4 — if `taskEngine.getTask` throws (e.g., DB locked,
  task row deleted), workspace-manager reads must fail loud, not silently. Today's
  Map-based reads return `null` on missing key; DB-based reads must either match that
  contract or be loud about the difference. Surfaced in the plan's risks table.
- **Plugin Integrity.** Untouched. Every change in Slice 7 is Core-internal —
  workspace-manager and session-memory are Core services. No adapter contracts shift;
  no plugin manifest fields change; the plugin SDK surface stays as-is. Core would
  still compile and function if every plugin were deleted.
- **Plugin Authoring Simplicity.** Untouched. The two new modules (`core/skills/`,
  `core/session-result/`) live in Core; plugins do not need to know about them. The
  facade refactor changes Core-internal call sites only.
- **UX Quality.** Net neutral by intent — see Decision #11 (observability and log audit).
  The slice doesn't degrade UX; the audit ensures it doesn't accidentally regress
  observability either (log messages must still describe what happened accurately
  after methods move modules).
