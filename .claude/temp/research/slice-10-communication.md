# Research: Slice 10 — Communication

> Synthesis of the 5-dive research pass (Session 56). Facts cite `file:line`. Pairs with the locked
> requirements (`.claude/temp/requirements-gathering/slice-10-communication.md`). Decisions tagged
> `[GATE]` need Farzam's call before/at planning; everything else is resolved.

## Observations (facts, grounded)

### Pillar A — outbound notification policy + plumbing
- **The router is policy-blind.** `createNotificationRouter` (`notification-router.ts:73`) returns `{notify, syncStateToCommPlugin, processRetries}`; `notify()` (`:214`) sends immediately. Context carries only `notification_retry` + `clock` + `observer` (`:17-25`) — no `OrchestratorConfig.notification`/`question_batching`.
- **Plumbing seam:** the router is built in `bootstrap.ts:171-179` and shared by Orchestrator (`:196`) and Daemon (`:228`). `config.orchestrator` is already in scope at bootstrap (`:183`). The Daemon receives `DaemonConfig`, NOT OrchestratorConfig (`daemon/index.ts:145`) — so the **router (via bootstrap injection) is the only clean carrier** for the policy; a "daemon reads policy and gates" design is ruled out.
- **The 4 "ad-hoc mechanisms" — layered, not all duplicates.** Only `HEALTH_NOTIFY_COOLDOWN_MS=300_000` + `healthNotifyCooldowns` (`daemon/index.ts:155-156`, cleanup `:581-585`) truly duplicates `suppress_window_ms` (same 5m). `blockedEscalationState`/`reviewReminderTimes` (`health-monitor.ts:61-62`) are **generation-timing** (when to fire intentional repeats) and the **retry queue** (`notification-router.ts:87`) is **delivery-retry** — all distinct, all KEEP; their output flows *through* the new policy.
- **Alert classification:** `cost_limit` is a *kind* that maps to an *alert* messageType (`notification-router.ts:47`). The "alerts bypass" rule must key on resolved `messageType` (`kindToMessageType`, `:197-210`), not the kind name. Milestones = completion/review_pending; alerts = task_error/cost_limit/escalation_alert.
- **No cron, no timezone library** in `package.json` (only `ms`, `grammy`). `digest.schedule` (cron) and `quiet_hours.timezone` (IANA) have **no evaluator anywhere**. Duration parsing is schema-driven and only touches `ZodNumber` (`config/loader.ts:335`) — `schedule`/`channel` strings pass through untouched.
- **The router emits NOTHING to the observation store today** — deliver/fail/retry are `observer.debug/info/warn` logs only. Under maximal-observability, the *entire outbound path is invisible to the dashboard* now.
- `digest.channel` default is the literal `"telegram"` (`config.ts:294`) — the one Plugin-Opacity violation. `bootstrap.ts:343-349` already computes `availableChannels` from comm plugins' `adapter_meta.channel` — the resolution machinery exists.
- `task.state_changed` is published only by `requestTransition` (`state-machine.ts:153-166`); the daemon already subscribes (`daemon:state-sync`, `index.ts:316-319`) → `syncStateToCommPlugin`.

