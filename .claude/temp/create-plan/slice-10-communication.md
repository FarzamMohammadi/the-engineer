# Plan: Slice 10 — Communication (refine-weighted)

> Build blueprint for the orchestrated sessions (Session 56). Authoritative scope. Pairs with
> `requirements-gathering/slice-10-communication.md` (intent) and `research/slice-10-communication.md`
> (the grounded design + file:line evidence). **Scope was narrowed (refine-over-build):** the heart is
> refinement/bug-fixes; ONE new capability (decision-escalation) is built; the rest of the reserved
> notification surface is CUT (dead config deleted).

## Final scope

**BUILD (one capability):**
- **Decision escalation** — wire the built-but-dead `should_i_ask` autonomy path: the agent surfaces
  discretionary decisions, the runner consults the owner's `safety.yaml` autonomy policy, `ask_human`
  blocks-and-asks, `proceed` continues. Activates existing dead config.

**REFINE / FIX (the heart):**
- Notification-router **observability** (it emits nothing to the dashboard today).
- **Unify suppression** (delete the hardcoded `HEALTH_NOTIFY_COOLDOWN_MS`; single-source dedup via one
  `suppress_window_ms`, moved to `DaemonConfig`).
- **Cancel/label coverage** (non-active cancel ticket-comment + `engineer:cancelled` cross-process label
  sync) and **review_reminder → owner** (single-user fix).
