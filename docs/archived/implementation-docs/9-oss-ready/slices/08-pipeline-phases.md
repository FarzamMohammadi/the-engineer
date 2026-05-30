# Slice 8: Pipeline Phases

> **This file is the backbone design record for the per-task pipeline — the heart of
> The Engineer.** It captures not just *what* was decided but *why*, because this
> reasoning is the seed for the eventual documentation slice and the user-facing
> pipeline docs. When the docs slice writes "how the pipeline works," it draws from
> here. Read it as a design narrative, not just a decision list.

## Requirements

Gathered through deep Q&A (Session 38) and refined through an expert-panel stress test
(Session 39). Code reality verified by direct grounding of the orchestrator surface,
pr-manager, review-handler, retry-policy, agent adapter, git-hosting adapter,
observation infrastructure, and existing test patterns. Research saved to
`.claude/temp/research/slice-08-pipeline-phases.md` (observations-vs-inferences split).
Implementation plan saved to `.claude/temp/create-plan/slice-08-pipeline-phases.md`.

### Scope Framing

This slice owns the per-task pipeline that the orchestrator runs from task intake to PR
merge. **It is a structural reshape** that folds three originally-separate slices
(8 / 9 / 10) into one coherent unit, because their seams are too tight to split without
leaving half-baked boundaries. Three intertwined halves:

1. **The pipeline shape** — 6 top-level phases (down from 7), a data-driven sub-phase
   architecture, a generic runner, the phase/state model, typed routing, full
   observability end to end.
2. **Delivery (absorbed from Slice 9)** — PR description, commit/push, PR creation, the
   blocking `await-review` step, and auto-merge.
3. **Review & Feedback External (absorbed from Slice 10)** — typed PR-event detection
   behind the `GitHostingAdapter` contract, and typed routing of those events back into
   a blocked task's pipeline.

Out of scope (handed to downstream slices, renumbered down by 2 after Slice 8 lands):

- Workspace cleanup on completion → Slice 9 (was 11).
- Notification routing, response polling, query handling → Slice 10 (was 12).
- Background services internals (cost tracking, data lifecycle, health) → Slice 11 (was 13).
- All dashboard UI for the new pipeline shape → Slice 13 (was 15). Slice 8 produces the
  data; Slice 13 displays it.
- npm SDK extraction → Slice 14 (was 16).

### Goals (priority order)

1. **Intuitive to evolve.** The single most important goal, and the reason for the
   reshape. The past pain point — tests shattering whenever the phase shape changed —
   was a symptom of a deeper problem: the pipeline was hardcoded, not data-driven. A
   contributor must be able to look at the structure, understand it, and know exactly
   where to make a change. Adding, removing, or toggling a step is a one-file change,
   never a runner rewrite. The architecture mirrors the mental model.
2. **Honest.** Cut the dead `integration` phase. No vestigial scaffolding. No docs that
   lie about config keys that don't exist.
3. **Loud and recoverable.** Every pipeline failure blocks with a descriptive, typed
   reason naming what failed and what the operator should do. No abandonment paths.
   `engineer retry` is the universal unblock verb.
4. **Observable by construction.** Every phase transition, sub-phase start/end/skip,
   loop iteration, routing decision, and block is logged, traced, and decision-recorded
   — and it is structurally impossible to add a step that forgets to do this, because
   the logging lives in the runner, not the steps.
5. **Plugin-blind.** The new `GitHostingAdapter.detectPrEvents` contract moves
   platform-specific aggregation behind the boundary. Core still compiles and functions
   if every plugin is deleted.

---

## The Architecture

This is the heart of the slice. Read this section and you understand the system.

### The intuition principle

A task walks through **phases**. Each phase is a **folder**. Each step within a phase
is a **sub-phase**, and each sub-phase is a **file**. Every sub-phase file owns exactly
two things and nothing else: **how to do its work**, and **where to go next**. That is
the whole architecture. The folder tree *is* the pipeline. A newcomer reads the tree
and knows the system; opens a file and understands one step completely.

