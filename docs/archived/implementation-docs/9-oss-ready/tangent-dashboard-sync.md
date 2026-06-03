# Tangent: Dashboard Sync & Transparency — Research

> **Status:** Research complete (2026-06-02). Plan drafted; awaiting GO before the build.
> **Type:** Tangent during Phase 9. Pulls the *dashboard-sync + surface-everything* portion of
> **Slice 13** (Dashboard Revisit) forward. Not the formal Slice 10 (Communication), which is still next.
> **Branch (build):** one shared worktree, created at build time.

## Why this exists

The dashboard was last built in **Slice 3**. Slices 4–9 reshaped the engine underneath it: the
data-driven **phase/sub-phase pipeline**, a simplified state machine + the **`cancelled`** terminal
state, the **block-reason taxonomy**, routing/skip/loop **decision trails**, the **reaper**
(`reaped_at` + run summary), OTLP trace export + **trace lineage**, and — in **Session 56** — a wave of
observation wiring (push, create-pr, `workspace_op`, `quota_status`, per-phase cost from the
`agent_call` span). The owner sees **only** the dashboard, and the dashboard has not kept up.

**Key reframe from the research:** because Session 56 already fixed most of the *emit* side and it is
merged to `main`, this tangent is **client- and API-weighted**, not an emit project. The data largely
exists in SQLite; the dashboard either reads the wrong field, iterates a stale vocabulary, or never
renders it. Two genuine emit-side gaps remain (the reaper run-summary is cross-process-invisible; the
client vocabulary is a hand-maintained mirror that drifts) — both flagged below.

## Method

Built the three-column truth table for every datum the engine records: what it **EMITS**
(`schemas/observer.ts`, `schemas/events.ts`, `schemas/task.ts`; the runner, `agent-step`, `verify`,
delivery sub-phases, the orchestrator root span, the reaper, the daemon) → what the **API EXPOSES**
(`src/dashboard/api/*`) → what the **CLIENT RENDERS** (`src/dashboard/client/src/*`). Every row where
emit ≠ expose ≠ render is a gap. Read ~35 source files end to end; verified field names and event types
by grep against the codebase, not by trusting docs.

Legend: ✅ correct · ⚠️ partial / under-surfaced · ❌ broken or absent.

---

## A. Pipeline phases & sub-phases (the Slice-8 reshape the client never caught up to)

**EMIT.** Real phases (`pipeline/types.ts`): `requirements · research · planning · execution · review ·
delivery`. The runner emits `phase_transition` observations named `phase_entered` /
`sub_phase_started` / `sub_phase_result` — **the phase name is in `input.phase`, never in `name`.** The
task row + each checkpoint carry `phase`, `sub_phase`, `phase_iteration`, `total_reworks`. Sub-phases:
requirements→`gather`; research→`investigate`; planning→`design`; execution→`implement,verify`;
review→`self-review,security,code-quality,architecture,refine`; delivery→`pr-description,push,create-pr,await-review,auto-merge`.

| Surface | State |
|---|---|
| `/tasks` list `phases_ran` | ❌ collects observation **`name`** (`phase_entered`,`sub_phase_started`,…), not phase names — meaningless strings |
| `/tasks` list columns | ⚠️ omits `sub_phase`, `phase_iteration`, `total_reworks` |
| `/tasks/:id` | ✅ `SELECT *` returns every column (incl. the four above) |
| `/tasks/:id/phases` | ✅ returns `phase_transition` obs (but consumer must read `input.phase`) |
| client `Phase` type (`types/api.ts`) | ❌ `…\| "self_review" \| "demo_prep"` — phases that no longer exist; missing `review`, `delivery` |
| `PHASE_LABELS` / `PHASE_ORDER` (`constants.ts`) | ❌ stale (`self_review`,`demo_prep`) |
| `PhasePipeline` (shared) | ❌ stale order + matches against the broken `phases_ran` |
| `task-table` phase column | ❌ broken (uses `PhasePipeline` + `phases_ran`) |
| `task-detail-page` `phasesFromDetail` | ❌ hardcoded hack: pushes `"self_review"` if `review` exists, `"execution"` if `workspace` exists |
| `task-phases-tab` | ❌ **triple-broken**: groups by `observation.name` (event names, not phases); iterates stale `PHASE_ORDER`; reads `metadata.cost_usd` (always null) |
| `TaskDetail`/`TaskListItem` types | ❌ no `sub_phase`/`phase_iteration`/`total_reworks` field |
| sub-phase / routing / skip / loop trail | ❌ not rendered anywhere (decisions only appear as raw JSON in the timeline) |

