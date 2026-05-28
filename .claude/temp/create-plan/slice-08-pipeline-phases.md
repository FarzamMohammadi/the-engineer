# Plan — Slice 8: Pipeline Phases

**Date**: 2026-05-27 | **Stakes**: Full
**Upstream**: `.claude/temp/research/slice-08-pipeline-phases.md` | `docs/archived/implementation-docs/9-oss-ready/slices/08-pipeline-phases.md`
**Status**: Draft

Synthesizes the slice file's 26 locked decisions and the research doc's observations
into a sequenced implementation plan. Calibrated to **full-stakes architectural
refactor** discipline: hard decision gates, explicit alternatives + why-rejected,
panel review, pre-mortem, dedicated docs sweep, closing standards sweep. Ten sessions,
each green-on-commit. May spill to eleven if either sweep demands.

---

## Intent

Rebuild the per-task pipeline as a 6-phase, data-driven sub-phase registry that is
honest (no dead surface), evolvable (sub-phases compose as declarative data), and
fully observable end-to-end. Absorb the original Slices 9 (Demo & PR) and 10 (Review
& Feedback External) into one coherent architectural unit. The single most important
reason: the past pain point of tests breaking on phase-shape changes points to a
deeper architecture problem — the pipeline must be dynamic, not hardcoded, so future
sub-phase additions/removals/toggles are config + one file, never a phase-runner
rewrite.

---

## Decision Record

### D1 — Sub-phase declaration shape: TypeScript discriminated union, one phase = one module

**Choice**: Each phase is a TypeScript module under `src/core/orchestrator/registry/`
exporting a `PhaseDefinition` const. A `PhaseDefinition` is `{ phase: Phase, subPhases: SubPhase[] }`. Each `SubPhase` is a discriminated union by `kind`:

```typescript
type SubPhase =
  | {
      readonly kind: "cli";
      readonly name: string;
      readonly buildPrompt: (ctx: SubPhaseContext) => string;
      readonly requiresSessionResult: true;
      readonly enabledBy?: (config: OrchestratorConfig) => boolean;
      readonly skipGate?: (ctx: SubPhaseContext) => SkipDecision | null;
      readonly routes: ReadonlyArray<RoutingRule>;
    }
  | {
      readonly kind: "orchestrator";
      readonly name: string;
      readonly handler: (ctx: SubPhaseContext) => Promise<SubPhaseResult>;
      readonly enabledBy?: (config: OrchestratorConfig) => boolean;
      readonly skipGate?: (ctx: SubPhaseContext) => SkipDecision | null;
      readonly routes: ReadonlyArray<RoutingRule>;
    };

type RoutingRule =
  | { readonly when: SessionResultPredicate; readonly target: { kind: "advance" } }
  | { readonly when: SessionResultPredicate; readonly target: { kind: "loopback_intra"; subPhase: string; iterationCap: number } }
  | { readonly when: SessionResultPredicate; readonly target: { kind: "loopback_inter"; phase: Phase; subPhase?: string } }
  | { readonly when: SessionResultPredicate; readonly target: { kind: "block"; reason: BlockReason; message: (ctx: SubPhaseContext) => string } }
  | { readonly when: SessionResultPredicate; readonly target: { kind: "terminal"; outcome: "completed" } };
```

Aggregated by `src/core/orchestrator/registry/index.ts` into a `Registry` const
(`Record<Phase, PhaseDefinition>`) consumed by the generic phase-runner.

**Context**: Adding/removing/toggling a sub-phase must be one new module file, not a
phase-runner edit. Discriminated unions give compile-time exhaustiveness; the runner's
`switch (rule.target.kind)` is exhaustive against the union.

