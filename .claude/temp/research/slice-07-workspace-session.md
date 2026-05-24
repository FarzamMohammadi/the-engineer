# Research — Slice 7: Workspace & Session

Direct source grounding for the slice's audit / refactor surface. File paths and line
numbers are factual as of `4715c3a` (post-Slice 6 wrap). Verify any number before relying
on it during implementation — code may shift.

## 1. Knowledge layer (the biggest cut)

### 1.1 The store and its surface

`src/core/session-memory/knowledge.ts` — `KnowledgeStore` class, ~115 lines.

- 6 prepared statements (insert, get-by-id, get-active by scope, get-active by scope +
  repo, supersede, confirm).
- 4 public methods: `storeKnowledge` (idempotent upsert by content-hash id),
  `getKnowledge` (read by scope, optionally filtered by repoScope), `supersedeKnowledge`,
  `confirmKnowledge`.

`src/core/session-memory/index.ts:50-106` — facade owns `knowledge: KnowledgeStore`
field and forwards all four methods.

`src/core/interfaces/session-memory.interface.ts:54-66, 84-87` —
`StoreKnowledgeInput` interface and the four `ISessionMemory` knowledge methods.

`src/core/session-memory/errors.ts:21-30` — `KnowledgeNotFoundError` class.

`src/core/session-memory/row-mappers.ts:62-76, 133-150` — `KnowledgeEntryRow` interface
and `rowToKnowledgeEntry` function.

### 1.2 The schemas and DB table

`src/schemas/session-memory.ts:113-173` — `KnowledgeScopeSchema`,
`KnowledgeConfidenceSchema`, `KnowledgeDomainSchema`, `KnowledgeEvidenceSchema`,
`KnowledgeEntrySchema`, and the `knowledgeId()` content-hash helper.

`src/db/migrations/001_schema.sql:180-200` — `knowledge` table + 3 indexes
(`idx_knowledge_natural_key`, `idx_knowledge_active`, `idx_knowledge_domain`).

### 1.3 The producers — there aren't any

`grep -rn "storeKnowledge|supersedeKnowledge|confirmKnowledge" src/` returns **zero
production call sites**. Only the store, the facade, and the interface declare them.

### 1.4 The consumer chain (read-only, always empty)

- `src/core/daemon/task-scheduler.ts:142-143` — reads `repoKnowledge` and `userKnowledge`
  on every dispatch.
- `src/core/daemon/task-scheduler.ts:167` — logs `knowledgeEntries: { repo:
  repoKnowledge.length, user: userKnowledge.length }`.
- `src/core/daemon/task-scheduler.ts:178` — packs into `Dispatch.knowledge`.
- `src/schemas/ephemeral.ts:89-96` — `DispatchSchema` declares `knowledge: z.object({
  repo: z.array(KnowledgeEntrySchema), user: z.array(KnowledgeEntrySchema) })`.
- `src/core/orchestrator/phase-handlers.ts` — six phases (requirements_gathering,
  research, planning, execution, self_review, demo_prep) all pass `dispatch.knowledge.
  repo` and `dispatch.knowledge.user` into their prompt builders. Specific lines:
  59-60, 87-88, 113-114, 140-141, 179-180, 202-203, 249-250 (some phases pass twice for
  sub-pipelines like multi-step review).
- `src/core/orchestrator/prompts/{requirements-gathering,research,planning,execution,
  review,demo-prep}.ts` — every prompt builder declares
  `repoKnowledge: KnowledgeEntry[]; userKnowledge: KnowledgeEntry[]` in its context
  type and calls `buildKnowledgeSection(ctx.repoKnowledge, ctx.userKnowledge)` to
  assemble the "Known Context" section.
- `src/core/orchestrator/prompts/format.ts:84-104` — `buildKnowledgeSection` returns
  `null` if both arrays are empty (which they always are), so the prompt section is
  never written.

### 1.5 Tests

