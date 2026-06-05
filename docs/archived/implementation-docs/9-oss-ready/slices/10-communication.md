# Slice 10: Communication

> **This file is the durable design record for The Engineer's communication layer — its voice
> (outbound), its judgment about when to involve the owner (decision escalation), and its ears
> (inbound query).** It captures not just *what* was decided but *why*, because this reasoning seeds
> the user-facing docs (how the owner stays in sync, how autonomy works, how to ask the system on
> demand). Read it as a design narrative.
>
> **Status: BUILT AND AUDITED — pending the owner's final hands-on review + merge of `slice10-build`
> → `main`.** Five implementation sessions (57–61) + two closing audits (62 code, 63 docs). Per-session
> detail in `sessions/57-slice10-s1.md`–`61-slice10-s5.md`, `62-slice10-s6.md`, `63.md`. The RRP working
> artifacts — `.claude/temp/{requirements-gathering,research,create-plan}/slice-10-communication.md` —
> remain the panel-reviewed build script with the full per-decision rationale; this file is the durable
> synthesis and the seed for the user-facing docs.

## Requirements

Gathered through co-owner Q&A (Session 56), grounded by a five-dive read of the real code (no
sub-agents), the resulting plan stress-tested before the build. The requirements doc framed three
pillars (A outbound policy, B decision escalation, C inbound query) built "to the done-done bar."

### Scope Framing — this is mostly *refinement*, not greenfield

Grounding overturned the requirements doc's implied scope. The reserved communication surface was
**validated-but-dead**: the notification-router sent every message the instant it was called with no
policy awareness; the `should_i_ask` autonomy path was fully built with zero production callers; the
inbound query handler was unreachable. But the elaborate outbound *policy* the requirements doc
imagined (digest, batching, quiet-hours, milestone/verbose phase-pings, question-batching) was the
wrong thing to build:

- **The dashboard already is the full-detail, always-on feed.** A periodic Telegram digest duplicates
  it. Batching/quiet-hours add stateful in-memory machinery (and a cron + timezone dependency) to a
  channel that, for a single owner, is already low-volume and milestone-only.
- **Question-batching was redundant** — the agent already batches every question in a phase into one
  outreach file per person.

So the create-plan **narrowed the slice to refine-over-build**: build **one** new capability
(decision-escalation), refine/fix the rest, and **cut the dead policy config** (deleting it *is* the
refinement). After the cut, `OrchestratorConfig` is `{review, observability}` and the single survivor
(`suppress_window_ms`) moved to `DaemonConfig` where the router that owns it lives.

### Goals (priority order)

1. **The owner stays in sync and in control without being spammed** — milestone-rich on their channel,
   full depth on the dashboard.
2. **The owner governs discretionary decisions by policy** — the agent surfaces a call, Core consults
   the owner's `safety.yaml` autonomy policy per call, and asks where the owner said to.
3. **Every fork is observable** — suppress, route, autonomy verdict, no-owner-proceed, cancel
   reconciliation each leave a drill-down trail. The outbound deliver/fail/retry path, invisible
   before, is now emitted.
4. **Honest config** — no contradictory or dead knobs; the cut surface is deleted, not parked.
5. **Single-user + owner-assumed-not-required throughout** — every human-targeted message resolves to
   the owner; a missing owner degrades gracefully (warn, never strand a task).
6. **Plugin-blind** — no hardcoded plugin/channel names; Core compiles and communicates with every
   plugin deleted.

---

## The Three Pillars, As Built

### Pillar A — Outbound (the voice): one observable, deduplicated path

The notification-router is the single outbound owner. Refinement, not new policy:

- **Observable.** Deliver / send-fail / retry-success / retry-exhausted each emit a `tool_execution`
  observation alongside the existing `comm.*` events; a suppressed duplicate records a `decision_point`
  (`notification_suppressed`) with the road not taken. The whole outbound path — invisible to the
  dashboard before — is now reconstructable from the emitted trail.
- **One dedup window.** The hardcoded `HEALTH_NOTIFY_COOLDOWN_MS` + `healthNotifyCooldowns` map + its
  tick cleanup were deleted; the router owns one suppress window
  (`DaemonConfig.notification_suppress_window_ms`, default 5m) keyed on the notification's **kind**
  plus scope (`taskId`, or a stable `source` for a task-less health alert, e.g.
  `"trigger:github-trigger"`). The five daemon health alerts and the reaper-failure alert route
  through it, so a flapping dependency cannot flood the owner with the same alert, while the first
  occurrence and any distinct kind/scope always pass immediately. (Alerts are **deduped**, not
  bypassed — see the alert-dedup decision below.)
- **Single-user fixes.** `review_reminder` resolves to the **owner** (it targeted the empty
  `reviewers` set before). The untyped `system.health_changed` publish gained a typed event + payload
  schema.