- **Ask round-trip**: close the answer-injection gap (owner's reply never reaches the agent today) and
  make `needs_human` deliver from any phase (today: requirements-only).
- **Inbound query**: fix the dead/mis-routed path (+ personId bug + latent double-dispatch).
- **Cleanups**: triple-defined `SafetyQuery` + dead `orchestrator.ts` schemas; untyped
  `system.health_changed` publish.

**CUT (delete dead config + templates + docs — refinement):**
- `digest` (overlaps the dashboard), `batch_window_ms`, `quiet_hours`, `milestone_based`/verbose
  phase-pings (all under `OrchestratorConfig.notification`), and `OrchestratorConfig.question_batching`
  (redundant — the agent already batches questions per person into one outreach file). After cuts,
  `OrchestratorConfig` = `{ review }`; the one survivor `suppress_window_ms` moves to `DaemonConfig`.

## Locked decisions
- Two-tier escalation (policy governs discretionary; agent still hard-blocks when stuck); broad-bounded
  (any phase, curated+extensible categories); no-owner → proceed + loud observation.
- Enforced-engine mechanism: agent surfaces `details.decisions[]`; the **runner** consults per decision
  (not `next()`, which stays pure); autonomy posture also rendered into the prompt as guidance.
- Curated category defaults in the safety template: `always_decide` = code_style, test_coverage,
  refactoring_local, doc_wording; `threshold` = scope_expansion, refactoring_broad; `always_ask` =
  architecture, dependencies, public_api, destructive, security. Unknown → always_ask (fail-safe).
- **Gate decisions:** discretionary blocks are **exempt from self-unblock** (reminders + escalation
  still fire); a threshold rule with a **missing metric → ask the owner** (fix current proceed-behavior).
- Query-vs-reply: **query-keyword wins** when exactly one task is blocked (documented).
- Observability: no new ObservationType, no new `comm.*` event. `recordDecision` (decision_point) for
  every fork (suppress / no-owner-proceed / inbound-route / autonomy — reuse the existing
  `autonomy_policy`); `lifecycle` instants for inbound-query-handled; thread full `traceScope` into the
  autonomy consult (today it orphans). Make the existing deliver/fail/retry path observable too.
- Single-user lens throughout; owner assumed-not-required (graceful warn); zero new dependencies;
  pre-v1 (delete dead config freely, no migration path).

## Sessions (sequential; each green, < ~500k tokens)

### S1 — A: notification-router refinement + dead-config cut  *(foundational)*
- **Do:** (1) Make the router observable — emit on deliver / send-fail / retry (reuse existing
  `comm.message_sent`/`comm.send_failed`/`comm.retry_*` events + add trace observations so the dashboard
  sees the outbound path). (2) Suppress unify — delete `HEALTH_NOTIFY_COOLDOWN_MS` + `healthNotifyCooldowns`
  + the tick Step-9 cleanup (`daemon/index.ts:155-156,581-585`); add a pure `suppress`-decision in the
  router keyed on `(messageType|kind, taskId | source)`; add a stable `source`/`dedup_key` to the alert
  Notification variant for null-task alerts; route the 5 health alerts + reaper-failure alert through it;
  alerts bypass suppression. Move `suppress_window_ms` to `DaemonConfig`. (3) **Cut dead config:** delete
  `OrchestratorConfig.notification` (digest/batch/quiet_hours/milestone_based) + `question_batching` and
  their `templates.ts` + `configuration/orchestrator.md` entries; `OrchestratorConfig` → `{review}`.
  (4) `review_reminder` resolves to the owner (single-user). (5) Fix the untyped `system.health_changed`
  publish (`daemon/index.ts:600`) — declare it in `EventTypeSchema` + payload, or route through the typed
  pattern.
- **Files:** `core/daemon/notification-router.ts`, `core/daemon/index.ts`, `core/daemon/health-monitor.ts`,
  `core/daemon/types.ts`, `schemas/config.ts`, `schemas/notifications.ts`, `schemas/events.ts`,
  `cli/bundled/templates.ts`, `cli/commands/start/bootstrap.ts`, `docs/configuration/orchestrator.md`.
- **Tests:** suppress dedup (identical within window → one delivered + suppress decision; advance clock →
  both); alerts bypass; review_reminder → owner; deliver/fail/retry now emit observations. FakeClock.
- **Acceptance:** no `OrchestratorConfig.notification`/`question_batching` anywhere; one suppress window;
  dashboard shows outbound deliver/fail/retry; `tsc`/lint/tests green; docs match.

### S2 — A: cancel/label coverage
- **Do:** in `reapCancelledTask` (before PR-close/early-return), emit the cancel `ticket_comment` (single
  emitter — **remove** the duplicate in `task-scheduler.ts:253-260`) and call
  `notifications.syncStateToCommPlugin(...)` directly (NOT a synthetic event) so `engineer:cancelled` is
  applied (diffStateLabels is dynamic — no label-set change). First-visit idempotency guard; best-effort
  (own try/catch; never block `markReaped`). Emit a state-transition/decision observation for the
  cross-process cancel. Retry self-heals on next dispatch (no hook). `writing-tickets.md` +=
  `engineer:cancelled`.
- **Files:** `core/workspace-reaper/index.ts`, `core/daemon/task-scheduler.ts`,
  `docs/usage-guide/writing-tickets.md` (+ bundled mirror if touched).
- **Tests:** queued-cancel & blocked-cancel each → source-ticket comment + `engineer:cancelled` label;
  active-cancel → exactly one comment (no double); reaper retry → no re-comment.
- **Acceptance:** every cancel path comments + syncs the label once; owner not DM'd; gates green.

### S3 — B: decision-escalation engine + policy wiring
- **Do:** add a generic `DecisionsSchema` (`z.array({category, summary, chosen, reasoning, details?})`)
  validated centrally in `agent-step.mapResult` so ANY phase can surface decisions; the **runner**, after
  `emitSubPhaseResult` and before routing, consults `ctx.safetyLayer.consultJudgment({type:"should_i_ask",
  …})` per decision (thread full `traceScope`); `ask_human` on any → block carrying the synthesized
  question, `proceed` → record + continue. Render the autonomy posture + category vocabulary into a shared
  prompt section. Populate the safety template `autonomy.decisions` with the curated defaults. Fix
  `evaluateThreshold` to ask on absent metric. Reconcile `SafetyQuery` (delete the dead `orchestrator.ts`
  schemas `SafetyQuerySchema`/`SafetyVerdictSchema`/`CommEventSchema`/`QuestionSchema`/`QuestionBatchSchema`
  + their test; align interface/input-schema).
- **Files:** `core/orchestrator/pipeline/{agent-step,runner,types,agent-prompt}.ts`, the prompt section;
  `core/safety-layer/{index,policy-engine}.ts`, `core/interfaces/safety-layer.interface.ts`,
  `schemas/orchestrator.ts`, `cli/bundled/templates.ts` (safety autonomy defaults),
  `docs/configuration/safety.md`.
- **Tests:** always_ask category blocks+asks; always_decide proceeds silently; threshold asks only when
  exceeded; absent metric → ask; each records `autonomy_policy` nested in the dispatch trace.
- **Acceptance:** a discretionary decision in any phase is policy-judged + observable; `SafetyQuery`
  single-sourced; gates green; safety.md documents the categories.

### S4 — B: ask round-trip refinement
- **Do:** generalize `deliverOutreach` + the responses dir beyond hardcoded `requirements/` (resolve from
  the blocking `sub_phase`) — fixes `needs_human` from any phase. **Close the answer-injection gap:** route
  the owner's reply into the resumed agent's context (set `ResumeState.carry` from the response file on
  unblock-resume so `buildCarrySection` renders it). No-owner ask → proceed + loud `decision_point`
  (confidence < 1, warn) in the runner (getOwner check lives in the runner, not the safety layer). Exempt
  discretionary `awaiting_human` blocks from `evaluate_self_unblock` (keep reminders + escalation).
- **Files:** `core/orchestrator/index.ts` (deliverOutreach, resolveResume/carry), `core/orchestrator/
  outreach-sender.ts`, `core/daemon/unblock-resolver.ts`, `core/daemon/health-monitor.ts`
  (self-unblock exemption), `core/orchestrator/pipeline/{runner,agent-prompt}.ts`, docs (safety.md /
  a user-flow note).
- **Tests (critical):** the resumed agent prompt **contains the owner's reply text** (the gap-closer);
  a `needs_human` from a non-requirements phase delivers a question; no-owner ask proceeds + records the
  decision, task not stranded; a discretionary block is NOT auto-self-unblocked.
- **Acceptance:** ask → owner answers → agent resumes seeing the answer, end-to-end; gates green.

### S5 — C: inbound query routing fix + enrichment
- **Do:** classify inbound in the response-poller BEFORE the sole-blocked fallback (linked→reply;
  unlinked+query-vocab→query; unlinked+sole-blocked+non-query→reply; unlinked+0/2+blocked→query;
  **query-keyword wins** on the ambiguous single-blocked case). Call `handleQuery` directly (still publish
  a `task_id=null` audit event); widen `ResponsePollerContext` with `safetyLayer`/`notifications`/
  `peopleDirectory`; close the external_ref double-dispatch; fix `status_response` to resolve to the
  **owner** (not the raw sender). Enrich `status`/`progress`/`cost`/`help` (ids+titles, blocked.reason,
  spend-vs-limit) while staying short; 2+-blocked unmatched → owner-facing "couldn't match" reply.
  Observability: `inbound_route` decision + `inbound_query_handled`. Clean the stale `daemon:comm`
  topology comment.
- **Files:** `core/daemon/{response-poller,query-handler,index,types}.ts`, `docs/plugins/communication/*`
  (+ bundled mirror), `docs/future-considerations.md` (correct the unparsed-token claim).
- **Tests:** sole-blocked + "status" → query (reaches handleQuery); sole-blocked + free text → unblock;
  0 and 2+ blocked + "status" → query; PR-review-pending non-regression; status_response → owner.
- **Acceptance:** owner can query from Telegram in every blocked-count case; gates green.

### S6 — AUDIT-1: code + tests sweep (Slice-10 files only)
- Full-file line-by-line sweep of every Slice-10-touched source + test file vs `coding-standards.md` +
  `anti-patterns.md` + the three observability tests (debuggability / owner-sync / external-reach) from
  `philosophy.md` and `architecture/observability.md`. Fix what falls short. Per `feedback_slice_closing_
  standards_sweep` — hunt deliberately, don't just read.

### S7 — AUDIT-2: docs + bundled-mirror sweep (Slice-10 docs only)
- Docs vs docs-as-system-blueprint + no-stale-counts; **diff `cli/bundled/plugin-docs.ts` + `templates.ts`
  against the live markdown** (mirror-drift). Confirm every changed contract/behavior/config has its doc
  update. Scope to Slice-10-touched docs only.

## Sequencing & context handoff
- Order: **S1 (foundational) → S2 → S3 → S4 → S5 → S6 → S7.** Strictly sequential — each builds on the
  prior's commits.
- Each session: reads `AGENT-README.md` + persona + `README.md` + `coding-standards.md` +
  `anti-patterns.md` + (`architecture/observability.md` when emitting) + this plan + the research +
  requirements docs + the **prior session's `sessions/N.md` + `active.md`**; does its scope; updates
  `docs/archived/implementation-docs/9-oss-ready/active.md` + writes `9-oss-ready/sessions/N.md`; commits
  green (cohesive, grouped commits). Context flows session→session through those tracking files (the
  proven mechanism).

## Orchestration
- All work happens in **one shared git worktree** (`slice10-communication` branch); the workflow runs the
  7 sessions sequentially there. Nothing touches the main checkout until the final review.
- **Final review (me, hands-on, after the workflow):** read every commit + diff + word; verify against
  this plan AND coding-standards/anti-patterns/observability + the Definition of Done; re-run gates;
  hand-check the answer-injection acceptance test and the suppress/cancel/label/query behaviors; fix any
  gaps myself; then merge the worktree → main.

## Risks
- The notification-router and the pipeline runner are load-bearing; a regression goes silent (owner goes
  dark / a decision skips the owner). Mitigation: observability-first (S1), the answer-injection
  acceptance test (S4), alerts-bypass tested first.
- Mirror drift (`plugin-docs.ts`/`templates.ts`) — AUDIT-2 diffs them line-by-line.
- Generalizing outreach/responses beyond `requirements/` must not regress the one working ask path.
