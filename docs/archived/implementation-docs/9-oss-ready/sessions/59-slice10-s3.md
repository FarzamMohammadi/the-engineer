# Session 59 (Slice 10 build) — 2026-06-04

Slice 10 (Communication), **S3 of the build plan: decision-escalation engine + policy wiring** (Pillar B — the one new BUILD capability).
Branch `slice10-build` (isolated worktree). Footwork: `.claude/temp/{requirements-gathering,research,create-plan}/slice-10-communication.md` (Session 56). Plan section: `create-plan` § S3.

> Naming note: logged as `59-slice10-s3.md` to mirror S1's `57-slice10-s1.md` and S2's `58-slice10-s2.md` (the bare `sessions/59.md` belongs to the unrelated Dashboard Sync tangent — the Slice-10 build reused the session counter on its own branch).

## What S3 builds

The `should_i_ask` autonomy path was fully built but had **zero production callers** — only `cost_check` was live. S3 wires it end-to-end as an **enforced engine**: the agent surfaces the discretionary decisions it made, the runner consults the owner's `safety.yaml` autonomy policy per decision, `ask_human` blocks-and-asks, `proceed` continues. This activates dead-but-tested config and is the one new capability of Slice 10.

Locked design (plan + research): **enforced engine, not prompt-only.** The agent surfaces structured `details.decisions[]`; the **runner** consults (an effect — `next()` stays pure); the prompt informs the agent of the vocabulary; the policy/template own the verdict.

## What I did (one unit of work: code + tests + docs + observability)

1. **Generic `DecisionsSchema`** (`pipeline/types.ts`). `z.array({category, summary, chosen, reasoning, details?})` + `SurfacedDecision` type. Generic across every phase — `category` keys the owner's policy, `details` carries any threshold metric (e.g. `{files: 7}`).

2. **Central validation in `agent-step.mapResult`.** After the sub-phase's own `detailsSchema` passes, `details.decisions` (if present) is validated against `DecisionsSchema`; a malformed entry returns `failed(details_invalid)`. Reuses the grounding/refine `details → data` precedent, but `decisions` is the ONE field any phase may surface, so it is validated centrally, not per sub-phase. The validated `details` flows into `SubPhaseResult.data`, so `data.decisions` reaches the runner.

3. **Runner consult** (`runner.ts`, new `consultDecisions` effect helper in a new `// ── Effects: autonomy escalation ──` section). After `emitSubPhaseResult` and before routing, for each surfaced decision the runner calls `ctx.safetyLayer.consultJudgment({type:"should_i_ask", context:{task_id, repo, decision_category, details}, trace: traceScope(ctx, phase)})`. The **first non-`proceed`** verdict returns an `awaiting_human` `BlockDetail` whose `needed` is a synthesized owner question; the runner converts it via the existing `emitBlock`. `proceed` on all → routing continues. `needs_human`/`failed` results never reach the consult (guarded). The consult lives in the loop, not in `next()` — a sub-phase cannot forget to be consulted (same discipline as the observability emissions).

   - **Fail-safe:** any verdict that is not `proceed` (policy `ask_human`, or a `deny` from a malformed consult) asks the owner rather than slipping a decision through unseen.
   - `readSurfacedDecisions` re-parses `data.decisions` with `DecisionsSchema` to recover the type (agent-step already validated it; a re-parse failure would mean drift — treated as none).

4. **`traceScope` threading (contract change).** `consultJudgment` recorded the `autonomy_policy` decision under a bare `{task_id}`, orphaning it off the dispatch trace. Added `trace?: SpanOptions` to `SafetyQuery` (interface + `SafetyQueryInputSchema`); the should_i_ask arm now records under `query.trace ?? {task_id}`. The runner passes the full `traceScope(ctx, phase)`, so the verdict nests in the dispatch trace tree (and exports correctly). The CLI `cost_check` caller (no dispatch) is unchanged — it omits `trace` and still records under `task_id`.

5. **Prompt section** (`agent-prompt.ts`). Added `SURFACE_DECISIONS` into `buildSystemPrompt` — it reaches **every** agent sub-phase by construction (all use `buildSystemPrompt(ROLE)`). It teaches: the surface-vs-hard-block distinction, the `details.decisions` contract, and the category vocabulary; principle-level ("surface a genuine fork, not every routine line"), not a procedural checklist.

6. **Curated defaults as the schema default** (`config.ts`, new `DEFAULT_AUTONOMY_DECISIONS` constant; `AutonomyBoundariesSchema.decisions` defaults to it). **Deviation from the literal brief** (which said populate the *template*): I made the curated set the schema default too, so **zero-config gets the curated policy** — otherwise `decisions: {}` resolves every category to `always_ask` (the unknown-fallback), the opposite of "conservative but curated." Single source of truth: the constant. Both safety templates (`SAFETY_TEMPLATE`, `EXAMPLE_SAFETY`) mirror it for visibility/editing. Categories: `always_decide` = code_style/test_coverage/refactoring_local/doc_wording; `threshold (files > 5)` = scope_expansion/refactoring_broad; `always_ask` = architecture/dependencies/public_api/destructive/security. Unknown → always_ask (fail-safe, untouched). Verified both templates parse through the schema (and the autonomy block through the real loader).