```
src/core/orchestrator/pipeline/
  runner.ts            ← the generic loop. ~120 lines. Rarely touched.
  types.ts             ← SubPhase, SubPhaseResult, Route, Ctx. The vocabulary.
  pipeline.ts          ← the phase order, each phase's sub-phase list, and entryFor. The map.
  cli-run.ts           ← the one defended boundary: spawn agent, retry, validate, recover, honor signal.

  requirements/
    gather.ts          ← prompt + next
  research/
    investigate.ts
  planning/
    design.ts
  execution/
    implement.ts       ← CLI: writes code, commits as it goes
    verify.ts          ← orchestrator: typecheck/lint/test; loops to implement on red
  review/
    self-review.ts     ← default lens
    security.ts        ← opt-in lens (adding a lens = adding a file)
    code-quality.ts    ← opt-in lens
    architecture.ts    ← opt-in lens
    refine.ts          ← consolidates findings, fixes in place, decides advance / repeat / escalate
  delivery/
    pr-description.ts  ← CLI: writes the PR narrative (this is the old "demo_prep")
    push.ts            ← orchestrator: commit stragglers + push
    create-pr.ts       ← orchestrator: open the PR
    await-review.ts    ← orchestrator: block, exit pipeline, wait for an external event
    auto-merge.ts      ← orchestrator: reached on approval, merges
```

### The three types everything rests on

```typescript
type SubPhase = {
  name: string;
  skip?: (ctx: Ctx) => SkipReason | null;        // optional: don't even run (trivial→skip research; push-only→skip create-pr)
  run:   (ctx: Ctx) => Promise<SubPhaseResult>;   // CLI: cli-run() helper. Orchestrator: a plain async fn.
  next:  (result: SubPhaseResult, ctx: Ctx) => Route;   // read the result, return where to go. Reads like prose.
};

type SubPhaseResult =
  | { outcome: "ok";          summary: string; data?: unknown }   // did the job; proceed
  | { outcome: "needs_human"; summary: string }                   // a person must answer something
  | { outcome: "failed";      summary: string; category: FailureCategory; detail: string };

type Route =
  | { go: "advance" }                                   // next sub-phase (or next phase if this was the last)
  | { go: "repeat"; carry: Carry }                      // loop THIS phase from its start  → phase_iteration++
  | { go: "jump"; to: Phase; carry: Carry }             // hand back to an earlier phase   → total_reworks++
  | { go: "block"; reason: BlockReason; sub_phase: string }   // loud, operator-recoverable
  | { go: "done" };                                     // terminal: completed
```

That is the entire vocabulary. **No predicate library, no routing-rule arrays, no
first-match-wins evaluation order to memorize.** To know what a step does, read its
`run` and its `next` — both are ordinary functions that appear in stack traces by name.

This shape is the resolution of the expert panel's strongest, unanimous finding: an
earlier draft modeled routing as a declarative `RoutingRule[]` DSL with predicate
functions and five target variants. All three panelists independently called it "a
small programming language" / "dependency-management theater" — more to learn than the
code it replaced, and invisible in a backtrace. Routing as a per-sub-phase `next()`
function is modular *and* linear: modular because each phase's logic lives in its own
files, linear because each `next` reads top to bottom like the if-chain it replaces.

### The runner

`runner.ts` is a generic loop. It holds the cursor (which phase, which sub-phase),
calls `skip` → `run` → `next` on each sub-phase, interprets the returned `Route`
(advance the cursor, repeat the phase, jump to another phase, block the task, or
finish), enforces the iteration caps, writes a checkpoint after each sub-phase, and
emits all observability. It knows nothing about any specific phase or sub-phase — it
drives whatever `pipeline.ts` declares. Adding a sub-phase never touches it.

### cli-run: the one defended boundary

Every CLI sub-phase does its real work in a **separate autonomous coding-agent
subprocess** (Claude Code, OpenCode, Gemini CLI). The orchestrator's only knowledge of
what happened is what that subprocess writes to a `session-result.json` file. That
boundary is where the genuine risk lives — a subprocess can die mid-write, leave a
stale template, or self-report success it didn't earn.

`cli-run.ts` concentrates *all* of that risk in one well-tested helper. A CLI sub-phase
is built as `run: cliRun({ prompt, skills, detailsSchema })`, and `cliRun` owns:

- Spawning the agent through the `AgentAdapter`, passing the abort signal.
- Retrying transient failures with backoff.
- Writing the structured trace.
- Reading `session-result.json` and **validating it hard** — a stale-template or
  malformed result becomes `{ outcome: "failed", category: "no_result" }`, failing loud
  instead of routing a lie.
- Recovering a partial write after a SIGTERM (the work may be done even if the process
  died).
- Validating the optional `details` payload against the sub-phase's `detailsSchema`
  (so `details` is never an untyped free-for-all).