### Pillar B — decision escalation
- **The autonomy machinery is built, tested, ZERO production callers.** `consultJudgment("should_i_ask")` (`safety-layer/index.ts:165-185`) → `policyEngine.evaluateAutonomy` (`policy-engine.ts:210-273`) → records an `autonomy_policy` decision (`:172-183`). Only `cost_check` is live (`query-handler.ts:101`). Agent runs dispatch as `actionClass:read` (`agent-step.ts:305`), which skips Gate 2 — so the autonomy verdict is genuinely unreachable.
- **The agent contract** is `session-result.json` `{status, summary, details?}` (`agent-step.ts:24-28`); `details` is schema-validated per sub-phase and becomes `SubPhaseResult.data` (`:211-226`). **Precedent for structured surfacing:** `grounding.ts:31` (`details.complexity`) and `refine.ts:37,59` (`details.verdict` routed by `next`).
- **The runner owns all observability** (`runner.ts`: `emitSubPhaseResult :405`, `emitRouteDecision :451`, `emitBlock :502`). `next()` is pure. So an enforced per-decision consult belongs in the runner loop (a sub-phase "cannot forget to be consulted").
- **The ONLY ask path today is `requirements/gather`.** Every phase's `next` maps `needs_human→block{awaiting_human}`, but only `gather` writes outreach files AND `deliverOutreach` **hardcodes `requirements/outreach`** (`orchestrator/index.ts:332`). → A `needs_human` from any non-requirements phase blocks with **no question delivered** (latent bug).
- **THE DEEPEST FINDING — the answer-injection gap.** The owner's reply is written to `requirements/responses/…` (`unblock-resolver.ts:137-153`) and the task re-queues, but **no prompt reads that dir** (grep: zero readers) and unblock-resume sets **no `carry`** (`resolveResume`, `index.ts:111-125`). So the owner answers, the task resumes, and **the agent never sees the answer.** The requirements doc's "agent re-runs seeing the reply, per existing rework behavior" describes behavior that **does not exist** (rework uses `carry`; unblock-resume uses neither). Must be designed + built, with an explicit test that the resumed prompt contains the reply.
- **`SafetyQuery` is a TRIPLE source** — `interfaces/safety-layer.interface.ts:5`, `safety-layer/index.ts:23-32` (optional), `schemas/orchestrator.ts:49-59` (nullable, divergent). The orchestrator.ts ones (+ orphan `CommEventSchema`/`QuestionSchema`/`QuestionBatchSchema`) are imported **only by their own test** — dead.
- **`autonomy_policy` observation passes only `{task_id}`** scope (`index.ts:182`) — it would orphan off the dispatch trace tree. `consultJudgment`/`recordDecision` must thread full `traceScope(ctx)` (contract change).
- **The escalation ladder auto-fires on discretionary blocks.** `processBlockedStages` (`health-monitor.ts:141`) runs on ALL blocked except `pr_review_pending`; `evaluate_self_unblock` at 8h can auto-resume via `attemptSelfUnblock` (`orchestrator/index.ts:419-431`) — potentially resolving a discretionary ask **without the owner answering**. New scope.
- **`evaluateThreshold` returns false→proceed when the metric is absent** (`policy-engine.ts:50-52`) — contradicts the requirements doc ("absent→ask_human"). The doc is wrong about current behavior.
- The safety template ships `autonomy.decisions: {}` (`templates.ts:486`), so **today every category resolves to `always_ask`** (unknown-fallback). Curated defaults are a NEW addition, not a tweak.

### Pillar C — inbound query
- **`handleQuery` IS wired** (`daemon:comm` subscription, `index.ts:297-314`, fires when `payload.task_id` is null). Event topology is declarative-only — `subscribe` is unconditional (`event-bus/index.ts:168-170`), so the "deferred" comment (`bootstrap.ts:240-241`) is stale; the subscription is live.
- **The dead path is upstream:** `response-poller.processInboundMessage` (`:160-207`) links every Telegram message to a task (metadata or sole-blocked fallback `:165-173`), publishes with a non-null `task_id`, and calls `tryUnblock` — OR discards (0/2+ blocked, `:175-182`). So a task-less event never reaches `handleQuery`; a Telegram "status" with one task blocked is **mis-attributed as an unblock reply.** The fix is **query-vs-reply discrimination in the poller**.
- **Latent double-dispatch:** a Telegram message carrying an `external_ref` would publish with `task_id=null` (`:188`) AND call `tryUnblock` (`:200`) — both query and unblock. Doesn't fire today (Telegram sets no external_ref) but is a real trap to close.
- Telegram **drops `/`-prefixed messages** except `/start` (`telegram-comm.ts:231-239`) — so the vocabulary must be slash-free (`status`/`cost`/`progress #N`/`help`, exactly what `query-handler` already matches).
- **personId routing is accidentally-correct:** `handleQuery` sets `personId` to the raw Telegram username (`query-handler.ts:50`), which `getPerson()` can't resolve (keys by id) → silent `getOwner()` fallback (`notification-router.ts:128`). Works only in single-user by accident.
- **`handleQuery` emits nothing** to the observation store — inbound is invisible.
- The dashboard has **no query endpoint** (only `/respond`, task-scoped) — inbound queries are **Telegram-only** in v1.

