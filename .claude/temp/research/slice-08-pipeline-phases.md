# Research: Slice 8 — Pipeline Phases

**Date**: 2026-05-26
**Branch**: main
**Repo**: the-engineer

## What I Found

### 1. Current Pipeline Surface

**Phase enum + sequence:**
- `PhaseSchema` (`src/schemas/orchestrator.ts:5-13`): 7-value enum `requirements_gathering`, `research`, `planning`, `execution`, `self_review`, `demo_prep`, `integration`.
- `PHASE_SEQUENCE` (`src/core/orchestrator/types.ts:122-130`): array literal in canonical order.
- `buildPhaseSequence(skipResearch: boolean)`: filters `research` out when trivial. Single mutation point — no other code paths reshape the sequence.

**Handler shape:**
- `createPhaseHandlers(agentRunner, ctx)` (`phase-handlers.ts:28`) returns `Record<Phase, PhaseHandler>`.
- `PhaseHandler` (`phase-runner.ts:27`): `(taskId, dispatch, priorOutputs, state) => Promise<PhaseOutput>`.
- Seven handler functions, each closes over `ctx` and `agentRunner`. Each calls `agentRunner.runPhaseWithCli(...)`.
- **`handleSelfReview` is structurally different**: runs N CLI calls (one per `reviewPhases` config entry) plus a refinement call. The other 6 handlers run exactly one CLI call. This is the existing precedent for "phase = multiple CLI calls" — sub-phases already exist informally inside self_review.

**Phase routing (phase-runner.ts):**
- `runPhasePipeline` is the main loop (≈260 lines).
- Uses `PhaseNavigator` for cursor advancement + sequence replacement (`navigator.replaceSequence`, `navigator.jumpTo`, `navigator.advance`).
- `handlePostPhaseActions` has hardcoded if-chains for phase-specific routing:
  - Universal fallback: `status=need_more_info` → loopback to `requirements_gathering` (except from requirements itself).
  - Requirements + `need_more_info` → run outreach + block (or proceed if no contacts resolved).
  - Requirements after return: route back to `returnToPhase`.
  - Requirements + trivial → `buildPhaseSequence(true)` overwrites the navigator sequence + persists `skip_research=true`.
  - Self-review + needs_work → loopback to execution (capped by `max_review_loopbacks` from config).
  - Demo_prep → invoke `prManager.commitAndPush` → `prManager.createPullRequest` → exit `review_pending`.
  - Self-review + `isLastPhase` (final) → fast-path PR (same flow as demo_prep).
- Remaining phases: standard advance.
- `Outcomes` enum: `completed`, `review_pending`, `terminated`, `blocked`, `error`.

### 2. Test Coupling Shape

`tests/unit/core/orchestrator/phase-runner.test.ts` (1057 lines):
- `createHandlersThatReturn(outputs)` uses `Object.fromEntries(PHASE_SEQUENCE.map(...))` — iterates the sequence. Refactor-friendly.
- `makeOutput(phase, data?)` has explicit per-phase default data shapes — coupled to today's phase output schemas (including `integration`, `quality_assessment: "ship_it"`, etc.). Refactor target.
- **Hardcoded shape assertions**:
  - `PHASE_SEQUENCE has exactly 7 phases` (line 1048) — direct test of count.
  - `starts with requirements_gathering and ends with integration` (line 1051-1054) — direct phase-name test.
- Multiple tests reference `quality_assessment: "needs_work"`, `quality_assessment: "ship_it"`, `next_phase: Phases.execution` — coupled to current self_review output shape.
- All tests use mocked `OrchestratorContext` — refactor-friendly (mocking infrastructure is solid).
- Resume tests use `Phases.X` enums directly.

`tests/unit/core/orchestrator/prompts/` only has:
- `execution.test.ts`, `integration.test.ts`, `review.test.ts`, `skills.test.ts`.
- **No tests for** `requirements-gathering`, `research`, `planning`, `demo-prep`, `context`, `format`, `system`. Coverage gap in current prompt suite.

### 3. AgentAdapter Surface (Post-Rename)

