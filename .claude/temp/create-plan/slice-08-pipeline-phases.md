# Plan — Slice 8: Pipeline Phases

**Date**: 2026-05-27 | **Stakes**: Full
**Upstream**: `.claude/temp/research/slice-08-pipeline-phases.md` | `docs/archived/implementation-docs/9-oss-ready/slices/08-pipeline-phases.md`
**Status**: Panel-Reviewed (3 panelists, Session 39) → revised → Approved

This plan is the decision record and session sequencing for Slice 8. The full design
narrative (the *why*, written for the eventual docs slice) lives in the slice file;
this plan holds the locked decisions, the sequenced task breakdown, the verification
contract, the risk register, the panel-review outcome, and the pre-mortem. Read the
slice file first.

## Intent

Rebuild the per-task pipeline as a 6-phase, data-driven sub-phase architecture that is
above all **intuitive to evolve and maintain** — folders are phases, files are
sub-phases, each file owns its work and its next step, routing is a plain function, and
the one dangerous boundary (the opaque agent subprocess) is concentrated in a single
defended module. Absorb the original Slices 9 (Demo & PR) and 10 (Review & Feedback
External) so the tightly-coupled pipeline/delivery/feedback surface lands as one
coherent unit. The reshape was stress-tested by a three-person expert panel (Torvalds,
Pike, Technical Architect) whose convergent findings reshaped the original draft —
their input is recorded under Panel Review.

## Decisions

### D1 — Routing is a per-sub-phase `next()` function, not a declarative rule engine
**Choice**: Each sub-phase is `{ name, skip?, run, next }`. `next(result, ctx): Route`
is an ordinary function returning a 5-variant `Route` union (advance / repeat / jump /
block / done). No predicate library, no `RoutingRule[]`, no first-match-wins ordering.
**Context**: All three panelists independently flagged the earlier `RoutingRule[]` +
predicate-DSL draft as "a small programming language" — more to learn than the if-chain
it replaced, invisible in a stack trace. The evolvability goal is served by a function
per phase: modular (own files) *and* linear (reads top to bottom).
**Rejected**:
- *Declarative `RoutingRule[]` with predicate functions*: a rules engine; the predicate
  closures make it code-in-config-costume with no stack trace.
- *One central routing function for all phases*: re-creates today's 280-line
  `handlePostPhaseActions` monster.
**Consequence**: `runner.ts` is generic and never edited to add a sub-phase. Routing
logic is co-located with each phase. Every `next` is a pure function, unit-tested with
synthetic results.

### D2 — The handoff: agent reports an outcome; the orchestrator owns the route
**Choice**: `session-result.json` is `{ status: "ok" | "needs_human" | "failed",
summary, details? }`. The agent never names a phase. Each sub-phase's `next` maps the
outcome to a destination. Only `refine` needs more; it puts a typed `verdict` in
`details`, validated by a per-sub-phase `detailsSchema` in `cli-run`.
**Context**: Today the agent picks `next_phase` from a 7-value enum and the code
reverse-engineers intent by string-matching it (the panel's #1-severity and an
independent second finding). Overloading the destination to smuggle intent is the
fragility. Separating "what happened" (agent) from "where to go" (our code) is the
project's "Orchestrate, don't build" applied to the handoff.
**Rejected**:
- *Keep the 7-value `next_phase` enum from the agent*: lets the agent mis-route (e.g.
  to a dead phase) and forces intent-by-string-match.
- *A wide polymorphic result schema per sub-phase*: `details` + per-sub-phase Zod
  validation gives the richness locally without a wide common contract.
**Consequence**: Smaller agent job (3 outcomes), an entire mis-route bug class gone,
routing greppable and testable. We never route a lie because `verify` and `review`
independently re-check upstream claims.