### Cross-cutting (observability / tests / docs / config)
- **Observation enum** (`observer.ts:12-25`): `task_execution, agent_call, tool_execution, phase_transition, decision_point, safety_verdict, state_transition, workspace_op, plugin_call, error, lifecycle, quota_status`. **No new type needed** — name via the `name` field. **No new `comm.*` event** (transient policy decisions belong in tracing, not the replayable ledger — `observability.md:38-39`).
- **Config is startup-only** (`configuration/README.md:30`; orchestrator.md/safety.md "Hot-reload: No"). So **autonomy hot-reload is a non-question** — policy captured at bootstrap. (Note: `people.yaml` template wrongly claims hot-reload — a pre-existing doc/code inconsistency.)
- **`src/cli/bundled/plugin-docs.ts` (100KB) + `templates.ts` (44KB) hand-mirror** `docs/plugins/communication/*` and the config templates — any doc edit must update the mirror in the same unit (§11), or bundled docs drift.
- **Pre-existing bug found:** `daemon/index.ts:600` publishes `system.health_changed`, which is **not in `EventTypeSchema`** and has no payload schema — an untyped publish. Slice 10 touches index.ts; fix or the audit flags it.

## Resolutions (the design, per pillar)

**A — Plumbing:** extend `NotificationRouterContext` to carry `notification: NotificationConfig` + `question_batching: QuestionBatchingConfig`; inject from `config.orchestrator` in bootstrap; update 2 test helpers + the unit mock-context. Clock already present.

**A — Pipeline:** a pure `decideDelivery(notification, policy, state, now)` (FCIS) the imperative `notify()` routes on. Alerts (by resolved messageType) bypass → suppress → batch → quiet-hours → deliver. Make the *existing* deliver/fail/retry path observable too.

**A — Suppress:** remove `healthNotifyCooldowns` + cleanup; move dedup into the suppress stage keyed on `(messageType-or-kind, taskId | source)`. **Null-task alerts need a stable `source`/`dedup_key`** on the alert Notification variant (schema addition) so trigger/plugin alerts still dedup per-source.

**A — Batch/defer flush:** `notifications.processPending?.(now)` beside `processRetries` at tick Step 4 (`index.ts:558`), driven by `clock.now()` — NOT `setTimeout` (FakeClock-testable, consistent with existing cadence hooks). Questions batch on their own buffer + `question_batching` window/max.

**A — Quiet hours:** opt-in; deferred non-alerts flush at window-end; blocking questions deferred too; alerts bypass via `allow_alerts`. Disabled = pure no-op, no warn.

**A — Digest:** new decoupled module shaped like `data-lifecycle` (`{start,stop,runDigest,getLastRun}`, injected Clock, config-gated); reads task state per `digest.include` and `notify()`s — never on the live suppress/batch path. Built in bootstrap, started/stopped by the daemon. `[GATE: cron+tz mechanism]`. `digest.include` += `cancelled`.

**A — digest.channel opacity:** default off `"telegram"` (→ `""`/nullable); resolve at send-time: explicit-channel-if-plugin-handles-it → owner's first contact channel → first available send-capable plugin; warn if none. Reuses `findPluginForChannel` + `availableChannels`.

**A — milestone_based=false:** thin path — a daemon subscription to `task.state_changed` emits a phase-ping notification; the router's policy drops it when `milestone_based=true` (gating in one observable place). Filter to meaningful phase transitions.

**A — cancel/label (A8):** **reaper-driven.** In `reapCancelledTask` (`workspace-reaper/index.ts:277`), before the PR-close/early-return: emit the cancel `ticket_comment` (single emitter — **remove the duplicate** from `task-scheduler.ts:253-260`) and call `notifications.syncStateToCommPlugin(...)` directly (NOT a synthetic `task.state_changed`, which would also wake cost-tracker). `diffStateLabels` is dynamic — `engineer:cancelled` works with **no label-set change**. First-visit guard for idempotency; best-effort (own try/catch; do not block `markReaped`). Retry self-heals on next dispatch (no hook). Reaper-failure alert already routes correctly once the policy is live. `writing-tickets.md` += `engineer:cancelled`.

