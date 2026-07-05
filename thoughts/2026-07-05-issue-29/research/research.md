# Research — Issue #29: Transient PR check-status lookup errors misread as CI failures

_Phase: research · Source: github_issue FarzamMohammadi/the-engineer#29 · Date: 2026-07-05_

This phase verifies the requirements doc against the actual code, maps the full blast radius, and
challenges the approach. **Observations** are facts read directly from code; **Inferences** are what I
conclude from them.

---

## 1. Verdict up front

**The premise is correct — the bug exists exactly as described, confirmed by reading the code.** No
premise conflict. The change surface is small, confined, and mirrors an existing precedent in the same
files (`merge_state`'s `unknown`). The requirements doc's audit is accurate on every material point; I
found **one non-material inaccuracy** (the "failure-window side effect" framing, §7) and a handful of
**additional facts** that sharpen the execution/planning picture (a test-double consumer, the exact
test inventory, the config location for any confirmation knob, and confirmation that several schemas
need **no** change).

---

## 2. The bug, traced end to end (Observations)

**The conflation lives in one `catch`.** `getChecksState`
(`src/plugins/git-hosting/github-hosting/github-hosting.ts:556-587`) wraps
`Promise.all([getCombinedStatusForRef, checks.listForRef])` in a single `try/catch`. On **any**
rejection it logs `"Checks-state lookup failed — reporting CI as failing"` and `return "failing"`
(lines 580-586). The local type is `type ChecksState = "passing" | "failing" | "pending" | "none"`
(line 547). Verified.

**The contract has no `unknown`.** `PRStatusSchema.checks_state = z.enum(["passing", "failing",
"pending", "none"])` (`src/schemas/adapters.ts:410`). Its sibling `merge_state = z.enum(["mergeable",
"conflicting", "unknown"])` (line 409) **already models exactly the pattern this task asks for**, with
a load-bearing comment (lines 406-408): `unknown` = "not yet computed", never folded into a negative
state, always treated as a wait. Verified.

**The failing reading drives rework, via this chain (all verified):**
1. `doGetPRStatus` (`github-hosting.ts:190-219`) calls `getChecksState` (line 198) and puts the result
   into `PRStatus.checks_state` (line 216).
2. `derivePrEvents` (`github-hosting.ts:488-489`): `if (status.checks_state === "failing") →
   push { type: pr_ci_failure }`.
3. `doDetectPrEvents` (`github-hosting.ts:319-339`) returns those events.
4. The poller's `pollSingleTask` → `arbitrate` → `routeEvent` → `isAutomatedBlocker(pr_ci_failure) ===
   true` → `routeBlockerEvent` (`pr-event-poller.ts:274-300`) → `reenter(task, pr_ci_failure)` re-queues
   the task at execution and posts the "CI is failing … reworking" ticket notice
   (`eventNotice`, line 445-446). **This is the phantom rework.**

**Inference.** A transient `ECONNRESET` inside `getChecksState` is indistinguishable, downstream, from
a genuine red check — both arrive as `checks_state: "failing"`. Introducing a distinct `unknown` value
that `derivePrEvents` ignores severs the transient path from the rework path while leaving the genuine
path untouched. This is precisely what the issue asks for, and the code confirms it is achievable with
a localized change.

---

## 3. The change surface (line-precise)

| # | File:line | Change | Confidence |
|---|---|---|---|
| a | `src/schemas/adapters.ts:410` | Add `"unknown"` to the `checks_state` enum + a comment mirroring the `merge_state` one (lines 406-408). | High |
| b | `src/plugins/git-hosting/github-hosting/github-hosting.ts:547` | Add `"unknown"` to the local `type ChecksState`. | High |
| c | `src/plugins/git-hosting/github-hosting/github-hosting.ts:576-586` | The `catch` returns `"unknown"` instead of `"failing"`; update the log message (no longer "reporting CI as failing"). | High |
| d | `src/core/orchestrator/pipeline/delivery/auto-merge.ts:190-214` | `decideReadiness`: add an `if (status.checks_state === "unknown") return retry_wait` branch **before** the final `return { disposition: "merge" }` (line 213). **This is the latent safety bug.** | High |
| e | `docs/plugins/git-hosting/README.md:92` | Add `unknown` to the `PRStatus` type block. | High |
| f | `docs/plugins/git-hosting/github-hosting.md:57 & 65` | Describe `unknown` in the PR-status / event-detection prose. | High |
| g | `src/cli/bundled/plugin-docs.ts` | **Regenerated**, never hand-edited — run `pnpm run docs:bundle`. | High |

**Observation (d) is the sharpest edge.** `decideReadiness` (`auto-merge.ts:190-214`) is an ordered
`if`-ladder: `merged` → `auto_merge_disabled` → `checks_state === "failing"` → `merge_state ===
"conflicting"` → `merge_state === "unknown" → retry_wait` → `checks_state === "pending" → retry_wait`
→ **else `return { disposition: "merge" }`**. I traced it with `checks_state === "unknown",
merge_state === "mergeable"`: it matches **none** of the guards and falls through to
`disposition: "merge"`. **Confirmed: without fix (d), the enum change silently enables merging on
unverified CI**, violating the exact safety property the owner named. `runAutoMerge` does a live
`getPRStatus` re-check (`auto-merge.ts:123`) that can itself hit the transient error, so this path is
reachable, not theoretical. The symmetric `merge_state === "unknown" → retry_wait` branch already
exists at line 206 — fix (d) is the CI-side twin of it.

---

## 4. Blast-radius: every `checks_state` consumer (audited & verified)

I grepped `checks_state | checksState | ChecksState` across `**/*.{ts,tsx,md,js}` (excluding
`node_modules` and the generated bundle). Full inventory:

### 4a. Consumers that need a code change

| Consumer | File:line | Why |
|---|---|---|
| The enum | `adapters.ts:410` | Add `unknown` (change a). |
| `ChecksState` type + `getChecksState` catch | `github-hosting.ts:547, 585` | Add `unknown`; return it on error (changes b, c). |
| `decideReadiness` fall-through | `auto-merge.ts:213` | Add `unknown → retry_wait` (change d). **Latent bug.** |

### 4b. Consumers that fall through correctly — **audit + test, no code change**

| Consumer | File:line | Behavior on `unknown` (traced) | Correct? |
|---|---|---|---|
| `derivePrEvents` red-check branch | `github-hosting.ts:488` (`=== "failing"`) | `unknown ≠ failing` → **no `pr_ci_failure`** | ✅ |
| `derivePrEvents` ready branch | `github-hosting.ts:504` (`=== "passing"`) | `unknown ≠ passing` → **no `pr_ready_to_merge`** | ✅ |
| `shouldPromoteApproval` (`/approve`) | `pr-event-poller.ts:204` (`=== "passing"`) | `unknown ≠ passing` → **won't promote**; `/approve` comment is then filtered by `isActionableRework` → task keeps waiting | ✅ |
| `FakeGitHostingPlugin.doDetectPrEvents` | `tests/helpers/fake-plugins/fake-git-hosting/index.ts:177, 186` | Same `=== "failing"` / `=== "passing"` shape → falls through to no event | ✅ (test double) |

**I traced `derivePrEvents(status={checks_state:"unknown", merge_state:"mergeable"},
review={approved:true}, [])` by hand: it returns `[]`** — no `pr_ci_failure`, no `pr_merge_conflict`,
no `pr_comments` (no changes-requested, no unapproved-with-comments), no `pr_ready_to_merge`. The task
stays `blocked(pr_review_pending)` with no notice, no dismissal, no re-push. This satisfies acceptance
criteria 3 and 5 **by fall-through** — but each still needs a regression test (§6) to lock it, because
"correct because nothing matched" is exactly the kind of behavior a future edit can silently break.

### 4c. Consumers that only log the value (no branching)

`auto-merge.ts:171, 175, 229` interpolate `status.checks_state` into log/decision strings. `unknown`
prints fine; no change.

### 4d. Places that do **NOT** change (verified — important negative space)

- **`src/schemas/git-hosting-events.ts` and `git-hosting-event-types.ts`** — the `PrEvent` vocabulary
  (`pr_comments | pr_ci_failure | pr_merge_conflict | pr_ready_to_merge | pr_merged`) is **unchanged**.
  This task adds **no new event**; `unknown` produces the *absence* of an event. Confirmed by reading
  both files.
- **`src/dashboard/client/src/lib/vocabulary.ts`** — grepped; it does **not** enumerate `checks_state`
  values, so no dashboard label/UI change is needed.
- **The `PrEvent` discriminated-union schema** — unchanged, same reason.
- **Other hosting plugins** — there are none. `grep "extends GitHostingAdapter"` returns only the real
  `GitHubHostingPlugin`, the `FakeGitHostingPlugin` test double, and a throwaway stub in
  `tests/unit/adapters/git-hosting.test.ts`. The contract is additive; the one production implementer
  is the one being edited.

**Inference.** The requirements doc's "5 call sites" audit is complete and correct. My grep surfaced
**two consumers it did not name** — the `FakeGitHostingPlugin` test double (4b) and the pure
log-only sites (4c) — neither of which needs a logic change, but the fake plugin is a useful lever for
poller/integration tests (§6). And critically, the **negative space (4d) confirms the change stays
confined** to the enum + one plugin + one readiness ladder + docs.

---

## 5. Execution-path scenarios (re-verified against code)

- **Scenario A (the reported bug).** CI green → later poll hits `ECONNRESET` in `getChecksState` →
  today returns `"failing"` → `pr_ci_failure` → rework. **After:** returns `"unknown"` → `derivePrEvents
  → []` → no re-entry → next poll reads the real (green) state and proceeds. ✅ Resolved by changes a-c.
- **Scenario B (genuine red CI).** A check truly fails → lookup **succeeds** → `resolveChecksApiState`
  returns `"failing"` (lines 603-628) → `pr_ci_failure` → rework, exactly as today. Preserved: the
  `catch` only fires on an API *error*, never on a successfully-read red result. ✅
- **Scenario C (auto-merge live re-check blips).** Task is `pr_ready_to_merge`; `runAutoMerge`'s
  `getPRStatus` (line 123) hits a transient error → `checks_state: "unknown"`. Without fix (d) →
  `disposition: "merge"` (merges unverified). With fix (d) → `retry_wait` → returns to the review
  wait, retries next poll. ✅ Preserves "never auto-merge on unverified status."

---

## 6. Test inventory (the contract for execution & review)

All are Vitest. The existing `merge_state === "unknown"` tests are the exact templates to mirror.

| Test file | Existing anchor to mirror | What to add/update |
|---|---|---|
| `tests/unit/plugins/git-hosting/github-hosting/github-hosting.test.ts` | `getPRStatus()` block, lines 265-436, mocks Octokit per-call (`mockOctokit.repos.getCombinedStatusForRef` / `mockOctokit.checks.listForRef`). **No existing test covers the `catch` path.** | **New (the key regression, AC #10):** make one/both check APIs `mockRejectedValueOnce(new Error("read ECONNRESET"))` and assert `status.checks_state === "unknown"` (not `"failing"`). Exercises the *real* error path. |
| same file, `derivePrEvents` block, lines 606-665 | Line 660-665: `"treats unknown mergeability as no conflict"` (the direct precedent) | **New:** `derivePrEvents(status({checks_state:"unknown"}), approved, [])` → `[]` (no `pr_ci_failure`, no `pr_ready_to_merge`). |
| `tests/unit/core/orchestrator/pipeline/delivery/auto-merge.test.ts` | Line 201-208: `"waits rather than reworking when mergeability is not yet computed (unknown)"` (`mockCtx({status:{merge_state:"unknown"}})` → `retry_wait`) | **New:** `mockCtx({status:{checks_state:"unknown"}})` → `disposition: "retry_wait"`, `mergePR` not called. Locks fix (d). |
| `tests/unit/core/daemon/pr-event-poller.test.ts` | Line 261/276: `setup({events:[approve()], prStatus:{checks_state:"pending"}})` for a non-promoting `/approve` | **New:** `prStatus:{checks_state:"unknown"}` + authorized `/approve` → no `pr_ready_to_merge`, task stays waiting (no `requestTransition`). |
| `tests/unit/schemas/adapters.test.ts` | Line 762-768: `"rejects an invalid merge_state and accepts the three valid ones"` | **New/extend:** assert `checks_state` accepts `"unknown"` (and the other four). |

**Fixtures carrying `checks_state: "passing"`** that will still typecheck unchanged (no edit needed, but
listed so review knows they were considered): `fake-git-hosting/index.ts:93`,
`tests/unit/adapters/git-hosting.test.ts:56`, and the `status`/`prStatus`/`mockCtx` factory defaults in
the four test files above.

**Inference.** Because `unknown` is a *new, additive* enum member and every consumer branches with `if
(x === "specific")` (no exhaustive `switch` on `checks_state` anywhere — verified), **the build will
not break** on the enum change; the risk is entirely *semantic* (a consumer silently mis-handling
`unknown`), which is why the fall-through consumers in §4b each need an explicit regression test even
though they need no code change.

---

## 7. Correction to the requirements doc (non-material, for the record)

Requirements §"A separate, already-safe failure path" (lines 88-92) says: _"once `getChecksState`
returns `unknown` instead of throwing, a checks-lookup blip no longer ticks the poller's failure
window."_

**Observation:** `getChecksState` **already** swallows its error internally today (`catch → return
"failing"`), so it does **not** throw today either. `doDetectPrEvents` therefore already returns
successfully on a checks blip, and the poller's `recentFailures` window (`pr-event-poller.ts:112`) is
**already not** ticked by a checks-lookup blip. **The fix changes the returned *value* (`"failing"` →
`"unknown"`), not whether it throws — so there is _no change_ to failure-window behavior.** The
doc's phrasing implies a throw-vs-return change that isn't happening. Immaterial to the outcome, but
planning should not assume the failure-window semantics shift. (The poller's outer `catch` at
`pr-event-poller.ts:109-115` only fires if the *whole* `detectPrEvents` throws — e.g. `pulls.get` or a
review/comments call fails — which remains unchanged.)

---

## 8. Conventions to mirror (so the change reads as native)

- **Mirror `merge_state`'s `unknown` end to end**: the enum comment style
  (`adapters.ts:406-408`), the mapping helper's tri-state note (`mapMergeState`,
  `github-hosting.ts:531-545`), the `derivePrEvents` "only a *definitive* negative is an event"
  comment (`github-hosting.ts:491-494`), and the `decideReadiness` `unknown → retry_wait` branch
  (`auto-merge.ts:204-208`). Reusing this exact shape is what makes the change reviewer-obvious.
- **Named branches, one concern each; no exhaustive switch to satisfy.** The codebase deliberately uses
  ordered `if`-ladders here; add the `unknown` guard in the same idiom rather than restructuring.
- **The catch's log message must change intent**: it currently asserts "reporting CI as failing";
  after the fix it should say something like "CI status unavailable — reporting unknown" so an operator
  reading logs sees the truth. Keep the sanitized `error.message` field.
- **Docs are generated**: edit the two `.md` files, then `pnpm run docs:bundle` (runs
  `scripts/gen-bundled-docs.ts` + `biome format`), which re-renders `src/cli/bundled/plugin-docs.ts`
  via `JSON.stringify` of the raw markdown. **Never hand-edit the bundle.** CI fails on drift.

---

## 9. Challenge & simplification (the code you don't write)

**Is there a simpler approach than a new enum value?** Considered and rejected: (i) catching the
error further out and returning no `PRStatus` — but every consumer needs a `PRStatus`, and this loses
the passing/pending/none distinction; (ii) a boolean `checks_lookup_failed` flag alongside
`checks_state` — strictly more surface than one enum member and doesn't match the `merge_state`
precedent. The enum member is the minimal, idiomatic change. **Simplest genuinely-correct approach =
the requirements' approach.** Confirmed.

**Are the existing patterns good, or legacy to avoid?** The `merge_state`/`unknown` precedent is
recent, well-commented, and directly analogous — good to copy, not legacy.

**Existing mechanism that already solves part of this?** Yes — the whole `merge_state === "unknown" →
wait` machinery. The task is essentially "extend that proven idea to `checks_state`." Nothing new needs
inventing.

### The delegated design decision (confirmation-before-rework) — facts for planning, not a decision

The issue (and requirements AC #8) explicitly **delegates** to design: _should a genuine `failing`
reading be confirmed (a re-check / small retry) before it drives rework?_ Research findings that bound
this decision:

- **The minimal `unknown` fix already fully resolves the reported bug** (a transient *lookup error*
  never reworks). Confirmation-before-rework addresses a *different, rarer* residual: a genuine
  `failing` *value* that is itself flaky at the GitHub level (e.g. a check reported failing, then
  re-run green). The reported incident (PR #28) was a lookup error, not a flaky value.
- **Two implementation shapes, with a real design tension:**
  - **(a) In-lookup retry** inside `getChecksState` (retry the API call a couple times before
    concluding). Helps only if the *reading* is flaky; a truly-red check re-reads red. Stateless,
    local, no persistence — cheapest, but narrow.
  - **(b) Cross-poll confirmation** (require two consecutive `failing` polls before emitting
    `pr_ci_failure`). This needs **persisted per-PR state**, which cuts against the poller's
    stateless-by-design contract (`derivePrEvents` "recomputed on every call so merge-readiness
    survives a daemon restart with no in-memory wait state" — `github-hosting.ts:466-473`). Precedent
    exists for *some* persisted review state (`task.review.consecutive_blocker_reentries`,
    `pr-event-poller.ts:292`), so it's not unheard-of, but it adds a wait-state the design avoids.
- **Where a config knob would live if planning chooses one:** `review_polling` in
  `src/schemas/config.ts:268-291` (alongside `failure_window_ms`, `max_failures_before_pause`,
  `max_blocker_reentries`), with matching template docs in `src/cli/bundled/templates.ts:94-98, 395-398`
  — the same regeneration caveat applies.
- **My read (inference, not a decision):** the `unknown` fix is the required core and satisfies every
  hard acceptance criterion; confirmation is an *optional* robustness lever. Whichever planning picks,
  AC #8 requires the choice be recorded so a reviewer sees what was decided and why. I recommend
  planning weigh (a)'s simplicity against (b)'s statefulness explicitly.

**`Promise.all` vs `Promise.allSettled` in `getChecksState` (open refinement).** Today a rejection of
*either* API call rejects the whole thing → `unknown`. A partial success (Status API answers, Checks
API errors, or vice-versa) currently yields `unknown` too, even though one source gave a real answer.
Treating any error as `unknown` is faithful to the issue and safe; richer partial handling
(`allSettled`, use the source that answered) is an optional refinement inside the delegated design
space — **not required** by any acceptance criterion. Flagging so planning decides deliberately rather
than by omission.

---

## 10. Assumptions not fully verified / open questions

- **Not run:** I did not execute `pnpm typecheck/lint/test` — this is research, not execution. The
  enum-additive + `if`-ladder analysis strongly implies the build stays green after the four changes,
  but that is an inference to be proven in execution (AC #11).
- **No open question requires a human.** The one genuinely-open sub-policy (confirmation-before-rework)
  is **owner-delegated by explicit instruction** ("Decide the exact policy as part of the work"), so it
  is planning's to resolve, not a `needs_human` block. Re-asking it would re-ask an answered question.
- **Premise check:** I looked specifically for evidence the bug doesn't exist or is already handled —
  the opposite of the ticket's claim. I found none: the `catch → "failing"` is present and reachable,
  no `unknown` checks-state exists, and `decideReadiness` would merge on it. **The premise holds; no
  `premise_conflict` to surface.**

---

## 11. One-paragraph summary for the next phase

Add `"unknown"` to `checks_state` (schema + local type), return it from `getChecksState`'s `catch`
instead of `"failing"`, and add the symmetric `checks_state === "unknown" → retry_wait` guard to
`auto-merge.ts:decideReadiness` (the one latent safety bug the enum exposes). `derivePrEvents`,
`shouldPromoteApproval`, and the fake plugin already fall through correctly and need only regression
tests, not code. No new PR event, no dashboard change, no other hosting plugin. Update the two
git-hosting `.md` docs and regenerate the bundle with `pnpm run docs:bundle`. Mirror the existing
`merge_state`/`unknown` precedent throughout. The confirmation-before-rework policy and any
`Promise.allSettled` partial-success refinement are owner-delegated design choices for planning to
resolve and record — the minimal `unknown` fix alone satisfies every hard acceptance criterion.
