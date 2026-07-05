# Plan — Issue #29: Transient PR check-status lookup errors misread as CI failures

_Phase: planning · Source: github_issue FarzamMohammadi/the-engineer#29 · Date: 2026-07-05_

This plan verifies the requirements + research against live code (every line below re-read this
session), resolves the one owner-delegated design decision, stress-tests the chosen approach, runs a
pre-mortem, and lays out an ordered, checkable implementation. **No code is written here.**

---

## 0. Verification of prior phases (done this session)

I re-read every cited line. All material claims hold:

- `PRStatusSchema.checks_state = z.enum(["passing","failing","pending","none"])` — `adapters.ts:410`. No `unknown`. ✔
- Sibling `merge_state = z.enum(["mergeable","conflicting","unknown"])` — `adapters.ts:409`, with the load-bearing comment at 406–408. This is the precedent to mirror. ✔
- `getChecksState` catch returns `"failing"` — `github-hosting.ts:576–586`; local `type ChecksState` at `:547`; `Promise.all` of the two API calls at `:564–567`. ✔
- `derivePrEvents`: `=== "failing"` at `:488`, `=== "passing"` at `:504` — `unknown` falls through to *no event*. ✔
- `shouldPromoteApproval`: `=== "passing"` at `pr-event-poller.ts:204` — `unknown` won't promote. ✔
- **`decideReadiness` latent bug confirmed by hand-trace**: `auto-merge.ts:190–214`. With `checks_state="unknown", merge_state="mergeable"` the input matches none of `merged / auto_merge_disabled / failing / conflicting / merge_unknown / pending` and **falls through to `return { disposition: "merge" }`** at `:213`. This is reachable — `runAutoMerge` does a live `getPRStatus` re-check at `:123` that can itself hit the transient error. **Must fix.** ✔

**Exhaustive consumer re-grep** (`checks_state|checksState|ChecksState` across `src docs tests`, excluding the generated bundle) confirms the audit is complete — the only *branching* consumers are the six above plus the `FakeGitHostingPlugin` test double (`tests/helpers/fake-plugins/fake-git-hosting/index.ts:177,186`, same `=== "failing"`/`=== "passing"` shape → falls through correctly, no change). All other hits are log-only interpolations (`auto-merge.ts:171,175,229`, `github-hosting.ts:332`) that print `unknown` fine. **No new consumer was missed.** ✔

Non-material correction from research (§7) noted and accepted: the fix changes the *returned value* (`"failing"`→`"unknown"`), not whether `getChecksState` throws — it already swallows internally today — so the poller's `recentFailures` failure-window behavior is **unchanged**. No hidden interaction there.

---

## 1. Approaches considered

### Approach A — **Add an `unknown` enum member** (chosen, simplest)

Add `"unknown"` to the `checks_state` contract, return it from `getChecksState`'s `catch` instead of
`"failing"`, and add the symmetric `checks_state === "unknown" → retry_wait` guard to
`decideReadiness`. Every other consumer already branches with `if (x === "specific")` and falls
through to the correct no-op on `unknown`; they need regression tests, not code. Mirrors the existing,
recent, well-commented `merge_state`/`unknown` design end-to-end.

- **New files:** 0. **New abstractions:** 0. **New event types:** 0. **New state:** 0.
- Blast radius: one enum + one plugin function + one readiness ladder + two docs + the regenerated bundle.

### Approach B — **Boolean `checks_lookup_failed` flag on `PRStatus`** (rejected)

Keep `checks_state` four-valued and add a parallel boolean. Rejected: strictly *more* contract surface
than a single enum member; forces every consumer to check two fields to answer one question ("is the
CI state trustworthy?"); and diverges from the `merge_state`/`unknown` precedent, so it reads as
foreign to a reviewer. It buys nothing the enum member lacks.

### Approach C — **Catch further out / return no `PRStatus`** (rejected)

Let the error propagate and have the caller skip the poll. Rejected: every consumer needs a
`PRStatus`; there is no "absent" shape in the contract, and inventing one loses the
`passing/pending/none` distinction the same call already computes. The `unknown` value *is* the clean
"absent CI answer" signal.

**Decision: Approach A.** Complexity did not earn its place in B or C — A is both the minimal change
and the idiomatic one (it extends a proven pattern rather than inventing one).

---

## 2. The owner-delegated design decision (I own this)

The owner explicitly delegated: _"whether a failure signal should require brief confirmation (a
re-check on the next poll, or a small retry) before it drives a real rework at all … Decide the exact
policy as part of the work."_ (AC #8.) Two genuinely-distinct failure modes must be separated to
decide well:

- **Mode 1 — lookup error** (`ECONNRESET`, dropped connection, rate-limit): the API *call throws*. This
  is the reported incident (PR #28). **Fully resolved by returning `unknown`** — no rework, wait, re-check.
- **Mode 2 — flaky *failing value***: the API *succeeds* and returns `failing`, but it's transient at the
  GitHub level (e.g. a check reported failed, then auto-re-runs green). The `unknown` fix does **not**
  touch this — a successfully-read red still drives rework. This is the only thing a "confirmation
  policy" could add.

Candidate policies for Mode 2:

| Policy | What it does | Cost | Helps Mode 2? |
|---|---|---|---|
| **P0 — no confirmation** (chosen) | a single successful `failing` reading reworks immediately | none; stateless | — (relies on existing circuit-breaker) |
| **P1 — in-lookup retry** | retry the two API calls N× inside `getChecksState` before concluding | latency on every failed lookup; local, stateless | **No** — an immediate re-call returns the *same* failing value (the check hasn't re-run) |
| **P2 — cross-poll confirmation** | require 2 consecutive `failing` polls before emitting `pr_ci_failure` | **persisted per-PR state** | Yes |

**Decision: P0 — no confirmation-before-rework. A genuine `failing` reading reworks immediately, as
today.** Reasoning (recorded so a reviewer sees the trade weighed, per AC #8):

1. **The `unknown` fix alone resolves the reported bug and satisfies every hard acceptance criterion
   (1–7, 9–11).** Mode 1 — the actual incident — never reworks after the fix. The AC-#8 guarantee "a
   single *transient* reading never triggers a rework" is met by `unknown` for the transient
   (lookup-error) class, which is the entire thrust of the issue.
2. **P2 requires breaking a load-bearing invariant.** The poller is deliberately stateless —
   `derivePrEvents` is "recomputed from the live PR on every poll … no in-memory wait-state to lose on
   restart" (`github-hosting.ts:464–473`). Two-poll confirmation inherently requires remembering the
   previous poll's result = persisted per-PR CI state. That is an **architecture change**, which my
   autonomy policy places in the *always-check-first* category, and it cuts directly against the
   documented design grain. Introducing it unprompted would be over-engineering against the codebase.
3. **The residual Mode-2 risk is already bounded by an existing mechanism.** `max_blocker_reentries`
   (default 3, `config.ts:282–289`; enforced at `pr-event-poller.ts:293`) escalates a non-converging
   automated-blocker loop to the owner instead of reworking forever. A genuinely-flaky red check costs
   at most a few passes before escalation — the damage P2 would prevent is already capped.
4. **P1 is redundant + net-negative.** It helps only Mode 1, which `unknown` already makes cheap (one
   wasted poll of *waiting*, not a rework). It adds latency to every failed lookup and does nothing for
   Mode 2. Not worth the code.
5. **AC #6 explicitly sanctions P0.** It reads: _"a real red check still routes to rework (**subject to
   the resolved confirmation policy**)."_ The parenthetical acknowledges immediate rework as a valid
   resolution; otherwise it would not say "a real red check still routes to rework."

**Why this is not surfaced as a `decisions[]` entry for owner confirmation:** the owner *delegated this
choice to me* ("Decide the exact policy as part of the work"), so re-asking would re-ask an answered
question. And P0 introduces **no** high-stakes change (no new architecture, no new state, no new
dependency) — it is the minimal fix. (Had I chosen P2, its architectural cost *would* warrant
surfacing.) The decision is recorded here and will be echoed in a code comment on the `catch` and in
the docs so a reviewer can see what was decided and why.

### Sub-decision: keep `Promise.all` — any lookup error → `unknown` (do **not** switch to `allSettled`)

Research floated salvaging a partial success (one API answers, the other errors) via `Promise.allSettled`.
**Rejected.** `getChecksState` combines the two sources worst-state-wins; if one source errors we
genuinely don't know what it would have reported — it may have been the one carrying a failure.
Salvaging the other source's `passing` would let us **claim CI is passing on incomplete data**, the
exact safety property the owner wants preserved ("never claim CI is *passing* on bad data"). The safe,
faithful behavior is: *any* error in the lookup → `unknown` → wait and re-read next poll. Keep
`Promise.all`. (This also keeps the change minimal.)

---

## 3. Stress-test of the chosen plan

- **Plugin Opacity — would Core compile with every plugin deleted?** ✔ Yes. The `checks_state` enum
  lives in Core's contract (`src/schemas/adapters.ts`) and is additive; `decideReadiness` (Core) and
  `derivePrEvents` (module-level, imported by Core paths) branch on the *contract value*, never on
  plugin internals. `getChecksState` is inside the github plugin; deleting the plugin removes it and
  Core references nothing from it. No Core→plugin reach is introduced.
- **Isolation — shared mutable state / cross-task bleed?** ✔ None. P0 adds zero state. `getChecksState`
  stays pure-per-call, `decideReadiness` and `derivePrEvents` stay pure. (This is precisely why P2 was
  rejected — it *would* add per-PR state.)
- **Boundaries — contracts, not internals?** ✔ The `PRStatus.checks_state` enum is the contract. The
  plugin *produces* the value; Core *reads* it. Every consumer goes through the `PRStatus` shape.
- **Reversibility — what's hard to undo?** The one semi-durable decision is the **contract change**
  (`checks_state` gains `unknown`) — it's part of the `GitHostingAdapter` public shape other hosting
  plugins implement. It is **additive** (existing consumers/implementers keep working; only the github
  plugin ever *emits* `unknown`), and it mirrors the already-shipped `merge_state.unknown`, so regret is
  low. Everything else (`decideReadiness` branch, log message, docs/bundle, P0) is trivially reversible.
  Named explicitly so review knows the contract widened.

All four checks pass — no redesign needed.

---

## 4. Pre-mortem (assume it ships with a subtle flaw)

1. **Doc-bundle drift → CI red (most likely mechanical failure).** Editing the two `.md` files but
   forgetting to regenerate `src/cli/bundled/plugin-docs.ts`, or hand-editing the bundle. The bundle
   embeds each doc's raw markdown via `JSON.stringify` and **"CI fails on drift"** (header comment in
   the file). _Mitigation:_ Part 4 is an explicit ordered step — edit `.md` first, then run
   `pnpm run docs:bundle` (`tsx scripts/gen-bundled-docs.ts && biome format`), never touch the bundle
   by hand; verification greps the regenerated bundle for the new `unknown` text and runs `lint`.

2. **A fall-through consumer silently mishandles `unknown` (semantic, compiles fine).** Because there is
   **no exhaustive `switch`** on `checks_state` anywhere (verified), the enum change won't break the
   build — the risk is entirely semantic. The sharpest is `decideReadiness` (would merge). _Mitigation:_
   the explicit `unknown → retry_wait` fix **plus** regression tests that lock each fall-through
   (auto-merge: no merge; `derivePrEvents`: no event; `shouldPromoteApproval`: no promote) so a future
   edit that mishandles `unknown` fails a test.

3. **The regression test doesn't exercise the *real* error path (masking).** If a test stubs
   `getChecksState` to return `unknown`, it proves nothing about the `catch` — it would pass even if the
   catch still returned `"failing"`. _Mitigation:_ AC #10's key test drives the **real** Octokit
   rejection (`mockRejectedValueOnce(new Error("read ECONNRESET"))`) through `getPRStatus` and asserts
   `checks_state === "unknown"`. This test *fails* if anyone reverts the catch to `"failing"`. This is
   the "a test that still passes when the code is deleted proves nothing" guard, applied deliberately.

4. **(Accepted, not a flaw) Persistent `unknown` → indefinite wait.** If the lookup keeps failing every
   poll, the task waits forever, re-checking each poll, with no escalation. The issue **prescribes** this
   ("leave the task waiting and re-check on the next poll"). It's benign: `unknown` emits no event → no
   blocker streak, and `getChecksState` swallows internally → no failure-window tick. Documented so
   review doesn't misread it as a gap. (Escalation-on-persistent-unknown would exceed the stated want.)

---

## 5. Ordered implementation plan

Each part lists concrete file paths and a verification step. Execute in order; later parts assume
earlier ones are green.

### Part 1 — Contract: add `unknown` to `checks_state`
- [ ] `src/schemas/adapters.ts:410` — change the enum to
      `z.enum(["passing", "failing", "pending", "none", "unknown"])`.
- [ ] Add a comment above `checks_state` (mirroring the `merge_state` comment at 406–408) stating:
      `unknown` = "the CI status could not be determined (the lookup itself errored — a network blip,
      dropped connection, or rate-limit); it is NOT `failing`, and Core treats it as a wait, never rework
      and never merge." (This makes the pre-existing "mirroring `checks_state`" phrasing in the
      `merge_state` comment accurate for the first time.)
