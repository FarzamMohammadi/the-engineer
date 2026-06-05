# Requirements: Slice 10 — Communication

> **Status:** DRAFT, in active collaboration (Session 56). Decisions below are Farzam-confirmed via
> Q&A unless tagged `[REC]` (my recommendation, awaiting confirm), `[RESEARCH]` (resolve in the
> research phase), or `[PLAN]` (resolve in create-plan). This is the requirements artifact for the
> whole slice; research + plan follow.

## Context

Slice 10 wires The Engineer's **full communication layer** — its voice (outbound) and its ears
(inbound) and its judgment about when to involve the owner (decision escalation). All of it is
**reserved scaffolding that is validated-but-dead today**: the notification-router sends every
message the instant it's called with no policy awareness; the `should_i_ask` autonomy path is fully
built but has zero production callers; the inbound query handler is unreachable. Scope was confirmed
as **all three pillars** (A + B + C), built to the project's "done done" bar.

## True Intent

The single owner stays **in sync and in control without being spammed**:
- **A — Outbound policy:** proactive notifications, tuned by the owner's policy (milestone level,
  suppression, batching, quiet hours, digest), reaching the owner's channel.
- **B — Decision escalation:** the agent consults the owner's autonomy policy before *discretionary*
  decisions and asks when configured to — the "should I ask?" half of communication.
- **C — Inbound query:** the owner can ask the system for status on demand from their comms channel.

## Governing Constraints (apply as lenses to every pillar)

1. **Single-user** (`docs/constraints.md`): the human side is exactly one person — the owner. Every
   human-targeted message, question, and query resolves to the owner. The people-directory role model
   (owner / reviewers / domain-expert) **stays as forward-scaffolding** — not deleted — but we build
   **no** multi-person fan-out or per-role routing. One contact, handled well.
2. **Owner assumed, not required**: missing owner is a WARN, never a hard-fail. Each pillar degrades
   gracefully when no owner is configured (see Edge Cases).
3. **Zero-config works; every policy knob is opt-in.** `quiet_hours` and `digest` default off and are
   never required; their absence is **silent** (no warning) and makes that pipeline stage a pure
   no-op. The only absence ever warned about is the owner contact itself.
4. **Plugin Opacity** (invariant): no hardcoded plugin/channel names. Fix `digest.channel`'s literal
   `"telegram"` default.
5. **Maximal observability**: every suppress / batch / defer / digest / autonomy-escalation action is
   a first-class, drill-down observation. The owner must be able to see *why* a message did or did not
   arrive in real time.
6. **Prompts are preview; don't over-engineer.** Especially: no multi-person edge handling.

## Scope

### In Scope

**Pillar A — Outbound notification policy**
- Wire `OrchestratorConfig.notification.*` + `question_batching.*` into the notification-router.
- A layered delivery pipeline: generation-timing (existing) → **policy** (suppress / batch /
  quiet-hours / digest) → delivery (existing).
- The cancel/label coverage deferred from Slices 8–9 (see below).
- Observability for every policy action.

**Pillar B — Decision escalation (owner consultation)**
- Wire the built-but-dead `should_i_ask` → `evaluateAutonomy` path with a production caller.
- The agent surfaces *discretionary* decisions (category + details) in any phase; the owner's
  autonomy policy decides proceed-vs-ask; "ask" reuses the existing block → outreach → unblock →
  resume plumbing.

