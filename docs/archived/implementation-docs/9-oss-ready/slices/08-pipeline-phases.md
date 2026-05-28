# Slice 8: Pipeline Phases

## Requirements

Gathered through Q&A (Session 38). Code reality verified through direct grounding of
the orchestrator surface, pr-manager, review-handler, retry-policy, agent adapter,
git-hosting adapter, observation infrastructure, and existing test patterns; research
saved to `.claude/temp/research/slice-08-pipeline-phases.md` with observations vs
inferences split per the dev-toolbox research skill. Implementation plan saved to
`.claude/temp/create-plan/slice-08-pipeline-phases.md`.

### Scope Framing

This slice owns the per-task pipeline that the orchestrator runs from task intake to
PR merge. **It is a structural reshape** of three previously-separate slices
(8 / 9 / 10) into one coherent unit. Three intertwined halves:

1. **The pipeline shape** — 6 top-level phases (down from 7), data-driven sub-phase
   registry, generic phase-runner over registry, state model with `phase` +
   `sub_phase` + iteration counter, typed routing declarations, full observability
   end-to-end.
2. **Delivery (absorbed from Slice 9)** — PR description writing, commit/push, PR
   creation, the `await_review` block sub-phase.
3. **Review & Feedback External (absorbed from Slice 10)** — typed PR-event detection
   via the `GitHostingAdapter` contract, typed routing from blocked-state back into the
   pipeline (comments → Requirements; CI failure / merge conflict → Execution;
   approval → notify; merge → terminal), feedback rework context plumbing, the full
   refactor of today's 996-line review-handler.

Out of scope (handed off to other slices):

- Workspace cleanup on completion → Slice 9 (was 11).
- Notification routing, response polling, query handling → Slice 10 (was 12).
- Background services (cost tracking, data lifecycle, health monitoring) → Slice 11 (was 13).
- Dashboard UI updates that follow from the new phase shape → Slice 13 (was 15).
- npm SDK extraction → Slice 14 (was 16).

(Subsequent slices renumber down by 2 after Slice 8 lands; was Slices 11→16, becomes Slices 9→14.)

### Goals (priority order)

1. **Honest, evolvable pipeline shape.** Cut the dead `integration` phase. Replace
   hardcoded phase if-chains in `phase-runner.ts` with a data-driven sub-phase
   registry. Adding/removing/toggling a sub-phase is config plus one new file.
   Phase-runner does not change. Tests follow the registry, not the shape.
2. **Phase + state model end-to-end.** Persist `phase` + `sub_phase` +
   `phase_iteration` on the task row. Collapse `Outcomes.review_pending` into
   `blocked(reason=pr_review_pending)`. Remove `TaskStates.review_pending` entirely.
3. **Default-every-failure-blocks.** No abandonment paths. Every failure transitions
   the task to `blocked` with a descriptive typed reason naming the failed sub-phase,
   failure category, and next operator action. `engineer retry` is the universal
   unblock verb. `retry-policy` module shrinks to a single `agent_unavailable`
   category; the `crash` category and `consecutive_crash_count` field are cut.
4. **Signal honoring end-to-end.** `AgentRunRequest` gains `signal: AbortSignal`;
   plugins pass it to Node's `spawn({ signal })` natively. Phase-runner threads
   `dispatch.signal` through `agent-runner` into every agent call. Closes the
   Slice 6 → Slice 8 handoff.
5. **Delivery as sub-phases under the new registry.** `pr_description` (CLI) +
   `pr_push` (orchestrator) + `pr_create` (orchestrator) + `await_review`
   (orchestrator block). Replaces today's `demo_prep` phase + the inline
   `tryCommitPushAndCreatePR` logic in phase-runner. Absorbs the long-standing TODO
   in `pr-manager.ts:154` (move commit responsibility back to execution).
6. **External review polling refactored onto typed events.** `GitHostingAdapter` gains
   a typed-event detection method; review-handler refactors against it. Five typed
   `PrEvent` variants (`pr_comments`, `pr_ci_failure`, `pr_merge_conflict`,
   `pr_approved` informational, `pr_merged` terminal). Routing per event type
   declared in the registry, not hardcoded.
7. **Observability load-bearing.** Every phase transition / sub-phase
   start-end-skip / loopback iteration / routing decision / block event / cap-hit
   alert / skip-gate trigger gets logged + traced + decision-recorded. Dashboard
   shows the registry state at every moment.