### D3 — `cli-run` is the single defended boundary
**Choice**: A `cliRun({ prompt, skills, detailsSchema })` helper builds the `run` for
every CLI sub-phase and owns: spawn-via-adapter (passing the signal), retry/backoff,
trace write, hard validation of `session-result.json` (stale-template / malformed →
`failed`), partial-write recovery after SIGTERM, and `details` Zod validation.
Orchestrator sub-phases skip it (their `run` is a plain async fn).
**Context**: The real risk is the opaque-subprocess boundary, not the orchestration
bookkeeping. Concentrate it in one tested module ("dumb routing, smart boundary").
**Rejected**:
- *Per-sub-phase spawn/parse logic*: scatters the risky code across many files (today's
  smell).
**Consequence**: One heavily-tested module carries the danger; routing stays trivial.

### D4 — Two loop counters with a clean lifecycle, both on the checkpoint
**Choice**: `phase_iteration` (intra-phase `repeat`, resets on phase entry, small
per-phase cap; Review = 3) and `total_reworks` (inter-phase backward `jump`s within one
dispatch, one generous global backstop). Both persist on the task row *and the
checkpoint*; both reset on a fresh dispatch.
**Context**: Today there are 3+ overlapping counters; an earlier draft added a 4th. The
panel surfaced that the new counter wasn't on the checkpoint (resume mid-loop loses the
guard) and that cross-phase oscillation needs a global backstop a per-phase counter
misses.
**Rejected**:
- *One counter*: can't both cap intra-phase tightly and catch cross-phase oscillation.
- *Four semantic counters*: redundant; the two dimensions (intra vs inter) are the real
  distinction.
**Consequence**: A single dispatch can't spin forever; human-driven external reworks
(each a fresh dispatch) stay unbounded. Caps enforced in the runner, one place.

### D5 — Crash ≠ pipeline failure: keep the retry-policy `crash` category untouched
**Choice**: Slice 8 does not modify `retry-policy`. Pipeline failures (sub-phase
failures) block with a typed reason. Crashes (uncaught throw / OOM / process death) keep
Slice 6's `crash` category: backoff + attempt cap (poison-task protection).
**Context**: The panel showed the earlier "cut the crash category, everything blocks"
decision erased a real safety mechanism — a task that crashes on every dispatch would
tight-loop on operator retry with no backoff and no terminal cap.
**Rejected**:
- *Cut the `crash` category (earlier draft)*: removes backoff + the auto-terminal cap;
  reintroduces poison-task thrash.
**Consequence**: Less Slice 8 scope (retry-policy untouched). "Every failure blocks"
applies to sub-phase failures only.

### D6 — Typed `PrEvent` vocabulary with stateless merge-readiness
**Choice**: `GitHostingAdapter.detectPrEvents(repo, prNumber): Promise<PrEvent[]>`. Five
variants: `pr_comments`, `pr_ci_failure`, `pr_merge_conflict`, `pr_ready_to_merge`,
`pr_merged`. The plugin emits `pr_ready_to_merge` **only** when approved + CI-green +
mergeable hold together; "approved but CI pending" emits nothing (task stays blocked,
waiting).
**Context**: The panel's darkest restart corner was the in-memory `approvedAwaitingCI`
map. Stateless readiness (recomputed each poll) deletes that map and the restart bug.
**Rejected**:
- *Separate `pr_approved` + later CI re-check via in-memory state*: lost on restart.
- *Raw review-status objects across the contract*: leaks platform internals; breaks
  Plugin Blindness.
**Consequence**: The merge-wait survives restart by construction. The contract is a
small typed union the plugin computes.

### D7 — External events re-enter via DB re-queue + `entryFor`, not a back-channel call
**Choice**: Daemon polls → Core `arbitrate(events)` picks one winner → Core dedup →
write the event onto the task → re-queue → scheduler re-dispatches. The pipeline reads
the pending event on entry and starts at `entryFor(event)`. `auto-merge` is a normal
sub-phase reached by *entry*. No `orchestrator.applyExternalEvent`.
**Context**: The panel's highest-leverage finding: a synchronous daemon→orchestrator
call inverts a clean acyclic boundary, runs a long merge on the poll thread, and isn't
crash-safe. The DB-handoff path already exists and works.
**Rejected**:
- *`orchestrator.applyExternalEvent(taskId, event)` (earlier draft)*: circular coupling,
  off-thread merge, restart-unsafe.