**Rejected**:
- *Function-ref registry only.* Sub-phases as `() => SubPhase` factories. Defers
  declaration to call time; loses static introspection (e.g., the docs-sweep session
  can't enumerate sub-phases from the registry without execution).
- *Plain config-object (JSON-shaped).* No type discrimination, no exhaustiveness checks
  on routes. Loses TypeScript's safety net for a pattern we use across N sub-phases.

**Consequence**: Phase-runner is a 100-200 line generic loop. Each sub-phase's logic
lives in its own module. Tests target the registry constant, not the runner.

### D2 — Sub-phase identifier: free-form string (validated by registry), `Phase` stays an enum

**Choice**: `Phase` stays a 6-value enum. `SubPhase.name` is `string`, validated at
registry construction by a Zod check that ensures no duplicate names within a phase
and no reserved words. Composite key for persistence is `(phase, sub_phase)` — two
columns on the task row, two fields on `CheckpointSchema`.

**Context**: OSS extensibility (a future plugin could declare custom review lenses)
favors flat strings. But the top-level phase shape is invariant and enum-validated.
Compile-time exhaustiveness on top-level phases (the dimension that affects every
consumer); runtime validation on sub-phase names (the dimension that grows).

**Rejected**:
- *Composite enum `Phase_SubPhase`.* Combinatorial explosion (6 phases × N sub-phases
  per phase × optional lenses). Awkward to query.
- *`SubPhase` as a per-phase enum.* Splitting per phase means every consumer that
  iterates "all sub-phases" needs N enum imports. Flat string is simpler.

**Consequence**: Validation lives in the registry's construction (one place).
Dashboard queries on `sub_phase` are simple string filters. Adding a lens doesn't
need a schema regen.

### D3 — Per-sub-phase checkpoints: add `sub_phase: string | null` to `CheckpointSchema`

**Choice**: `CheckpointSchema` gains `sub_phase: z.string().nullable()`. Resume reads
`(checkpoint.phase, checkpoint.sub_phase)` and jumps the registry cursor to the named
sub-phase within the named phase. `sub_phase: null` means "phase-level checkpoint"
(for backward-shape with phase-only resume paths, but in v1 every checkpoint sets
both fields).

**Context**: Per-sub-phase resume preserves work after operator unblock + retry. The
flat field on the existing schema is the minimal change. The DB migration adds one
column to the `checkpoints` table.

**Rejected**:
- *Composite key `"phase:sub_phase"`.* Stringly-typed composite; harder to filter on
  dashboard. Saves one column at the cost of every consumer parsing.
- *Separate `sub_phase_checkpoint` table.* Two checkpoint tables means two write
  paths, two read paths. Overengineered for a single new field.

**Consequence**: One DB column added. Phase-runner's `resolveStartState` resolves
both phase and sub-phase from the checkpoint. Tests assert on both fields.

### D4 — Workspace sub-phase dir creation: create-on-demand by the registry runner

**Choice**: `workspace-manager.createWorkspace` continues to pre-create the top-level
phase directories (per the registry's enumerated `Phase` set). Sub-phase
sub-directories are created on first write by the runner (`mkdirSync` in the agent-runner /
orchestrator-handler path, same pattern today's `runPhaseWithCli` uses for review
sub-phases at `llm-caller.ts:422-424`, now `agent-runner.ts`).

**Context**: Pre-creating all sub-phase dirs requires the workspace-manager to know
the registry shape, introducing a cross-module coupling that's awkward (workspace-manager
is upstream of orchestrator). On-demand creation is the existing pattern, already
proven for review's dynamic lens dirs.

**Rejected**:
- *Pre-create-all from registry.* Couples workspace-manager to the registry.
  Workspace-manager's job is git/disk, not pipeline shape.
- *Hybrid (top-level + registered defaults).* Same coupling problem in smaller form.

**Consequence**: Workspace-manager stays oblivious to sub-phases. Registry runner
owns directory creation symmetrically with file writes.

### D5 — `PrEvent` typed union payload schemas

**Choice**: Five Zod schemas under `src/schemas/git-hosting-events.ts`:

```typescript
PrCommentsEventSchema     = { type: "pr_comments";       comments: PrComment[] }
PrCiFailureEventSchema    = { type: "pr_ci_failure";     failed_checks: PrCheck[] }
PrMergeConflictEventSchema= { type: "pr_merge_conflict"; conflicting_files: string[]; base_branch: string }
PrApprovedEventSchema     = { type: "pr_approved";       approver: string; approved_at: string }
PrMergedEventSchema       = { type: "pr_merged";         merged_at: string; merged_by: string | null }
```

Where `PrComment = { id, author, body, created_at }` and `PrCheck = { name, status,
log_url: string | null, summary: string }`. `PrEventSchema = z.discriminatedUnion("type", [...])`.

**Context**: Each event must carry (a) routing destination's "Why You're Back Here"
context (e.g., CI failure → which checks failed + logs), (b) dashboard signal data,
(c) accommodation gate data (IDs / timestamps for dedup).

**Rejected**:
- *Single generic payload (raw JSON).* Loses type safety; the routing destination
  has to re-parse.
- *Larger payloads (full review status).* Bloats the contract; plugin-specific
  internals leak into Core.

**Consequence**: `GitHostingAdapter.detectPrEvents` returns `PrEvent[]`. Plugin
authors implement aggregation behind the contract. Routing destinations get typed,
minimal, useful context.

### D6 — Block reason taxonomy (enumerated)

**Choice**: Block reasons enumerated as a Zod enum, persisted in `BlockedDetails.reason`:

```typescript
BlockReasonSchema = z.enum([
  // From requirements outreach
  "need_more_info",
  // From Delivery's await_review sub-phase
  "pr_review_pending",
  // From AgentAdapter retry exhaustion
  "agent_unavailable_persistent",
  // From sub-phase failures (descriptive suffix = sub-phase name)
  "sub_phase_failure",
  // From Review cap-hit without escape route
  "review_iteration_cap_hit",
  // From cost limit
  "cost_limit_reached",
  // From workspace verification failure on resume
  "workspace_corrupt",
]);
```

`BlockedDetails.efforts_made`, `contacted`, `needed`, `waiting_for` continue to carry
the descriptive context (today's structured shape preserved).

**Context**: Loud, typed, taxonomied block reasons are a Slice 8 load-bearing
requirement. Every block message must name the failed sub-phase + category + next
operator action. The enum is the source of truth; structured fields carry the human
prose.

**Rejected**:
- *Free-form string reasons.* Loses queryability for dashboard, loses Zod validation
  at write time.
- *More granular enum (every sub-phase × every failure mode).* Combinatorial; the
  sub-phase name lives in `BlockedDetails.needed` or a new `sub_phase` field on the
  block.

**Consequence**: Dashboard filters block reasons. Operator alerts can be templated
per reason. Future additions are explicit enum extensions.

### D7 — Routing predicate shape: pure function over `SessionResult`

**Choice**: A `RoutingRule.when` is `(sessionResult: SessionResult, ctx: SubPhaseContext) => boolean`. Common predicates exported from `src/core/orchestrator/registry/predicates.ts`: `isReady`, `needsMoreInfo`, `isError`, `isComplexity(level)`, `iterationLessThan(n)`, etc. Routes evaluated top-to-bottom; first match wins.

**Context**: Predicates as functions give arbitrary expressive power for the rare
edge case; the standard library of named predicates covers 90% with readable names.

**Rejected**:
- *Declarative match objects (`{ status: "ready" }`).* Less expressive; can't
  express `iteration < cap && quality_assessment === "needs_work"`.
- *Hand-rolled per-sub-phase route handlers.* Defeats the "data-driven" goal.

**Consequence**: Routes read cleanly in the phase definition modules. Predicates are
testable in isolation.

### D8 — Default `self_review` lens prompt: distill refactor-guide.md "earn its keep" + cut/keep lists; deeper structural principles stay in coding-standards

**Choice**: The `self_review` lens prompt (single default lens for Review) absorbs
from `refactor-guide.md`:
- The "does this earn its keep?" stance (framing the lens's primary question).
- The "fine-comb" discipline (read it cold / assess need / assess perfection /
  consider best practices).
- The cut-on-sight list (stale docstrings, YAGNI rationale, context-only comments,
  speculative future hooks, dense one-liners, escape-hatch types).
- The keep-on-sight list (wrapper for uniform wire shape, multiple suppress blocks
  for independent failures, load-bearing comments, marker classes).
- "Encode contracts in code, not comments" as a refactor heuristic.

The deeper structural principles (co-locate with source of truth, public first, mass
rename verification, required-vs-optional kwargs) are NOT in the lens prompt —
they're in `docs/coding-standards.md` as durable engineering doctrine, applied by
all phases.

**Context**: Lens prompts grow noisy fast. Keep the lens focused on the audit
behaviors and concrete patterns; leave the cross-cutting engineering principles in
the standards doc.

**Rejected**:
- *Port refactor-guide wholesale into lens.* 253-line prompt bloat for a single
  CLI call.
- *Don't port any of it.* Misses the most relevant audit checklists.

**Consequence**: `self_review` lens prompt is focused and operational. Coding-standards
absorbs the structural principles (Slice 8 implementation task in Session 8 or 9).

### D9 — Requirements `gather` "context summary" upfront

**Choice**: `gather` writes `## Context Summary` at the top of `requirements.md` as
the first artifact, BEFORE any questions or outreach. Format: 2-3 sentences echoing
what the task is and what the agent currently understands. Mirrors dev-toolbox's
Phase 1 Intake "summarize back" step, adapted for async (the summary lives in the
file, not in an interactive turn).

**Context**: Catches misunderstandings early. If the agent's context summary is
wrong, the operator notices at the FIRST artifact, not after questions get asked.

**Rejected**:
- *No upfront summary; jump to questions.* Misses the dev-toolbox principle entirely.
- *Defer to refinement phase.* Too late; questions may already be wrong.

**Consequence**: `gather` prompt instructions include "write `## Context Summary`
first." Template in the deliverable section reflects this.

### D10 — Expert-panel-review fate: keep as opt-in skill, no sub-phase promotion

**Choice**: Today expert-panel-review is injected as a skill into self_review's
prompt (via `SKILL_PHASE_MAP[Phases.self_review]`). New model: same — the skill
mapping is per sub-phase. `self_review` and `refinement` sub-phases inject
`expert-panel-review` skill. Not a sub-phase itself.

**Context**: A sub-phase implies its own session-result.json + routing. Expert
panel is best applied INLINE in the lens session (the lens reads the skill, applies
its perspective). Promoting to sub-phase is over-engineering for a tool that's a
prompt augmentation, not a routing-state-machine concern.

**Rejected**:
- *Promote to sub-phase.* Adds a CLI call + session-result roundtrip for what's
  effectively a prompt enhancement.
- *Cut from default skills.* Loses real value (expert-panel perspectives catch
  blind spots).

**Consequence**: `SKILL_PHASE_MAP` becomes `SKILL_SUB_PHASE_MAP` keyed by `(phase,
sub_phase)`. Default skills per sub-phase declared at registry construction.

### D11 — Test architecture: registry-iteration pattern + per-sub-phase unit tests

**Choice**: Tests adopt the registry as their source of truth:
- `phase-runner.test.ts`: iterates `Registry` instead of `PHASE_SEQUENCE`. Uses mock
  sub-phases (a `MockSubPhase` helper) to test runner behavior independently of real
  sub-phase logic. Hardcoded "exactly 7 phases" / "starts with X ends with Y"
  assertions deleted.
- Per-sub-phase tests under `tests/unit/core/orchestrator/phase-definitions/{phase}/{sub_phase}.test.ts`. Each tests its `buildPrompt` (snapshot-style) and its `routes`
  predicates (in isolation against synthetic `SessionResult` data).
- Integration tests (`tests/integration/`) verify the runner's iteration over the
  real registry produces the expected phase-and-sub-phase trace for canonical task
  scenarios (happy path, trivial-skip, review-loop-cap-hit, external-feedback-rework,
  approval→merge).

**Context**: Tests must adapt to registry changes without breaking; the prevention
of past pain points (tests breaking on phase shape changes) is a load-bearing
requirement.

**Rejected**:
- *Keep `PHASE_SEQUENCE` constant for backward compat.* Universal rule: no backward
  compat pre-v1. Tests import from the source of truth.
- *Snapshot tests on the whole pipeline.* Brittle to legitimate changes.

**Consequence**: Adding a sub-phase: add the module + add its unit test. No
phase-runner test changes. Removing a sub-phase: remove both. Tests are localized
to the sub-phase they cover.

### D12 — Auto-merge preserved, refactored against typed events (correction of slice file #23)

**Choice**: Today's `attemptMerge` + `approvedAwaitingCI` + `handlePostApprovalFailures`
behavior all preserved. Refactored to consume typed `PrEvent` from the new
`GitHostingAdapter.detectPrEvents` contract instead of polling raw review/PR
status. `pr_approved` event triggers an orchestrator-side sub-phase
`attempt_auto_merge` under Delivery. Conditions for actual merge attempt: CI passing
+ mergeable + `safetyLayer.checkAutoMergeAllowed(repo)`. Today's safety gate stays
(operator controls per-repo whether auto-merge is enabled).

**Context**: Q20 was reread during planning; the original lock was sloppy. Approval
is the trigger; The Engineer performs the merge; merge event is terminal. Cutting
auto-merge would degrade UX significantly — operator approves and then has to
manually merge too.

**Rejected**:
- *Cut auto-merge entirely.* Misreads Q20; degrades operator UX.
- *Auto-merge as a CLI sub-phase (LLM-driven merge).* The merge is a deterministic
  git operation, not an LLM judgment call. Orchestrator-side sub-phase is the right
  shape.

**Consequence**: Delivery gets a fifth sub-phase: `attempt_auto_merge` (orchestrator).
Triggered by `pr_approved` event routing (not the natural sub-phase advance).
SafetyLayer + merge config preserved.

### D13 — Skipped sub-phase observability shape

**Choice**: Every skip-gate firing produces:
- `observer.recordDecision("skip_gate", context, options, chosen, reasoning, confidence, opts)` — recorded in `IObservationStore` for dashboard query.
- A journal entry of type `phase_change` (or `decision` if we add the type back —
  see open finding below) with summary `"Skipped sub-phase {name} — {reason}"` and
  tags `["skip", phase, sub_phase]`.
- A task row state update: `phase` advances normally, `sub_phase` reflects "the next
  one that did run" (not the skipped one). Iteration counter unchanged.
- A span of type `decision_point` (existing `ObservationTypes` value) named
  `skip_gate` with structured input + outcome.

**Context**: Loud observability for every skip is a hard requirement (Farzam
emphasized 3+ times). Future skip-gates (post-trivial, post-pattern-detection)
inherit the same machinery uniformly.

**Rejected**:
- *Silent skip (no decision record).* Violates the observability requirement.
- *Just a log line, no journal entry.* Dashboard can't query log lines; journal is
  the audit trail.

**Consequence**: Skip-gates have a documented "what to emit" contract. Future skip
additions follow the same pattern. (`JournalEntryType` may need to re-add `decision`
if it was cut in Slice 7 — check during Session 1.)

### D14 — Slice 8 ships no dashboard UI; data layer only

**Choice**: Slice 8 lands the DATA — new task columns (`sub_phase`, `phase_iteration`),
new event types (`pr_approved`, `pr_merged`, etc.), new observation records (every
skip, every routing decision, every iteration). Dashboard data-layer endpoints
(REST/RPC routes that serve task state, observations, journal entries) update to
expose the new fields, but the DASHBOARD UI (React components, charts, filters,
visualizations) is fully deferred to Slice 13 (was 15).

**Context**: Slice 8 is already huge with 10 sessions. Bundling dashboard UI risks
crowding out architectural work. The data layer must land in Slice 8 because the
schema changes are inherent to the slice; the UI is pure visualization on top.

**Rejected**:
- *Slice 8 owns dashboard UI for its scope.* Crowds out core architectural work.
- *Slice 13 owns the data layer too.* Coupled — Slice 13 can't display data Slice 8
  hasn't shipped.

**Consequence**: Slice 13 (was 15) inherits a substantial dashboard work item.
Slice 8's Session 9 (project-wide docs sweep) explicitly excludes UI work.

---

## Scope Boundary

**Delivering**:

- Cut the `integration` phase entirely (enum, schema, prompt builder, dir, skill
  mapping, trace mapping, demo_prep routing branch, all references in src + docs).
- New 6-phase canonical pipeline: Requirements → Research → Planning → Execution →
  Review → Delivery.
- Sub-phase registry primitive (`src/core/orchestrator/registry/`) with declarative
  declarations per phase, generic runner over registry, typed routing rules.
- Per-sub-phase persistence: `sub_phase` + `phase_iteration` columns on `tasks`;
  `sub_phase` column on `checkpoints`.
- `Outcomes.review_pending` removed; `blocked(reason=pr_review_pending)` is the new
  mechanism. `TaskStates.review_pending` removed from state machine.
- Block reason taxonomy as an enum; descriptive structured details preserved.
- `retry-policy` module shrinks to single `agent_unavailable` category; `crash`
  category + `consecutive_crash_count` field cut; consumers refactored to block
  directly.
- `AgentAdapter.run(request)` accepts `request.signal: AbortSignal`; plugins pass
  to `spawn({ signal })`. Phase-runner threads `dispatch.signal` end-to-end. Self-unblock
  path also threads signal.
- Execution split: `implement` (CLI, agent commits logically during work) + `verify`
  (orchestrator: typecheck + lint + tests). Verify-failure loops with structured
  failure context.
- Delivery sub-phases: `pr_description` (CLI), `pr_push` (orchestrator),
  `pr_create` (orchestrator), `await_review` (orchestrator block),
  `attempt_auto_merge` (orchestrator, triggered by `pr_approved` event).
- `GitHostingAdapter.detectPrEvents` contract method + github-hosting plugin
  implementation. Five typed `PrEvent` variants.
- Typed routing from external events into the pipeline (per-event-type targets per
  D12 + slice file #8).
- Review-handler refactored against typed events. All existing capabilities
  preserved (accommodation gate, comment-based approval, authorized approver,
  circuit breaker, per-tick caching, self-comment filtering, branch deletion,
  thoughts-removal-before-merge, post-approval CI/conflict handling with cap=3).
- Trivial-skip generalized as a registry skip-gate; full observability per D13.
- Dev-toolbox skill refinements ported into sub-phase prompts (per port/adapt/skip
  table in research doc § 15). One prompt file per sub-phase, grouped under
  `prompts/{phase}/{sub_phase}.ts`.
- `thoughts/{task}/{phase}/{sub_phase}/output.md` + `session-result.json` per-CLI sub-phase
  layout. Symmetric with traces dir.
- `docs/constraints.md` adds "Sub-Phase Execution Order" (sequential v1).
- `docs/future-considerations.md` adds "Parallel Sub-Phase Execution".
- Project-wide docs sweep (Session 9): architecture docs, configuration docs, user-flow
  docs, plugin author guides, README, bundled CLI plugin docs, seed-example.
- Closing standards sweep (Session 10): line-by-line audit against coding-standards /
  anti-patterns / philosophy.

**Deferring**:

- Dashboard UI for the new pipeline shape → Slice 13 (was 15). Slice 8 ships data
  layer + endpoint exposure only.
- Workspace cleanup on completion → Slice 9 (was 11).
- Notification routing internals + response polling → Slice 10 (was 12).
- Background services internals (cost tracking deep, data lifecycle, health) →
  Slice 11 (was 13).
- npm SDK extraction → Slice 14 (was 16).
- Parallel sub-phase execution → future-considerations entry.

---

## Task Breakdown

Sessions sized to ~400k token cap each, focused. Each session ends with green
gates (typecheck + lint + tests + build) and a coherent commit. Consolidate where
it brings real value; separate where focus matters more.

### Session 1: Foundation cleanup

**Goal**: Cut the integration phase + collapse `review_pending` outcome + clean
decomposition residue from source + docs. Smallest blast-radius cleanup before the
architecture rebuild. Pipeline still runs at end of session, just with 6 phases and
no `review_pending` outcome.

**Where**:
- `src/schemas/orchestrator.ts` — remove `integration` from `PhaseSchema`,
  `PHASE_DIRECTORIES`, `PhaseOutputMap`. Delete `IntegrationOutputSchema` +
  `IntegrationOutput`.
- `src/schemas/task.ts` — remove `TaskStates.review_pending` from `TaskStateSchema`,
  `ValidTransitions`, `PermissionTable`. Add `BlockReasonSchema` enum.
  `BlockedDetails.reason` is `BlockReasonSchema` (was `z.string()`).
- `src/core/orchestrator/types.ts` — remove `integration` from `PHASE_SEQUENCE`.
  Remove `Outcomes.review_pending`. `ExecuteTaskResult` no longer has the
  `review_pending` variant.
- `src/core/orchestrator/prompts/integration.ts` — delete file.
- `src/core/orchestrator/prompts/index.ts` — remove `integration` re-exports.
- `src/core/orchestrator/prompts/demo-prep.ts` — remove "if this is a decomposed
  child task" routing instruction.
- `src/core/orchestrator/prompts/planning.ts` — remove decomposition instruction.
- `src/core/orchestrator/phase-handlers.ts` — remove `handleIntegration`.
- `src/core/orchestrator/phase-runner.ts` — remove integration handling.
- `src/core/orchestrator/agent-runner.ts` — remove `integration` entries from
  `PHASE_DIR_MAP`, `PHASE_TRACE_DIR_MAP`.
- `src/core/orchestrator/prompts/skills.ts` — remove `Phases.integration` from
  `SKILL_PHASE_MAP`.
- `src/core/daemon/review-handler.ts` — `getTasksByState(review_pending)` calls
  rewire to a new `getBlockedTasksByReason("pr_review_pending")` filter.
- `src/core/orchestrator/pr-manager.ts` — `tryCommitPushAndCreatePR` now exits
  with `blocked(pr_review_pending)` instead of `review_pending` outcome.
- `src/db/migrations/001_schema.sql` — rewrite (universal rule: consolidate
  migrations pre-v1). Drop `review_pending` from state CHECK constraint, drop
  `integration` from any phase-related CHECK, add `sub_phase` + `phase_iteration`
  columns to tasks (default null / 0), add `sub_phase` column to checkpoints
  (default null).
- `docs/configuration/orchestrator.md` — delete decomposition section. Verify every
  documented config key exists in `OrchestratorConfigSchema` / `DaemonConfigSchema`.
- `docs/configuration/workspace.md` — delete `child_pr_strategy` row.
- `docs/cli.md` — remove decomposition mention from orchestrator.yaml description.
- `docs/configuration/README.md` — same.
- `docs/usage-guide/writing-tickets.md` — remove "handles decomposition natively"
  claim.

**Approach**:
- Pull all integration deletions atomically (typecheck will fail until the chain is
  complete).
- `review_pending` removal goes through CHECK constraint update, ValidTransitions
  edits, PermissionTable edits, all `getTasksByState(review_pending)` rewires.
- Block reason enum lands as preparation for D6's full taxonomy in Session 4.
- Tests: delete `tests/unit/core/orchestrator/prompts/integration.test.ts`. Update
  `phase-runner.test.ts` — `exactly 7 phases` → `exactly 6 phases`, ends with
  `delivery` (Wait — `delivery` doesn't exist yet; this session keeps `demo_prep`
  as the last phase. The rename to `delivery` happens in Session 2-3 when the
  registry lands.). Adjust assertions accordingly.
- Decomposition doc residue: each doc file gets reviewed end-to-end; not just the
  decomposition section.
- "Delete `~/.engineer/data.db` before running this version" lands in the session log.

**Depends on**: Nothing.

**Verify**: `pnpm run typecheck && pnpm run lint && pnpm test:all && pnpm run build`
all green. `grep -r "integration\|review_pending\|decomposition" src/` returns only
intentional matches (docs/code comments referring to "git integration testing" or
similar non-pipeline meanings).

**Commit**: Use `/commit` after verification passes.

---

### Session 2: Sub-phase registry primitive

**Goal**: New `src/core/orchestrator/registry/` module with `PhaseDefinition`,
`SubPhase` (discriminated union), `RoutingRule`, predicates library, registry
aggregator. Generic phase-runner consumes the registry. Tested in isolation with a
mock registry. Real phase handlers don't migrate yet — they coexist.

**Where**:
- New: `src/core/orchestrator/registry/types.ts` — `PhaseDefinition`, `SubPhase`,
  `RoutingRule`, `RoutingTarget`, `SkipDecision`, `SubPhaseContext`,
  `SessionResultPredicate` types per D1.
- New: `src/core/orchestrator/registry/predicates.ts` — `isReady`,
  `needsMoreInfo`, `isError`, `isComplexity(level)`, `iterationLessThan(n)`,
  `iterationEquals(n)`, `qualityAssessment(value)`, etc.
- New: `src/core/orchestrator/registry/index.ts` — `Registry` aggregator (initially
  empty; later sessions add phase definitions).
- Modify: `src/core/orchestrator/phase-runner.ts` — new generic loop function
  `runRegistryPipeline(dispatch, state, deps, registry)` parallel to the existing
  `runPhasePipeline`. Existing `runPhasePipeline` stays for now; sessions 3-5
  migrate phases off it onto the new loop.
- New: `tests/unit/core/orchestrator/registry/types.test.ts` — type-level tests
  (the file compiles only if the types are coherent).
- New: `tests/unit/core/orchestrator/registry/predicates.test.ts` — each predicate
  tested against synthetic `SessionResult`.
- New: `tests/unit/core/orchestrator/registry/runner.test.ts` — phase-runner
  registry-driven tests using a `MockRegistry` helper (e.g., "runs sub-phases in
  order", "honors skip gates", "loops back intra-phase up to cap", "blocks on
  cap-hit").
- Modify: `src/schemas/orchestrator.ts` — `Phase` enum becomes 6 values
  (`requirements`, `research`, `planning`, `execution`, `review`, `delivery`).
  Rename `requirements_gathering` → `requirements`, `self_review` → `review`,
  `demo_prep` → `delivery`. Update all consumers. (Bulk rename across the codebase
  — large but mechanical.)

**Approach**:
- Build the registry types + predicates + aggregator + runner in isolation. No
  real phase migrations yet.
- The Phase enum rename is the trickiest part of this session — touches every
  consumer. Use grep to verify zero stale references.
- `MockRegistry` helper goes in `tests/helpers/test-mock-registry.ts`. Helps every
  downstream session's tests.
- Generic runner uses `IObservationStore.recordDecision` for every routing rule
  evaluated (per D13).

**Depends on**: Session 1.

**Verify**: `pnpm test` passes including the new registry tests. `pnpm run typecheck`
green. `grep -rn "requirements_gathering\|self_review\|demo_prep" src/` returns
zero matches. The two phase-runner entry points (`runPhasePipeline` legacy and
`runRegistryPipeline` new) both compile.

**Commit**: Use `/commit`.

---

### Session 3: Migrate Req/Research/Planning/Execution onto registry

**Goal**: Four phase definitions: `requirements` (with `gather` sub-phase),
`research` (with `investigate`), `planning` (with `design`), `execution` (with
`implement` + `verify`). All four phases run through `runRegistryPipeline` after
this session. Old `phase-handlers.ts` handlers for these phases deleted.
`runPhasePipeline` legacy stays only for `review` + `delivery` (until Sessions 4-5).

**Where**:
- New: `src/core/orchestrator/registry/requirements.ts` — `requirements`
  `PhaseDefinition` with `gather` sub-phase. Imports `buildGatherPrompt` from
  `prompts/requirements/gather.ts` (also new in this session). Routes: `isReady` →
  advance; `needsMoreInfo` → outreach + block.
- New: `src/core/orchestrator/registry/research.ts` — `research` with `investigate`.
  Routes: `isReady` → advance; `needsMoreInfo` → loopback inter to requirements
  (via `RoutingTarget.kind = "loopback_inter"` per D1).
- New: `src/core/orchestrator/registry/planning.ts` — `planning` with `design`.
  Routes: same pattern.
- New: `src/core/orchestrator/registry/execution.ts` — `execution` with
  `implement` (CLI) + `verify` (orchestrator). `verify` runs typecheck + lint + tests
  via `execFileSync` calls; failure routes loopback intra to `implement` with
  structured failure context.
- New: `src/core/orchestrator/prompts/requirements/gather.ts` — port from existing
  `requirements-gathering.ts`; add `## Context Summary` per D9; batched outreach
  per slice file #15.
- New: `src/core/orchestrator/prompts/research/investigate.ts` — port from
  existing `research.ts`. Dev-toolbox principles ported in Session 8.
- New: `src/core/orchestrator/prompts/planning/design.ts` — port from existing
  `planning.ts`.
- New: `src/core/orchestrator/prompts/execution/implement.ts` — port from existing
  `execution.ts`, adapted for "do logical commits during work" + "no need to
  commit everything at the end" (`pr_push` will).
- Modify: `src/core/orchestrator/registry/index.ts` — register the four definitions.
- Modify: `src/core/orchestrator/phase-handlers.ts` — delete the four migrated handler
  functions.
- Delete: `src/core/orchestrator/prompts/requirements-gathering.ts`,
  `research.ts`, `planning.ts`, `execution.ts` (top-level prompt files for these
  phases). Move tests to per-sub-phase test files.
- Modify: `src/core/orchestrator/prompts/index.ts` — update re-exports.
- New per-sub-phase tests: `tests/unit/core/orchestrator/phase-definitions/{phase}/{sub_phase}.test.ts`
  for each migrated sub-phase. Snapshot-style assertions on `buildPrompt`.
- Modify: `src/core/orchestrator/index.ts` (Orchestrator class) — `runPhasePipeline`
  call becomes `runRegistryPipeline(..., registry)`. (Still falls through to legacy
  for `review` + `delivery` until Sessions 4-5.)

**Approach**:
- Adapt prompt content during migration — don't just port verbatim. Apply the
  batched-outreach rule for `gather`, the context-summary upfront for `gather`, etc.
- Trivial-skip generalizes here: `research.investigate.skipGate` checks complexity
  from prior requirements output. Same shape used in Session 4 for review lens
  skip-gates.
- `execution.verify` runs gates via `execFileSync` with `signal` parameter (D5's
  signal threading lands in Session 6 — for now `verify` uses no signal).
- Tests: per-sub-phase prompt tests for all four; integration test for "trivial task
  skips research".

**Depends on**: Session 2.

**Verify**: `pnpm test:all` green. End-to-end task run (via integration test) goes
through requirements → research → planning → execution under the new registry.
Review + delivery still run under legacy runPhasePipeline (will migrate next).

**Commit**: Use `/commit`.

---

### Session 4: Review phase onto registry

**Goal**: `review` `PhaseDefinition` with `self_review` (CLI lens) + `refinement`
(CLI consolidator) sub-phases. Optional config-enabled sub-phases: `security_review`,
`code_quality`, `architecture_review`. Intra-phase loop in refinement capped at 3
with refinement-declared escape route (Planning / Requirements / Block). Sub-phase
order driven by config (`rrpir.review_phases`). `handleSelfReview` deleted.

**Where**:
- New: `src/core/orchestrator/registry/review.ts` — `review` `PhaseDefinition`.
  `subPhases` array built dynamically from config: always `self_review` + optional
  lenses (`enabledBy: config => config.rrpir.review_phases.includes(name)`) +
  `refinement`. Routes on refinement: advance to delivery if clean; loopback intra
  to first lens if iteration < cap and reassessment needed; loopback inter to
  Planning / Requirements if refinement declares; block on cap-hit.
- New: `src/core/orchestrator/prompts/review/self_review.ts` — default broad lens
  prompt, distilled from refactor-guide.md per D8.
- New: `src/core/orchestrator/prompts/review/refinement.ts` — consolidator prompt.
- New: `src/core/orchestrator/prompts/review/security_review.ts` — opt-in lens.
- New: `src/core/orchestrator/prompts/review/code_quality.ts` — opt-in lens.
- New: `src/core/orchestrator/prompts/review/architecture_review.ts` — opt-in lens.
- Modify: `src/schemas/config.ts` — `RrpirConfigSchema.review_phases` default
  changes from `["requirements_check"]` to `["self_review"]`. Optional lenses
  enumerable.
- Modify: `src/core/orchestrator/registry/index.ts` — register review.
- Modify: `src/core/orchestrator/phase-handlers.ts` — delete `handleSelfReview`.
- Delete: `src/core/orchestrator/prompts/review.ts` (top-level).
- New per-sub-phase tests.
- Modify: `src/core/orchestrator/index.ts` — Orchestrator class routes review
  through registry.

**Approach**:
- Per-lens prompt content adapted from today's lens definitions in `review.ts`
  (`REVIEW_LENS` const). Each lens becomes its own file with its own prompt builder.
- Refinement consolidator absorbs the existing "fix every actionable issue" stance
  from today's prompt. Adds the "if Review can't fix it, declare escape route"
  language.
- Iteration cap (3) enforced at the routing level (`iterationLessThan(3)` predicate).
  Cap-hit route: `block(reason: review_iteration_cap_hit, message: descriptive)`.
- Tests: snapshot tests per lens prompt; integration tests for "loop intra up to cap
  → block", "refinement declares escape → routes to Planning", "ship_it → advance to
  delivery".

**Depends on**: Session 3.

**Verify**: `pnpm test:all` green. End-to-end task run goes through Req → Research →
Planning → Execution → Review (with iteration loop) → Delivery (still legacy)
under registry.

**Commit**: Use `/commit`.

---

### Session 5: Delivery sub-phases

**Goal**: `delivery` `PhaseDefinition` with `pr_description` (CLI) + `pr_push`
(orchestrator) + `pr_create` (orchestrator) + `await_review` (orchestrator block) +
`attempt_auto_merge` (orchestrator, triggered by external event). `handleDemoPrep`
deleted. `tryCommitPushAndCreatePR` decomposed into the sub-phase handlers.
PrManager's `commitAndPush` + `createPullRequest` consumed by sub-phase handlers.

**Where**:
- New: `src/core/orchestrator/registry/delivery.ts` — `delivery` `PhaseDefinition`.
  Sub-phases: `pr_description` → `pr_push` → `pr_create` → `await_review` (blocks)
  → `attempt_auto_merge` (orchestrator, triggered by `pr_approved` event routing in
  Session 7's review-handler).
- New: `src/core/orchestrator/prompts/delivery/pr_description.ts` — agent writes
  PR write-up.
- Modify: `src/core/orchestrator/pr-manager.ts` — refactor `commitAndPush` and
  `createPullRequest` to be invoked directly from sub-phase handlers (no more
  `tryCommitPushAndCreatePR` wrapper). `removeThoughtsAndPush` stays as-is.
- Modify: `src/core/orchestrator/phase-runner.ts` — remove
  `tryCommitPushAndCreatePR`, `blockForPrWorkflowError` (the latter becomes a
  shared helper used by sub-phase handlers for blocking on git/hosting failures).
- Modify: `src/core/orchestrator/registry/index.ts` — register delivery.
- Delete: `src/core/orchestrator/prompts/demo-prep.ts`.
- Delete: `src/core/orchestrator/phase-handlers.ts` (now empty).
- New per-sub-phase tests.
- Modify: `src/core/orchestrator/index.ts` — Orchestrator class removes the old
  `phaseHandlers` field.

**Approach**:
- `pr_push` sub-phase wraps the existing `pr-manager.commitAndPush` behavior. Block
  on failure with `sub_phase_failure_pr_push` reason.
- `pr_create` wraps `createPullRequest` similarly. Block on failure.
- `await_review` is a pure orchestrator sub-phase that transitions task to
  `blocked(reason=pr_review_pending)` and exits the pipeline. Returns a sentinel
  `SubPhaseResult` for "exit pipeline, task blocked" — phase-runner recognizes and
  exits cleanly with `Outcomes.blocked`.
- `attempt_auto_merge` is registered but not normally reachable via natural advance
  — it's triggered by review-handler routing on `pr_approved` events (which lands
  in Session 7). For now (Session 5), it exists in the registry but isn't wired.
- Tests: per-sub-phase tests, integration test for "happy path: req → research →
  planning → execution → review → pr_description → pr_push → pr_create → blocked".

**Depends on**: Session 4. `runPhasePipeline` legacy is now fully unused — delete it
in this session, leaving only `runRegistryPipeline`.

**Verify**: `pnpm test:all` green. End-to-end task run goes the full pipeline under
the registry. Legacy runner deleted; no references remain.

**Commit**: Use `/commit`.

---

### Session 6: AgentAdapter signal threading + retry-policy shrink

**Goal**: `AgentRunRequest.signal` plumbed end-to-end. All 3 agent plugins honor
`signal.aborted` via Node's native `spawn({ signal })`. Phase-runner threads
`dispatch.signal` through every agent call. Self-unblock path also signal-aware.
`retry-policy` module shrinks to single `agent_unavailable` category. `crash`
category + `consecutive_crash_count` column cut. Crash-style failures route to
block directly via `BlockReason.sub_phase_failure`.

**Where**:
- Modify: `src/schemas/adapters.ts` — `AgentRunRequestSchema` gains
  `signal: z.instanceof(AbortSignal)` (or runtime extension pattern matching
  `Dispatch.signal`'s "outside Zod" approach — likely the latter; the schema stays
  serializable, `AgentRunRequest` runtime type extends with `signal`).
- Modify: `src/adapters/agent.ts` — `AgentAdapter.run` / `doRun` accept signal.
- Modify: `src/plugins/agent/claude-code-agent/claude-code-agent.ts` — pass
  `request.signal` to `spawn(cmd, args, { signal: request.signal })`.
- Modify: `src/plugins/agent/gemini-cli-agent/gemini-cli-agent.ts` — same.
- Modify: `src/plugins/agent/opencode-agent/opencode-agent.ts` — same.
- Modify: `src/core/orchestrator/agent-runner.ts` — accept signal from caller,
  pass to `agent.run({ ..., signal })`.
- Modify: `src/core/orchestrator/phase-runner.ts` — pass `dispatch.signal` to every
  `agent-runner.runPhaseWithCli` call.
- Modify: `src/core/orchestrator/index.ts` — self-unblock path threads signal.
- Modify: `src/core/retry-policy/index.ts` — `RetryCategory` becomes `"agent_unavailable"`
  only. `COUNTER_FIELDS` loses `crash` entry. `TERMINAL_STATES` loses `crash` entry.
- Modify: `src/schemas/config.ts` — `retry_policy.crash` removed from config schema.
- Modify: `src/schemas/task.ts` — `consecutive_crash_count` field removed from Task.
- Modify: `src/core/daemon/task-scheduler.ts` — boot recovery uses
  `taskEngine.requestTransition(..., TaskStates.blocked, ..., { reason: "sub_phase_failure", ... })` instead of `retryPolicy.recordFailure("crash", taskId)`.
- Modify: `src/core/orchestrator/phase-runner.ts` — `handlePhaseError` blocks directly
  with the failed sub-phase name in `BlockedDetails.needed`.
- Modify: `src/db/migrations/001_schema.sql` — drop `consecutive_crash_count` column.
- Tests: agent plugin tests for signal honoring (mock spawn behavior). Retry-policy
  tests trim to agent_unavailable only. Integration test for "preempted task aborts
  in-flight agent CLI call".

**Approach**:
- Signal threading: a non-Zod runtime extension on `AgentRunRequest` (`AgentRunRequestPayload & { signal: AbortSignal }`) mirroring `Dispatch.signal` pattern. Plugin's `doRun` reads `request.signal` and passes to spawn.
- Node 16+'s `spawn({ signal })` handles abort: SIGTERM to child + promise rejection.
- `crash` category cut is a wide blast radius — every consumer rewires to block-directly.
- Migration: pre-v1, just drop the column.

**Depends on**: Session 5.

**Verify**: `pnpm test:all` green. Integration test verifies a preempted task's
in-flight agent CLI call gets SIGTERM'd. `grep "crash" src/core/retry-policy/` returns
zero matches. `grep "consecutive_crash_count" src/` returns zero matches.

**Commit**: Use `/commit`.

---

### Session 7: GitHostingAdapter typed events + review-handler refactor + auto-merge sub-phase

**Goal**: `GitHostingAdapter.detectPrEvents(repo, prNumber, accommodated): Promise<PrEvent[]>` contract method. github-hosting plugin implementation aggregates today's polling logic into typed events. Review-handler refactored to consume typed events instead of polling raw status. Typed routing from external events into the pipeline (per slice file #8 + D12). `attempt_auto_merge` sub-phase wired and triggered by `pr_approved` routing.

**Where**:
- New: `src/schemas/git-hosting-events.ts` — `PrEvent` discriminated union (5
  variants per D5), `PrComment`, `PrCheck` schemas.
- Modify: `src/adapters/git-hosting.ts` — `GitHostingAdapter` gains
  `detectPrEvents(repo, prNumber, accommodated): Promise<PrEvent[]>` abstract method.
  `wrapAsync` wrapper for the new method.
- Modify: `src/plugins/git-hosting/github-hosting/github-hosting.ts` — implement
  `doDetectPrEvents`. Internally calls existing polling methods (`getReviewStatus`,
  `getPRStatus`, `getPRComments`) and aggregates into typed events. Today's
  `deriveAggregateReviewState`, `detectCommentApproval`, `evaluatePostApprovalChecks`
  logic moves here (becomes plugin-internal).
- Modify: `src/core/daemon/review-handler.ts` — major refactor:
  - Replace `checkMerges` + `checkFeedback` + `checkApprovedCI` with a single
    `pollForEvents(reviewBlockedTasks?)` that calls `hosting.detectPrEvents` per
    blocked task and routes each event through the new typed routing.
  - Event routing: `pr_comments` → re-queue + add unapplied feedback round with
    structured context → registry routes to Requirements; `pr_ci_failure` →
    re-queue + structured context → Execution; `pr_merge_conflict` → same →
    Execution; `pr_approved` → trigger `attempt_auto_merge` sub-phase (via
    registry-aware orchestrator method); `pr_merged` → terminal complete.
  - Preserved: accommodation gate, comment-based approval (now surfaces inside the
    plugin's event detection), authorized approver check, circuit breaker,
    per-tick caching, self-comment filtering, branch deletion on completion,
    thoughts-removal-before-merge, `MAX_POST_APPROVAL_FIX_RETRIES = 3`.
- New: `src/core/orchestrator/registry/delivery.ts` — wire `attempt_auto_merge` as
  an orchestrator sub-phase. Triggered by external `pr_approved` routing (not
  natural sub-phase advance). Calls `hosting.mergePR` after CI + mergeable gates.
- Modify: `src/core/orchestrator/index.ts` — Orchestrator exposes a method
  `applyExternalEvent(taskId, event: PrEvent)` that review-handler calls to drive
  typed routing.
- Tests: per-event-type integration tests for the full external-event-to-pipeline-state
  flow. Plugin test for `doDetectPrEvents`. Refactored review-handler tests.

**Approach**:
- This is the densest session. Review-handler is 996 lines today. Refactor in
  surgical passes; each commit green.
- Approach: (1) Implement plugin-side `doDetectPrEvents` (today's logic, relocated).
  (2) Add the contract method to the adapter. (3) Refactor review-handler step by step:
  merge detection → feedback detection → CI handling → auto-merge attempt.
  (4) Wire `attempt_auto_merge` sub-phase.
- Auto-merge preserved per D12: `safetyLayer.checkAutoMergeAllowed` gate, CI gate,
  mergeable gate, `approvedAwaitingCI` deferred-merge pattern all preserved as
  internal logic in the new sub-phase + review-handler.

**Depends on**: Session 6.

**Verify**: `pnpm test:all` green. Integration tests cover all 5 event types
end-to-end. Auto-merge integration test confirms today's behavior preserved (with
new typed-event plumbing).

**Commit**: Use `/commit`.

---

### Session 8: Dev-toolbox skill principles ported into prompts

**Goal**: Each sub-phase prompt absorbs the relevant dev-toolbox principles per
the port/adapt/skip table in research doc § 15. Concrete prompt diffs across all
sub-phase prompt files. Coding-standards absorbs the structural principles from
refactor-guide.md not captured by the self_review lens.

**Where**:
- Modify: `src/core/orchestrator/prompts/requirements/gather.ts` — context summary
  upfront (D9); principles of depth (recursive decomposition, exhaustive enumeration,
  state transitions, boundary probing, cross-cutting concerns, "what happens next",
  interaction mapping) folded in; anti-patterns list; "walk through 2-3 concrete
  scenarios"; outreach batched per contact (already locked).
- Modify: `src/core/orchestrator/prompts/research/investigate.ts` — observations
  vs inferences split; "read upstream artifacts FIRST"; cross-cutting concerns hunt
  ("what areas marked out-of-scope, is that true?"); "every change has a blast
  radius"; "assume something is always missed"; "read before you claim"; doc template
  gets `## What I Found` (observations) and `## What It Means` (inferences) split.
- Modify: `src/core/orchestrator/prompts/planning/design.ts` — last-line-of-defense
  ownership framing; Decision template `Choice / Context / Rejected / Consequence`;
  "decisions over descriptions"; "no open questions ship"; cross-reference requirements
  vs research; existing pre-mortem section strengthened.
- Modify: `src/core/orchestrator/prompts/execution/implement.ts` — already split
  into implement + verify in Session 3; this session refines the implement prompt
  with refactor-guide's "iterate small, run lint, run tests after each edit" rhythm.
- Modify: `src/core/orchestrator/prompts/review/self_review.ts` — refactor-guide's
  "does this earn its keep?" framing; fine-comb discipline; cut-on-sight + keep-on-sight
  lists (per D8).
- Modify: `src/core/orchestrator/prompts/review/refinement.ts` — strengthen the
  "fix what you find" + "simplicity audit" + "review what ships" steps with
  refactor-guide framing.
- Modify: `docs/coding-standards.md` — add sections absorbing refactor-guide's
  structural principles (co-locate with source of truth, public first, mass rename
  verification, required-vs-optional kwargs).
- Tests: prompt snapshot tests update.

**Approach**:
- Per-sub-phase: one prompt file at a time, sweep the port/adapt/skip table per
  research doc § 15, apply the diffs.
- Coding-standards additions: phrased as durable engineering doctrine (not
  refactor-guide-specific language); they apply across all phases.

**Depends on**: Session 7.

**Verify**: `pnpm test:all` green (prompt snapshot tests updated). Lint clean.

**Commit**: Use `/commit`.

---

### Session 9: Project-wide docs sweep

**Goal**: Every doc file in `docs/` reviewed end-to-end for accuracy against the
new pipeline shape. Architecture docs reshaped. Configuration docs verified
key-by-key against schemas. User-flow docs updated. Plugin author guides reflect
new contract additions. README updated. Bundled CLI plugin docs synced.
Seed-example aligned.

**Where**:
- `docs/architecture/overview.md` — pipeline section rewritten; new 6-phase shape;
  sub-phase registry concept introduced.
- `docs/architecture/three-tier-model.md` — touch as needed (likely minimal —
  three-tier model is plugin-shaped, not phase-shaped).
- New (potential): `docs/architecture/pipeline.md` — dedicated pipeline reference
  if overview's section grows too large.
- `docs/configuration/orchestrator.md` — `rrpir` block reshape; `review_phases`
  default lens; every claimed config key verified against `OrchestratorConfigSchema`.
- `docs/configuration/daemon.md` — `retry_policy` section reflects single
  `agent_unavailable` category.
- `docs/configuration/workspace.md` — already cleaned in Session 1; verify.
- `docs/configuration/README.md` — orchestrator.yaml description updated.
- `docs/cli.md` — `engineer retry` semantics updated to "unblock-and-resume";
  decomposition mention deleted; `--home` flag references current.
- `docs/usage-guide/writing-tickets.md` — decomposition claim deleted; "what
  happens when you submit a ticket" walked through new 6-phase flow.
- `docs/plugins/README.md` — agent adapter and git-hosting adapter contract
  signatures updated.
- `docs/plugins/agent/README.md` — agent contract with `signal` parameter
  documented.
- `docs/plugins/git-hosting/README.md` — `detectPrEvents` contract documented.
- `docs/plugins/git-hosting/github-hosting.md` — plugin's event-detection
  behavior documented.
- `docs/contribution-docs/` — agent-executable how-tos for adding plugins reflect
  new contracts.
- `docs/future-considerations.md` — adds "Parallel Sub-Phase Execution".
- `docs/constraints.md` — adds "Sub-Phase Execution Order" (sequential v1).
- `docs/philosophy.md` — touch as needed (likely zero changes — philosophy is
  shape-agnostic).
- `README.md` — any mention of "7 phases" or "RRPIR acronym" updated to new shape.
  Pipeline mention in "How it works" section refreshed.
- `AGENT-README.md` — verify still accurate (agent guide is shape-agnostic, but
  confirm no stale phase references).
- `src/cli/bundled/plugin-docs.ts` — synced with `docs/plugins/`.
- `src/cli/bundled/templates.ts` — `orchestrator.yaml` template reflects new
  config shape.
- `seed-example/` — yaml files updated to match new shape.
- CHANGELOG.md — preview-tag entry for Slice 8.

**Approach**:
- Sweep one doc file at a time. For each: read top-to-bottom; verify every claim
  against current code; rewrite as needed.
- Configuration docs: grep every claimed config key against the Zod schemas — fail
  loud on any divergence.
- README + AGENT-README receive light touch (mostly shape-agnostic).
- Dashboard UI not in scope (deferred to Slice 13). But data-layer endpoint
  documentation IS in scope.

**Depends on**: Sessions 1-8.

**Verify**: For each documented config key, grep the schema and find a match. For
each documented adapter method, grep the adapter contract and find a match.
Cross-reference doc claims against code reality. `pnpm test:all` still green.

**Commit**: Use `/commit`.

---

### Session 10: Closing standards sweep

**Goal**: Line-by-line audit of every file the slice created or changed against
`docs/coding-standards.md`, `docs/anti-patterns.md`, `docs/philosophy.md`, and the
principle-driven checks in `approach.md` § "Closing Standards Sweep". Two-pass
discipline (per Slice 7 Session 36 lesson). May spill into Session 11 if surface
demands.

**Where**:
- Every file touched in Sessions 1-9 (`git diff <slice-start>..HEAD --name-only`).

**Approach**:
- First pass: read every changed file end-to-end against the standards.
- Second pass: apply each principle-driven check deliberately:
  - Every documented reference must match the code as it is now.
  - Every plugin manifest must match the implementation's behavior.
  - Every swallowed error must be logged.
  - `manifest` is read-only to the plugin.
  - Every constant value lives in one place.
  - No stale counts in docs.
  - No vestigial scaffolding.
- Update memory (`feedback_slice_closing_standards_sweep.md`) if a new class of
  defect surfaces.
- Commits batched by area (schemas → core → plugins → cli → tests → docs).

**Depends on**: Sessions 1-9.

**Verify**: All gates green; coding-standards full audit complete.

**Commit**: Per-batch commits via `/commit`.

---

## Verification Contract

| Check | Type | Command or Observation |
|---|---|---|
| Type check clean | Auto | `pnpm run typecheck` returns 0 |
| Lint clean | Auto | `pnpm run lint` returns 0; no new warnings |
| Unit tests pass | Auto | `pnpm test` returns 0 |
| Integration tests pass | Auto | `pnpm test:integration` returns 0 |
| E2E tests pass | Auto | `pnpm test:e2e` returns 0 |
| Build clean | Auto | `pnpm run build` returns 0 |
| Phase enum has 6 values | Manual grep | `grep "PhaseSchema" src/schemas/orchestrator.ts` shows 6 values, no `integration` |
| `TaskStates.review_pending` removed | Manual grep | `grep "review_pending" src/ tests/` returns only the `pr_review_pending` block-reason matches |
| Signal honored end-to-end | Integration | Test "preempted task aborts in-flight agent CLI call" passes |
| Retry-policy single category | Manual grep | `grep '"crash"\\|consecutive_crash_count' src/` returns zero matches |
| Sub-phase registry generic runner | Code review | `phase-runner.ts` has no phase-specific or sub-phase-specific if-chains |
| Trivial-skip generalized | Integration | Skip-gate observability shows decision_point + journal entry + dashboard state |
| Auto-merge preserved | Integration | Approval → CI gated → mergeable gated → `hosting.mergePR` called |
| Typed event routing | Integration | Each of 5 event types routes to correct destination per slice file #8 |
| Block reason taxonomy | Code review | `BlockReasonSchema` enum; every block call site uses a typed reason |
| Outreach batched | Manual | `gather` outreach writes one file per contact with all questions in it |
| Project-wide docs updated | Manual | Every config key in `docs/` exists in the schemas; no stale 7-phase mentions |
| Closing sweep complete | Manual | Every file touched audited line-by-line; commits batched |

---

## Risks

| Risk | If It Happens | Mitigation |
|---|---|---|
| Registry refactor breaks tests in non-obvious ways | Hours of test rewrites mid-session | Session 2 lands `MockRegistry` helper FIRST; subsequent sessions consume it. Per-sub-phase tests are localized so regressions don't cascade. |
| Review-handler refactor regresses auto-merge / accommodation gate / dedup | Operator-visible bug post-deploy | Session 7 builds incrementally; each refactor pass has a focused integration test. Today's existing tests stay green during the refactor (they're not deleted until the new equivalent passes). |
| `crash` category cut breaks crash recovery on real failure | Daemon won't pick up tasks after restart | Session 6 includes an integration test "crashed task on boot routes to blocked with reason"; manual test on a dev daemon before merging. |
| Phase enum rename misses a stale reference | Build breaks in prod with `Unknown phase "demo_prep"` | Session 2's verify step includes `grep -rn "requirements_gathering\\|self_review\\|demo_prep" src/` returning zero. Verified mechanically. |
| Doc sweep misses a claimed config key | Operators read stale docs | Session 9's verify step: for every documented key, grep the Zod schema. Automated check possible (script). |
| Signal threading misses an agent plugin | Termination silently best-effort for that plugin | Session 6 tests every agent plugin's spawn invocation; integration test asserts SIGTERM on abort for each. |
| Closing sweep finds structural defect requiring re-design | Slice can't close in 10 sessions | Session 10 spills into 11. Process supports it. Two-pass discipline catches structural issues. |
| Auto-merge integration with `attempt_auto_merge` sub-phase has subtle differences from today's `attemptMerge` | Auto-merge regresses (delayed merge, lost retry, dropped notification) | Session 7 integration tests cover the full happy-path (approval → CI pass → merge → complete) AND failure paths (approval → CI fail → re-queue, approval → conflict → re-queue, approval → CI pending → defer). |

---

## Pre-mortem

*"Imagine this plan shipped and failed. What was the most likely cause?"*

**Scenario 1: Tests-vs-architecture mismatch resurfaces.**
The registry was supposed to make tests resilient to phase shape changes. But
because tests still snapshot prompts heavily (each lens, each sub-phase has its own
snapshot), the act of porting dev-toolbox principles into prompts (Session 8)
breaks every snapshot test in one session. Half a session is spent regenerating
snapshots, and the snapshot churn buries real semantic regressions.

*Mitigation*: Session 8's snapshots regenerate with explicit review of each diff.
Use git-add-patch to stage snapshot updates one prompt at a time; any "huh, this
changed" diff is investigated, not blindly accepted. Add a "no snapshot drift
without semantic review" item to the closing sweep checklist.

**Scenario 2: Review-handler's accommodation gate regresses, causing duplicate
feedback rounds on the same comments.**
The 996-line refactor in Session 7 is dense. The accommodation gate logic
(`hasUnaccommodatedFeedback`, `accommodated_comment_ids`, `accommodated_review_state`)
is delicate — easy to lose a nuance during the typed-event refactor. After deploy,
a PR with a comment + an approval triggers two feedback rounds instead of one,
each kicking off a rework cycle.

*Mitigation*: Session 7 starts by writing a unit test that captures today's
accommodation-gate behavior (against the existing implementation), then refactors
the handler to keep that test green. The test is the contract; the refactor moves
the implementation. Plus integration test: same-comment-twice doesn't double-rework.

**Scenario 3: Auto-merge sub-phase `attempt_auto_merge` is registered but never
triggered because the `pr_approved` routing wiring missed a hookup.**
The new typed-event routing requires the review-handler to call
`orchestrator.applyExternalEvent(taskId, event)` to drive routing into the registry.
If review-handler still routes `pr_approved` through the old "transition to active +
let pipeline resume" pattern instead of triggering the auto-merge sub-phase,
auto-merge silently doesn't happen. Operators approve PRs and nothing merges; they
discover by reading dashboards.

*Mitigation*: Session 7 integration test "approval triggers auto-merge attempt"
exercises the full flow. The wiring goes review-handler → orchestrator method →
registry → sub-phase. Test asserts `hosting.mergePR` is called (mocked) after an
`pr_approved` event. Also: dashboard data layer (Session 9) exposes "was
attempt_auto_merge ever invoked for this task?" so the absence is observable.

---

## Panel Review

**Panelists**: To be run via `/expert-panel-review`. Status: PENDING.

**Incorporated**: TBD after panel runs.

**Declined**: TBD with reasoning.

---

## References

- Requirements (durable home): `docs/archived/implementation-docs/9-oss-ready/slices/08-pipeline-phases.md`
- Research: `.claude/temp/research/slice-08-pipeline-phases.md`
- Session 38 log (RRPIR session): `docs/archived/implementation-docs/9-oss-ready/sessions/38.md`
- Active state: `docs/archived/implementation-docs/9-oss-ready/active.md`
- Approach: `docs/archived/implementation-docs/9-oss-ready/approach.md`
- Dev-toolbox skills: `~/Documents/Repos/dev-toolbox/ai/claude-code/skills/rrpir/`
- Refactor guide: `~/Documents/Repos/dev-toolbox/ai/coding-standards/refactor-guide.md`