`src/adapters/agent.ts` (renamed from `llm.ts`, verified):
- Class: `AgentAdapter extends BaseAdapter`.
- Public: `run(request: AgentRunRequest): Promise<AgentRunResult>` — wraps `doRun()`.
- Plugin abstract: `doRun(request)`.
- Additional: `getCapabilities()`, `getQuotaStatus()`.

`AgentRunRequest` schema (`src/schemas/adapters.ts:204-215`):
- Fields: `prompt`, `system_prompt`, `cwd`, `trace_output_path`. **No `signal` field.**

`AgentRunResult` schema (`src/schemas/adapters.ts:252-258`):
- Fields: `content`, `cost_usd`, `duration_ms`, `usage`.

**Three agent plugins** (`src/plugins/agent/`):
- `claude-code-agent/`, `gemini-cli-agent/`, `opencode-agent/` + shared `subprocess.ts`.
- `claude-code-agent.ts:99` implements `doRun`; calls `spawnAndParse` which uses `spawn(this.config.cli_path, args, opts)`.
- Node's `child_process.spawn()` supports `{ signal }` option natively (Node 16+) — no manual abort listener needed.

### 4. Dispatch + Signal Plumbing

`src/schemas/ephemeral.ts` (full file, 26 lines):
- `DispatchSchema` (Zod): `{ task, resume_from }`.
- `Dispatch` (runtime type): `DispatchPayload & { signal: AbortSignal }`.
- Explicit comment: `// Slice 6 ships the wiring; honoring through phase-runner → agent-runner → agent plugins lands in Slice 8.`

`grep "signal\." across src/core/orchestrator/, src/core/daemon/, src/plugins/agent/`:
- Only result: `preemption-manager.ts:188` — log line, unrelated.
- **Signal flows in via `Dispatch`, is never read anywhere downstream.**

### 5. State Machine (`src/schemas/task.ts`)

`TaskStateSchema` (7 values): `requirements_gathering`, `queued`, `active`, `blocked`, `review_pending`, `completed`, `failed`.

**`review_pending` is a full state, not just an Outcome:**
- `ValidTransitions` entries (lines 244-262): active → review_pending (with sub `code`), review_pending → active, review_pending → completed, review_pending → queued.
- `PermissionTable` entry (line 300-304): allows `read + communicate`, conditional `merge`.
- Used in `taskEngine.getTasksByState(TaskStates.review_pending)` throughout review-handler.

`Task` schema fields (lines 154-218):
- `phase: z.string().nullable()` — NOT enforced as Phase enum (string).
- `return_to_phase: PhaseSchema.nullable()` — enforced.
- `loopback_count: int default 0`, `requirements_loop_count: int default 0`.
- `skip_research: boolean default false` — trivial-skip persistence.
- `consecutive_crash_count: int default 0`, `consecutive_agent_unavailable_count: int default 0`.
- `blocked: BlockedDetailsSchema.nullable()` — structured `{ reason, efforts_made, contacted, needed, waiting_for }`.

`SubStateSchema` (2 values): `working`, `code`. Used only on `active` and `review_pending` transitions.

### 6. retry-policy Module (`src/core/retry-policy/index.ts`, 128 lines)

- `RetryCategory` type: `"crash" | "agent_unavailable"`.
- `COUNTER_FIELDS`: `crash` → `consecutive_crash_count`; `agent_unavailable` → `consecutive_agent_unavailable_count`.
- `TERMINAL_STATES`: `crash` → `"failed"`; `agent_unavailable` → `"blocked"`.
- `recordFailure(category, taskId)` returns `{disposition: "retry", not_before, count}` or `{disposition: "terminal", state, count}`.
- `recordSuccess(category, taskId)` resets counter + clears `not_before`.

Config (`src/schemas/config.ts:158-173`):
- `retry_policy.crash`: `backoff_minutes` default `[1, 5, 15, 30, 30]`, `max_attempts` default `5`.
- `retry_policy.agent_unavailable`: `backoff_minutes` default `[2, 5, 10, 15, 15]`, `max_attempts` default `5`.