- `tests/unit/core/session-memory/knowledge.test.ts` — 145 lines, all knowledge-store
  coverage. Delete entirely.
- `tests/unit/core/session-memory/index.test.ts:582 lines` — contains knowledge facade
  test cases mixed with the other store cases. Inspect during planning and surgically
  remove knowledge sections.

## 2. Other dead surface in session-memory

### 2.1 `getSessionChain`

- Declared in `interfaces/session-memory.interface.ts:88`, facade
  `session-memory/index.ts:70-72`, store `session-memory/sessions.ts:56-59`.
- **Zero callers in src/.** `grep -rn "getSessionChain" src/` finds only the definitions.
- `tests/unit/core/session-memory/sessions.test.ts` covers it — delete the section.

### 2.2 `JournalEntryType` dead values

`src/schemas/session-memory.ts:33-41` — enum has `action`, `finding`, `decision`,
`error`, `communication`, `phase_change`, `checkpoint_marker`.

Production writes only:

- `phase_change` — `phase-runner.ts` lines 144, 201, 211, 221, 367
- `error` — `phase-runner.ts:270`, `phase-runner.ts:395`, `pr-manager.ts:121`
- `checkpoint_marker` — `phase-runner.ts:310` (preemption only)

Cut: `action`, `finding`, `decision`, `communication`.

Update `001_schema.sql:140` — the `CHECK(type IN (...))` constraint.

### 2.3 `JournalEntry` type-specific columns

`src/schemas/session-memory.ts:47-69` — `action_type`, `finding_type`, `decision_key`,
`error_detail`, `comm_target`.

Grep every `addJournalEntry` call site in src/ — none pass `actionType`, `findingType`,
`decisionKey`, or `commTarget`. Only `errorDetail` is passed (at `phase-runner.ts:272`
and `pr-manager.ts:123`).

Cut: `action_type`, `finding_type`, `decision_key`, `comm_target` columns + schema
fields + `AddJournalEntryInput` parameters + row mapper handling.

Update `001_schema.sql:143-147` — remove the four columns from `CREATE TABLE
journal_entries`.

### 2.4 `JournalQueryFilters`

`src/core/interfaces/session-memory.interface.ts:67-73` — declares filters `type`,
`phase`, `tags`, `since`.

`src/core/session-memory/journal.ts:86-114` — `queryJournal` builds dynamic SQL based
on filters, supports AND-semantics for tags.

Only call site: `orchestrator/index.ts:240` — `this.ctx.sessionMemory.queryJournal(
taskId)`. **No filters passed.** Followed by `.slice(-5)` to grab the most recent 5
entries for blocked-task context.

Cut: `JournalQueryFilters` interface, the dynamic-SQL builder. Collapse `queryJournal`
to a single prepared statement: `SELECT * FROM journal_entries WHERE task_id = ? ORDER
BY timestamp ASC`.

### 2.5 `CheckpointReason` dead values

`src/schemas/session-memory.ts:74-78` — enum: `phase_transition`, `preemption`,
`pre_costly_op`, `periodic`.

Production writes only `phase_transition` (`phase-runner.ts:174`) and `preemption`
(`phase-runner.ts:302`).

Cut: `pre_costly_op`, `periodic`. Update CHECK in `001_schema.sql:171`.

### 2.6 `SessionEndReason` dead values

`src/schemas/session-memory.ts:6-15` — enum: `completed`, `preempted`, `crashed`,
`new_session`, `decomposed`, `review_pending`, `blocked`.

Production writes: `crashed` (orchestrator/index.ts:166, phase-runner.ts:278),
`completed` (phase-runner.ts:1049), `preempted` (phase-runner.ts:315), `blocked`
(phase-runner.ts:420, 627, 943), `review_pending` (phase-runner.ts:482).

Cut: `new_session`, `decomposed`. Update CHECK in `001_schema.sql:125`.

### 2.7 `previous_session_id` and `resumed_from_checkpoint` columns (write-only)

`src/db/migrations/001_schema.sql:126-127` — the two columns on `sessions`.