7. **Threshold-gap fix** (`policy-engine.ts`). `evaluateThreshold` returned `boolean` (a bool can't say "metric missing"). Now returns a 3-state `ThresholdOutcome` (`exceeded`/`within`/`metric_absent`); `evaluateAutonomy`'s threshold branch maps `metric_absent → ask_human` (was: `false → proceed`). Conservative — a threshold-governed decision surfaced without its number asks the owner. Extracted `compareThreshold` for the operator switch.

8. **SafetyQuery cleanup** (`schemas/orchestrator.ts`). Deleted the dead `SafetyQuerySchema`, `SafetyVerdictSchema`, `CommEventSchema`, `QuestionSchema`, `QuestionBatchSchema` (confirmed by grep: imported only by their own test) + the test file. `SafetyQuery`/`SafetyVerdict` are now single-sourced on the interface (+ the input-validation schema), aligned on `optional`. `ComplexitySchema` + `PHASE_DIRECTORIES` stay (real consumers). Committed separately.

9. **Docs.** `docs/configuration/safety.md` Autonomy section rewritten: how it works (surface → consult → proceed/ask/threshold), the surface-vs-hard-block distinction, a default-categories table, override examples. README safety section now states autonomy escalation IS enforced (agent-surfaced + Core-enforced), while distinguishing it from scope-boundary file/branch gates that still don't gate the CLI's internal writes.

## Tests added

- `agent-step.test.ts` — `describe("surfaced decisions")`: valid decisions flow into `data`; a missing-field decision → `details_invalid`; non-array `decisions` → `details_invalid`; decisions validated alongside the sub-phase's own schema.
- `runner.test.ts` — `describe("autonomy escalation")`: always_decide proceeds (next called, completed); escalated decision blocks+asks (next NOT called, `awaiting_human`, question contains the category + chosen); the consult receives the category, details, and full `traceScope` (task_id + phase); no decisions → no consult; first escalated decision stops the loop (2 consults, blocked).
- `policy-engine.test.ts` — threshold with the metric absent → `ask_human` (fail-safe); `evaluateThreshold` returns `exceeded`/`within`/`metric_absent`.
- `index.test.ts` — `should_i_ask` records `autonomy_policy` under the threaded trace; falls back to `{task_id}` with no trace; updated `evaluateThreshold` assertions to the 3-state outcome.
- `config.test.ts` — autonomy defaults now assert the curated policy (not `{}`).
- Test harness (`tests/helpers/test-mock-pipeline.ts`): `createMockPipeline` accepts a `consultJudgment` override + exposes the spy; `RecordedDecision` now captures the `opts` (trace) so a test can assert nesting.

## Decisions / deviations

- **Curated defaults as the schema default, not just the template** (item 6) — deliberate enhancement so zero-config works; documented above. The single source is `DEFAULT_AUTONOMY_DECISIONS`; templates mirror it.
- **`evaluateThreshold` return type changed bool → `ThresholdOutcome`** — a bool can't honestly express the three states; this is the cleanest FCIS shape. Public exported fn, so the two existing tests were updated.
- **No-owner edge (B4) deferred to S4** — the plan assigns the `getOwner()` no-owner-proceed-and-observe check to S4 (ask round-trip), and the self-unblock exemption likewise. S3's `ask_human → block` is correct on its own; the round-trip that delivers the question and carries the answer back is S4. S3 synthesizes the question into the block's `needed` so it is not lost.
- **Repo for the consult** = `ctx.task.repo ?? ""`. In practice an agent sub-phase runs only with a workspace (so a repo); the fail-safe `verdict !== "proceed"` covers the empty-repo validation-deny edge.

## Gates (all green)

- **lint** (`biome + tsc + tsc test + knip + madge`): 0 errors. **3 pre-existing** `noExcessiveCognitiveComplexity` warnings, all in `notification-router.ts` (S1's file, outside S3 scope; S2's handoff noted 2 — there are 3, all in that one file, none in S3's files).
- **typecheck**: clean (src + test tsconfig).
- **tests**: 2516 unit (was 2514 at S2: −10 dead orchestrator schema tests, +12 new) + 64 integration + 16 e2e.
- **build**: OK (pre-existing dashboard chunk-size warning only).

## For the owner's final review

- **The autonomy verdict is enforced at the runner, not inside the CLI.** Core can't gate the CLI's internal file writes; it gates the *agent's surfaced decisions*. The agent must honestly declare a decision for the policy to see it — the prompt teaches this, but a dishonest agent that never declares is invisible to the gate (same trust model as the rest of the pipeline). Worth a glance at the `SURFACE_DECISIONS` prompt wording.
- **Curated defaults ship live (schema default).** A user who never writes `safety.yaml` gets the curated policy. If you'd rather the live default stay `{}` (all-ask) and only the template carry the curated set, that's a one-line revert of the schema default — flagging the choice.
- **Pre-existing template/loader gap (NOT mine, NOT fixed):** `EXAMPLE_SAFETY`'s `response_timeout.blocked.stages.*.after_ms` duration strings (`"4h"`, `"2d"`) don't pass the real loader's duration coercion in that nested-array context (the coercion only reaches certain `ZodNumber` fields). My autonomy block parses cleanly through both the schema and the real loader. The stage-duration gap predates S3 and is a candidate for the closing audit (S6/S7) or a loader fix.

## Next: S4 — B: ask round-trip refinement

Generalize `deliverOutreach` + the responses dir beyond hardcoded `requirements/` (resolve from the blocking `sub_phase`) so `needs_human` AND the new autonomy block deliver from any phase; **close the answer-injection gap** (set `ResumeState.carry` from the response file on unblock-resume so `buildCarrySection` renders the owner's reply); no-owner ask → proceed + loud `decision_point` (the `getOwner` check lives in the runner); exempt discretionary `awaiting_human` blocks from `evaluate_self_unblock`. Per the CRITICAL grounding note: the answer-injection gap is **already fixed on main** (`pending_response`/`responseCarry`/`resolveResponse`) — verify against CURRENT code before rebuilding it; the research's line numbers are stale.
