# Session 60 — Slice 10 (Communication) BUILD, S4: ask round-trip refinement (Pillar B)

Branch `slice10-build`. Plan § S4. Builds on S3 (`f4e6650`).

## Scope

Pillar B ask round-trip. The answer-injection RETURN path was already done on main
(`68a7`: `pending_response` → `resolveDispatchStart` → `resolveResponse` → `responseCarry` carries the
owner's reply into the re-run). This session built the remaining three gaps:

1. **Generalize FORWARD outreach beyond requirements.** `deliverOutreach` hardcoded `requirements/outreach`,
   so a `needs_human` (or an autonomy escalation) from any non-requirements phase blocked with no question
   delivered.
2. **No-owner edge (gate decision).** An `ask_human` autonomy verdict with no owner configured must NOT
   block — proceed + a loud warn-level decision.
3. **Self-unblock exemption (gate decision).** A discretionary autonomy block must be exempt from the
   8h `evaluate_self_unblock` auto-resolve (the owner must decide); reminders + final escalation still fire.

## What Happened

All three built as one unit (code + tests + docs). Gates green: lint 0 errors (3 pre-existing
`notification-router.ts` complexity warnings, S1's file, outside scope), typecheck clean, 2529 unit
(+13 over S3's 2516) + 64 integration + 16 e2e, build OK.

### (1) Forward outreach beyond requirements
- **`SubPhase.resultDir?: (ctx) => string`** (new, `pipeline/types.ts`) — each agent sub-phase exposes the
  directory it wrote its work to, the single source of truth for where its `outreach/` lives. Set on every
  agent sub-phase (gather, investigate, design, implement, refine, the review lenses via the `lens()`
  factory, pr-description) by extracting the existing `agentStep.directory` fn to a shared `dir` const and
  referencing it from both `agentStep` and `resultDir`. Orchestrator sub-phases (verify, the delivery
  git/PR steps) leave it absent — they write no deliverable, so they have no outreach dir.
- **`outreachDirForSubPhase(ctx, subPhaseName)`** (new, exported from `orchestrator/index.ts` for direct
  unit testing, like `responseCarry`) — finds the blocking sub-phase in `PIPELINE` by name and returns
  `{resultDir}/outreach`, or null. Single-sources the layout including review's nested `review/<lens>`
  directories. `deliverOutreach(ctx, detail)` now resolves the dir from `detail.sub_phase` instead of
  hardcoding requirements.
- **Synthesized-question fallback** — when the asking sub-phase wrote no outreach file (the autonomy
  escalation, whose question is synthesized into `detail.needed`, or any phase that asked without a file),
  `deliverNeededToOwner` delivers `detail.needed` to the owner as a `question`, so the question is never
  lost. Warns (does not crash) when no owner is configured.

### (2) + (3) Discretionary-decision block category + the two gate behaviors
- **New `BlockCategory` `awaiting_human_decision`** (`schemas/task.ts`) — distinct from `awaiting_human`
  (a sub-phase stuck, needs info). The runner's `consultDecisions` now emits this category for an escalated
  decision. Both still route to the coarse `BlockReasons.need_more_info` (the daemon waits on the owner for
  both); `toBlockReason` + `blockLogLevel` + `blockTask`'s outreach trigger handle both `awaiting_*human*`
  categories. Mirrored into the dashboard taxonomy (`vocabulary.ts` BLOCK_CATEGORIES + `constants.ts`
  BLOCK_CATEGORY_LABELS "Awaiting Decision") so the parity test stays green and the badge renders.
- **No-owner edge** (`runner.ts` `consultDecisions`) — the `getOwner()` check lives in the RUNNER, not the
  safety layer (which stays owner-agnostic). On a non-`proceed` verdict with no owner, the runner calls the
  new `recordOwnerlessProceed` (a warn-level, confidence 0.5 `autonomy_no_owner` `decision_point` naming the
  decision + chosen + reasoning, road-not-taken = "block and ask the owner, impossible here") and continues
  instead of blocking. Mirrors `sendOutreach`'s existing warn+proceed for no-contact.
- **Self-unblock exemption** (`daemon/health-monitor.ts`) — threaded `task.blocked.category` through
  `processBlockedStages` → `executeBlockedStageAction`; the `evaluate_self_unblock` action skips (with an
  info log) when the category is `awaiting_human_decision`. `send_reminder` and `escalation_alert` are
  unaffected, so a discretionary block is still nudged and eventually escalates if never answered — it just
  is never auto-resolved.

### Tests
- `tests/unit/core/orchestrator/outreach-routing.test.ts` (new, +8) — `outreachDirForSubPhase` resolves each
  phase's dir (requirements/research/planning/execution/delivery + review's nested per-lens layout), returns
  null for verify (orchestrator sub-phase) and unknown names; `buildCarrySection` renders the owner's reply
  carried by `responseCarry` (the answer-return into any phase); `sendOutreach` delivers a real outreach file
  written under a non-requirements phase dir and reports `no_files` (the synthesized-question fallback path).
- `runner.test.ts` (+3, 2 updated) — the escalated-decision block now asserts category
  `awaiting_human_decision` and requires a configured owner; new no-owner test (proceeds + records
  `autonomy_no_owner`, never blocks); new resume-with-answer test (the carried reply reaches a resumed
  non-requirements sub-phase's `run`).
- `health-monitor.test.ts` (+3) — a discretionary block is NOT self-unblocked (but still reminded); a stuck
  `awaiting_human` block IS still self-unblock-eligible; a discretionary block still escalates to failed at
  the final stage.
- `tests/helpers/test-mock-pipeline.ts` — `peopleDirectory.getOwner()` now resolves from `options.people`
  (was always null), and a new `mockOwner()` helper, so tests can configure an owner to exercise the
  block-and-ask path vs the no-owner-proceed path.

### Docs
- `docs/configuration/safety.md` Autonomy section: new "What happens when it asks" (round-trip from any
  phase, resumes where it asked with the reply carried in; the `awaiting_human_decision` vs `awaiting_human`
  distinction and the self-unblock exemption) + "When no owner is configured" (proceed + record). The
  Response Timeouts `self_unblock_check` stage now notes the exemption.

## Decisions Made

1. **A new `BlockCategory`, not a flag.** A discretionary decision the owner must CONFIRM is a genuinely
   different kind of wait than "stuck, needs info" — a first-class category honors the project's
   strict-data-invariants preference (a meaningful key over a nullable boolean) and lets the health-monitor
   exempt cleanly on `task.blocked.category`. Ripple was small and clean (toBlockReason, blockLogLevel,
   blockTask, the dashboard taxonomy + parity test).
2. **`resultDir` on `SubPhase`, single-sourced with `agentStep.directory`.** Rather than re-deriving the
   directory layout (and re-implementing review's nesting) in the orchestrator, each sub-phase exposes the
   one directory function it already uses. The orchestrator resolves outreach from it, so the layout never
   drifts from where work is actually written.
3. **Synthesized-question fallback delivers `detail.needed`.** The autonomy escalation never writes an
   outreach file, so generalizing the dir alone would not deliver its question. Delivering `detail.needed`
   to the owner closes that — the owner always gets the question, file or not.

## Deviations

- Added a new `BlockCategory` (`awaiting_human_decision`). The plan said "distinguish ... e.g. via the block
  reason/category" — this is the category route, the cleanest distinguisher. Logged as decision #1.
- Session log named `60-slice10-s4.md` to mirror S1–S3 (`N-slice10-sN.md`); the bare `60.md` is the
  unrelated Dashboard Sync tangent that reused the counter on its own branch.

## Reality-vs-research

- The answer-injection RETURN path is already done on main (`68a7`), as the grounding note said — verified,
  not rebuilt. `resolveDispatchStart`/`resolveResponse`/`responseCarry` carry the owner's reply; the new
  resume test confirms it reaches a non-requirements sub-phase.
- One observation for the owner's review: `responseCarry`'s prose is requirements-flavored ("defines the
  scope of this task ... overrides any broader reading"). For a discretionary-decision answer ("yes proceed"
  / "use X instead") that framing is slightly off but serviceable. It is the SAME already-done carry the
  brief said not to rebuild, so it was left as-is — a candidate for a small framing tweak in the closing
  audit (S6) if desired.

## Gate Results

lint PASS (0 errors; 3 pre-existing `notification-router.ts` complexity warnings, outside scope) ·
typecheck PASS · test PASS (2529 unit + 64 integration + 16 e2e) · build PASS.

## Next

S5 — Pillar C: inbound query routing fix + enrichment (poller classification, direct `handleQuery`,
personId→owner, close the external_ref double-dispatch, enrich formatters, inbound observability). Then
S6/S7 audits.