**Inconsistency to call out:** the **metrics** page groups cost by the *real* `obs.phase`
(`execution`,`review`,`delivery`) and is correct — so the dashboard simultaneously shows the right
phases in Metrics and the wrong ones (`Demo`, `Review` stencils) in the phase pipeline.

---

## B. Decisions — the "why" (the headline gap)

**EMIT.** `decision_point` via `recordDecision`, stored in `input` as
`{ context, options:[{id,description}], chosen, reasoning, confidence }`. Emitted for: `route:<subphase>`
and `skip:<subphase>` (every routing fork + every skip, runner), `merge_readiness` (auto-merge, with the
live PR status that drove it), self-unblock (`auto_resolve` vs `escalate`), `pr_event_arbitration`,
`approve_comment_promotion`, `cost_check`. Loop increments are `decision_point`/`loop_repeat|loop_jump`
with `{phase,count}`.

| Surface | State |
|---|---|
| `/observations?type=decision_point` | ✅ generic query works |
| timeline | ⚠️ includes `decision_point` but renders it generically (name + input JSON) — alternatives/reasoning/confidence not legible |
| activity feed | ⚠️ shows the decision **name** only |
| first-class Decisions view | ❌ **none** — the road-not-taken, the reasoning, the confidence are never surfaced as designed |

This is the single richest thing the engine emits and the least surfaced. *(Open decision #2: where the
Decisions view lives.)*

---

## C. Agent calls — cost / tokens / blob drill-down

**EMIT.** `agent_call` span: `input = { step, prompt_blob }`; `output = { outcome, summary, cost_usd,
tokens_in, tokens_out, cache_read_tokens, result_blob, transcript_blob }`. **`metadata` is always null.**
The full prompt, the agent's `session-result.json`, and the full transcript are stored as blob refs.
No model id on the span (model_id rides the `cost.incurred` event).

| Surface | State |
|---|---|
| `/tasks/:id/agent-traces` | ✅ returns the spans |
| `aggregateAgentCost` (metrics/system) | ✅ reads `output ?? input` — correct (Session 56) |
| `task-agent-tab` header totals | ❌ sums `metadata.cost_usd` / `metadata.total_tokens` → **always $0 / 0 tokens** |
| `task-agent-tab` per-call cost/tokens/model | ❌ reads `metadata.*` (null); "model" falls back to the **step name** |
| blob drill-down (prompt/result/transcript) | ❌ blob refs shown as raw strings in a JSON dump; never fetched via `/api/blob` — the deepest drill-down dead-ends |

The Agent Calls tab is the worst single offender: the costliest, most important activity, rendered with
zero cost, zero tokens, the wrong model, and no way to read what the agent was asked or answered.

---

## D. Verdicts (`safety_verdict`)

**EMIT.** `verify` emits `safety_verdict`/`verify_gates`: `{ passed, gate_count, gates:[{name,passed}],
failed_gates }`, level info/warn. Each gate also gets a `tool_execution` span (below).

| Surface | State |
|---|---|
| `/observations` + timeline | ⚠️ present, but rendered as generic JSON only |
| dedicated verdict rendering | ❌ no badge, no pass/fail summary, no Verdicts surface |

---

## E. Tool executions

**EMIT.** `tool_execution` spans: `gate:<name>` (verify; `output={passed,output}`), `git_push`,
`create_pr` + `dismiss_approvals`, `merge_pr`, `remove_thoughts_and_push`.

| Surface | State |
|---|---|
| `/tasks/:id/traces` + `task-tools-tab` | ✅ name + status + duration + input/output JSON — mostly fine |
| grouping by phase / verdict cross-link | ⚠️ flat list; gate verdicts not tied to the verify verdict |

The healthiest tab. Light polish only.

---

## F. State machine, block taxonomy, cancel