**B — Mechanism (enforced engine + prompt guidance):** add a generic `DecisionsSchema` (`z.array({category, summary, chosen, reasoning, details?})`) validated centrally in `agent-step.mapResult` so ANY phase can surface decisions; the **runner** (after `emitSubPhaseResult`, before routing) consults `ctx.safetyLayer.consultJudgment({type:"should_i_ask", …})` per decision — `ask_human` on any → block carrying the synthesized question; `proceed` → record + continue. Render the autonomy posture + category vocabulary into a shared prompt section (engine enforces, prompt informs). Thread full `traceScope(ctx)` into the consult.

**B — Categories (template defaults):** `always_decide`: code_style, test_coverage, refactoring_local, doc_wording. `threshold (files > N)`: scope_expansion, refactoring_broad. `always_ask`: architecture, dependencies, public_api, destructive, security. Open/extensible (unknown→always_ask fail-safe). Prompt vocabulary and template keys must stay in sync.

**B — Round-trip:** generalize `deliverOutreach` + the responses dir beyond `requirements/` (resolve from the blocking `sub_phase`). **Close the answer-injection gap:** route the owner's reply into the resumed agent's context — set `ResumeState.carry` from the response file on unblock-resume (consistent with rework rendering via `buildCarrySection`), or add a `buildResponsesSection`. Acceptance test: resumed prompt contains the reply text.

**B — No-owner:** runner checks `getOwner()`; if null on an `ask_human` verdict → proceed + a loud `decision_point` (confidence < 1, warn) naming the decision made without the owner. The check lives in the runner, NOT the safety layer (owner-agnostic).

**B — SafetyQuery:** delete the dead `schemas/orchestrator.ts` schemas (`SafetyQuerySchema`, `SafetyVerdictSchema`, `CommEventSchema`, `QuestionSchema`, `QuestionBatchSchema`) + their test; reconcile to the interface + the input-validation schema; align nullable/optional.

**C — Reachable routing:** classify in `response-poller` BEFORE the sole-blocked fallback: linked→reply; unlinked + query-vocab→query; unlinked + sole-blocked + non-query→reply; unlinked + (0 or 2+ blocked)→query. Call `handleQuery` directly (still publish a `task_id=null` audit event); widen `ResponsePollerContext` with `safetyLayer`/`notifications`/`peopleDirectory`. Close the external_ref double-dispatch. Fix `status_response` to resolve to the **owner** (not echo the raw sender). `[GATE: query-vs-reply precedence when exactly one task is blocked]`.

**C — Vocabulary + UX:** keep `status`/`progress #N`/`cost`/`help` (slash-free); enrich formatters (ids+titles, `blocked.reason`, real spend-vs-limit) while staying short; turn the 2+-blocked unmatched discard into an owner-facing `status_response` ("couldn't match — N blocked").

**Observability (all pillars):** no new type/event. `decision_point` (recordDecision, with road-not-taken) for suppress / batch-flush / quiet-defer / no-owner-proceed / inbound-route / autonomy (reuse existing `autonomy_policy`); `lifecycle` instant for batched-enqueue / quiet-flush / inbound-query-handled; `tool_execution` span for digest-send (reusing the existing `comm.message_sent` event). **Also make the existing deliver/fail/retry path observable.**

## Decision Gates (need Farzam — surfaced, not silently picked)