8. **Dev-toolbox skill refinements ported into prompts** as concrete prompt diffs.
   One locked adaptation: outreach is batched per contact (not one question at a
   time). Other principles classified port / adapt / skip per the framework in the
   plan.
9. **Docs and tests in sync.** Decomposition residue cleaned across docs.
   `docs/constraints.md` gets "Sub-Phase Execution Order" (sequential v1).
   `docs/future-considerations.md` gets "Parallel Sub-Phase Execution". Closing
   standards sweep at the end (may spill into a second sweep session given the
   absorbed scope).

## Decisions

### #1 — Cut the `integration` phase entirely

Dead surface since Slice 6 deleted decomposition. The phase always runs with
`childSummaries: []`; the prompt is "merge child branches" but there are no children.
Demo_prep still routes to it via `next_phase: "integration"` instruction. Delete the
enum value, schema (`IntegrationOutputSchema`), prompt builder
(`prompts/integration.ts`), the `"integration"` entry in `PHASE_DIRECTORIES`, the
trace dir mapping, the skill mapping, demo_prep's routing branch. PHASE_SEQUENCE
shrinks. Future-considerations entry for decomposition already exists.

### #2 — 6-phase canonical model

New canonical order: **Requirements → Research → Planning → Execution → Review →
Delivery**. `self_review` becomes its own top-level `Review` phase (not a sub-step
under Execution). `demo_prep` collapses into `Delivery` alongside commit/push/PR
creation. Phase enum values: `requirements`, `research`, `planning`, `execution`,
`review`, `delivery`.

### #3 — Phase + state model with `sub_phase` + `phase_iteration`

Task row gains: `phase` (top-level enum), `sub_phase` (string, name from registry),
`phase_iteration` (int, for intra-phase loops like Review). All three persisted, all
visible in dashboard. The `phase` field becomes an enum-validated value (today it's
`string().nullable()`).

### #4 — Outcome collapse: `review_pending` → `blocked(pr_review_pending)`

`Outcomes.review_pending` removed. The task's `await_review` sub-phase transitions
the task to `blocked` with structured reason `pr_review_pending`. Same mechanism as
`need_more_info` already uses today. `TaskStates.review_pending` removed from
`TaskStateSchema`, `ValidTransitions`, `PermissionTable`. Existing
`getTasksByState(TaskStates.review_pending)` call sites in `review-handler` rewire to
`getBlockedTasksByReason("pr_review_pending")` (new query method or filter).

### #5 — Sub-phase registry as load-bearing architecture

Each top-level phase has 1+ sub-phases declared as data. A sub-phase declaration:
`{ name, kind: "cli" | "orchestrator", handler ref, session_result_required, skip_gate?,
config_gate?, routing_declarations[] }`. Phase-runner becomes generic over the
registry. Routing rules (intra-phase loop, advance, escape to other phase, block,
terminal) are declared per sub-phase, not hardcoded in phase-runner if-chains.

**The load-bearing concern:** today's tests broke whenever phase shape changed because
the architecture wasn't dynamic. Slice 8 fixes this — slight over-engineering for
evolvability is sanctioned. Adding/removing/toggling a sub-phase is config + one new
file. Tests follow the registry shape.

### #6 — Default sub-phases per phase

| Phase | Default sub-phases | Optional opt-in |
|---|---|---|
| Requirements | `gather` (CLI, may block on outreach) | — |
| Research | `investigate` (CLI) | — |
| Planning | `design` (CLI) | — |
| Execution | `implement` (CLI), `verify` (orchestrator: typecheck/lint/tests) | — |
| Review | `self_review` (CLI), `refinement` (CLI) | `security_review`, `code_quality`, `architecture_review` |
| Delivery | `pr_description` (CLI), `pr_push` (orch), `pr_create` (orch), `await_review` (orch block) | — |

`self_review` is a single broad default lens that absorbs requirements-check + code
smells + completeness ideas from refactor-guide.md. Other lenses opt-in via config.
Refinement always-on.

### #7 — Review intra-phase loop with cap + refinement-declared escape

