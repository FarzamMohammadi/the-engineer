# Active — Phase 9: OSS Ready

> **ALWAYS READ BEFORE PROCEEDING.** Then read [approach.md](approach.md) and the current slice file.
> These references are permanent. Never remove them.

## Key Files

- [vision.md](vision.md) — why we're doing this, what done looks like
- [approach.md](approach.md) — strategy, lenses, co-founder rules, RRP discipline (what to hunt for, how to present findings), closing sweep principles, 16-slice roadmap, session protocol
- Current slice: `slices/07-workspace-session.md` — Sessions 1-4 complete, Session 5 (closing sweep) next

## How This File Works

This file answers one question: **where are we right now?** Nothing more.

- **Current** holds the active slice — its state, plan, and the immediate next step.
- When a slice finishes, recap it as **one line** under **Completed Slices**, then advance
  **Current** to the next slice.
- Depth lives elsewhere: per-session detail in `sessions/N.md`, per-slice decisions in that
  slice's file. Do not duplicate that depth here.

## Current

**Slice 7 — Workspace & Session** — Session 4 (workspace-manager state
simplification: kill the `workspaces` Map, persist `base_branch`, drop
`baseCommit` from `WorkspaceRecord`, end-to-end resume flow verification)
complete. Next: Session 5 — closing standards sweep across every file
touched by Sessions 1–4.

**Session 1 landed** (commits `7893cf9` doc-only + `a36a213` code cut):
- `KnowledgeStore`, knowledge schemas, knowledge table + indexes, `Dispatch.knowledge`
  field, scheduler reads + log fields, all six prompt builders' knowledge plumbing,
  `buildKnowledgeSection` + `formatKnowledge` — all deleted. Net +17 / −1050 lines.
- All knowledge tests, mocks, fixtures cut from src and tests.
- `docs/future-considerations.md`: consolidated `Hybrid Semantic Memory Search` into
  `Cross-Task & Cross-Session Memory (supplementary)` (captures pivot story); added
  separate `Standing System-Prompt Context (Repo + Owner Preferences)` entry for the
  static owner-authored repo-knowledge / preferences feature that surfaced mid-session
  (distinct from the cut layer — pure static text into the system prompt, not a
  dynamic typed store).
- Green at commit: 2401 unit + 39 integration + 16 e2e, lint clean, typecheck clean.

**Session 2 landed** (commit `876b97a`):
- Schema surface trimmed: SessionEndReason 7→5, JournalEntryType 7→3,
  CheckpointReason 4→2. Dropped `previous_session_id`,
  `resumed_from_checkpoint` from sessions; dropped `action_type`,
  `finding_type`, `decision_key`, `comm_target` from journal entries.
  Migration CHECK constraints updated to match.
- SessionMemory facade → namespace: `ISessionMemory` interface deleted,
  SessionMemory now exposes `sessions`, `journal`, `checkpoints` as
  public readonly store fields. All call sites updated (38 files, net
  −479 lines).
- Dead code removed: `JournalQueryFilters` (dynamic SQL builder),
  `CreateSessionInput`, `getSessionChain`, `SessionRow`, `rowToSession`.
- Resume audit trail: journal entry at `phase-runner.ts:140` confirmed as
  authoritative (captures phase, reason, next_action — no column dependency).
- Green at commit: 2384 unit + 39 integration + 16 e2e, lint clean,
  typecheck clean.

**Session 4 landed** (commits `98b70bf` code + `f7b4923` lint):
- `WorkspaceManager` is now stateless. `private readonly workspaces = new
  Map<...>` field deleted along with every set/get/delete mutation;
  `registerExistingWorkspace` deleted (DB is the only state — nothing to
  register). Every read goes through a private `readRecord` helper that
  projects `task.workspace` via `taskEngine.getTask(taskId)`.
- `TaskWorkspaceSchema` gains `base_branch: string` (non-nullable). Kills
  the silent wrong-base bug on restart that `registerExistingWorkspace`
  used to mask (hardcoded `default_base_branch` + empty `baseCommit`).
- `WorkspaceRecord.baseCommit` dropped — read nowhere post-creation; kept
  as a local in `createWorkspace` purely to populate the event payload.
- Constructor takes an options object (`WorkspaceManagerDeps`) including
  the new `taskEngine: ITaskEngine` dep. 5 deps past coding-standards § 3
  positional ideal.