This is the panel's "make the routing dumb and in-code; make the boundary smart and
defended" principle. The dangerous 10% is one module, tested with a fake agent. The
routing is dumb named functions. Orchestrator sub-phases (`verify`, `push`, etc.) skip
`cli-run` entirely — their `run` is just an async function.

### Observability by construction

Because every transition flows through the runner interpreting a `Route`, **the runner
is the single place that emits observability**: phase-enter, sub-phase-start,
sub-phase-result, the routing decision (`recordDecision` with the alternatives and the
reason), every skip, every block, and every iteration increment. You cannot add a
sub-phase and forget to log it, because the logging is not in the sub-phase — it is in
the loop that drives it. The "every step traced" requirement is satisfied by
construction, not by remembering. This directly serves Goal 4 and the radical-
observability philosophy.

---

## The Handoff Contract

The interface between an opaque agent subprocess and the orchestrator is the actual
design surface of this slice. Get it wrong and everything above is built on sand.

### The agent reports an outcome; the orchestrator owns the route

`session-result.json` carries a small, honest vocabulary:

```json
{ "status": "ok" | "needs_human" | "failed",
  "summary": "one line",
  "details": { }   /* optional, sub-phase-specific, validated per sub-phase */ }
```

**The agent never names a phase.** It reports *what happened* — I did my job, I need a
person, or I failed. The sub-phase's `next` function (orchestrator code we own and can
grep and test) maps that outcome to a destination. This is the project's "Orchestrate,
don't build" and "Principles over prescriptions" applied to the handoff: the agent does
work and reports facts; the orchestrator owns control flow.

Why this matters, concretely:
- **Smaller job for the agent.** Three outcomes, not a seven-value phase enum it has to
  reason about.
- **A whole bug class disappears.** The agent literally cannot route to a dead or wrong
  phase, because it does not choose phases. (The old model let the agent write
  `next_phase: "integration"`; that is impossible now.)
- **Routing is greppable and testable.** It lives in `next` functions, not smuggled
  through an overloaded destination field. The earlier code reverse-engineered intent
  by string-matching `next_phase` (`=== "execution"` secretly meant "needs rework") —
  that hack is gone.

### We do not trust the self-report

A subprocess can write `"ok"` without having earned it. The architecture defends
against that **structurally**, not by hoping: `implement`'s claim of success is checked
by `verify` (real typecheck/lint/test gates, orchestrator-owned, the agent cannot
fake), and the whole change is checked again by `review` (independent quality lenses).
We never route a lie because the next step verifies the last step's claim. This is the
answer to the panel's deepest concern — routing correctness is not bounded by an
agent's honesty, because honesty is independently re-checked downstream.

### Richer signals are local and validated