Refinement iterates within Review (re-runs lenses + applies fixes) capped at 3
iterations (configurable). Refinement may declare an early escape route at any
iteration: "this is a Planning problem" → Planning; "this is a Requirements problem"
→ Requirements. Cap-hit without early-route → unconditional block with descriptive
reason (workflow-level red flag, loud by design). Replaces today's "needs_work routes
to execution" inter-phase loopback.

### #8 — Typed external event routing from `await_review`

Five typed event variants from the `GitHostingAdapter`'s new event detection method:

| Event | Route | Reason |
|---|---|---|
| `pr_comments` | Requirements (with skip-gate fast-path) | Assessment may surface new scope; trivial-comment skip-gate routes forward fast |
| `pr_ci_failure` | Execution | Pure code fix, no human-intent ambiguity |
| `pr_merge_conflict` | Execution | Pure code fix, base branch moved |
| `pr_approved` | trigger auto-merge attempt (orchestrator sub-phase) | Human approval is the trigger; The Engineer performs the merge |
| `pr_merged` | terminal `completed` | Merge is the real completion event |

Routing declared as data per sub-phase, not hardcoded. `pr_approved` triggers The
Engineer's auto-merge attempt via `GitHostingAdapter.mergePR` (CI-gated + mergeable-gated).
On merge success → `pr_merged` event → terminal. On CI not ready → wait, recheck next
tick. On CI failure post-approval → route via `pr_ci_failure`. On conflict post-approval
→ route via `pr_merge_conflict`. (Today's `attemptMerge` + `approvedAwaitingCI` flow
preserved, refactored against typed events.)

### #9 — Failure policy: every failure blocks with descriptive typed reason

No abandonment paths. CLI session dies without writing session-result.json → block.
Schema validation fails → block. Orchestrator sub-phase throws → block. Plugin call
errors → block. Each block carries a structured reason naming the failed sub-phase +
failure category + next operator action. `engineer retry` unblocks; resume picks up at
the failed sub-phase. Catastrophic orchestrator crashes still flow through Slice 6's
crash-recovery, which retries → blocks. Functionally the operator always has a
recoverable surface.

### #10 — `retry-policy` shrinks to single `agent_unavailable` category

Cut the `crash` category (`consecutive_crash_count` field, `COUNTER_FIELDS["crash"]`,
`TERMINAL_STATES["crash"]`, `retry_policy.crash` config). Crash-style failures block
immediately per #9. Keep `agent_unavailable` (genuine provider transient — backoff +
retry before blocking is real value). Refactor consumers of `crash` category in
`task-scheduler.ts` (boot recovery) and `phase-runner.ts` `handlePhaseError` to block
directly.

### #11 — Signal honoring end-to-end

`AgentRunRequest` schema gains `signal: AbortSignal`. `AgentAdapter.run(request)`
plumbs it through; each plugin's `doRun` passes `request.signal` to
`spawn(cmd, args, { signal })` natively. Phase-runner passes `dispatch.signal` to
every `agentRunner.runPhaseWithCli` call. Self-unblock path in
`orchestrator/index.ts:262` also threads signal. Termination (preemption, hard-cap,
shutdown, cost-limit) actually aborts in-flight agent CLI calls instead of being
best-effort.

### #12 — Per-sub-phase checkpoints, composite resume

`CheckpointSchema` gains `sub_phase: string | null`. Each sub-phase's completion writes
a checkpoint. Resume code reads `(checkpoint.phase, checkpoint.sub_phase)` and skips
to the named sub-phase. **Planning resolves the exact representation** (single
`sub_phase` field on checkpoint vs composite key).

### #13 — Execution split: `implement` + `verify`, logical commits during implement

`implement` (CLI) — agent writes code, runs tests during work, makes logical commits
using the dev-toolbox `/commit` skill. `verify` (orchestrator) — runs `pnpm run
typecheck`, `pnpm run lint`, `pnpm test`. If red, loops back to `implement` with
structured failure context (gate + output) under the same "Why You're Back Here"
pattern as external feedback. `pr_push` becomes the safety-net catch-all commit
during Delivery. Resolves `pr-manager.ts:154` TODO.

### #14 — Delivery sub-phases

Four sub-phases:

- **`pr_description`** (CLI) — agent writes the PR write-up.
- **`pr_push`** (orchestrator) — commit any straggler changes + push branch.
- **`pr_create`** (orchestrator) — open the PR via `GitHostingAdapter.createPR`.
- **`await_review`** (orchestrator block) — transition task to
  `blocked(reason=pr_review_pending)`, exit pipeline. Unblock on external event per
  #8.