- `createWorkspace` owns the `taskEngine.updateTaskField("workspace", ...)`
  write so persistence and worktree creation are a single contract
  (eliminates the coordination foot-gun for callers).
- `cleanupWorkspace` leaves `task.workspace` intact post-cleanup; the
  `workspace.cleaned` event is the canonical audit trail. No `cleaned_at`
  field added — decision recorded in the session log.
- Resilience lens: `taskEngine.getTask` exceptions propagate out of
  `readRecord` — no try/catch around DB calls. Fail loud per § 15.
- `workspace-lifecycle.setupWorkspace` simplified: no `registerExisting
  Workspace` calls on rework/resume; resume path becomes early return
  ("DB-backed reads work as-is"). Persistence write removed (createWorkspace
  owns it now).
- `review-handler.tryRemoveThoughtsBeforeMerge` drops its re-register dance
  + stale "until Session 4's stateless refactor" comment.
- `EVENTS` declaration gets an explicit "subscribers: [] is intentional
  (audit-trail-only)" comment per Decision #12.
- New unit test asserts the resume flow contract: `base_branch` persists
  on create + a fresh WorkspaceManager over the same DB reads it back.
  Plus targeted assertions on the new "task.workspace retained as audit
  post-cleanup" semantics and the schema's `base_branch` requirement.
- Test helper `test-workspace-manager.ts` wires a real `TaskEngine` over
  the test DB and exposes `setupTask(taskId)` + `createWorkspaceManager()`
  so tests can simulate restart over the same DB.
- Green at commit: 2389 unit + 39 integration + 16 e2e, lint clean
  (0 errors, 0 new warnings), typecheck clean.

**Session 3 landed** (commit `85afd55`):
- `core/session-result/` extracted from orchestrator — three pure functions
  (read/write template/backup) consumed by workspace-manager and llm-caller
  as peers. Tests relocated.
- `core/skills/` created with `SkillsManager` class (`sync()` + `getDir()`).
  Wired through `CoreComponents` → `OrchestratorContext` → bootstrap;
  orchestrator init calls `skillsManager.sync()`; phase-handlers call
  `skillsManager.getDir()`. The walk-up `findRepoRoot()` replaced with a
  fixed relative resolve from `import.meta.url` (same depth in src/ and dist/).
- `removeThoughtsAndPush` moved to pr-manager as a standalone exported
  function with narrow `{workspaceManager, observer}` deps; review-handler
  imports and calls it directly. Span `remove_thoughts_and_push` +
  `recordDecision` for the "no files to remove" early-return path.
- Dead-surface cuts in workspace-manager: `injectAuth` re-export deleted;
  `gitExecWithAuth` push branch (unreachable) dropped, helper simplified to
  fetch-auth semantics.
- SSOT refinement surfaced during planning: `workspace_root` tilde expansion
  hoisted from WorkspaceManager's constructor into `system.ts` so both
  SkillsManager and WorkspaceManager receive the canonical expanded path.
- Observability: span `skills_sync` (lifecycle) added; "skills" added to
  ComponentTag; bootstrap log + comment enumerate SkillsManager.
- Green at commit: 2384 unit + 39 integration + 16 e2e, lint clean,
  typecheck clean, build OK. Net −270 lines.

**Mid-session decision recorded:** the standing system-prompt feature (owner-authored
repo knowledge + preferences injected into the system prompt at session startup) is
**deferred** to a later slice (likely Slice 8 or 14, which own prompt assembly), not
folded into Slice 7. Reason: Slice 7 is shaped as cuts and reshapes — adding a new
feature blurs that. Future-considerations entry captures the shape.

**Plan deltas vs `slice-07-workspace-session.md`:** Sessions 1-4 executed the
plan's task lists. Two scope additions:
- Session 3 hoisted the `workspace_root` tilde expansion from WorkspaceManager
  into `system.ts` (SSOT for the canonical path).
- Session 4 moved the `taskEngine.updateTaskField("workspace", ...)` write
  from `workspace-lifecycle.setupWorkspace` into `WorkspaceManager.createWorkspace`
  itself. Rationale: with the Map gone, "create the worktree" and "persist
  the workspace shape" become a single atomic contract — callers can't
  forget the second step, tests don't need a manual updateTaskField after
  every create.

Remaining Session 5 (closing standards sweep) unchanged.

Methodology refinements (commits `b41aff7`, `adb6f66` from Session 31): `approach.md`
codifies "What Each RRP Must Hunt For", "Presenting Findings During RRP", and
"coding-standards alignment is a planning concern, not a sweep concern." Future RRPs
inherit this discipline.