Only `refine` needs more than three outcomes (it must say "ship" vs "the code needs
rework" vs "the plan is wrong" vs "the requirements are unclear"). It puts a typed
`verdict` in `details`, and its own `next` reads it. `cli-run` validates `details`
against `refine`'s `detailsSchema`. So the common contract stays dead simple, and the
richness is opt-in, local to the one sub-phase that needs it, and type-checked.

---

## Routing and Loop Control

### repeat vs jump — two verbs, two counters

- **`repeat`** means "do this phase again from its first sub-phase." It is an
  *intra-phase* loop. Example: `verify` fails → `repeat` → back to `implement` with the
  test failures as carry. Counted by `phase_iteration`, which **resets on every phase
  entry** and is capped per-phase (Review's refine loop caps at 3).
- **`jump`** means "hand control back to an earlier phase." It is an *inter-phase*
  rework. Example: `refine` decides the plan itself is wrong → `jump` to Planning.
  Counted by `total_reworks`, which does **not** reset within a dispatch, with one
  generous global backstop that catches cross-phase oscillation (refine→execution→
  refine→…) that a per-phase counter would miss.

Keeping them as distinct verbs (rather than collapsing `repeat` into `jump`-to-self) is
deliberate: `verify.next` saying `repeat(...)` reads clearer than `jump("execution")`
from inside execution, and the two verbs map one-to-one onto the two counters. A `jump`
to the current phase is disallowed — use `repeat`.

### The two counters replace four

Today the codebase has `loopback_count`, `requirements_loop_count`, and a history-
derived post-approval-fix count, and an earlier draft added a fourth. They collapse
into:

- `phase_iteration` — intra-phase, resets on phase entry, small per-phase caps.
- `total_reworks` — inter-phase backward jumps within one dispatch, one generous
  global cap.

**Lifecycle:** both persist on the task row *and on the checkpoint*, so a mid-loop
preempt-and-resume does not reset the guard (without this, a thrashing task that keeps
getting preempted would never trip its cap — a real bug the panel surfaced). Both reset
on a *fresh* dispatch. The consequence is exactly right: a single dispatch cannot spin
forever, but human-driven external reworks (a reviewer asking for changes ten times)
are legitimately unbounded, because each external event is its own fresh dispatch.

### Caps live in the runner, not in `next`

A `next` function just says `repeat`. The runner increments `phase_iteration`, compares
against the phase's configured cap, and converts an over-cap `repeat` into a
`block(reason: iteration_cap_hit)`. The cap policy is in one place. Hitting the cap is a
workflow-level red flag, loud by design — if Review cannot converge in three passes,
something deeper than the code is wrong, and the operator should look.

---

## The Phases

Everything upstream of Delivery is identical regardless of how the work ships; only
Delivery's shape changes by config (see "The Deliverable").

| Phase | Default sub-phases | The one thing that makes it right |
|---|---|---|
| **Requirements** | `gather` | Writes a `## Context Summary` *first* (so a wrong understanding is caught at the first artifact), grounds in the codebase before asking, batches **all** questions for a contact into one outreach file. `needs_human` blocks the task. |
| **Research** | `investigate` | Observations-vs-inferences discipline; `skip` on trivial complexity. |
| **Planning** | `design` | One agent session that designs *and* stress-tests its own plan (no separate panel roundtrip); `skip` on trivial. |
| **Execution** | `implement` → `verify` | `verify` is orchestrator-owned gates the agent cannot fake; on red it `repeat`s to `implement` carrying the failures. `implement` commits logically as it goes; `push` is the later safety net. |
| **Review** | `self-review` (+ opt-in lenses) → `refine` | Lenses each write findings and `advance`; `refine` consolidates, **fixes in place**, `repeat`s to re-check (cap 3), and only `jump`s out (to execution/planning/requirements) when it genuinely cannot fix. This matches how the system actually behaved best historically: review reviewed *and* fixed, rather than always bouncing to execution. |
| **Delivery** | `pr-description` → `push` → `create-pr` → `await-review`; plus `auto-merge` (entry-only) | See below. Skip-gates collapse it to just `push` in push-only mode. `await-review` blocks and exits; external events re-enter. |

Notes that earn a sentence:

- **One sub-phase is the common case, and that is fine.** Requirements/Research/Planning
  have a single sub-phase today. The architecture does not force them to have more; it
  makes *growing* them cheap if a future need appears. The cost of the abstraction is
  paid by Review (2 + 3 opt-in) and Delivery (5), which genuinely need it now — not
  speculation.
- **Lenses are just sub-phases with a trivial `next: advance`.** Multiple lenses give
  each one focus (security looks only at security), then `refine` fixes holistically.
  With only the default lens on, `review` is `[self-review, refine]` — find then fix,
  which also reduces an agent rationalizing away its own findings.

---

## External Events and Delivery

### The Deliverable (config-driven — the load-bearing product framing)

The Engineer's entire pipeline exists to produce **one of two deliverables**, chosen by
`workspaceConfig.pr.skip_pr_creation` (global default, per-repo override). This is the
clearest single statement of "what does The Engineer do," and the docs slice should
anchor on it.

| Delivery sub-phase | Push-only (`skip_pr_creation: true`) | PR mode (default) |
|---|---|---|
| `pr-description` (CLI) | **skip** | run |
| `push` (orchestrator) | **run** | run |
| `create-pr` (orchestrator) | **skip** | run |
| `await-review` (orchestrator block) | **skip** | run |
| `auto-merge` (orchestrator, entry-only) | **skip** | run on approval |

- **PR mode (default).** The deliverable is a *reviewed, merged pull request*. The full
  lifecycle with live feedback loops. **Done when the PR is merged** — The Engineer
  performs the merge once a human approves and CI is green (auto-merge), or detects an
  external merge.
- **Push-only mode.** The deliverable is a *pushed branch*. `push` runs, everything else
  skips, the task completes immediately. No PR, no review loop, no feedback — a
  deliberate escape hatch for operators who own the downstream PR process themselves.
  **Done when the branch is pushed.**

Everything upstream of Delivery is identical across both modes; only Delivery's shape
differs, expressed as skip-gates. This is the second concrete use of the skip-gate
mechanism (trivial-skip is the first) and the proof of the architecture's value: a
fundamental product behavior is a data-declared skip-gate, not a hardcoded branch.

### Typed PR events, computed statelessly

The `GitHostingAdapter` gains `detectPrEvents(repo, prNumber): Promise<PrEvent[]>`. The
plugin aggregates platform-specific state (reviewer statuses, check runs, mergeability)
into a small typed vocabulary:

- `pr_comments` — actionable reviewer feedback.
- `pr_ci_failure` — checks are red.
- `pr_merge_conflict` — the base moved and it no longer merges.
- `pr_ready_to_merge` — approved **and** CI green **and** mergeable, all at once.
- `pr_merged` — merged (by us or externally).

The crucial refinement: the plugin emits `pr_ready_to_merge` **only when all merge
preconditions hold simultaneously**. "Approved but CI still running" emits nothing — the
task simply stays blocked, waiting. This **deletes the in-memory `approvedAwaitingCI`
map** that exists today, and with it an entire class of restart bugs: on daemon restart
there is no in-memory wait-state to lose, because readiness is recomputed statelessly
from the PR on every poll. The panel's darkest 3am corner (daemon restarts mid-wait,
task stuck forever, nothing alerts) cannot occur.

### How an event re-enters the pipeline

External events do **not** call into the orchestrator through a back channel. They flow
through the boundary that already works: daemon polls → `arbitrate` picks one winning
event → dedup → write the event onto the task → re-queue → the scheduler re-dispatches
normally. The pipeline, on entry, reads the pending event and starts at the right place
via one exhaustive map:

```typescript
// pipeline.ts — the whole "how does each external event re-enter" in one place
const entryFor = (e: PrEvent): Entry => {
  switch (e.type) {
    case "pr_comments":       return { phase: "requirements" };                // may surface scope; trivial→skip-gates forward
    case "pr_ci_failure":     return { phase: "execution", sub: "implement" };
    case "pr_merge_conflict": return { phase: "execution", sub: "implement" };
    case "pr_ready_to_merge": return { phase: "delivery",  sub: "auto-merge" };
    case "pr_merged":         return { phase: "delivery",  sub: "auto-merge" }; // detects already-merged → done
  }
};
```

This keeps the daemon→orchestrator boundary acyclic and crash-safe (the pending event
lives on the task row, in the DB, surviving restart), runs the merge inside a normal
dispatch (abortable via signal, observable as a normal sub-phase, off the daemon's poll
thread), and makes `auto-merge` a legitimate sub-phase reached by *entry* rather than
*advance*. The panel's highest-leverage finding (drop the synchronous
`applyExternalEvent` coupling) and its "a sub-phase the runner never advances to isn't a
sub-phase" critique are both resolved: every external re-entry uses the same standard
mechanism.