### #15 — Outreach batching (locked adaptation of dev-toolbox principle)

Requirements `gather` writes ONE outreach file per contact with ALL questions in it.
Not split across iterations. Adapts the dev-toolbox `requirements-gathering` skill's
"strictly one question at a time" — which is right for interactive Q&A, wrong for
async comm-plugin outreach. Locked decision.

### #16 — Rework feedback context as structured data

Every loop-back / rework sub-phase prompt gets a structured "Why You're Back Here"
section embedding the event type, raw content, file refs, CI logs, conflict files —
whatever the hosting plugin surfaced. Untrusted external content wrapped via
`wrapUntrustedContent`. No loose feedback strings appended to prompts. The
sub-phase's registry declaration includes "what context shape do I need" so the
orchestrator assembles it correctly.

### #17 — Trivial-skip generalized as registry skip-gate

Today's `skip_research` flag becomes one instance of a generic per-sub-phase skip
mechanism. Each sub-phase declares its skip condition in the registry. Trivial
complexity from Requirements may skip Research and Planning sub-phases. Full
observability for every skip: `recordDecision` for the skip, journal entry naming the
gate that fired, dashboard reflects the skipped sub-phase clearly. Closes the
Slice 5 → Slice 8 trivial-skip-honesty handoff.

### #18 — Sequential sub-phase execution (v1 constraint)

Sub-phases execute sequentially within a phase. Parallel execution deferred to
future-considerations. `docs/constraints.md` gets "Sub-Phase Execution Order" entry.
`docs/future-considerations.md` gets "Parallel Sub-Phase Execution" capability
concept.

### #19 — `thoughts/` directory layout: per-sub-phase dirs

```
thoughts/{task}/{phase}/{sub_phase}/
  output.md           (CLI sub-phases)
  session-result.json (CLI sub-phases)
  log.txt             (orchestrator sub-phases — optional)
```

Symmetric with traces dir structure. Self-contained sub-phase units. **Planning
resolves** pre-create-all vs create-on-demand strategy in workspace-manager.

### #20 — Prompt builder organization: one file per sub-phase, grouped by phase

```
src/core/orchestrator/prompts/
  requirements/gather.ts
  research/investigate.ts
  planning/design.ts
  execution/implement.ts
  review/self_review.ts, refinement.ts
  delivery/pr_description.ts
  shared/format.ts, system.ts, context.ts, skills.ts
```

Sub-phase prompt-builder filenames match sub-phase names. Adding a lens = add a file.
Maps directly to thoughts/, traces/, and registry layout.

### #21 — Dev-toolbox skill refinements ported into phase prompts

Port / adapt / skip framework — concrete prompt diffs in the plan. Per-skill
enumeration lives in research doc § 15 ("Dev-Toolbox Skill Principles") and gets
translated into prompt edits during Implementation Session for prompts. Key locks:

- **Port** (use as-is): observations vs inferences split (Research), Decision template
  Choice/Context/Rejected/Consequence (Planning), refactor-guide cut-on-sight /
  keep-on-sight lists (self_review lens), principles of depth (Requirements gather).