**Cross-slice handoffs inherited from prior slices (still parked for target slices):**
- Slice 5 → Slice 12: #9 reply-token + #10 unblock check.
- Slice 5 → Slice 8: trivial-skip.
- Slice 5 → Slice 10: review polling.
- Slice 6 → Slice 8: decomposition-handler.ts deletion + planning prompt instruction
  removal + decomposition schemas deletion + integration phase re-evaluation + signal
  honoring through phase-runner → llm-caller → LLM plugins.
- Slice 6 → Slice 12: notification-kind enumeration audit.
- Slice 6 → Slice 15: dashboard UI cleanup for the simplified state machine.

## Completed Slices

- **Slice 1 — Standards Alignment:** `docs/coding-standards.md` written — 10 categories decided via deep Q&A.
- **Slice 2 — Repo Readiness:** Biome aligned, lint split, CI parallelized, tests restructured (`tests/unit/` mirrors `src/`), migrations consolidated, hardcoded paths fixed.
- **Slice 3 — Dashboard:** 5-page React SPA rewrite (Overview, Tasks, Activity, Metrics, Errors), all features working, coding standards audited. Sessions 4–8 — detail in `slices/03-dashboard.md`.
- **Slice 4 — Startup & Configuration:** Getting-started path (`pnpm run setup` → `engineer start`), OS detection gate, seed-example sanitization + dogfooding, removals (checkCliArtifacts, config-version machinery, Output.table, quiet mode), CLI restructure (Screaming Architecture), original coding standards audit (1–11), new coding standards added (§4 expanded, §5 expanded, §7 framing, §12–§15), six post-bootstrap infrastructure gaps closed (retryable flag, cause chains, trace_id correlation, floating promises, span/log correlation, graceful degradation logs), and new standards applied across slice 4 in-scope files. "Apply with judgment, never mechanically" principle codified. Sessions 9–16 — detail in `slices/04-startup.md`.
- **Slice 5 — Trigger & Requirements (Contacts) Flow:** PluginContext + per-plugin StateStore (the SDK foundation), durable dedup moved to Core on `idempotency_key`, dead `trigger.pr_review` scaffolding removed (issues-only trigger), per-plugin poll cadence + configurable label/assignee work selection + Core-owned backoff, single-user constraint (`docs/constraints.md`, owner assumed-not-required, doctor "People Directory" category). Closing standards sweep (Session 22) closed it: deleted unwired config hot-reload infra, re-synced bundled plugin docs with source, removed dead `max_tokens`, fixed the chronic orchestrator test flake, line-by-line audit of all in-scope files. Sessions 17–22 — detail in `slices/05-trigger.md`.
- **Slice 6 — Scheduling & Dispatch:** Decomposition consumer deleted in full, single retry-policy module (per-category, config-driven), dispatch-tracker primitive (AbortController, per-dispatch identity, idempotent late callbacks), `Outcomes.terminated` with typed reason routing, preemption tightened (eligible filter, bounded priority, one-per-tick), hard-cap enforcement (`max_active_duration_ms` → terminate → failed + alert), crash recovery unification (boot-loop hole closed), `engineer retry` accepts failed tasks, `failed → queued` transition, dead `preemption.ready` event deleted. Closing standards sweep (Session 29) fixed stale overview States table, dispatch-tracker drain complexity, Array<T> syntax, swallowed DB-open error in retry CLI, stale decomposition JSDoc. Post-sweep refinement (Session 30) collapsed triplicated LLM subprocess helpers (env allowlist + buildLlmEnv + appendStderr) into `src/plugins/llm/subprocess.ts` — surfaced a new sweep principle: duplicated *functions* count under § 11 too, not just literals. Sessions 25–30 — detail in `slices/06-scheduling.md`.
- **E2E test fix (carried over from Slice 5, Session 23):** the five `task-happy-path` + `crash-recovery` e2e failures were structural — tests used `clone_url: ""` (silently skipping workspace creation → `WorkspaceNotReadyError` → no LLM call), and asserted impossible LLM counts since the FakeLLM doesn't simulate the CLI's `session-result.json` write. Rewrote as one full-pipeline smoke test (bare git repo + FakeLLM side-effect hook) plus honest dispatch/routing/recovery tests. 16/16 e2e passing. Commit `f54ad8c`.