**Consequence**: Boundary stays acyclic and crash-safe (event on the task row). Merge
runs in a normal dispatch (abortable, observable). `entryFor` is one exhaustive map.

### D8 — Arbitration, dedup, authorization are Core policy
**Choice**: `arbitrate(events): PrEvent` (precedence: changes-requested/comments beat
ready-to-merge) lives in Core. Dedup against `accommodated_*` lives in Core. `/approve`
authorization against the people-directory lives in Core; the plugin only reports the
comment fact.
**Context**: The panel showed `detectPrEvents(accommodated)` leaked Core's dedup policy
into the plugin, and that authorization needs the people-directory (a Core concept).
**Rejected**:
- *Dedup/authz in the plugin*: every new hosting plugin re-implements Core policy, or
  unauthorized `/approve` triggers a merge.
**Consequence**: The contract stays narrow; Core owns policy; plugins report facts.

### D9 — Structured block payload
**Choice**: `BlockDetail = { reason: BlockReason, sub_phase: string, category:
FailureCategory, needed: string }`. Typed keys, not prose.
**Context**: The dashboard and alerting read "which sub-phase / which category"
programmatically; stuffing them in a prose field forces string-parsing and violates the
project's strict-data-invariants rule.
**Rejected**:
- *Sub-phase name in a prose `needed` string*: not queryable.
**Consequence**: Slice 13 dashboard reads typed keys. `BlockReason` is a closed enum.

### D10 — Build dark, cut over atomically (migration)
**Choice**: Build the full `pipeline/` without wiring it to `executeTask` (legacy runner
stays live and green). Cut over in one commit: point `executeTask` at the new runner,
delete legacy + old prompts + old enum, finalize the schema. Pre-v1 DB wipe means no
in-flight task straddles the runners.
**Context**: The panel would "bet against" the earlier parallel-runner plan — a task is
one stateful flow; a checkpoint written by one runner and resumed by the other corrupts
(double-push). No safe window exists.
**Rejected**:
- *Parallel runners, migrate phase-by-phase (earlier draft)*: checkpoint-corruption
  window; the enum rename breaks the legacy runner's hardcoded phase checks mid-migration.
- *New runner delegates to old handlers (thin adapters)*: throwaway scaffolding on old
  prompt shapes.
**Consequence**: A few build sessions have old+new code coexisting (bounded cost). The
cutover is one green commit. The DB wipe is the migration.

### D11 — Audit the semantic consumers of `blocked`
**Choice**: health-monitor stuck-detection, unblock-resolver, and response-poller must
treat `blocked(pr_review_pending)` as expected-waiting, not stuck.
**Context**: Collapsing `review_pending` into `blocked` changes what "blocked" means; the
panel flagged false-alarms on every PR awaiting review.
**Rejected**:
- *Rewire only the query call sites*: leaves stuck-detection firing on waiting tasks.
**Consequence**: An explicit task in Session 7, not an afterthought.

### D12 — Preserve auto-merge, refactored onto typed events
**Choice**: The Engineer auto-merges on approval (CI-green + mergeable + safety-gated),
as today — refactored to be driven by the `pr_ready_to_merge` event and run as the
`auto-merge` sub-phase. `MAX_POST_APPROVAL_FIX_RETRIES` semantics survive as the
post-approval `pr_ci_failure`/`pr_merge_conflict` loopbacks counted by `total_reworks`.
**Context**: Q20's "merge = terminal, approval = informational" was reread mid-planning:
approval is the *trigger*, The Engineer performs the merge, the merge is terminal. The
capability stays.
**Rejected**:
- *Cut auto-merge*: degrades UX (operator approves, then must merge manually).
- *LLM-driven merge sub-phase*: the merge is a deterministic git op, not a judgment call.
**Consequence**: `auto-merge` is an orchestrator sub-phase reached via `entryFor`.