### Arbitration, dedup, and authorization stay in Core

- **Arbitration** (panel S2): two events can land in one poll (a comment *and* an
  approval). `arbitrate(events): PrEvent` is a Core policy function that picks the single
  winner by precedence (changes-requested/comments beat ready-to-merge — address
  feedback before merging). This replaces the precedence that today's aggregate-state
  derivation provided and that a naive list-of-events would have dropped.
- **Dedup** (panel S4): the plugin returns *all* events; Core filters against
  `accommodated_comment_ids` / `accommodated_review_state`. Dedup is The Engineer's own
  processing-state concern, not the platform's — it stays in Core so a new hosting
  plugin author does not have to re-implement it.
- **Authorization** (panel S4): a `/approve` comment is a *fact* the plugin can report,
  but *who may approve* is Core policy (the people-directory). The plugin surfaces the
  comment; Core decides whether that author's `/approve` counts. Authorization never
  leaks into a plugin.

---

## Failure Model

### Every pipeline failure blocks, loudly and recoverably

Any sub-phase failure — a CLI session that dies without a valid `session-result.json`,
a `details` schema validation failure, an orchestrator step that throws, a plugin call
that errors, a `verify` that stays red past its cap — transitions the task to `blocked`
with a **structured, typed** reason. The block payload is typed keys, not prose:

```typescript
type BlockDetail = { reason: BlockReason; sub_phase: string; category: FailureCategory; needed: string };
```