### Pillar A' — Cancel/label coverage (reaper-driven)

A cancel from `engineer cancel` or the dashboard while a task sits queued or blocked is a raw DB write
that emits no `task.state_changed`, so the comm-plugin label never synced and no courtesy comment was
left — and `cancelled` is terminal, so it never self-corrected. The **reaper** is now the single
emitter for the cancel comment + label across every cancel path: `reapCancelledTask` calls
`announceCancel(task)` before any reap step, which `notify`s a `ticket_comment` and calls
`syncStateToCommPlugin(...)` directly (not a synthetic `task.state_changed`, so no other state
subscribers wake) to apply `engineer:cancelled`. Best-effort with isolated try/catch (one failing
never skips the other, neither blocks `markReaped`), guarded by a first-visit flag so a retrying reap
does not re-comment. `engineer retry` self-heals its label on the next dispatch's real transition — no
hook needed. The now-duplicate active-cancel comment was removed from the scheduler.

### Pillar B — Decision escalation (the judgment): the one new capability

The built-but-dead `should_i_ask` autonomy path is now wired end-to-end as an **enforced engine**:

- **Agent surfaces, runner enforces, `next()` stays pure.** A generic `DecisionsSchema` (array of
  `{category, summary, chosen, reasoning, details?}`) is validated centrally in `agent-step.mapResult`,
  so **any** phase can surface `details.decisions`. The **runner**, after `emitSubPhaseResult` and
  before routing, consults `consultJudgment({type:"should_i_ask", …})` per surfaced decision; the
  first non-`proceed` verdict becomes an `awaiting_human_decision` block carrying a synthesized
  question, otherwise routing continues. A sub-phase "cannot forget to be consulted."
- **Engine enforces, prompt informs.** The shared system prompt teaches the agent to surface decisions
  + the category vocabulary; the engine is the enforcement. The prompt vocabulary, the safety-template
  defaults, and the schema default are kept in sync (the agent-prompt carries an explicit sync comment
  naming the other two sources).
- **Curated, owner-extensible categories.** Shipped as the schema default (`DEFAULT_AUTONOMY_DECISIONS`
  in `config.ts`) so zero-config gets sensible behavior, mirrored in both safety templates and
  documented in `safety.md`: `always_decide` = code_style / test_coverage / refactoring_local /
  doc_wording; `threshold (files > 5)` = scope_expansion / refactoring_broad; `always_ask` =
  architecture / dependencies / public_api / destructive / security. Unknown category → `always_ask`
  (fail-safe).
- **Two-tier.** Autonomy governs *discretionary* calls the agent *could* make alone; the agent still
  *hard-blocks* (`needs_human`) when it genuinely cannot proceed. Distinct concerns, distinct blocks
  (`awaiting_human_decision` vs `awaiting_human`).

### Pillar B' — Ask round-trip (close the loop)

For an escalated "ask" to be worth anything, the question must reach the owner and the answer must
reach the agent:

- **Any phase can ask.** Forward outreach was hardcoded to `requirements/`. Every agent sub-phase now
  exposes its `resultDir`, and `deliverOutreach` resolves the blocking sub-phase's `outreach/`
  directory from it — so a `needs_human` (or a synthesized autonomy question) from research, planning,
  execution, review (incl. the nested `review/<lens>` layout), or delivery delivers.