- [ ] **Verify:** `pnpm run typecheck` compiles; `tests/unit/schemas/adapters.test.ts` still green.

### Part 2 — Plugin: return `unknown` on any lookup error
- [ ] `src/plugins/git-hosting/github-hosting/github-hosting.ts:547` — extend the local type to
      `type ChecksState = "passing" | "failing" | "pending" | "none" | "unknown";`.
- [ ] Same file, `getChecksState` `catch` (`:576–586`) — `return "unknown";` instead of `"failing"`.
      Keep the `Promise.all` at `:564–567` (any error → `unknown`; **no** `allSettled` salvage — see §2
      sub-decision). Rewrite the log message from _"Checks-state lookup failed — reporting CI as failing"_
      to _"CI status lookup failed — reporting checks_state as unknown (will re-check next poll)"_, keeping
      the sanitized `error instanceof Error ? error.message : String(error)` field. Update the block
      comment above the `return` (currently "Pessimistic fallback — treat … as failing") to state the P0
      rationale: an unverified lookup is `unknown`, never `failing` — so a transient blip never reworks,
      while we still never claim `passing` on bad data.
- [ ] **Verify:** `pnpm run typecheck`; new catch-path unit test (Part 5b) passes and asserts `unknown`.

### Part 3 — Auto-merge safety fix: `unknown → retry_wait` (the latent bug)
- [ ] `src/core/orchestrator/pipeline/delivery/auto-merge.ts:decideReadiness` — insert, **before** the
      final `return { disposition: "merge" }` at `:213` (place it right before the existing
      `checks_state === "pending"` guard at `:210` for readability), a distinct branch mirroring the
      `merge_state === "unknown"` branch at `:206–208`:
      `if (status.checks_state === "unknown") return { disposition: "retry_wait", reasoning: "CI status could not be determined — waiting to re-check rather than merging on unverified checks" };`