**Cross-module crash retry consumers** (`grep "recordFailure.*crash"`):
- `daemon/task-scheduler.ts` boot recovery: catastrophic task crashes route through `crash` category.
- `orchestrator/phase-runner.ts` `handlePhaseError`: routes through it too (per Slice 6 design).
- Cutting `crash` category requires refactoring both call sites to block-with-reason instead.

### 7. Config Shape

`RrpirConfigSchema` (`src/schemas/config.ts:245-250`):
- `max_requirements_loops: int default 5`
- `include_thoughts_in_pr: boolean default true`
- `review_phases: array of ReviewPhaseName, default ["requirements_check"]`
- `max_review_loopbacks: int default 3`

`PhasesConfigSchema` (`config.ts:295-300`):
- `checkpoint_on_transition: boolean default true`
- `periodic_checkpoint_interval_ms: int default 900_000`
- `max_loopbacks_before_alert: int default 3`
- `force_full_pipeline: boolean default false`

`ReviewPhaseNameSchema` enum (`config.ts:234-238`): `requirements_check`, `security_review`, `code_quality`, `architecture_review`.

DaemonConfig also has: `review_polling.failure_window_ms` (300000), `review_polling.max_failures_before_pause` (3), `notification_retry`, `evaluation`.

### 8. Observability Infrastructure (`src/core/observer/`)

`IObservationStore` interface (`types.ts:39-89`):
- `startSpan(type, name, input?, options?): ObservationSpan` — spans with `end()`, `startChild()`, `addEvent()`, `setError()`.
- `observe(type, name, data, options?): string` — instant observation.
- **`recordDecision(name, context, options, chosen, reasoning, confidence, opts?): string`** — perfect fit for routing decisions.
- `recordError(error, context, recovery?, opts?): string`.
- `query(filters): Observation[]` — dashboard reads.
- `subscribe(callback): unsubscribe` — real-time streaming.
- `storeBlob(content): string`, `readBlob(hash): string | null`.

`observer.withTrace(traceId)` returns a traced observer — already used in orchestrator's `executeTask` to scope `traceId` per task dispatch.

### 9. PrManager (`src/core/orchestrator/pr-manager.ts`, 485 lines)

Three exported pieces:
- `commitAndPush(sessionId, taskId, dispatch): CommitAndPushResult` — sync function (git ops are sync).
- `createPullRequest(sessionId, taskId, demoPrepOutput, dispatch): Promise<CreatePRResult>` — async (hosting plugin call).
- `removeThoughtsAndPush(deps, taskId): boolean` — standalone export.

`commitAndPush`:
- Runs `git add -A`, checks staged changes via `git diff --cached --quiet`, commits if changes (commit msg differs for rework vs fresh).
- Then `workspaceManager.pushBranch(taskId)`.
- **TODO comment** (line 154-156): "Reconsider moving commit responsibility back to the execution phase entirely. The CLI agent should commit all changes during its session; pr-manager should only push." — aligns with Q11's split commit-during-implement + verify.
- Result: `pushed` | `nothing_to_push` | `{error, step, reason}`.

`createPullRequest`:
- Rework path: dismiss stale approvals, mark feedback applied, notify ticket comment.
- New PR path: read PR description from `PhaseOutput.data.pr_description` or from deliverable file → `composePrBody` (decorations + trigger ref + description + footer) → `gitHosting.createPR`.

`removeThoughtsAndPush` (called from review-handler immediately before merge):
- Diffs against base, removes `thoughts/` files added by the branch, commits, pushes.
- Uses `observer.recordDecision` already — good pattern to replicate.

### 10. Review-Handler (`src/core/daemon/review-handler.ts`, 996 lines)

**Already implements significant chunks of Slice 10's scope.**

Public interface (`ReviewHandler`):
- `checkMerges(reviewPendingTasks?)` — polls for merged PR state.
- `checkFeedback(reviewPendingTasks?)` — polls for review feedback (approvals, changes_requested, comments).
- `checkApprovedCI()` — polls CI status for approved-but-awaiting-CI tasks.
- `handleFeedbackEvent(payload)` — dispatches on feedback type.
- `clearTickCache()` — resets per-tick PR status cache.