1. **`[GATE]` Cron + timezone mechanism for digest + quiet hours.** No lib exists. **Rec: add `croner`** (zero-dep, TS-native, IANA-timezone-aware, `nextRun()`) — it solves BOTH the digest cron and the quiet-hours timezone in one proven dep. Alternative: hand-roll cron next-fire + `Intl.DateTimeFormat` tz checks (non-trivial: DST/IANA). Tooling/dep call is Farzam's.
2. **`[GATE]` Pillar C query-vs-reply precedence when exactly one task is blocked.** **Rec: query-vocabulary wins** (owner can ask `status` mid-block; the cost is a free-text reply literally containing "status"/"cost" is treated as a query — acceptable single-user, documented). Alternative: reply-wins (owner can't query while one task is blocked).
3. **`[GATE]` Discretionary block × self-unblock ladder.** A discretionary `awaiting_human` block inherits the blocked-stages ladder; `evaluate_self_unblock` at 8h could auto-resume without the owner answering. **Rec: exempt autonomy/discretionary blocks from `evaluate_self_unblock`** (the point is the owner decides) — keep reminders + escalation.
4. **`[GATE]` `evaluateThreshold` absent-metric behavior.** Code proceeds; the requirements doc said ask. **Rec: fix to `ask_human` on absent metric** (conservative, matches "when in doubt, ask").
- **Decide-and-document (mention, veto-able), not gates:** reuse an existing `MessageType` for the digest (don't add `digest` type) → avoids touching the contract suite + 3 plugins; fix the untyped `system.health_changed` publish while in `index.ts`; correct the `people.yaml` hot-reload doc claim if cheap.

## New scope discovered (beyond the requirements doc)
- The **answer-injection gap** (B) — load-bearing, must build.
- **needs_human only works from requirements** (B) — latent bug to fix in the round-trip work.
- The **router emits nothing to the observation store** — outbound path invisible; observability scope is bigger than "new policy actions."
- **Null-task alert suppress key** needs a schema discriminator.
- **`autonomy_policy` scope threading** (orphaned trace) — mandatory fix.
- **Escalation-ladder × discretionary block** interaction (gate 3).
- Dead `schemas/orchestrator.ts` schemas + the untyped `system.health_changed` publish — cleanups the audit will flag.

## Proposed session decomposition (each focused, < ~500k tokens, sequential)
- **S1 — A: plumbing + suppress + observability spine (foundational).** Context extension + bootstrap injection; pure `decideDelivery` skeleton; suppress stage (remove `healthNotifyCooldowns`, alert source discriminator); make deliver/fail/retry observable; alerts-bypass. Tests.
- **S2 — A: batch + quiet-hours + milestone_based.** Batch + defer buffers; `processPending(now)` tick hook; timezone (gate 1); question-batch buffer; phase-pings; review_reminder→owner. Observations. Tests.
- **S3 — A: digest + cancel/label coverage.** Digest scheduler (gate 1) + channel opacity + include `cancelled`; reaper-driven cancel comment + label sync (remove scheduler dup, idempotency guard); reaper-alert verification. Tests + docs (writing-tickets, orchestrator.md).
- **S4 — B: decision-surfacing engine + policy.** `DecisionsSchema` + central validation; runner consult; `traceScope` threading; autonomy template defaults; SafetyQuery reconcile; prompt vocabulary; threshold-absent fix (gate 4). Tests.
- **S5 — B: round-trip + no-owner + escalation interaction.** Generalize outreach/responses beyond requirements; **close the answer-injection gap** (carry on resume) with the prompt-contains-reply test; no-owner proceed+observe; self-unblock exemption (gate 3); end-to-end acceptance tests. Docs.
- **S6 — C: reachable query routing + enrichment.** Poller classification (gate 2); widen context; direct `handleQuery`; personId→owner; close double-dispatch; enrich formatters; 2+-blocked→owner reply; inbound observability. Tests + docs.
- **S7 — AUDIT-1 (code + tests):** full-file line-by-line sweep of the ~20 touched source files + tests vs coding-standards / anti-patterns + the 3 observability tests (debuggability / owner-sync / external-reach).
- **S8 — AUDIT-2 (docs + mirror):** docs vs docs-as-system-blueprint + no-stale-counts; diff `plugin-docs.ts` / `templates.ts` against the live markdown.

Sequencing: S1 is foundational (B reuses the router). A (S1–S3) → B (S4–S5) → C (S6, independent) → audit (S7–S8). B feeds A's question-batch buffer (built S2, exercised S4–S5).