**Pillar C — Inbound comms-query**
- Fix the dead query-vs-reply routing so general queries reach a handler.
- A deterministic keyword query interface (status / progress #N / cost / help) with rich responses.

**Deferred items folded in (from Slices 8–9 → Slice 10):**
- Cancel `ticket_comment` for **non-active** cancels (today active-only).
- Reaper-failure `alert` routing through the notification policy (the alert already fires).
- `DigestConfig.include` `cancelled` entry.
- `engineer:cancelled` comm-plugin label + **cross-process label sync** (cancel and `engineer retry`
  are raw DB writes that emit no `task.state_changed`, so `syncStateToCommPlugin` never fires; cancel
  is terminal so it never self-corrects). Plus the `engineer:cancelled` row in
  `docs/usage-guide/writing-tickets.md`.

### Out of Scope (deliberate)

- Multi-person / multi-role fan-out, per-role routing (single-user constraint).
- Durable pending-notification persistence — pending sends are **in-memory**, consistent with the
  existing retry queue (a restart loses a ping, never information; task state is always in the DB).
- LLM-parsed / conversational queries (cost + non-determinism); slash-command grammar (telegram-comm
  filters `/`-prefixed messages).
- A fully-general / open-ended autonomy framework (we ship a curated, owner-extensible category set).
- `github-comm` `receive` capability (still deferred — `future-considerations.md`).

## Requirements

### Pillar A — Outbound Notification Policy

**A1. Comms level (`milestone_based`, default true).** The owner's channel stays signal-rich:
milestone-level messages only (pickup, PR-awaiting-review, completion, alerts, reminders, questions).
`milestone_based=false` opts into extra **phase-transition** pings for a chattier channel. Full
phase-by-phase depth always lives in the dashboard, never the DM feed. `[REC]` building the
`false` mode is a thin add (subscribe to `task.state_changed` → notify when verbose) — sized in
`[RESEARCH]`.

**A2. Layered pipeline.** A generated notification flows: **alerts bypass everything** (delivered
immediately; `quiet_hours.allow_alerts` honored) → **suppress** → **batch** → **quiet-hours** →
deliver. Digest is a parallel, decoupled roll-up (A6), not a pipeline stage.

**A3. Suppression (`suppress_window_ms`, default 5m).** An identical `(kind, task)` within the window
is dropped as a duplicate; the suppressed count is observable. This **replaces** the hardcoded
`HEALTH_NOTIFY_COOLDOWN_MS` (same 5m value) — the one true duplicate among the ad-hoc mechanisms.

**A4. Batching (`batch_window_ms`, default 2m).** Non-alert notifications to the owner within the
window coalesce into one message. Questions batch on their **own** window (`question_batching`:
default 30s, max 5) since Pillar B feeds them. `[REC]` partial batches flush on window-elapse or
max-size, whichever first.

**A5. Quiet hours (opt-in, default off).** When enabled, non-alert notifications generated during the
window are **deferred and flushed at quiet-hours end** (not dropped). Blocking questions **respect
quiet hours** (deferred too) — the owner opted into the boundary; the task waits (blocked, not
failed; nothing lost). Alerts bypass via `allow_alerts`. When disabled/unconfigured: pure no-op,
immediate delivery, no warning.

**A6. Digest (opt-in, default off) — supplement mode.** When enabled, a periodic (cron) roll-up of
task states (`digest.include`) is sent **in addition** to real-time notifications — it never
suppresses or replaces them. Architecturally decoupled: a scheduled reader of task state, untangled
from the live suppress/batch path. `digest.include` gains a `cancelled` entry.

**A7. Plugin-opacity fix.** `digest.channel` must not default to the literal `"telegram"`; it
resolves to the owner's configured channel / an available comm plugin. `[RESEARCH]` exact
resolution.

**A8. Cancel/label coverage.** Non-active cancels comment on the source ticket and flip the label to
`engineer:cancelled`; cross-process state writes (cancel, retry) sync the comm-plugin label;
`writing-tickets.md` documents `engineer:cancelled`. The owner is **not** DM'd about a cancel they
initiated. `[RESEARCH]` the label-sync mechanism (likely the daemon emitting `task.state_changed` on
detection).

**A9. Unify (layered, not flatten).** Remove only `healthNotifyCooldowns`. Keep `blockedEscalationState`
and `reviewReminderTimes` (generation-timing — *when* to fire intentional repeats) and the retry
queue (delivery retry). Their output flows through the new policy pipeline.

### Pillar B — Decision Escalation

**B1. Two-tier relationship.** `should_i_ask` governs **discretionary** decisions: the agent surfaces
a decision + category, the owner's autonomy config decides proceed-vs-ask. The agent **also** retains
its existing **hard-block** when it genuinely cannot proceed (missing requirement, ambiguous spec) —
that is not an autonomy choice.

**B2. Broad but bounded scope.** The agent can surface a discretionary decision in **any phase** where
one genuinely arises; each is policy-checked; v1 ships a **curated, owner-extensible** category set;
reuses the existing block → outreach → unblock → resume plumbing (generalizing today's
requirements-only pattern).

**B3. Default posture — conservative but curated.** Ship a known category vocabulary the agent is
taught, and populate the safety template with sensible defaults: safe categories (e.g. `code_style`)
→ `always_decide`; risk/irreversibility categories (e.g. `scope_expansion`, `architecture`,
`dependencies`, `destructive`, `public_api`) → `always_ask`. `[RESEARCH]` the exact curated list,
grounded in the pipeline's real decision points and reversibility/risk.

**B4. No-owner edge — proceed + loud observation.** When a decision escalates to "ask" but no
owner/contact is configured, the agent **proceeds autonomously** and emits a loud, drill-down
observation naming the decision made without the owner. Never strands the task. (Matches
`constraints.md`: "the daemon still runs… the warning makes the trade-off visible.")

**B5. Observability.** Each consultation records the existing `autonomy_policy` decision observation
(alternatives, chosen, reasoning); escalations and their owner-questions are visible end-to-end.

**B6. Round-trip.** An "ask" verdict blocks the task and asks the owner (questions batched by A4);
the owner's answer flows back via the response-poller → unblock-resolver; the task resumes and
proceeds with the answered decision. `[RESEARCH]` how the answer reaches the agent's context on
resume (the agent re-runs the phase seeing the reply, per existing rework behavior).

### Pillar C — Inbound Comms-Query

**C1. Fix the dead routing.** A general query must reach a handler. Today no path produces a
task-less `comm.message_received` that reaches `handleQuery` (and telegram-comm filters `/`-commands).
`[RESEARCH]` how to distinguish a **query** from an **unblock reply** in inbound messages.

**C2. Deterministic keyword interface.** Support `status`, `progress #N`, `cost`, `help` with rich,
well-formatted responses. No LLM, no per-query cost. The dashboard remains the full detail surface.

## Edge Cases & Error Handling

- **No owner configured:** A → notifications have nowhere to land (warn at startup, already done);
  B → proceed + loud observation (B4); C → no owner to answer (queries come *from* the owner anyway).
- **`review_reminder` targets `reviewers`** (`getReviewers()`), empty in single-user → today delivers
  to zero contacts. v1: resolve to the owner.
- **Unknown decision category** → `always_ask` (already coded). **Threshold metric absent** in details
  → `ask_human` (already coded).
- **Delivery failure** → existing retry queue (in-memory, retryable-flag gated).
- **No comm plugin for a channel** → warn; try next contact (already handled).
- **Daemon restart** with pending batched/deferred notifications → lost (in-memory by decision);
  task state intact in DB, digest/dashboard reconcile.
- **Cross-process cancel as a dispatch completes** → already handled (Slice 9); label sync is the new
  coverage.
- **Unparseable query** → `help`-style response (already the fallback).

## Open Questions (for Research / Planning)

- `[PLAN]` **Decision-surfacing mechanism:** is the autonomy verdict computed by the policy engine
  (enforced, observable; needs the agent to surface structured decisions in `session-result`) or
  rendered into the prompt for the agent to self-apply (lighter, but "preview" and less observable)?
  Recommendation leans enforced-engine for safety + observability, with the owner's latitude rendered
  into the prompt as guidance. Decide in planning.
- `[RESEARCH]` **`SafetyQuery` dual-source-of-truth:** defined in both `safety-layer/index.ts` and
  `schemas/orchestrator.ts` — reconcile to one.
- `[RESEARCH]` Curated category list + default levels (B3).
- `[RESEARCH]` Query-vs-reply routing fix + telegram `/`-filter interaction (C1).
- `[RESEARCH]` Answer-to-agent delivery on resume (B6).
- `[RESEARCH]` `digest.channel` plugin-opacity resolution (A7); label-sync mechanism (A8).
- `[RESEARCH]` **Router plumbing:** the policy lives in `OrchestratorConfig` but the router is
  daemon-resident (built in `bootstrap.ts`, shared by orchestrator + daemon). How does the policy +
  a clock reach it cleanly? (Bootstrap already has `config.orchestrator` in hand.)
- `[PLAN]` **Session decomposition:** carve A / B / C into implementation sessions, each < ~500k
  tokens (one or more per pillar), sequenced for dependencies (B feeds A's question batching;
  A's router plumbing is foundational; C is largely independent).

## Affected Systems

- `src/schemas/config.ts` — notification/question_batching consumed; `digest.channel` default;
  `digest.include` `cancelled`.
- `src/core/daemon/notification-router.ts` — the policy pipeline (the heart of A).
- `src/core/daemon/index.ts` — remove `healthNotifyCooldowns`; tick-loop hooks (digest schedule,
  batch/defer flush); inbound query routing.
- `src/core/daemon/health-monitor.ts` — reminders flow through the policy (keep cadence state).
- `src/core/daemon/query-handler.ts` + `response-poller.ts` — Pillar C routing + queries.
- `src/core/daemon/task-scheduler.ts` + `src/core/workspace-reaper/index.ts` — cancel/label coverage.
- `src/core/safety-layer/{index,policy-engine}.ts` — wire `should_i_ask`; reconcile `SafetyQuery`.
- `src/core/orchestrator/pipeline/**` — agent surfaces discretionary decisions; consult + route.
- `src/core/orchestrator/outreach-sender.ts` — generalized ask path.
- `src/plugins/communication/{github-comm,telegram-comm}` — label sync, query routing.
- `src/cli/commands/start/bootstrap.ts` — pass notification policy + clock to the router.
- `src/cli/bundled/templates.ts` — autonomy defaults; orchestrator notification YAML.
- `src/schemas/events.ts` / `observer.ts` — new observations/events for policy actions.
- Docs: `configuration/orchestrator.md`, `configuration/safety.md`, `plugins/communication/*`,
  `usage-guide/writing-tickets.md`, `architecture/*`.

## Acceptance Criteria (testable, to expand in planning)

- [ ] With defaults, a completion sends one real-time milestone; with `digest.enabled`, it also
      appears in the next digest.
- [ ] Two identical `(kind, task)` notifications within `suppress_window_ms` → one delivered, one
      suppressed (observable).
- [ ] N notifications within `batch_window_ms` → one coalesced message.
- [ ] Quiet hours on: a non-alert generated inside the window is delivered at window-end; an alert is
      delivered immediately.
- [ ] A decision in an `always_ask` category blocks + asks the owner; an `always_decide` proceeds
      silently; a `threshold` asks only when exceeded — each records an `autonomy_policy` observation.
- [ ] No owner + "ask" verdict → agent proceeds, loud observation emitted, task not stranded.
- [ ] A Telegram `status` query returns a formatted status (routing no longer drops/mis-routes it).
- [ ] A cancelled task gets a source-ticket comment + `engineer:cancelled` label (active and
      non-active cancels).
- [ ] `tsc`, lint, tests green; docs updated in the same unit of work; observability verified.