Key existing capabilities:
- **Aggregate state derivation** (`deriveAggregateReviewState`): combines per-reviewer statuses to derive `changes_requested | approved | comment | null`.
- **Comment-based approval** (`detectCommentApproval` + `APPROVE_COMMAND_REGEX = /^\/(approve|approved)\s*$/i`): scans comments for `/approve` from authorized users.
- **Authorized approver check** (`isAuthorizedApprover`): consults people-directory for `owner` and `reviewer` roles.
- **Post-approval issue evaluation** (`evaluatePostApprovalChecks`): returns `("ci_failure" | "merge_conflict")[]` from `checks_state` + `mergeable`.
- **Post-approval failure handling** (`handlePostApprovalFailures`): re-queues task with synthetic feedback round (groups CI + conflict into single cycle); `MAX_POST_APPROVAL_FIX_RETRIES = 3` with attempt counter from state history.
- **Auto-merge** (`attemptMerge`): if `safetyLayer.checkAutoMergeAllowed(repo)` + CI passes + mergeable → `hosting.mergePR(repo, prNumber, mergeStrategy)`. Otherwise complete + notify (human merges).
- **Accommodation gate** (`hasUnaccommodatedFeedback`): dedup new comments vs already-processed (via `task.review.accommodated_comment_ids` + `accommodated_review_state`).
- **Self-comment filtering**: `SELF_COMMENT_PREFIXES` list (13 prefixes) to skip daemon-posted comments.
- **Circuit breaker**: time-windowed failure counting (`failure_window_ms`, `max_failures_before_pause`).
- **Per-tick caching** of PR status via `prStatusCache`.
- **Stale dedup pruning** for tasks no longer in `review_pending`.

`handleFeedbackEvent` dispatches on `payload.feedback_type`:
- `"approved"` → `handleReviewApproval` → `handleCodeApproval` (CI gate + maybe auto-merge or complete).
- Otherwise → `handleFeedbackRework` → transition to `queued` with reason `feedback_rework:${type}`.

`finalizeTaskCompletion` on merge:
- Deletes remote branch if `workspaceConfig.pr.delete_branch_after_merge`.
- Calls `workspaceManager.cleanupWorkspace(taskId, true)`.
- Notifies via NotificationKinds.completion + optional ticket comment.

**Auto-merge diverges from Q20 ("merge = terminal, approval = informational"):**
- Today: approval → safetyLayer-gated auto-merge attempt → on success, terminal completed.
- Q20: approval is informational, terminal completion is the external merge event.
- This is a real divergence — needs decision in planning.

### 11. GitHostingAdapter Contract (`src/adapters/git-hosting.ts`)

PR lifecycle: `createPR`, `updatePR`, `mergePR`, `closePR`.
Queries: `getPRStatus(repo, prNumber)`, `getReviewStatus(repo, prNumber)`, `getPRComments(repo, prNumber)`.
Other: `commentOnPR`, `dismissApprovals`, `getBranchProtection`, `getDefaultBranch`, `getAuthenticatedRemoteUrl`.

**No event-based methods** — pure polling API. Review-handler aggregates polling results into events internally.

For Q10's 5-event typed routing, two options:
- (a) Add new method `detectPrEvents(repo, prNumber, accommodated): PrEvent[]` returning typed union — moves platform-specific aggregation behind the contract.
- (b) Keep polling methods, formalize the typed `PrEvent` union in Core, have review-handler aggregate per-event-type (current pattern, just typed).

Option (a) is plugin-blindness-cleaner (Core never sees `reviewStatus.reviewers[].state` directly). Option (b) is less plugin work. Plan decides.

### 12. Decomposition Residue

**Source code:**
- `src/core/orchestrator/prompts/demo-prep.ts:109` — `"next_phase": "integration" (if this is a decomposed child task)`.
- `src/core/orchestrator/prompts/planning.ts:97` — `"If decomposition is needed (3+ genuinely independent areas of change)..."`.
- `src/core/orchestrator/prompts/integration.ts` — entire file (`ChildTaskSummary`, `IntegrationPromptContext`, `buildIntegrationPrompt`).
- `src/core/orchestrator/prompts/index.ts:21` — exports `ChildTaskSummary`.