### D13 — One default review lens; refine fixes in place and loops (cap 3)
**Choice**: Review default = `[self-review, refine]`; opt-in lenses (`security`,
`code-quality`, `architecture`) add via config. `refine` consolidates, fixes in place,
`repeat`s to re-check (cap 3), and `jump`s out only when it genuinely cannot fix.
**Context**: Matches how the system behaved best historically (review reviewed *and*
fixed rather than always bouncing). The `self-review` lens distills refactor-guide.md's
"earn its keep" framing + cut/keep lists; deeper structural principles go to
coding-standards.
**Rejected**:
- *Always bounce rework to execution*: loses the in-place-fix behavior Farzam wanted.
- *Multi-lens default*: more CLI calls for the common case; lenses are opt-in.
**Consequence**: Adding a lens is one file + one config value.

### D14 — Config-driven deliverable (skip-gated Delivery)
**Choice**: `skip_pr_creation` (global + per-repo) gates `pr-description` / `create-pr` /
`await-review` / `auto-merge`; `push` always runs. PR mode → merged PR is the
deliverable ("done when merged"). Push-only → pushed branch is the deliverable ("done
when pushed").
**Context**: The user locked the deliverable concept. Second concrete use of the
skip-gate mechanism; proves the architecture.
**Rejected**:
- *Push-only as a separate pipeline*: it's the same Delivery with most sub-phases gated.
- *Always create a PR*: defeats the escape hatch.
**Consequence**: A fundamental product behavior is a data-declared skip-gate, anchored
in the docs as "What The Engineer Delivers."

### D15 — Slice 8 ships data, not dashboard UI
**Choice**: Slice 8 emits the new data (schema columns, typed events, observation
records). All dashboard UI for the new shape is Slice 13 (was 15).
**Context**: Slice 8 is already large; UI is pure visualization on top of the data.
**Rejected**:
- *Bundle dashboard UI into Slice 8*: crowds out architectural work.
**Consequence**: Slice 13 inherits a substantial, well-specified UI work item.

## Scope Boundary

**Delivering**: the 6-phase sub-phase architecture (runner, types, cli-run, all phase
folders); `integration` cut; `review_pending` → `blocked(pr_review_pending)`; the
`BlockReason` enum + structured `BlockDetail`; the two-counter model on task +
checkpoint; signal threading end-to-end; `implement`/`verify` split; the five Delivery
sub-phases + skip-gates; `GitHostingAdapter.detectPrEvents` + plugin impl + Core
arbitrate/dedup/authz; typed external re-entry via `entryFor`; review-handler refactor;
trivial-skip as a generic skip-gate; dev-toolbox prompt ports; the constraints +
future-considerations entries; the project-wide docs sweep; the closing standards sweep.

**Deferring**: dashboard UI → Slice 13; workspace cleanup → Slice 9; notification/
response-poller internals → Slice 10; background-services internals → Slice 11; npm SDK
→ Slice 14; parallel sub-phases → future-considerations. Retry-policy crash handling is
**untouched** (D5).

## Task Breakdown

(Verification, dependencies, and commit cadence per session. All sessions green-on-commit;
`/commit` after each coherent increment.)

### Session 1 — Foundation cleanup
**Goal**: 6 phases, no `review_pending` outcome, no decomposition residue; the current
runner still drives everything.
**Where**: `schemas/orchestrator.ts` (drop `integration`), `schemas/task.ts` (drop
`review_pending` from state enum / ValidTransitions / PermissionTable; add
`BlockReasonSchema` + structured `BlockDetail`), `orchestrator/types.ts`,
`prompts/integration.ts` (delete), `prompts/{demo-prep,planning}.ts` (residue),
`phase-handlers.ts` + `phase-runner.ts` + `agent-runner.ts` (integration handling),
`review-handler.ts` (`getTasksByState(review_pending)` → `getBlockedTasksByReason`),
`pr-manager.ts`, `db/migrations/001_schema.sql`, the lying docs.
**Verify**: `pnpm run typecheck && lint && test:all && build` green; `grep -r
"integration\|review_pending\|decomposition" src/` returns only intentional matches.

### Session 2 — Pipeline core (built dark)
**Goal**: `pipeline/runner.ts`, `pipeline/types.ts`, `pipeline/cli-run.ts` (with signal
threading: optional `AgentRunRequest.signal` + adapter + the three agent plugins'
`spawn({signal})`), the mock-pipeline test harness, observability-in-runner. Not wired to
`executeTask`.
**Where**: new `src/core/orchestrator/pipeline/`; `schemas/adapters.ts`
(`AgentRunRequest.signal` optional); `adapters/agent.ts`; `plugins/agent/*`; new
`tests/helpers/test-mock-pipeline.ts`; runner/cli-run/predicate-free tests.
**Verify**: legacy still drives `executeTask` and its tests pass; new runner tests pass
in isolation (mock sub-phases: order, skip, repeat-to-cap, block, observability emitted);
cli-run tests with a fake agent cover valid/stale/partial/abort.

### Session 3 — Upstream phases (built dark)
**Goal**: `requirements/gather`, `research/investigate`, `planning/design`,
`execution/implement` + `execution/verify`, with prompts and per-sub-phase tests.
**Where**: `pipeline/{requirements,research,planning,execution}/*`; `pipeline/pipeline.ts`
(register these phases). Prompt content adapted (context-summary-first, batched outreach,
observations/inferences). `verify` runs gates via `execFileSync`.
**Verify**: integration test (fake agent, real workspace/session-memory) runs req →
research → planning → execution under the new runner in isolation; trivial-skip skips
research + planning with full skip observability.

### Session 4 — Review + Delivery phases (built dark)
**Goal**: `review/*` (self-review + opt-in lenses + refine, cap-3 repeat, escalation
jumps), `delivery/*` (the five sub-phases + skip-gates), `entryFor`, `arbitrate`.
**Where**: `pipeline/{review,delivery}/*`; `pipeline/pipeline.ts` (register + `entryFor`);
`schemas/config.ts` (`review_phases` default `["self-review"]`).
**Verify**: integration tests — review loop-to-cap-then-block; refine escalation routes;
PR-mode happy path to `blocked(pr_review_pending)`; push-only runs only `push` →
`completed` with skip observability on the rest.

### Session 5 — Atomic cutover
**Goal**: `executeTask` → new runner; delete legacy runner + handlers + old prompts + old
phase enum; finalize `001_schema.sql` (sub_phase / phase_iteration / total_reworks on
tasks + checkpoints; two-counter wiring; resume reads `(phase, sub_phase)`).
**Where**: `orchestrator/index.ts`; delete `phase-runner.ts` legacy loop,
`phase-handlers.ts`, old `prompts/*`; `schemas/orchestrator.ts` (final 6-value enum);
`schemas/session-memory.ts` (checkpoint fields); migration.
**Verify**: full `test:all` now runs against the new pipeline; legacy deleted, zero stale
references; DB-wipe note in the session log.

### Session 6 — Typed PR events (contract + plugin)
**Goal**: `GitHostingAdapter.detectPrEvents`; github-hosting impl (aggregates today's
polling, computes `pr_ready_to_merge` statelessly); Core `arbitrate` + dedup +
authorization.
**Where**: `schemas/git-hosting-events.ts` (new); `adapters/git-hosting.ts`;
`plugins/git-hosting/github-hosting/*`; Core arbitration/dedup/authz helpers.
**Verify**: plugin test for `doDetectPrEvents` (all five variants; ready-to-merge only when
all preconditions hold); Core arbitration test (comment + approval → comment wins);
authz test (unauthorized `/approve` does not become ready-to-merge).

### Session 7 — External re-entry + review-handler refactor
**Goal**: refactor the 996-line review-handler onto typed events; external events flow via
DB re-queue + `entryFor`; wire `await-review` + `auto-merge`; delete `approvedAwaitingCI`;
audit `blocked` semantic consumers.
**Where**: `daemon/review-handler.ts`; `pipeline/delivery/{await-review,auto-merge}.ts`;
`pipeline/pipeline.ts` (`entryFor` wiring on dispatch); `daemon/health-monitor.ts`,
`daemon/unblock-resolver.ts`, `daemon/response-poller.ts` (treat `pr_review_pending` as
waiting).
**Verify**: per-event integration tests (each of five events → correct re-entry);
auto-merge happy path (approval → CI green → merge → done) and failure paths (CI fail →
execution; conflict → execution); restart test (blocked-waiting task re-derives readiness,
no lost state); health-monitor does not flag `pr_review_pending`.
**Note**: if this session strains the budget, split 7a (contract+plugin already in S6 →
re-entry + review-handler refactor) / 7b (auto-merge + consumer audit). The slice file
flags this.

### Session 8 — Dev-toolbox skill principles into prompts
**Goal**: per-sub-phase prompt diffs (port/adapt/skip table in research §15); refactor-
guide framing into `self-review`; structural principles into `coding-standards.md`.
**Verify**: prompt snapshot tests updated with reviewed diffs; lint clean.

### Session 9 — Project-wide docs sweep
**Goal**: architecture docs (overview + a new `pipeline.md` drawing on the slice file's
narrative), configuration docs (every key verified against schemas), user-flow docs,
plugin-author guides (the two new contract surfaces), README, bundled CLI docs,
seed-example, CHANGELOG. No dashboard UI.
**Verify**: every documented config key greps to a schema; every documented adapter method
greps to the contract; `test:all` green.

### Session 10 — Closing standards sweep
**Goal**: line-by-line audit of every touched file (two-pass). Update
`feedback_slice_closing_standards_sweep.md` if a new defect class surfaces. May spill to
Session 11.
**Verify**: all gates green; full audit complete.

## Verification Contract

| Check | Type | Command / Observation |
|---|---|---|
| Types / lint / tests / build | Auto | `pnpm run typecheck && pnpm run lint && pnpm test:all && pnpm run build` |
| 6 phases, no integration | Grep | `grep "PhaseSchema" src/schemas/orchestrator.ts` → 6 values |
| `review_pending` gone | Grep | only `pr_review_pending` block-reason matches remain |
| Routing is functions, not a DSL | Review | no predicate library / rule arrays; `next` per sub-phase |
| Signal honored | Integration | preempted task SIGTERMs the in-flight agent CLI |
| Retry-policy untouched | Grep | `retry-policy/` diff is empty for Slice 8 |
| Stateless merge readiness | Integration | restart of a blocked-waiting task re-derives readiness; no in-memory map |
| Typed event re-entry | Integration | each of five `PrEvent` types re-enters at `entryFor` target |
| Auto-merge preserved | Integration | approval → CI green → mergeable → `mergePR` called |
| Block payload typed | Review | `BlockDetail` keys, not prose |
| Adding a lens = one file + one line | Manual | demonstrated by a throwaway lens in a test branch |
| Docs match schemas | Grep | every documented config key exists in a Zod schema |

## Risks

| Risk | If it happens | Mitigation |
|---|---|---|
| New runner built dark surprises at cutover | Cutover session runs long | Sessions 2-4 integration-test the new runner end-to-end with the fake agent + real workspace/session-memory, so cutover only swaps the entry point. |
| Review-handler refactor regresses dedup/auth/auto-merge | Operator-visible double-rework or lost merge | Session 6/7 first capture today's behavior in tests against the existing impl, then refactor to keep them green. Restart + same-comment-twice tests explicit. |
| Snapshot churn (Session 8) buries a semantic regression | A bad prompt ships | Stage snapshot updates one prompt at a time; review each diff; "no snapshot drift without semantic review" on the sweep checklist. |
| `verify`→`implement` loop oscillates instead of converging | Task burns the cap then blocks | Structured failure carry (the gate output) is fed into the next `implement` prompt; cap-3 then block is the intended floor; integration test for cap-hit. |
| Phase enum rename misses a SQL/template reference | Cutover build breaks | Cutover verify greps `src/`, `001_schema.sql`, `bundled/templates.ts`, and persisted CHECK constraints; pre-v1 DB wipe covers history rows. |
| Session 7 too large | Spills | Pre-split into 7a/7b documented; the slice may run to 11 sessions. |

## Panel Review

**Panelists** (Session 39): Linus Torvalds (data structures / over-abstraction), Rob Pike
(interface width / clarity), Technical Architect (one-way doors / operations / migration).
Each read all three artifacts plus the live source.

**Convergent findings incorporated:**

| Finding | Panelists | Action |
|---|---|---|
| Routing DSL is over-engineered | All 3 | **Changed** — replaced `RoutingRule[]`+predicates with a `next()` function per sub-phase (D1). |
| `session-result` too thin; routes on overloaded `next_phase` | Torvalds (top), Pike | **Changed** — agent reports a 3-word outcome; orchestrator owns the route; richness local + validated (D2). |
| Parallel-runner migration corrupts checkpoints | Pike, Architect | **Changed** — build dark, atomic cutover, DB-wipe migration (D10). |
| `applyExternalEvent` inverts a clean boundary | Architect (top), Pike | **Changed** — events re-enter via DB re-queue + `entryFor` (D7). |
| Crash ≠ block (lost backoff/cap) | Architect | **Changed** — keep retry-policy `crash` category untouched (D5). |
| `PrEvent[]` arbitration missing | Architect | **Added** — Core `arbitrate` (D8). |
| Dedup/authz leak into plugin | Architect | **Changed** — both stay in Core (D8). |
| Block payload is prose, not keys | Architect | **Changed** — structured `BlockDetail` (D9). |
| `blocked` semantic consumers false-alarm | Architect | **Added** — explicit consumer audit (D11, Session 7). |
| Counter on the checkpoint; cross-phase backstop | Torvalds, Architect | **Changed** — two counters on task + checkpoint, intra + inter (D4). |
| Session 7 is two sessions | Pike, Architect | **Accepted** — pre-split 7a/7b documented. |

**Refinements beyond the panel (found by deeper design):** stateless `pr_ready_to_merge`
(deletes the `approvedAwaitingCI` map and its restart bug, D6); observability emitted by
the runner so a step cannot forget it; `cli-run` as the single defended boundary (D3);
`details` validated per sub-phase so it is never an escape-hatch type.

**Declined:** none of substance — the convergent findings were all sound and incorporated.
The one judgment call kept against a minor Pike/Torvalds preference: `repeat` and `jump`
remain distinct `Route` verbs (mechanically `repeat` = jump-to-self) because the
readability and the one-to-one mapping onto the two counters outweigh the single-variant
saving.

## Pre-mortem

**Scenario 1 — Cutover reveals an integration mismatch the dark build missed.** The new
runner passed isolation tests but the real `executeTask` wiring (observer trace scoping,
session lifecycle, workspace record timing) differs subtly, and the cutover commit isn't
green. *Mitigation*: Sessions 2-4 use the *real* workspace-manager, session-memory, and
observer in integration tests (only the agent CLI is faked), so the wiring is exercised
before cutover; the cutover changes the entry point, not the collaborators.

**Scenario 2 — The `verify→implement` loop converges on green gates but the code is
subtly wrong, and `review` rationalizes it through.** Gates pass, lenses say "ok," a real
bug ships. *Mitigation*: the `self-review`/`refine` split exists precisely so finding is
separated from fixing; the refactor-guide "earn its keep / does this surprise a reader"
framing in the `self-review` lens targets exactly the plausible-but-wrong class; the
cap-3 block surfaces a non-converging case to the human rather than shipping it.

**Scenario 3 — A reviewer comments and approves in the same poll; the task both reworks
and merges.** *Mitigation*: `arbitrate` (D8) is the single Core precedence point —
changes-requested/comments beat ready-to-merge — so exactly one event wins per tick;
integration test for the simultaneous case.

## References
- Requirements + design narrative: `docs/archived/implementation-docs/9-oss-ready/slices/08-pipeline-phases.md`
- Research: `.claude/temp/research/slice-08-pipeline-phases.md`
- Session 38 log: `docs/archived/implementation-docs/9-oss-ready/sessions/38.md`
- Dev-toolbox skills: `~/Documents/Repos/dev-toolbox/ai/claude-code/skills/rrpir/`
- Refactor guide: `~/Documents/Repos/dev-toolbox/ai/coding-standards/refactor-guide.md`