Writers:

- `src/core/session-memory/sessions.ts:20, 32, 33, 35, 43, 44` — `createSession` writes
  both via the prepared statement.
- `src/core/orchestrator/workspace-lifecycle.ts:67-68` — `createSession` is called with
  `previousSessionId: dispatch.resume_from.session_id` and `resumedFromCheckpoint:
  dispatch.resume_from.id` when the dispatch is a resume.

Readers across `src/`: **zero**. The row mapper at `session-memory/row-mappers.ts:88-89`
maps the fields onto the `Session` object, but the resulting `Session` object's fields
are not consumed by any code path. (`task-scheduler.ts:150` uses the string literal
`"resumed_from_checkpoint"` as a state-transition reason — unrelated to the column.)

Cut: both columns from `001_schema.sql`, both fields from `SessionSchema`, both
parameters from `CreateSessionInput`, both fields from `SessionRow` and `rowToSession`.

### 2.8 "Backwards compatibility" re-exports

`src/core/session-memory/index.ts:25-39` — two re-export blocks with explicit
backwards-compatibility comments:

- Interface types re-exported from the facade (`AddJournalEntryInput`,
  `CreateCheckpointInput`, `CreateSessionInput`, `JournalQueryFilters`,
  `StoreKnowledgeInput`).
- Row mappers (`rowToCheckpoint`, `rowToJournalEntry`, `rowToKnowledgeEntry`,
  `rowToSession`).

Cut both blocks. Callers import from the canonical locations
(`interfaces/session-memory.interface`, `session-memory/row-mappers`).

## 3. Facade refactor — from forwarder to namespace

### 3.1 Current shape (the smell)

`src/core/session-memory/index.ts:50-106` — ~57 lines of pass-through methods (forwards
each method to the appropriate sub-store, no added logic).

### 3.2 Desired shape

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

### 3.3 Call-site impact

Every consumer of `sessionMemory.*` shifts to `sessionMemory.<store>.*`:

- `phase-runner.ts:1049` — `sessionMemory.endSession(...)` → `sessionMemory.sessions.
  end(...)`
- `phase-runner.ts:140, 197, 207, 217, 266, 306, 363, 391` —
  `sessionMemory.addJournalEntry(...)` → `sessionMemory.journal.addEntry(...)`
- `phase-runner.ts:163, 291` — `sessionMemory.createCheckpoint(...)` →
  `sessionMemory.checkpoints.create(...)`
- `phase-runner.ts:278, 315, 420, 482, 627, 943` — `sessionMemory.endSession(...)`
- `orchestrator/index.ts:166` — same
- `orchestrator/index.ts:240` — `sessionMemory.queryJournal(taskId)` →
  `sessionMemory.journal.query(taskId)`
- `pr-manager.ts:117` — `sessionMemory.addJournalEntry(...)`
- `daemon/health-monitor.ts:80` — `sessionMemory.getLatestJournalTimestamp(...)` →
  `sessionMemory.journal.getLatestTimestamp(...)`
- `daemon/task-scheduler.ts:133` — `sessionMemory.getLatestCheckpoint(...)` →
  `sessionMemory.checkpoints.getLatest(...)`
- `workspace-lifecycle.ts:65, 71` — `sessionMemory.createSession(...)` →
  `sessionMemory.sessions.create(...)`

`ISessionMemory` interface in `interfaces/session-memory.interface.ts:75-89` — drop
entirely. The namespace IS the contract. Each store class is the implicit per-store
contract.

## 4. Workspace-manager surface

### 4.1 The class and its file (700 lines)

`src/core/workspace-manager/index.ts` — single class `WorkspaceManager` holds:

- Lifecycle: `createWorkspace`, `verifyWorkspace`, `cleanupWorkspace`.
- Clone & push: `ensureClone`, `pushBranch`, `deleteRemoteBranch`.
- Re-register: `registerExistingWorkspace`.
- Thoughts cleanup: `removeThoughtsAndPush`.
- Queries: `getWorktreePath`, `getWorkspaceRecord`.
- Skills: `getSkillsDir`, `syncSkills`.
- Helpers: `findRepoRoot`, `gitExecWithAuth`, `gitExec`, `emitVerified`.
- Event declarations: `EVENTS` exported constant.

### 4.2 In-memory `workspaces` Map — dual source of truth

Map mutations: lines 260 (set after create), 409 (delete after cleanup), 548 (set after
re-register).

Map reads: lines 289 (verify), 369 (cleanup), 488 (pushBranch), 513
(deleteRemoteBranch), 575 (removeThoughtsAndPush), 610 (getWorktreePath), 615
(getWorkspaceRecord).

DB-persisted analogue: `src/schemas/task.ts:102-108` — `TaskWorkspaceSchema` carries
`repo`, `branch`, `worktree_path`, `thoughts_dir`. Missing today: `base_branch`,
`base_commit`.

`registerExistingWorkspace` (lines 543-563) rebuilds the Map from `TaskWorkspace`,
hardcoding `baseBranch: this.config.default_base_branch` and `baseCommit: ""`.

`registerExistingWorkspace` callers: `workspace-lifecycle.ts:37, 59`,
`review-handler.ts:650`. (Three sites; verify exact context per call during
implementation.)

### 4.3 `baseBranch` consumers (proving the persistence need)

- `pr-manager.ts:196` — `git rev-list --count origin/${record.baseBranch}..HEAD` for PR
  "commits ahead" count.
- `pr-manager.ts:354` — passes `record.baseBranch` as `base` to
  `prHostingPlugin.createPullRequest`.
- `evaluation/snapshot.ts:59` — `git diff origin/${record.baseBranch}...HEAD`
- `evaluation/snapshot.ts:60` — `git log --stat origin/${record.baseBranch}..HEAD`
- `workspace-manager.ts:581` — `removeThoughtsAndPush` uses
  `origin/${record.baseBranch}` for the diff.
- `evaluation/prompts.ts:26, 83` — embeds the base branch in eval prompts.

If a task created its workspace with `options.baseBranch !== config.default_base_branch`,
all six consumers above silently use the wrong base after a daemon restart.

### 4.4 `baseCommit` consumers

`grep -rn "baseCommit|base_commit" src/`:

- `workspace-manager/index.ts:211` — computed at creation via `git rev-parse`.
- `workspace-manager/index.ts:257` — stored in `WorkspaceRecord`.
- `workspace-manager/index.ts:261` — logged in `Workspace created` info log.
- `workspace-manager/index.ts:273` — emitted in `workspace.created` event payload.
- `workspace-manager/index.ts:554` — set to `""` on re-register.
- `interfaces/workspace-manager.interface.ts:27` — declared on `WorkspaceRecord`.
- `schemas/events.ts:228` — `WorkspaceCreatedPayloadSchema.base_commit` field.

**Zero runtime consumers post-creation.** The value is read by no code path after the
creation log + event emission. Drop from `WorkspaceRecord` (keep as a local in
`createWorkspace`, emit in event payload, then discard).

### 4.5 `injectAuth` re-export

`workspace-manager/index.ts:93-94`:

```typescript
// Re-export from utils for backwards compatibility — canonical home is src/utils/git-url.ts.
export { injectAuth } from "../../utils/git-url.js";
```

Sole consumer: `plugins/git-hosting/github-hosting/github-hosting.ts:20` — imports from
`../../../utils/git-url.js` directly. The re-export is not even consumed. Delete.

### 4.6 Dead `push` branch in `gitExecWithAuth`

`workspace-manager/index.ts:665-675`:

```typescript
private gitExecWithAuth(args: string[], cwd: string): string {
  if (args[0] === "fetch" || args[0] === "push") {
    // Get remote URL and inject auth for this operation only
    const remoteUrl = this.gitExec(["remote", "get-url", "origin"], cwd);
    const authUrl = this.authUrlProvider(remoteUrl);
    // Replace "origin" with the auth URL in the args
    const authArgs = args.map((a) => (a === "origin" ? authUrl.unwrap() : a));
    return this.gitExec(authArgs, cwd);
  }
  return this.gitExec(args, cwd);
}
```

Call sites:

- `workspace-manager/index.ts:201` — `this.gitExecWithAuth(["fetch", "origin"],
  repoCloneDir)` (the only consumer).
- Pushes go through different paths (`pushBranch` line 503, `deleteRemoteBranch` line
  528) that build the auth URL explicitly and call `gitExec`, not `gitExecWithAuth`.

The `push` branch in `gitExecWithAuth` is unreachable. Simplify the helper or rename to
make it explicit (e.g., `fetchWithAuth(cwd: string)` taking no args).

## 5. Session-result relocation

### 5.1 Current location and consumers

`src/core/orchestrator/session-result.ts` exports `writeSessionResultTemplate`,
`readSessionResult`, `backupSessionResult`.

Consumers:

- `workspace-manager/index.ts:28` (import) — calls `writeSessionResultTemplate` at line
  242 to seed each phase directory at creation.
- `orchestrator/llm-caller.ts` (multiple lines) — calls `backupSessionResult` and
  `readSessionResult` around CLI invocations.

### 5.2 Target shape

Relocate to `src/core/session-result/index.ts`. Both workspace-manager and orchestrator
import from there as peers. Module boundary smell resolved without semantic change to
template lifecycle.

`PHASE_DIRECTORIES` constant in `schemas/orchestrator.ts:33-41` stays where it is —
it's a phase-shape constant, not a session-result concern.

## 6. Skills extraction

### 6.1 Current surface in workspace-manager

- `workspace-manager/index.ts:620-623` — `getSkillsDir(): string` returns
  `path.join(workspace_root, "skills")`.
- `workspace-manager/index.ts:632-644` — `syncSkills(): void` walks up to find repo root
  via `findRepoRoot`, copies `resources/skills/` to `{workspace_root}/skills/`.
- `workspace-manager/index.ts:648-662` — `findRepoRoot(): string` walks up from this
  module location looking for `package.json`.

### 6.2 Consumers

- `orchestrator/index.ts:121` — `this.ctx.workspaceManager.syncSkills()` at orchestrator
  init (one call).
- `orchestrator/phase-handlers.ts:32` — `const skillsDir = ctx.workspaceManager.
  getSkillsDir()` captured at factory time, then passed into the prompts for execution,
  self-review (sub-phases + refinement), and demo-prep.

### 6.3 Target shape

New module `src/core/skills/index.ts`:

```typescript
export class SkillsManager {
  constructor(private readonly workspaceRoot: string, private readonly observer: IObserver) {}
  sync(): void { /* moved from WorkspaceManager.syncSkills */ }
  getDir(): string { /* moved from WorkspaceManager.getSkillsDir */ }
}
```

Bootstrap constructs `SkillsManager`; orchestrator context carries `skillsManager`;
init calls `skillsManager.sync()`; phase-handlers query `skillsManager.getDir()`.

`findRepoRoot` either moves with the new module or is replaced. Research during planning
will determine simplest stable approach (likely: pass repo root in via construction, set
from bootstrap once).

## 7. `removeThoughtsAndPush` relocation

### 7.1 Current implementation

`workspace-manager/index.ts:567-604` (~38 lines). Does:

1. Compute base ref: `origin/${record.baseBranch}`.
2. `git diff --name-only --diff-filter=A baseRef -- thoughts/` to find added files.
3. If none, return `false`.
4. `git rm -f ...files`, `git commit -m "chore: remove engineering thoughts before
   merge"`, then call `this.pushBranch(taskId)`.
5. Return `true`.

### 7.2 Caller

`review-handler.ts:652` — immediately before merge.

### 7.3 Adjacent git operations in pr-manager