**Live docs:**
- `docs/configuration/workspace.md:37` — `child_pr_strategy` config row (likely dead config).
- `docs/configuration/orchestrator.md:3,56-58,97` — decomposition section, `auto_threshold_ms`, `suggest_threshold_ms`, `min_child_size_ms` config keys. **These config keys do NOT appear in DaemonConfigSchema or OrchestratorConfigSchema today** — docs lie about config that doesn't exist.
- `docs/cli.md:222` — `"orchestrator.yaml — RRPIR phases, notifications, decomposition"`.
- `docs/configuration/README.md:10` — `"RRPIR pipeline, notifications, decomposition, phases"`.
- `docs/usage-guide/writing-tickets.md:85` — `"The Engineer handles decomposition natively"`.

### 13. Workspace-Lifecycle (`src/core/orchestrator/workspace-lifecycle.ts`, 62 lines)

Trivial wiring: `setupWorkspace(dispatch)` calls `workspaceManager.createWorkspace` on first dispatch; no-op on resume/rework. `createSession(dispatch)` creates the session row.

`workspaceManager.createWorkspace` is what reads `PHASE_DIRECTORIES` from `schemas/orchestrator.ts:33-41` and pre-creates each phase's dir under `thoughts/{task}/`. For sub-phase dirs, the workspace-manager must either:
- Pre-create all known sub-phase dirs (drives a `SUB_PHASE_DIRECTORIES` registry-derived constant).
- Create on-demand when each sub-phase first writes its `output.md` (the agent-runner can `mkdirSync` like it does for review sub-phases today).

### 14. Orchestrator Class (`src/core/orchestrator/index.ts`)

`Orchestrator.executeTask(dispatch)`:
- Generates `traceId` via `ulid()`.
- Creates session via `workspaceLifecycle.createSession`.
- Sets up workspace via `workspaceLifecycle.setupWorkspace` (closes session on failure).
- Notifies milestone + ticket_comment.
- Gathers `repoContext` via `gatherRepoContextSafe`.
- Builds `PipelineState` (initial `phaseSequence: 0`).
- Calls `runPhasePipeline(dispatch, state, deps)`.

JSDoc on class (line 71): `"The brain of the system — a 7-phase pipeline that takes a task from intake to integration."` — **STALE for 6-phase model**.

**`attemptSelfUnblock` method** (line 224-288): blocks-recovery path. Calls `agent.run({...})` with no signal — also needs signal threading when AgentAdapter gains it.

### 15. Dev-Toolbox Skill Principles

#### requirements-gathering skill

| Principle | Verdict | Notes |
|---|---|---|
| Phase 1 Intake: read ticket, files, summarize back | ADAPT | The Engineer's gather writes summary to `requirements.md` upfront, not interactively |
| Phase 2 Codebase Grounding: read code before asking | PORT | Current `requirements-gathering.ts` partially does this; emphasize harder |
| Phase 3 Intent Extraction with 7 principles of depth (recursive decomposition, exhaustive enumeration, state transitions, boundary probing, cross-cutting concerns, "what happens next", interaction mapping) | PORT | Major gap in current prompt; these become "investigation principles" |
| "Strictly one question at a time" | ADAPT | Locked Q4: batch ALL questions per outreach file |
| "User signals when to stop" | ADAPT | Self-decide based on completeness criteria, no interactive signal |
| Anti-patterns list (broad confirmation, batching, suggesting to move on, feeling like you "get it" too early) | PORT | High-value quality bar |
| Walk through 2-3 concrete end-to-end scenarios | PORT | Strengthen current edge-case sweep |
| Verify against existing interfaces / UIs / portals | PORT | Useful for The Engineer's tasks too |
| "When a question needs someone else" + draft for stakeholder | ALREADY THERE | Outreach concept already covers this |
| Requirements doc template | ADAPT | Current template absorbs improvements (Context, True Intent, Open Questions sections) |
| "More is always better than less" | PORT | Counters the rush-to-implement instinct |
| "Never volunteer to stop" | ADAPT | Replace with explicit completeness criteria |