**EMIT.** `state` enum includes `cancelled`. `state_transition`/`task_blocked` obs:
`{ category, sub_phase, needed }`. `task.state_changed` events: `{from_state,to_state,from_sub,to_sub,
reason,triggered_by}`. `state_transitions` table. Task `blocked` = `{ reason, category, sub_phase, needed }`
(`reason` is the coarse `BlockReason`; `category` the full `BlockCategory`; `needed` the operator-facing
next step). `CANCELLABLE_STATES` (derived) = `requirements_gathering, queued, active, blocked`.

| Surface | State |
|---|---|
| `STATE_COLORS/LABELS/DOT` | ✅ include `cancelled` |
| `/tasks/:id` `blocked` (full) + `last_transition_*` | ✅ exposed |
| `blocked-response` (client) | ❌ reads `blocked.question` / `blocked.context` — **fields that never exist**; shows `reason` (coarse enum) but **not** `needed` (the actionable next step), `category`, or `sub_phase` |
| `isCancellable` (task-detail) | ⚠️ hardcodes `active\|queued\|blocked` — misses `requirements_gathering` (in `CANCELLABLE_STATES`) |
| `FILTER_STATES` (task list) | ⚠️ omits `cancelled` — no Cancelled chip |
| block-reason / category badges + filters | ❌ not surfaced |

---

## G. Reaper / completion / cleanup

**EMIT.** `reaped_at` task column (durable). `git.branch_deleted` + `git.pr_merged` events (durable).
Reaper **`getLastRun()` `ReapStats`** (`scanned/reaped/deferred/failed/durationMs`) is **in-memory in
the daemon process** — the dashboard is a *separate process* and cannot read it. The reaper alert is a
notification, not necessarily a queryable row.