`pr-manager.ts:196` — `git rev-list --count origin/${record.baseBranch}..HEAD` for the
PR's "N commits" count.

`pr-manager.ts:244` — likely another `getWorkspaceRecord` use; verify during
implementation.

There may be a coherent surface ("git operations against the base branch / PR-prep")
that consolidates. Decide during planning based on what surfaces when the code is moved.

## 8. Migrations and consolidated migration story

Slice 2 established "all migrations are rewritten as if created in one session." There
is only one migration file (`001_schema.sql`) plus `002_observations.sql`. The slice's
schema changes edit `001_schema.sql` in place:

- Drop the `knowledge` table + 3 indexes.
- Update the `sessions` table's `end_reason` CHECK to drop `new_session`, `decomposed`.
- Update the `journal_entries` table's `type` CHECK to drop `action`, `finding`,
  `decision`, `communication`.
- Drop the `journal_entries.action_type`, `finding_type`, `decision_key`,
  `comm_target` columns.
- Update the `checkpoints` table's `reason` CHECK to drop `pre_costly_op`, `periodic`.
- No schema change needed for `tasks.workspace` (it's stored as a JSON blob in a `TEXT`
  column at line 30 of `001_schema.sql`) — adding `base_branch` to the JSON shape is a
  schema-only change in `TaskWorkspaceSchema`.

## 9. Test surface impact (high-level inventory)

- `tests/unit/core/session-memory/knowledge.test.ts` (145 lines) — delete entirely.
- `tests/unit/core/session-memory/sessions.test.ts` (107 lines) — remove
  `getSessionChain` cases.
- `tests/unit/core/session-memory/journal.test.ts` (257 lines) — remove cases for dead
  enum values, dead columns, dead filter combinations. Adjust API to match namespace +
  renames.
- `tests/unit/core/session-memory/checkpoints.test.ts` (123 lines) — remove cases for
  dead `CheckpointReason` values. Adjust API.
- `tests/unit/core/session-memory/index.test.ts` (582 lines) — facade test. Update for
  namespace shape, remove knowledge sections, remove dead-enum cases.
- `tests/unit/core/workspace-manager/index.test.ts` (459 lines) — update for stateless
  workspace-manager, removed methods (`registerExistingWorkspace`, `syncSkills`,
  `getSkillsDir`, `removeThoughtsAndPush`), changed `WorkspaceRecord` (no `baseCommit`,
  base branch persisted).
- `tests/helpers/test-session-memory.ts` — adjust the test helper for the new shape.
- `tests/helpers/test-workspace-manager.ts` — adjust for stateless model.
- New test files: `tests/unit/core/skills/`, `tests/unit/core/session-result/`,
  `tests/unit/core/orchestrator/pr-manager.test.ts` cases for the relocated
  `removeThoughtsAndPush`.

## 10. Resume flow walkthrough (end-to-end audit target)

The slice scope names "session resume." This is the flow Slice 7 must verify still
composes after its changes. None of the changes intend to alter behavior; the audit
exists to prove that.

**Today's resume flow, step by step:**

1. **Daemon boot / crash recovery.** Tasks in `active.*` states get re-considered by
   the scheduler.
2. **`task-scheduler.ts:dispatchTask` (lines 131-188).**
   - `getLatestCheckpoint(task.id)` reads the most recent checkpoint.
   - `hasUnappliedFeedback` short-circuits checkpoint to null for rework dispatches.
   - The `Dispatch` package gets `resume_from: checkpoint` (or null for fresh runs).
3. **`workspace-lifecycle.ts:setupWorkspace` (lines 19-61).**
   - If `dispatch.resume_from` is null (fresh dispatch): either create the workspace
     or re-register from `task.workspace`.
   - If `dispatch.resume_from` is non-null (resume): re-register from
     `task.workspace`.
   - **After Slice 7's Map removal:** `registerExistingWorkspace` is gone; reads of
     `task.workspace` happen via `taskEngine.getTask`. No re-register call needed.