- **The answer reaches the agent.** The return path was already fixed on `main` (`68a7`:
  `pending_response` → `resolveDispatchStart` → `resolveResponse` → `responseCarry` carries the
  owner's reply into the re-run) — verified for a non-requirements phase, not rebuilt.
- **No-owner edge.** An escalated verdict with no owner configured does not block (which would strand
  the task) — the runner proceeds and records a loud warn-level, confidence-0.5 `autonomy_no_owner`
  `decision_point` naming the call made without the owner. The `getOwner()` check lives in the
  **runner**; the safety layer stays owner-agnostic.
- **Self-unblock exemption.** The daemon's `evaluate_self_unblock` stage skips
  `awaiting_human_decision` (only the owner can decide), while reminders + final escalation still fire.

### Pillar C — Inbound (the ears): a reachable query path

`handleQuery` (status / progress #N / cost / help) was unreachable: the response-poller linked every
inbound message to a task (metadata or the sole-blocked fallback) before it could be seen as a query,
so a Telegram `status` while one task was blocked was mis-routed as an unblock reply. The poller now
**classifies first** (`classifyInbound`, a pure fn): metadata link → reply; query vocabulary → query
(and **wins** over the sole-blocked reply — the owner can ask `status` mid-block); else sole-blocked →
reply; 0-or-2+-blocked → query. It calls `handleQuery` **directly** (still publishing a `task_id=null`
audit event), and the redundant `daemon:comm` subscription was removed, closing a latent external_ref
double-dispatch. `handleQuery` resolves the response recipient to the **owner** explicitly; no owner →
warn + no reply. Formatters were enriched (active/blocked tasks by id+title, block reason, cost
verdict + percent-of-limit warnings) while staying short; a 2+-blocked unmatched message becomes an
owner-facing "couldn't match — N are blocked" notice. Observability: an `inbound_route`
`decision_point` + an `inbound_query_handled` `lifecycle` per served query.

---

## Locked Decisions (full rationale in the plan)

- **Refine over build; cut the dead policy.** Digest / batch_window_ms / quiet_hours /
  milestone_based+verbose phase-pings / question_batching are CUT. Pre-v1, so the schemas, templates,
  and doc sections are *deleted*, not deprecated — no migration path.
- **Enforced engine, not prompt-only.** The autonomy verdict is computed by the policy engine (enforced
  + observable), not rendered into the prompt for the agent to self-apply. The owner's latitude *is*
  rendered into the prompt as guidance, but the gate is real.
- **The runner consults, `next()` stays pure.** Per-decision consult belongs in the runner loop (which
  owns all observability); `next()` remains a pure routing function.
- **Alerts are deduped, not bypassed.** The requirements doc's multi-stage policy wanted "alerts bypass
  everything" so an alert is never *delayed*. With the policy cut, the only outbound stage left is
  dedup, and a flapping trigger alerting every tick must not flood the owner — that is exactly what the
  deleted `HEALTH_NOTIFY_COOLDOWN_MS` did. So alerts pass through the suppress window like everything
  else. (The "bypass" wording was a leftover from the cut policy; flagged for the owner's final confirm.)
- **Query-keyword wins on the ambiguous single-blocked case.** When exactly one task is blocked, a
  query-vocabulary message is treated as a query, not the reply — so the owner can ask `status`
  mid-block. The cost (a free-text reply literally containing "status" is read as a query) is
  acceptable single-user and documented.
- **Threshold with a missing metric → ask.** `evaluateThreshold` returns a 3-state outcome; an absent
  metric routes to `ask_human` (it silently proceeded before). "When in doubt, ask."
- **No new ObservationType, no new `comm.*` event.** Transient policy/route decisions belong in tracing
  (`decision_point` / `lifecycle` / `tool_execution`), not the replayable event ledger. The existing
  `autonomy_policy` decision is reused and now threads the full `traceScope` (it orphaned before).
- **SafetyQuery single-sourced.** The dead duplicate `schemas/orchestrator.ts` schemas
  (`SafetyQuerySchema` / `SafetyVerdictSchema` / `CommEventSchema` / `QuestionSchema` /
  `QuestionBatchSchema`) + their test were deleted; `SafetyQuery`/`SafetyVerdict` live on the interface.

---

## The Refine-over-Build Cuts (what was deleted, and why it is right)

- **`OrchestratorConfig.notification.*`** (digest, batch_window_ms, quiet_hours, milestone_based) — the
  dashboard is the always-on detail feed; a single owner's milestone channel is already low-volume.
- **`OrchestratorConfig.question_batching.*`** — the agent already batches per-phase questions into one
  outreach file; a second batching layer is redundant.
- **The dependency that would have been needed** (a cron + IANA-timezone library for digest +
  quiet-hours) — never added. Zero new dependencies.
- **Net effect:** `OrchestratorConfig` collapsed to `{review, observability}`; the one real survivor
  (`suppress_window_ms`) moved to `DaemonConfig` beside the router. Less config, less surface, less to
  document, nothing dead.

---

## Cross-Slice Handoffs

### Inbound (reserved/parked surface landing here)

- The reserved `OrchestratorConfig.notification.*` / `question_batching.*` knobs (parked by Slice 8,
  carried through Slice 9) — **cut** here.
- The Slice 9 cancel/label handoff (non-active cancel comment + `engineer:cancelled` cross-process
  label sync + the `writing-tickets.md` row) — **done** here, reaper-driven.

### Outbound / still deferred

- **Per-person `quiet_hours` + `notification_level`** (`PersonSchema.preferences`) — **DELETED in the
  owner's final review (Session 56).** Unwired dead scaffolding for the cut quiet-hours/notification-level
  features (zero code consumers); removed from the schema (incl. `NotificationLevelSchema`), `setup.ts`,
  both people templates, `people.md`, and the test fixtures, with all gates re-run green. If/when
  multi-user lands, per-person preferences return as a deliberate, wired feature — not dead config.
- **`AGENT_README` bundled mirror** (`cli/bundled/plugin-docs.ts`) has substantial **pre-existing**
  drift from the live `docs/plugins/agent/README.md` (stale intro, missing `trace_output_path`/`signal`
  rows). Out of Slice-10 scope (the agent adapter is not Slice-10-touched); flagged for a dedicated
  agent-docs sync.
- **`github-comm` `receive` capability** — still deferred (`future-considerations.md`).
- **LLM-parsed / conversational inbound queries** — the deterministic keyword interface ships; smart
  reply correlation for the 2+-blocked metadata-less case is in `future-considerations.md`.

---

## Session Breakdown (Sessions 57–63, each green-on-commit)

- **S1 (57):** notification-router refinement — observability + one suppress window + cut dead config +
  `review_reminder`→owner + typed `system.health_changed`. (`40849c9`, `d135bc3`, `c9c1ad3`, `4ae50c7`)
- **S2 (58):** cancel/label coverage, reaper-driven single emitter. (`06b97e8`)
- **S3 (59):** the decision-escalation engine + policy wiring + curated defaults + SafetyQuery cleanup +
  threshold-gap fix. (`ffa675e`, `8e6ed02`)
- **S4 (60):** ask round-trip — any-phase outreach, no-owner proceed, self-unblock exemption,
  `awaiting_human_decision` block category. (`8b499ed`)
- **S5 (61):** inbound query routing fix + enrichment + observability. (`0bde17e`, `2ebfb24`)
- **S6 (62):** AUDIT-1 — code + tests standards sweep. Cleared the router's three cognitive-complexity
  warnings (split along seams, emissions preserved verbatim), `NotificationKinds.alert` constant.
  (`fde4587`)
- **S7 (63):** AUDIT-2 — docs + bundled-mirror sweep. Synced the two hand-maintained mirrors to their
  live markdown; added the documented `review` block to the orchestrator templates. (`9f79082`)

---

## Closing Audit Verdict

The Slice-10 work was overwhelmingly clean — the per-session closing discipline held. AUDIT-1 found the
code FCIS-respecting, richly observed, with isolated failure boundaries and single-source types; its one
must-fix was the router's lint warnings. AUDIT-2 found the live docs accurate and the new behavior
(suppression, autonomy categories, cancel label, inbound query) documented in both live docs and the
bundled mirrors, the cut config fully gone from both, and the autonomy category vocabulary synced across
all four sources (`config.ts`, `templates.ts`, `agent-prompt.ts`, `safety.md`); it fixed four mirror/
template drifts and flagged the two out-of-scope items above.

## Lens Check

- **Resilience.** Positive. Outbound dedup keeps a flapping dependency from flooding the owner; the
  in-memory retry queue is preserved; a restart loses at most a transient ping, never information (task
  state is always in the DB). The no-owner edge never strands a task — it proceeds and records loudly.
- **Plugin Integrity.** Positive. No hardcoded plugin/channel names; every human-targeted message
  resolves through the people directory to the owner and is delivered by whatever comm plugin owns the
  channel. Core compiles and communicates with every plugin deleted; the inbound query path is
  capability-gated on `receive`.
- **Plugin Authoring Simplicity.** Neutral. No new adapter surface — Pillar A/B/C all use existing
  contract methods (`sendMessage`, `syncStateToCommPlugin`, `commentOnTicket`, `pollMessages`).
- **UX Quality.** Positive. The owner gets milestone-rich notifications without spam, governs
  discretionary calls by a curated-but-extensible policy, and can ask the system on demand from
  Telegram with no slash grammar to remember. Zero-config behaves sensibly; every knob is opt-in.
- **Observability.** Strongly positive — the slice's spine. Every fork (suppress, route, autonomy
  verdict, no-owner-proceed, cancel reconciliation) is a drill-down `decision_point`/`state_transition`;
  the outbound deliver/fail/retry path is emitted; the `awaiting_human_decision` block category is
  mirrored into both dashboard client files (parity-test-guarded). The owner can reconstruct the whole
  communication story from the emitted trail alone.

---

## Future Considerations

- **Per-person notification preferences** — if/when multi-user lands (the cut single-user constraint),
  `notification_level` + `quiet_hours` per person become real again; until then they are dead.
- **Smart reply correlation** — a subagent to disambiguate the 2+-blocked, metadata-less inbound case
  (`future-considerations.md`).
- **`github-comm` `receive`** — a second inbound channel beyond Telegram.

## Documentation Seed

For the documentation slice and this slice's own doc updates:
- **"How the owner stays in sync"** → milestone notifications + dedup window + the dashboard as the
  full feed.
- **"How autonomy works"** → the surface-vs-hard-block distinction, the curated category table, the
  ask round-trip, the no-owner degradation (`safety.md` § Autonomy).
- **"Ask the system on demand"** → the inbound query vocabulary + query-vs-reply classification
  (`plugins/communication/README.md` § Inbound queries).
- **"How a cancel is reconciled"** → the reaper-driven comment + `engineer:cancelled` label across
  every cancel path (`usage-guide/writing-tickets.md`).