| Surface | State |
|---|---|
| `reaped_at` (per task) | ❌ not surfaced anywhere |
| `git.branch_deleted` / `git.pr_merged` | ⚠️ appear in the generic timeline/activity only |
| reaper run-summary | ❌ **unreachable cross-process** — surfacing it needs a small durable emission *(open decision #1)* |

---

## H. Trace lineage / OTLP / Jaeger

**EMIT.** `last_trace_link` per task; observations carry `trace_id` + `links`; one root span per dispatch;
`trace_otlp_id` derived server-side via the exporter's own `deriveTraceId`.

| Surface | State |
|---|---|
| "View trace in Jaeger" deep-link | ✅ wired (telemetry on + trace exists) — genuinely good |
| client `Observation` type `links` | ⚠️ missing the `links` field |
| dispatch boundaries / lineage in timeline | ⚠️ all dispatches merged flat; no per-dispatch grouping or "previous/next dispatch" navigation |

---

## I. Quota / cost / metrics

**EMIT.** `quota_status`/`quota_polled` (untraced gauge), `cost.incurred` events (carry `model_id` + token
breakdown), `agent_call` spend.

| Surface | State |
|---|---|
| metrics: cost-by-phase/task, trend, tokens, quota windows, phase-performance | ✅ correct (real `obs.phase`; quota renders real `windows[]`) |
| `model_id` (from cost events) | ⚠️ never surfaced |

The metrics page is the reference for "done right" — it reads the true emitted shape. Light only.

---

## J. Cross-cutting / hygiene

- **Vocabulary mirror drift.** `client/types/api.ts` hand-mirrors `schemas/observer.ts` +
  `schemas/task.ts`. `Phase` has already drifted (`self_review`/`demo_prep`). Session 56 explicitly
  deferred "a single shared source for the client observation-type vocabulary" to Slice 13. *(open decision #4)*
- **`errors` API stale event types.** `collectErrorEvents` queries `task.failed` and
  `health.check_failed` — **neither exists** in `EventTypeSchema` (real: `timeout.alert`,
  `health.plugin_failed`, `cost.quota_exhausted`). Silently returns fewer errors than it should.
- **Hardcoded version.** Sidebar shows `v0.0.1`; `package.json` is `0.4.0-preview` (SSOT §11 violation).
- **No client tests.** API has tests (`tests/unit/dashboard/api/*`); the client has none.

---

## Implications

1. **This is a sync + surfacing job, not a rewrite.** Reuse the SPA shell, the UI kit, TanStack Query,
   the SSE plumbing, the metrics page (the model to copy). Rebuild a view only where its shape no longer
   fits (the phase tab, the agent tab, decisions).
2. **Fix the vocabulary at the root first.** The stale `Phase`/`PHASE_ORDER` poisons four components.
   Single-source it before touching any view, or the fixes drift again.
3. **The data is (almost) all there.** Most gaps are "read the right field" (agent cost from `output`,
   phases from `input.phase`, block `needed`) or "render what's emitted" (decisions, verdicts, reaped_at).
4. **Two genuine emit-side decisions remain:** the reaper run-summary (cross-process) and how the client
   vocabulary stays in lockstep with the schemas. Both are small; both are flagged as open decisions.
5. **Honor "stored is not surfaced" in reverse too:** don't invent UI for data that isn't emitted
   (e.g. a per-call model id — it's on the cost event, not the agent span; decide whether to thread it).

---

## Locked decisions (Farzam, 2026-06-02)

1. **Reaper run-summary → add a durable sweep emission.** The reaper publishes a small per-sweep
   event/observation (mirroring data-lifecycle's `cleanup_completed`); the dashboard surfaces sweeps +
   per-task `reaped_at`. Emit and its view ship together (S4).
2. **Decisions view → task-level Decisions tab.** Inside task detail. No global cross-task explorer now.
3. **Scope → per-task pipeline + task/list/overview (refine-weighted).** Reuse the SPA; reaper/cleanup
   surfaced lightly. Daemon/background internals (data-lifecycle, health depth) stay with Slice 11.
4. **Vocabulary → shared const module + CI parity test.** A pure-TS const module (no Zod/node deps)
   imported by both the API and the client, plus a test asserting parity with the schema enums.

## Build plan (sequenced; vocab/API → shared components → views → polish)

> Each session is one focused unit in the shared worktree, green on every commit, with its own
> `sessions/N.md` + an `active.md` touch. Final review is hands-on by the orchestrator (run the app, see
> the data render). UI sessions interrelate, so the build runs **sequentially**.

- **S1 — Vocabulary single-source + API truth (no new UI).** Stand up the shared const vocabulary module
  (`Phase`/`ObservationType`/`TaskState`/`BlockReason`/`BlockCategory`) + the CI parity test; kill
  `self_review`/`demo_prep`; rebuild `PHASE_LABELS`/`PHASE_ORDER` + add sub-phase labels. Fix `phases_ran`
  (derive real distinct phases from `input.phase`); add `sub_phase`/`phase_iteration`/`total_reworks` to
  the list columns + `TaskListItem`/`TaskDetail`; fix the `errors` API stale event types; type
  `reaped_at`/`blocked`(full)/`pending_pr_event`/`links` into the client contract.
  Acceptance: typecheck/lint/tests green; parity test passing.
- **S2 — Shared components.** New/rebuilt: `PhasePipeline` (6 real phases + sub-phase + iteration/rework),
  `DecisionCard` (alternatives + chosen + reasoning + confidence), `BlobViewer` (lazy `/api/blob` fetch
  for prompt/response/transcript/diff), `VerdictBadge`, block-reason/category badges.
- **S3 — Task detail rebuild (the core drill-down).** Overview (sub_phase/iteration/reworks/reaped_at +
  legible block taxonomy with `needed`, fix `isCancellable` → `CANCELLABLE_STATES`); Phases tab (rebuilt
  on real `input.phase` with the sub-phase/routing/skip/loop trail + per-phase cost from `agent_call`);
  Agent tab (cost/tokens from `output`, model decision, blob drill-down); a **Decisions tab**; richer
  timeline (decisions, verdicts, agent calls drillable; dispatch boundaries); `blocked-response` reads
  `needed`/`category`/`sub_phase`.
- **S4 — Lists/overview/activity + reaper vertical + cleanup/polish.** Task-table phase column; state
  filters incl. `cancelled` + block-reason filter; **reaper sweep emission + its surfacing as one
  vertical** (overview cleanup card + per-task `reaped_at`); sidebar version from `package.json`; delete
  dead UI; docs sync (`observability.md` dashboard section, README). Final DoD + the three observability
  tests, app run + hand-verification, merge worktree → `main`.