4. **`workspace-lifecycle.ts:createSession` (lines 63-74).**
   - Resume path: `sessionMemory.createSession({ taskId, previousSessionId,
     resumedFromCheckpoint })`.
   - **After Slice 7's session field cuts:** call becomes `sessionMemory.sessions.create
     ({ taskId })`. The `previousSessionId` / `resumedFromCheckpoint` arguments are
     gone with the columns.
5. **`phase-runner.ts:executeTask` calls `startupResume` (line ~125).**
   - `verifyWorkspace(taskId)` confirms the worktree is intact. Throws
     `WorkspaceVerificationError` if not — handled in the main loop.
   - **After Slice 7:** `verifyWorkspace` reads `task.workspace` from DB instead of
     Map; behavior is identical for the happy path.
6. **`phase-runner.ts:140` writes a journal entry.**
   - Type: `phase_change`, summary: `Resumed from checkpoint in <phase> phase. Reason:
     <reason>.`, detail: `checkpoint.next_action`, tags: `["resume"]`.
   - This entry is the audit trail for "this dispatch is a resume" — it survives the
     `previous_session_id` / `resumed_from_checkpoint` column cuts.
7. **Pipeline resumes from `checkpoint.phase`** using the `startIndex` derived from
   the checkpoint.

**Acceptance for the audit:** every step above still works the same way at the end of
Session 4. The only behavioral delta is that the session row no longer carries
`previous_session_id` / `resumed_from_checkpoint` — the journal entry (step 6) is the
single authoritative resume audit trail.

## 11. Workspace events — empty subscribers (informational)

`workspace-manager/index.ts:38-60` declares three events with `subscribers: []`:

```typescript
export const EVENTS: EventDeclaration[] = [
  { type: "workspace.created", ..., subscribers: [] },
  { type: "workspace.verified", ..., subscribers: [] },
  { type: "workspace.cleaned", ..., subscribers: [] },
];
```

Verified: no `subscribe("workspace.*", ...)` exists anywhere in `src/`. The events are
emitted via the EventBus (which persists them to the `events` table) but never
consumed by a runtime handler. This is intentional (audit trail), not dead code.

Add a one-line comment to the `EVENTS` declaration making the intent explicit so a
future reader doesn't flag it as a defect.

## 12. Risks and gotchas surfaced during research

- **PrConfigSchema reference in workspace.md docs** — `docs/configuration/workspace.md`
  references `skip_pr_creation` and other config that may shift if PR concerns
  reorganize; verify doc alignment during implementation.
- **`gitExecWithAuth` simplification** — if renamed to `fetchWithAuth`, make sure no
  external import of `gitExecWithAuth` exists (it's private today; safe).
- **In-memory Map removal — atomic ordering** — when the Map is removed,
  `createWorkspace` must complete the `taskEngine.updateTaskField("workspace", ...)`
  write before any downstream call can ask `getWorktreePath()`. Verify this ordering in
  `workspace-lifecycle.ts` and the orchestrator init paths.
- **`cleanupWorkspace` post-Map** — today it does `this.workspaces.delete(taskId)` at
  the end. After the refactor, cleanup is a workspace state, but `task.workspace`
  remains on the task forever (the worktree is gone, but the record stays for audit).
  Decide during planning whether `cleanupWorkspace` nulls `task.workspace`, sets a
  `cleaned: true` flag, or leaves it alone. Today's behavior is "drop from Map" which
  effectively nulls runtime access — match the closest semantics.
- **`thoughts_dir` already has a date prefix** — re-registration today passes
  `workspace.thoughts_dir` through unchanged. After Map removal, queries return the same
  field — no behavior change. Confirm.
- **Three `registerExistingWorkspace` call sites have different intents:** rework, resume,
  and review-handler. After the refactor they all become no-ops (delete the calls);
  verify that downstream calls in each path use only `getWorktreePath` /
  `getWorkspaceRecord`, which both work statelessly.