(panel S3 — the failed sub-phase and the failure category are query-relevant dimensions
the dashboard and alerting read directly, so they are typed fields, not strings stuffed
into a human-prose blob; this also honors the project's strict-data-invariants rule.)
`engineer retry` unblocks; resume picks up at the failed sub-phase. No abandonment.

### A crash is not a pipeline failure — keep the retry-policy crash category

The panel surfaced a real distinction the earlier draft erased. A *pipeline failure* is
the orchestrator *deciding* it cannot proceed — that blocks, per above. A *crash* is an
uncaught throw / OOM / process death mid-dispatch, where the orchestrator decided
nothing; it died. Crashes keep Slice 6's `retry-policy` `crash` category: exponential
backoff plus an attempt cap, which is exactly the poison-task protection that prevents a
task that crashes on every dispatch from thrashing the daemon and burning agent spend in
a tight retry loop. **Slice 8 does not touch retry-policy's crash handling.** "Every
failure blocks" governs *sub-phase* failures; crashes keep their backoff safety net.
(This also shrinks Slice 8's scope — one fewer thing to refactor.)

### Audit the consumers of `blocked` (panel S5)

Collapsing `review_pending` into `blocked(reason=pr_review_pending)` changes what
"blocked" means — it is now *either* "needs a human" *or* "waiting on an external PR
event." The health-monitor's stuck-detection, the unblock-resolver, and the
response-poller must treat `blocked(pr_review_pending)` as *expected waiting*, not
*stuck*, or they will false-alarm on every PR awaiting review. This is an explicit task,
not just a query-call-site rewire.

---

## Signal Honoring

`AgentRunRequest` gains an optional `signal: AbortSignal`. `cli-run` passes
`dispatch.signal` to every agent run; each agent plugin passes it to Node's native
`spawn(cmd, args, { signal })`, which sends SIGTERM to the child on abort. This closes
the Slice 6 → Slice 8 handoff so termination (preemption, hard-cap, shutdown,
cost-limit) actually aborts in-flight agent CLI calls instead of waiting for them to
finish. The self-unblock path (`orchestrator/index.ts`) threads the signal too. The
field is optional so legacy code compiles unchanged during the build window (it is
deleted at cutover regardless).

---

## Skip-gates and Trivial-skip

A sub-phase's optional `skip(ctx)` is the single mechanism for "don't even run this
step." It subsumes two earlier ideas (config-disabled and context-skipped) into one
hook — `ctx` carries config, so an opt-in lens skips when config disables it, and
research skips when requirements reported trivial complexity. Every skip emits the full
observability triple (decision-record + journal + dashboard-visible state) from the
runner. Today's `skip_research` flag becomes one instance of this generic mechanism;
trivial tasks may skip both Research and Planning. The Slice 5 → Slice 8 trivial-skip-
honesty handoff closes here.

---

## Migration Strategy: build dark, cut over atomically

The panel would "bet against" an earlier plan that ran a legacy runner and the new
runner side by side, migrating phases one at a time. The reason is decisive: a task is
one continuous stateful flow, not partitionable by phase. A checkpoint written by one
runner (with a `sub_phase`, new enum names) resumed by the other (no `sub_phase`, old
names) corrupts the resume — re-running a whole phase, double-pushing. There is no safe
window.

So the migration is **build-dark-then-atomic-cutover**:

1. Build the entire `pipeline/` (runner, types, cli-run, every phase folder and
   sub-phase file) *without wiring it to `executeTask`*. The legacy runner stays fully
   live and untouched and keeps every test green. The new code is exercised end to end
   in isolation with the fake-agent test harness (real workspace-manager, real
   session-memory, fake CLI).
2. **In a single commit**, point `executeTask` at the new runner, delete the legacy
   runner + handlers + old prompt files + old phase enum, and finalize the schema. Since
   pre-v1 wipes `~/.engineer/data.db` on a new version, no in-flight task straddles the
   two runners — the DB wipe *is* the migration. The corruption window does not exist.

A little duplicated code coexisting for a few build sessions (old and new both present,
new not yet wired) is a tiny, bounded cost; a shared-mutable-state seam across four
sessions is not.

---

## Cross-Slice Handoffs

### Inbound (parked from prior slices, all land here)

- **Slice 5 → Slice 8:** trivial-skip honesty. Generalized as the `skip` hook with full
  observability.
- **Slice 6 → Slice 8:** decomposition residue. The `integration` phase is cut; the
  prompt prose, the demo_prep routing branch, and the lying config docs
  (`orchestrator.md` references `decomposition.*` keys that do not exist in any schema)
  are removed.
- **Slice 6 → Slice 8:** signal honoring. Closed via the `AgentRunRequest.signal`
  threading above.
- **Session 37 (Agent rename) → Slice 8:** the `provider_id: "agent"` literal in
  `agent-runner` should carry the real plugin id; folded into the cutover.

### Outbound (parked for downstream slices, post-renumber)

- **Slice 8 → Slice 9 (was 11):** terminal-state cleanup — workspace removal on
  merged/completed, terminal notifications. Slice 8 produces a clean `completed` state;
  Slice 9 owns the reaper.
- **Slice 8 → Slice 10 (was 12):** notification-kind audit; reply-token + unblock check;
  response-poller integration with the typed-event surface.
- **Slice 8 → Slice 13 (was 15):** ALL dashboard UI for the new shape — `phase` /
  `sub_phase` / `phase_iteration` / `total_reworks` visibility, the simplified state
  machine (no `review_pending` row), block-reason taxonomy display, the routing-decision
  and skip-gate trails. Slice 8 emits the data; Slice 13 displays it.
- **Slice 8 → the documentation slice (Slice 12, was 14, "Agent Readiness") + Slice 8's
  own Session 9 docs sweep:** this entire file is the design source. The
  user-facing pipeline docs ("how a task flows," "what The Engineer delivers," "how to
  add a review lens," "how feedback re-enters") draw their *why* from here. See
  "Documentation Seed" below.

## Findings (no decision needed — captured for implementation)

- `docs/configuration/orchestrator.md` documents `decomposition.auto_threshold_ms`,
  `suggest_threshold_ms`, `min_child_size_ms` — none exist in any schema. The docs lie.
  Verify every claimed config key against the Zod schemas during the docs sweep.
- Pre-v1: rewrite `001_schema.sql` to the final shape (drop `review_pending` from the
  state CHECK, drop the dead phase values, add `sub_phase` / `phase_iteration` /
  `total_reworks` to tasks, add `sub_phase` / `phase_iteration` / `total_reworks` to
  checkpoints). "Delete `~/.engineer/data.db` before running this version" goes in the
  cutover session log.
- No prompt-builder unit tests exist today for several phases; every new sub-phase prompt
  file gets one (closes the gap).
- The self-unblock path uses `agent.run` directly and must thread the signal too.

## Future Considerations

Captured in `docs/future-considerations.md` during implementation:

- **Parallel sub-phase execution.** v1 runs sub-phases sequentially (documented as a
  deliberate constraint in `docs/constraints.md`). A future version could let a phase
  declare independent sub-phases that run concurrently (e.g., the three review lenses).
- **Per-task pipeline customization.** The pipeline is global today. A future version
  could let a trigger or a task type select a pipeline variant.

## Session Breakdown

Sized to ~400k tokens each, focused, each green-on-commit. Quantity is not the goal;
value is. Refined in `.claude/temp/create-plan/slice-08-pipeline-phases.md`.

1. **Foundation cleanup.** Cut `integration`; collapse `review_pending` →
   `blocked(pr_review_pending)`; add the `BlockReason` enum + structured `BlockDetail`;
   decomposition residue in source + docs. Operates on the *current* runner, which stays
   live. Green.
2. **Pipeline core.** `pipeline/` runner + types + `cli-run` (with signal threading:
   `AgentRunRequest.signal` + adapter + the three agent plugins' `spawn({signal})`) +
   the mock-pipeline test harness + observability-in-runner. Built dark, tested in
   isolation. Green.
3. **Upstream phases.** `requirements/gather`, `research/investigate`, `planning/design`,
   `execution/implement` + `execution/verify`, with their prompts and per-sub-phase tests.
   Built dark. Green.
4. **Review + Delivery phases.** `review/*` (self-review + opt-in lenses + refine with
   the cap-3 repeat loop), `delivery/*` (the five sub-phases + skip-gates), `entryFor`,
   `arbitrate`. Built dark. Green.
5. **Atomic cutover.** Point `executeTask` at the new runner; delete the legacy runner,
   handlers, old prompts, old phase enum; finalize `001_schema.sql` (columns +
   checkpoints + 2-counter model). DB-wipe note. All tests now run against the new
   pipeline. The big green-cutover commit.
6. **Typed PR events (contract + plugin).** `GitHostingAdapter.detectPrEvents`;
   github-hosting plugin implementation (aggregates today's polling, computes
   `pr_ready_to_merge` statelessly); Core `arbitrate` + dedup + authorization.
7. **External re-entry + review-handler refactor.** Refactor the 996-line review-handler
   onto typed events; external events flow via DB re-queue + `entryFor`; wire
   `await-review` + `auto-merge`; delete the `approvedAwaitingCI` map; audit the
   `blocked` semantic consumers (health-monitor, unblock-resolver, response-poller).
8. **Dev-toolbox skill principles ported into prompts.** Concrete per-sub-phase prompt
   diffs (the port/adapt/skip table in the research doc); refactor-guide framing into the
   `self-review` lens.
9. **Project-wide docs sweep.** Architecture docs, configuration docs (verify every key
   against schemas), user-flow docs, plugin-author guides, README, bundled CLI docs,
   seed-example. Draws on this file's rationale. No dashboard UI (deferred to Slice 13).
10. **Closing standards sweep.** Line-by-line audit of every touched file against
    coding-standards / anti-patterns / philosophy, two-pass discipline. May spill to
    Session 11.

## Closing Standards Sweep

Mirrors Slice 7's closing pattern: full-file line-by-line audit of every file the slice
created or changed against `docs/coding-standards.md`, `docs/anti-patterns.md`,
`docs/philosophy.md`, and the principle-driven checks in `approach.md` (every documented
reference matches code; every manifest matches behavior; every swallowed error logged;
every constant single-sourced; no stale counts; no vestigial scaffolding; no
backward-compat re-exports). Two-pass discipline (Slice 7 Session 36 lesson — the second
pass finds the structural defects the first pass reads past). Update
`feedback_slice_closing_standards_sweep.md` if a new defect class surfaces.

## Lens Check

- **Resilience.** Strongly positive. Signal honoring makes termination real. Structured
  block reasons make the operator's diagnostic surface sharp. Per-sub-phase checkpoints
  mean a crash mid-Review-iteration-2 resumes at iteration 2. The stateless
  `pr_ready_to_merge` removes a whole class of restart bugs.
- **Plugin Integrity.** Positive. `detectPrEvents` moves platform aggregation behind the
  contract; dedup and authorization stay in Core; the sub-phase architecture is
  Core-internal. Core still compiles with every plugin deleted.
- **Plugin Authoring Simplicity.** Positive. The two contract additions
  (`AgentRunRequest.signal`, `GitHostingAdapter.detectPrEvents`) are minimal and typed.
- **UX Quality.** Strongly positive. The dashboard gains `phase` / `sub_phase` /
  iteration / structured block reasons (Slice 13 displays them). The deliverable framing
  (PR vs push-only) is explicit and documented. Block reasons are loud and actionable.

## Documentation Seed

> **For the future documentation slice and this slice's own Session 9 docs sweep.** This
> file is deliberately written as a design narrative, not a terse decision list, because
> the *why* captured here is the raw material for the user-facing docs. When the docs are
> written, these are the pieces to lift and adapt:

- **"How a task flows through The Engineer"** → the 6-phase model + the "intuition
  principle" (folders = phases, files = sub-phases) + the phases table.
- **"What The Engineer delivers"** → the Deliverable section (PR mode vs push-only,
  "done when merged" vs "done when pushed").
- **"How The Engineer handles review feedback"** → the typed PR-event vocabulary + the
  `entryFor` re-entry map + the loop-and-cap model.
- **"How to extend the pipeline" (contributor guide)** → the three newcomer walkthroughs
  below; the `SubPhase` type; "add a lens = add a file."
- **"How The Engineer stays observable"** → observability-by-construction.
- **Design rationale / architecture-decision record** → the panel findings and the five
  refinements (outcome-not-destination handoff, two-counter model, stateless merge
  readiness, observability-in-runner, the one defended boundary). These explain *why the
  architecture is shaped this way*, which is what separates good docs from a feature
  list.

### The newcomer walkthroughs (the maintainability bar, and excellent doc material)

- *Add a "performance" review lens* → copy `review/security.ts` to
  `review/performance.ts`, write the prompt, set `next: advance`, add one line to
  `pipeline.ts`, add a config enum value, add a snapshot test. One file plus one line.
- *Change what happens when verify fails* → open `execution/verify.ts`, edit its `next`
  function. One function, one file.
- *Understand how an approved PR gets merged* → `pipeline.ts`'s `entryFor` says
  `pr_ready_to_merge → delivery/auto-merge`; open that file and read `run` + `next`. Two
  hops.

The structure mirrors the mental model, the dangerous part is one well-tested file, and
observability cannot be forgotten. That is the "amazing to evolve and maintain" bar this
slice is held to.