- [ ] Update the comment at `:209` (currently "only 'pending' returns to the wait") to also name
      `unknown` as a wait state, so the ladder reads truthfully.
- [ ] **Verify:** `pnpm run typecheck`; new auto-merge unit test (Part 5c) asserts `retry_wait` and that
      `mergePR` is **not** called on `checks_state: "unknown"`.

### Part 4 — Docs + regenerated bundle
- [ ] `docs/plugins/git-hosting/README.md:92` — add `unknown` to the `checks_state` type union and a
      short comment (mirroring the `merge_state` comment at `:89–90`): `unknown` = CI status could not be
      determined (lookup errored) → Core waits, never rework, never merge.
- [ ] `docs/plugins/git-hosting/github-hosting.md` — in the **PR status** paragraph (`:57`) and the
      **Event detection** paragraph (`:65`), add a sentence: when the CI lookup errors transiently, the
      plugin reports `checks_state: unknown` (never `failing`), so a network blip leaves the task waiting
      and re-polling instead of triggering a phantom rework — while still never reporting `passing` on an
      unverified lookup.
- [ ] Run **`pnpm run docs:bundle`** to regenerate `src/cli/bundled/plugin-docs.ts`. **Never hand-edit
      the bundle.**
- [ ] **Verify:** `grep -c "unknown" src/cli/bundled/plugin-docs.ts` reflects the new text within the two
      git-hosting docs; `pnpm run lint` passes (drift check clean); `git status` shows the bundle changed.

### Part 5 — Regression tests (the permanent guard)
- [ ] **(5a) Schema** — `tests/unit/schemas/adapters.test.ts` (near `:762`): extend/add a case asserting
      `PRStatusSchema` accepts `checks_state: "unknown"` (and still the other four), and rejects an
      invalid value. Locks Part 1.
- [ ] **(5b) THE key regression, AC #10** — `tests/unit/plugins/git-hosting/github-hosting/github-hosting.test.ts`,
      `getPRStatus()` block (near `:325`): new test — `mockOctokit.checks.listForRef.mockRejectedValueOnce(new Error("read ECONNRESET"))`
      (and a sibling test rejecting `repos.getCombinedStatusForRef`), then assert
      `status.checks_state === "unknown"` (explicitly **not** `"failing"`). **Drives the real `catch`** —
      fails if the catch reverts to `"failing"`. Also assert (via a spy on the plugin's logger/observer, if
      the harness exposes it) that no `pr_ci_failure` is derivable from this status — or cover that in 5d.
- [ ] **(5c) auto-merge fall-through** — `tests/unit/core/orchestrator/pipeline/delivery/auto-merge.test.ts`
      (beside the `merge_state: "unknown"` test at `:201`): new test — `mockCtx({ status: { checks_state: "unknown" } })`
      → `disposition: "retry_wait"`, `mergePR` **not** called. Locks Part 3.