#### research skill

| Principle | Verdict | Notes |
|---|---|---|
| "Facts before opinions" / observations vs inferences split | PORT | Current `research.ts` doesn't enforce this discipline |
| "Read upstream artifacts FIRST" | PORT | Emphasize harder |
| "Investigation plan before investigating" | SKIP | No interactive user to confirm plan with |
| "Every change has a blast radius" | PORT | Partially in "Dependencies & Integration Points" |
| "Assume something is always missed" | PORT | High-value framing |
| "Read before you claim" | PORT | Discipline applies cleanly |
| Cross-cutting concerns running questions ("what areas marked out-of-scope, is that true?", "what references this domain?", "what would silently break?", "what would a thorough reviewer ask?") | PORT | Currently absent |
| Facts Wall (observations + inferences separation) | PORT | Doc template addition |
| Research doc template (What I Found / What It Means split) | ADAPT | Current template absorbs the structure |

#### create-plan skill

| Principle | Verdict | Notes |
|---|---|---|
| "Take full ownership / last line of defense" | PORT | Currently absent in planning prompt |
| Phase 1 Absorb: read upstream artifacts fully | PORT | Already partially there |
| Phase 2 Design: present full draft, walk through decisions | ADAPT | No interactive walkthrough; embed decision rationale in plan doc |
| Decision template: Choice/Context/Rejected/Consequence | PORT | Current template lacks this; "## Decisions" section in plan |
| Phase 3 Stress Test via expert panel | ADAPT | Optional sub-phase or skill in self_review (not planning) |
| Pre-mortem for high-stakes | ALREADY THERE | Strengthen with refactor-guide ideas |
| Plan template: Intent, Decisions, Scope Boundary, Task Breakdown, Verification Contract, Risks, Panel Review | ADAPT | Merge with current (Approach Eval, Phases checkboxes, Risks, Pre-mortem, Test Strategy, Success Criteria) |
| "Decisions over descriptions" | PORT | Framing principle |
| "No open questions ship" | PORT | Hard rule |

#### review skill

| Principle | Verdict | Notes |
|---|---|---|
| "Final quality gate" framing | PORT | Refinement adopts |
| Automated verification (typecheck/lint/tests/build) | ALREADY SPLIT | `verify` sub-phase in Execution (Q11) owns this |
| Test coverage analysis | PORT | Self_review lens or dedicated lens |
| "Run /review-pr against branch" | SKIP | N/A in The Engineer; the lenses do this |
| Change review (debug code, inconsistencies, hardcoded values) | PORT | Into self_review or code_quality lens |
| Local testing handoff | SKIP | No human in the loop for local testing |
| "Fix what you find" | ALREADY THERE | Refinement does this |
| "Coverage is about behavior, not lines" | PORT | Quality bar |

#### refactor-guide.md (for self_review lens specifically)