- **Adapt**: one-question-at-a-time → batch per outreach (#15); user-signals-when-to-stop
  → self-decide based on completeness; interactive walkthroughs → embed rationale in
  doc artifacts.
- **Skip**: investigation-plan-before-research (no interactive user), local-testing
  handoff (no human in the loop), AskUserQuestion mechanics.

### #22 — `GitHostingAdapter` typed-event detection contract

Add `detectPrEvents(repo, prNumber, accommodated): Promise<PrEvent[]>` to the
adapter contract. Plugin implementations aggregate platform-specific state into
typed `PrEvent` variants. Core's review-handler consumes typed events; routing
declared by the registry. **Planning resolves** the exact `PrEvent` payload schema
per variant (CI failure carries which checks failed + error logs; merge conflict
carries which files; comments carry comment text + author + ID; approved/merged
carry minimal metadata).

### #23 — Review-handler refactor onto typed events; auto-merge preserved

Today's 996-line `daemon/review-handler.ts` refactors against the new typed-event
contract. **All existing capabilities preserved**, just rewired through the typed
events:

- Accommodation gate (dedup) — preserved.
- Comment-based approval (`/approve` regex) — preserved (surfaces as `pr_approved` event from the hosting plugin).
- Authorized approver check via people-directory — preserved.
- Circuit breaker (failure window for hosting API) — preserved.
- Per-tick caching — preserved.
- Self-comment filtering (`SELF_COMMENT_PREFIXES`) — preserved.
- Branch deletion on completion — preserved.
- Thoughts-removal-before-merge — preserved.
- **Auto-merge — preserved.** On `pr_approved` event, The Engineer attempts the merge
  (CI-gated + mergeable-gated) via `GitHostingAdapter.mergePR`. Today's `attemptMerge`
  flow stays, just driven by the typed event instead of the polling code path.
- `MAX_POST_APPROVAL_FIX_RETRIES = 3` — preserved as a registry-level cap on
  `pr_ci_failure` / `pr_merge_conflict` loopback iterations after approval.
- `approvedAwaitingCI` (deferred merge while CI runs) — preserved.

### #24 — Slice rename: `08-pipeline-phases.md`

The original slice file name `08-rrpir-phases.md` reflected the RRPIR (5-step)
methodology. The new shape is 6 phases, only some of which map cleanly to RRPIR
letters. Slice file renames to `08-pipeline-phases.md` to reflect what the slice
actually owns.

### #25 — Slice 8 absorbs Slices 9 + 10 in full

Original roadmap: Slice 9 = Demo & PR; Slice 10 = Review & Feedback (External).
Both are tightly coupled to the pipeline shape and to each other. Splitting them
risks half-baked seams. One coherent architectural unit lands together.
Subsequent slices renumber down by 2 (was 11→16, becomes 9→14). Slice 11
boundary preserved (workspace cleanup stays Slice 9 / was Slice 11 — terminal
state cleanup is a different concern than pipeline shape).

### #26 — `engineer retry` CLI verb stays

Semantically becomes "unblock-and-resume" in the new every-failure-blocks model,
but the verb stays. No new `engineer unblock` command. The block-reason naming
carries the real semantics; the CLI verb is general-purpose. Avoids CLI surface
churn.

## Cross-Slice Handoffs

### Inbound (parked from prior slices, all land in Slice 8)

- **Slice 5 → Slice 8:** trivial-skip honesty. Verified in research: today's
  complexity-based `skip_research` flag lives at `phase-runner.ts:691-703`,
  persisted on the task row. #17 generalizes it.
- **Slice 6 → Slice 8:** decomposition cleanup. Verified surface: 4 source files
  (`prompts/demo-prep.ts:109`, `prompts/planning.ts:97`,
  `prompts/integration.ts` entire, `prompts/index.ts:21`) + 5 doc files
  (`docs/configuration/orchestrator.md` references config keys that don't
  exist in `OrchestratorConfigSchema` — docs lie). #1 cuts the surface.
- **Slice 6 → Slice 8:** signal honoring. Verified gap: `Dispatch.signal:
  AbortSignal` flows in via Slice 6's dispatch-tracker but is never read anywhere
  downstream. Only `signal` mention beyond `Dispatch` is `preemption-manager.ts:188`
  (unrelated log line). #11 closes it.
- **Session 37 (LLM→Agent rename) → Slice 8:** `provider_id` literal in
  `agent-runner.ts` still hardcodes `"agent"` on `cost.incurred` payload.
  Semantically the field should be the actual plugin ID
  (e.g. `claude-code-agent`). Folded into Slice 8 cleanup.

### Outbound (parked for downstream slices, post-renumber)

- **Slice 8 → Slice 9 (was 11) Completion & Cleanup:** terminal-state hooks
  (workspace cleanup on merged, archive logic, terminal notifications). Slice 8
  produces the terminal `completed` state cleanly with all observability;
  Slice 9 owns the post-pipeline reaper.
- **Slice 8 → Slice 10 (was 12) Communication:** notification-kind enumeration
  audit (already parked from Slice 6); reply-token + unblock check (already parked
  from Slice 5); response-poller integration with the new typed-event surface.
- **Slice 8 → Slice 13 (was 15) Dashboard Revisit:** ALL dashboard UI for the new
  pipeline shape — `phase` + `sub_phase` + `phase_iteration` visibility, visual
  treatment of the simplified state machine (no more `review_pending` row),
  block-reason-taxonomy display, routing-decisions trail, skip-gate trail,
  sub-phase progress visualization. Slice 8 produces the data (schema columns,
  event emissions, observation records) and minimal data-layer surface; Slice 13
  owns all UI work.

## Findings (no decision needed — captured for the plan to address)

- **`docs/configuration/orchestrator.md` references nonexistent config keys**
  (`decomposition.auto_threshold_ms`, `suggest_threshold_ms`, `min_child_size_ms`).
  Not in `DaemonConfigSchema` or `OrchestratorConfigSchema`. Docs lie. Slice 8
  decomposition residue cleanup must verify each claimed config key exists, not
  just delete section headers.
- **Pre-v1 universal rule applies**: rewrite `001_schema.sql` to reflect the
  post-Slice-8 shape (drop `review_pending` from CHECK constraint, drop
  `consecutive_crash_count` column, add `sub_phase` + `phase_iteration` to tasks
  row, add `sub_phase` to `checkpoints` row). Document "delete `~/.engineer/data.db`
  before running this version" in the slice's session log.
- **Test surface changes substantially.** Most coupling is through `PHASE_SEQUENCE`
  iteration (refactor-friendly), but `makeOutput()` has per-phase data shapes that
  rewrite for sub-phase outputs, and `PHASE_SEQUENCE has exactly 7 phases` /
  `starts with X ends with Y` assertions break naturally and rewrite for 6-phase
  shape. New per-sub-phase tests follow existing prompt-test pattern (snapshot-style
  assertions on prompt builders).
- **No prompt-builder unit tests today** for `requirements-gathering`, `research`,
  `planning`, `demo-prep`, `context`, `format`, `system`. Slice 8's new per-sub-phase
  prompt files all get unit tests (closes the gap).
- **Self-unblock path** (`orchestrator/index.ts:224-288`) uses `agent.run` directly
  without signal. Easy to miss — included in #11's signal-threading scope.
- **Documentation surface to update.** `docs/architecture/overview.md` (pipeline
  section), `docs/configuration/orchestrator.md` (rrpir block + delete decomposition
  section), `docs/cli.md`, `docs/usage-guide/writing-tickets.md`, plus possibly a
  new `docs/architecture/pipeline.md` if the overview section grows too large.

## Implementation Decisions (resolved in plan, Session 39)

These are implementation-level shape decisions that the plan resolves with engineering
judgment. Documented in the plan's Decision Record with Choice/Context/Rejected/Consequence
template. Requirements are locked — these don't reopen anything; they translate locked
requirements into concrete implementation shape.

- `PrEvent` typed union payload schemas per event type.
- Sub-phase routing declaration shape (TypeScript discriminated union vs function refs vs config object).
- Per-sub-phase checkpoint shape (`sub_phase: string | null` on `CheckpointSchema` vs composite key).
- Workspace-manager sub-phase dir creation strategy (pre-create vs create-on-demand).
- `Phase` enum split (top-level enum + flat-string sub-phase vs composite enum).
- Expert-panel-review fate (keep as skill, promote to sub-phase, or cut).
- Refactor-guide.md distillation scope (lens prompt vs coding-standards).
- Requirements `gather` "context summary" upfront analog to dev-toolbox Phase 1 Intake.
- Block reason taxonomy enumeration.
- Test architecture pattern (registry iteration + per-sub-phase tests).

## Future Considerations

Captured in `docs/future-considerations.md` (added during implementation):

- **Parallel Sub-Phase Execution** — generalization of the registry's sequential
  execution to allow declared-parallel sub-phases (e.g., security_review +
  code_quality + architecture_review running concurrently within Review).
- **Auto-Merge** — if cut in Slice 8 (TBD per #8 open question), captures the
  capability concept for a future paid-tier or opt-in feature.

## Session Breakdown

Finalized in `.claude/temp/create-plan/slice-08-pipeline-phases.md`. Sized so each
session finishes completely (code + tests + docs + green gates) within Farzam's
~400k token cap per session, ideally focused. Quantity does not matter if it brings
real value (Farzam's wording).

Rough breakdown (refined in plan):

1. **Session 1 — Foundation cleanup.** Cut integration phase + collapse
   `review_pending` outcome + decomposition residue cleanup (source + docs).
   Smallest blast-radius cleanup before the architecture rebuild.
2. **Session 2 — Sub-phase registry primitive.** New `registry.ts`, types,
   declaration shape, generic phase-runner over registry. Tested in isolation
   with mock sub-phases.
3. **Session 3 — Migrate phases onto registry.** Requirements, Research, Planning,
   Execution onto the new registry. Old phase-handlers shape deleted.
4. **Session 4 — Review phase onto registry.** `self_review` + `refinement` +
   optional lenses. Intra-phase loop + cap + escape-route routing.
5. **Session 5 — Delivery sub-phases.** `pr_description`, `pr_push`, `pr_create`,
   `await_review`. PR-manager surgery; `tryCommitPushAndCreatePR` teardown.
6. **Session 6 — `AgentAdapter` signal threading + retry-policy shrink.** Through
   adapter, agent-runner, phase-runner, all 3 agent plugins. Cut `crash` category.
7. **Session 7 — `GitHostingAdapter` typed events + review-handler refactor.**
   New contract method, hosting plugin implementation, review-handler refactor
   against typed events, typed routing into the pipeline. Auto-merge preserved
   under the new routing.
8. **Session 8 — Dev-toolbox skill principles ported into prompts.** Concrete
   prompt diffs per sub-phase (per the port/adapt/skip table in research doc).
9. **Session 9 — Project-wide docs sweep.** Architecture docs (`overview.md`,
   `three-tier-model.md`, potentially a new `pipeline.md`), configuration docs
   (`orchestrator.md` rrpir reshape + delete decomposition section + verify
   every claimed config key exists), user-flow docs, plugin author guides,
   README mentions of "7 phases" / "RRPIR" acronym, bundled CLI plugin docs,
   seed-example references. Dashboard UI work explicitly deferred to Slice 13
   (was 15) — Slice 8 produces the data, Slice 13 displays it.
10. **Session 10 — Closing standards sweep.** Line-by-line audit of every file
    the slice created or changed against `coding-standards.md`, `anti-patterns.md`,
    `philosophy.md`. Two-pass discipline. May spill into Session 11 if surface
    demands (slice is bigger than Slice 7).

## Closing Standards Sweep

Same pattern as Slice 7's closing sweep — full-file line-by-line audit of every
file the slice created or changed, against `docs/coding-standards.md`,
`docs/anti-patterns.md`, `docs/philosophy.md`, and the principle-driven checks in
`approach.md` § "Closing Standards Sweep" (every documented reference matches code;
every manifest matches behavior; every swallowed error is logged; every constant
lives in one place; no stale counts; no vestigial scaffolding; backwards-compat
re-exports forbidden; coding-standards alignment as planning concern, not
sweep-only). Two-pass discipline (Slice 7 Session 36 lesson — first pass finds
small things, second pass finds the structural defects). Update
`feedback_slice_closing_standards_sweep.md` if a new class of defect surfaces.

## Lens Check

Per `approach.md` § "Lenses" — every slice is evaluated through these perspectives.

- **Resilience.** Net strongly positive. Signal honoring closes a real cancellation
  hole (best-effort termination becomes actual termination). Every-failure-blocks
  with descriptive reason makes the operator's diagnostic surface dramatically
  clearer. Per-sub-phase checkpoints mean a crash mid-Review-iteration-2 doesn't
  redo iteration-1.
- **Plugin Integrity.** Net positive. `GitHostingAdapter` typed-event contract moves
  platform-specific aggregation behind the adapter boundary (Plugin Opacity
  strengthened — Core stops seeing `reviewStatus.reviewers[].state`). Agent plugin
  contract gains `signal` parameter uniformly across all 3 agent plugins. Sub-phase
  registry is Core-internal; no plugin contract leakage.
- **Plugin Authoring Simplicity.** Net positive. The two new contract additions
  (`AgentRunRequest.signal`, `GitHostingAdapter.detectPrEvents`) are minimal and
  well-typed. Sub-phase registry doesn't touch plugin contracts.
- **UX Quality.** Net strongly positive. Dashboard now shows `phase` + `sub_phase`
  + iteration count + descriptive block reasons. Operator-facing CLI messaging
  becomes uniform. Auto-merge default-OFF (if locked in plan) removes a surprise
  behavior. Block reason taxonomy makes "what's wrong" loud and clear.