- [ ] **(5d) derivePrEvents fall-through** — same github-hosting test file, `derivePrEvents` block (beside
      the `merge_state: "unknown"` test at `:660`): new test —
      `derivePrEvents(status({ checks_state: "unknown" }), approved, [])` → `[]` (no `pr_ci_failure`, no
      `pr_ready_to_merge`). Locks the `derivePrEvents` fall-through against future edits.
- [ ] **(5e) poller /approve fall-through** — `tests/unit/core/daemon/pr-event-poller.test.ts` (beside the
      `checks_state: "pending"` non-promotion test at `:260`): new test —
      `setup({ events: [approve()], prStatus: { checks_state: "unknown" } })` → `requestTransition` **not**
      called (no `pr_ready_to_merge` promotion), task stays waiting. Locks the `shouldPromoteApproval`
      fall-through.
- [ ] **(Optional strengthener) end-to-end no-op on `unknown`** — the `FakeGitHostingPlugin`
      (`tests/helpers/fake-plugins/fake-git-hosting/index.ts`) already falls through correctly on
      `unknown` (no code change). If a poller/integration test can set a stored PR's `checks_state` to
      `unknown`, add one asserting the poll produces no re-entry and no merge. Nice-to-have — the unit
      tests above already carry the AC-#10 proof; do **not** modify fake-plugin production logic.
- [ ] **Verify:** run each touched test file individually, then `pnpm test`.

### Part 6 — Full project gates (AC #11)
- [ ] `pnpm run typecheck` — green.
- [ ] `pnpm run lint` — green (includes doc-bundle drift check).
- [ ] `pnpm test` (unit) — green, including all new regressions.
- [ ] `pnpm run test:integration` — green (the fake plugin falls through on `unknown`; confirm
      `tests/integration/pipeline-review-delivery.integration.test.ts` and siblings stay green).

---

## 6. Regression strategy (guarding against future breakage)

The feature is protected permanently by tests that each pin one link in the chain, so a future edit
that regresses any link fails CI:

- **5b** pins the *source of truth* — the real `catch` produces `unknown`, not `failing`. It exercises
  the genuine error path (Octokit rejection), so it cannot pass on a stubbed default; deleting or
  reverting the catch fix turns it red.
- **5c / 5d / 5e** pin the three fall-through consumers whose correctness is "nothing matched" — exactly
  the behavior a future refactor can silently break. Each asserts the *absence* of the harmful action
  (no merge / no `pr_ci_failure` / no promotion).
- **5a** pins the contract shape.

Together they prove the end-state: a transient check-status lookup error yields `checks_state: "unknown"`,
derives **no `pr_ci_failure`**, and drives **no merge** — the exact regression the issue describes.

---

## 7. Decision log (what was chosen, rejected, and locked in)

| Decision | Chosen | Rejected | Locks in |
|---|---|---|---|
| Model "lookup failed" | New `unknown` enum member on `checks_state` | Boolean flag; catch-further-out/no-`PRStatus` | Additive contract widening on `GitHostingAdapter`, mirroring `merge_state.unknown` |
| Confirmation-before-rework (delegated) | **P0 — none**; genuine `failing` reworks immediately | P1 in-lookup retry; P2 cross-poll confirmation | Poller stays stateless; Mode-2 risk bounded by existing `max_blocker_reentries` |
| Partial-lookup handling | Keep `Promise.all` — any error → `unknown` | `Promise.allSettled` partial salvage | Preserves "never claim `passing` on bad data" |
| `decideReadiness` on `unknown` | Distinct `unknown → retry_wait` branch before the merge fall-through | Leaving the fall-through (→ would merge) | Closes the latent auto-merge safety bug |
| Docs | Edit two `.md` + regenerate bundle via `pnpm run docs:bundle` | Hand-editing the generated bundle | CI drift-check stays green |

---

## 8. Out of scope (explicitly not touched)

No new `PrEvent` type; no dashboard/vocabulary change; no config knob (P0 needs none); no other hosting
plugin (there is none); no `Promise.allSettled` refactor; no change to the poller's failure-window,
`max_failures_before_pause`, or `max_blocker_reentries` machinery. The change stays confined to: one
enum, one plugin function, one readiness ladder, two docs + the regenerated bundle, and the tests.

---

## 9. Status

`ok` — the plan is decision-complete. The one owner-delegated design choice (confirmation policy) is
resolved to **P0** with recorded reasoning and requires no owner sign-off (delegated, and introduces no
high-stakes change). No `needs_human`. Execution can proceed against the ordered steps above.