| Principle | Verdict | Notes |
|---|---|---|
| "Does this earn its keep?" framing | PORT | Self_review lens primary stance |
| Read it cold / assess need / assess perfection / consider best practices | PORT | Fine-comb discipline as the lens's operating mode |
| Encode contracts in code, not comments | PORT | Powerful refactor principle |
| Public first, helpers near consumers | PORT | Module organization audit |
| Visible staleness beats silent staleness | PORT | Tied to Fail Loud philosophy |
| Isolated failure boundaries | PORT | N independent ops = N try/catch |
| Things to cut on sight list | PORT | Concrete audit checklist for self_review lens |
| Things to keep on sight list | PORT | Counter-list (don't over-cut) |
| "Mass renames: verify the boundary" | PORT | Useful for change quality checks |
| Required vs optional kwargs | PORT | Code-quality consideration |
| Co-locate with source of truth | PORT | Architecture lens consideration |

## What It Means

### Patterns to follow

1. **Registry as data, runner as code (extend existing pattern).** `phase-handlers.ts` already separates the handlers from the runner. `PhaseNavigator` already supports sequence replacement (for trivial-skip). Sub-phase registry is the natural extension: phase-runner becomes a generic loop over the registry; each sub-phase is data (name + handler ref + routing declarations + skip-gates + config gates). The existing scaffolding is the starting point — no greenfield primitive needed.

2. **Use Node's native AbortSignal support.** `child_process.spawn(cmd, args, { signal })` is Node 16+ standard. When `signal.aborted` fires, Node sends SIGTERM to the child and rejects the spawn-promise chain. Each agent plugin's `doRun` accepts `request.signal` from the new `AgentRunRequest` and passes it directly to `spawn`. No manual listener wiring needed.

3. **GitHostingAdapter typed events — option (a) wins.** Add `detectPrEvents(repo, prNumber, accommodated): PrEvent[]` to the contract. The platform-specific aggregation (state derivation, comment scanning, CI/mergeable checks) lives in the plugin. Core sees clean typed events. Today's review-handler logic becomes the github-hosting plugin's implementation of `detectPrEvents`. Plugin Blindness gain: a future GitLab plugin implements detectPrEvents differently and Core's review-handler doesn't change.

4. **Remove `review_pending` state entirely, use `blocked(reason=pr_review_pending)`.** Surgical changes: `TaskStateSchema` drops the value, `ValidTransitions` rewrites 5 entries, `PermissionTable` rewrites 1 entry, `BlockedDetails` already supports the structured shape. All review-handler `getTasksByState(review_pending)` calls become `getBlockedTasks(reason=pr_review_pending)` (new query method or filter). Workspace cleanup hooks already trigger on completion — fine.

5. **Per-sub-phase checkpoints, composite resume keys.** Add `sub_phase: string | null` to `CheckpointSchema`. Resume code reads `(checkpoint.phase, checkpoint.sub_phase)`. Phase-runner skips to the named sub-phase within the named phase. Single field addition, minimal blast radius.

6. **Observability — already powerful, just use it harder.** `recordDecision` is perfect for every routing call. Every sub-phase gets its own span (`startSpan` with `sub_phase` metadata). Every skip emits an `observe` with structured data. `withTrace(traceId)` already scopes per-task. No new infrastructure — just thorough usage at the new sub-phase granularity.

7. **Test pattern preservation.** Most current tests iterate `PHASE_SEQUENCE` to build mocks — they keep working if a `SUB_PHASE_REGISTRY` iteration replaces it. The hardcoded `exactly 7 phases` assertion + `starts/ends with` assertion break naturally and get rewritten for the 6-phase shape. New per-sub-phase tests follow the existing prompt test pattern (snapshot-style assertions on prompt builders).

### Risks

1. **Decomposition residue is wider than expected.** `docs/configuration/orchestrator.md` references config keys (`decomposition.auto_threshold_ms`, etc.) that **do not exist in DaemonConfigSchema or OrchestratorConfigSchema**. The doc was lying before Slice 6 deleted decomposition — Slice 8's docs cleanup must verify each claimed config key exists, not just delete the section header.

2. **Auto-merge divergence from Q20.** Today's review-handler auto-merges on approval when safetyLayer.checkAutoMergeAllowed(repo) returns true. Farzam's Q20 said "merge = terminal, approval = informational." Reconciliation needed:
   - **Option A**: Cut auto-merge entirely. Humans always merge externally. Aligns with Q20 strictly.
   - **Option B**: Keep auto-merge as safety-config-gated optional behavior (today's pattern). Default-OFF or default-ON?
   - **Option C**: Cut for OSS-default; preserve as power-user opt-in via config.
   - Recommendation for planning: **Option C** — auto_merge_after_approval config defaults to `false` for new installs; existing behavior preserved when explicitly enabled. Preserves capability, no surprise default behavior.

3. **`review_pending` removal touches state history.** Existing rows in `state_transitions` table reference `review_pending` as `from_state` and `to_state`. Pre-v1 universal rule says nuke `data.db` — no migration burden. But: any code that reads state history (`taskEngine.getStateHistory`) and checks for specific state values will need updates. `review-handler.ts:660` references this exact pattern (`countPostApprovalFixAttempts` reads history for transition reason).

4. **Test rewrite chunk is significant.** Not just `phase-runner.test.ts` — `index.test.ts`, `phase-navigator.test.ts`, `agent-runner.test.ts`, all four `prompts/*.test.ts` files, and integration tests. Restructuring tests to the new sub-phase registry shape is likely a full session by itself (Session 4 in the sizing).

5. **Self-unblock uses `agent.run` directly without signal.** `orchestrator/index.ts:262` — when AgentAdapter.run gains `signal`, this call site also needs threading. Easy to miss because it's outside the phase pipeline path.

6. **The 996-line review-handler refactor is dense.** Restructuring it to consume typed events from GitHostingAdapter while preserving all current behavior (accommodation gate, dedup, circuit breaker, MAX_POST_APPROVAL_FIX_RETRIES, comment-based approval, authorized approver checks, auto-merge optional behavior, branch deletion, workspace cleanup) is delicate. Plan should isolate this in its own session.

7. **`PHASE_SEQUENCE` is exported from `types.ts` and imported by tests directly.** Tests bypass the registry abstraction. New design must either keep `PHASE_SEQUENCE` (now derived from the registry) or update all test imports.

8. **`refactor-guide.md` is large (253 lines) — porting it ALL into the self_review lens prompt would bloat the prompt.** Plan should distill the highest-value principles (cut-on-sight/keep-on-sight lists, "earn its keep", encode contracts in code) into a focused lens prompt — not paste the whole guide.

### Open Questions

1. **Auto-merge fate** (auto-merge today vs Q20's terminal-merge model). Recommendation: config-gated default-OFF. Plan to confirm.
2. **`PrEvent` typed union shape**. Five types confirmed (`pr_comments`, `pr_ci_failure`, `pr_merge_conflict`, `pr_approved`, `pr_merged`). What payload schema per type? Each must carry enough info for the typed routing destination's prompt context (e.g., CI failure → list of failed checks, error logs).
3. **Sub-phase routing declaration shape**. TypeScript discriminated union (`{ kind: "advance" } | { kind: "loopback"; to: SubPhaseName } | { kind: "block"; reason: BlockReason } | { kind: "skip-to-phase"; phase: Phase }`)? Or function refs returning a route? Decide in planning.
4. **Per-sub-phase resume implementation**. `CheckpointSchema` gets `sub_phase: string | null`? Or composite key `"phase:sub_phase"`? Decide in planning.
5. **`PHASE_DIRECTORIES` constant + workspace-manager**. Pre-create all sub-phase dirs at workspace creation, or create on-demand? On-demand simpler but spreads `mkdirSync` calls; pre-create cleaner but requires deriving the sub-phase list from the registry at workspace-manager time. Lean on-demand.
6. **`Phase` enum split**. Current `Phase` is a 7-value enum. New model: `Phase` becomes 6-value top-level enum; `SubPhase` is per-phase enum or just `string` (for flexibility / OSS extensibility)? Lean `string` for OSS extensibility, validated by the registry.
7. **Expert-panel-review fate**. Today injected as a skill into self_review's prompt. New options: (a) keep as skill (today's pattern), (b) make a configurable sub-phase of Review (off by default), (c) cut entirely from default behavior. Lean (a) — minimal change, already works.
8. **`PHASE_SEQUENCE` derivation**. Today a const array. New model: derived from the registry's top-level phase order, exported for back-compat with tests? Or break the test imports and update them all? Plan decides.
9. **Refactor-guide.md distillation scope**. Which principles port into the self_review lens prompt, which become coding-standards updates instead? Lean: lens prompt absorbs the framing + cut/keep lists; deeper structural principles stay in coding-standards.
10. **`requirements-gathering` Phase 1 Intake "summarize back" analog**. Current gather doesn't write a context summary upfront. Add a "## Context Summary" section at top of `requirements.md` as the first artifact (before any questions are asked)? Decide in planning.
