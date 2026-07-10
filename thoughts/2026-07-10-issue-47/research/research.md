# Research — Issue #47: Auto-merge blocked by branch protection loops into endless rework

Source: `github_issue FarzamMohammadi/the-engineer#47`
Base: `main` (top = `5c3dd53`, PR #45 merged)
Date: 2026-07-09
Builds on: `../requirements/requirements.md` (read first — task context + complexity assessment)

This document is investigation only. It maps what the task touches, verifies (not inherits) the
requirements phase's mechanism claims by reading the code, walks the runtime path end to end, and names
the design forks the owner explicitly delegated. It does **not** design or plan the fix.

Legend: **[OBS]** = fact verified by reading code/tests. **[INF]** = conclusion drawn from observations.

---

## 1. Verdict on the premise

**[OBS]** Every mechanism claim in `requirements.md` checks out against the code (details below). **[INF]**
The premise is valid and the task is genuinely open — this is **not** a `premise_conflict`. The prior
host-blocked hand-off (`needs_human_merge`, terminal `done`) exists but is *routed around*, not *missing*
— confirmed below. No premise-conflict decision is raised.

---

## 2. The blast radius — every file the fix touches, and why

| # | File | Role | Why it's in scope |
|---|------|------|-------------------|
| 1 | `src/schemas/adapters.ts` (`PRStatusSchema.merge_state`, line 409) | **Adapter contract** | The enum `["mergeable","conflicting","unknown"]` has **no way to say "host won't merge it"**. Criterion 4 needs a new host-agnostic value (e.g. `"blocked"`). This is *the* contract a 2nd hosting plugin implements (criterion 6). |
| 2 | `src/plugins/git-hosting/github-hosting/github-hosting.ts` (`mapMergeState`, `doGetPRStatus`, `derivePrEvents`, `classifyMergeError`) | **Host truth (plugin)** | `mapMergeState` reads only `pr.mergeable` and never `pr.mergeable_state` — the field that actually carries "blocked". Host-specific detection must live here (criterion 6). |
| 3 | `src/core/daemon/pr-event-poller.ts` (`shouldPromoteApproval`, `routeEvent`) | **Core policy — promotion + routing** | The `/approve` promotion path treats a BLOCKED PR as mergeable and re-promotes every poll; the `pr_ready_to_merge` re-entry is **unbounded** (criteria 2, 3). |
| 4 | `src/core/orchestrator/pipeline/delivery/auto-merge.ts` (`decideReadiness`, `autoMergeNext`) | **Core policy — merge readiness/route** | `decideReadiness` has no "blocked" branch, so a blocked PR falls through to `merge` → attempts a doomed merge whose *failure* is what misroutes to rework (criteria 1, 5, 7). |

Supporting / context files (read, not necessarily changed):
- `src/core/orchestrator/pipeline/pr-events.ts` — `entryFor`, `arbitrate`, `derivePrEvents`-adjacent policy, `findAuthorizedApproval`. Pure Core policy; where routing tables live.
- `src/schemas/git-hosting-events.ts` + `git-hosting-event-types.ts` — the `PrEvent` vocabulary. A new event type would be added here *if* design chooses an event-based escalation (see §6).
- `src/schemas/task.ts` — `ReviewStateSchema` (holds `consecutive_blocker_reentries`, the existing cross-dispatch counter) and `BlockCategories` (`pr_rework_cap_hit`, `awaiting_human`, `awaiting_pr_review`).
- `src/schemas/config.ts` (`review_polling.max_blocker_reentries`, default 3) + `src/cli/bundled/templates.ts` — where a new bound/config knob would live if design adds one.
- `src/cli/bundled/plugin-docs.ts` (line 50) — the GitHub plugin's **bundled doc string** describes merge-state and error mapping; **must be updated** if the mapping changes (it is prose duplicated from the code, a known drift hazard).

---

## 3. The loop, traced end to end (verified at runtime, not from signatures)

**Setup:** owner posts `/approve` on PR that is `MERGEABLE` but `mergeStateStatus: BLOCKED`,
`reviewDecision: REVIEW_REQUIRED` (branch protection wants a *formal* approval a comment does not give).
CI is green.

1. **[OBS]** `pr-event-poller.ts` `pollSingleTask` → `actionableEvents` → `shouldPromoteApproval`
   (lines 190–213). It re-checks live status and returns true iff
   `state==="open" && checks_state==="passing" && merge_state==="mergeable"`. For a BLOCKED PR,
   `pr.mergeable === true` (branch protection does **not** affect GitHub's boolean `mergeable`), so
   `mapMergeState` → `"mergeable"`, and **all three predicates hold → it promotes**. Synthesizes
   `[{ type: pr_ready_to_merge }]` and drops the same-poll comments.
2. **[OBS]** `routeEvent` (lines 271–283): `pr_ready_to_merge` is **not** an automated blocker
   (`isAutomatedBlocker` covers only `pr_merge_conflict`/`pr_ci_failure`, lines 421–424) and not
   `pr_comments`, so it falls to `reenter(task, pr_ready_to_merge, …)` — **the unbounded path. No counter
   is touched.** `max_blocker_reentries` never sees this cycle. ← criterion 3 gap, confirmed.
3. **[OBS]** Re-entry lands at `delivery/auto-merge` (`entryFor(pr_ready_to_merge)` →
   `{ phase: delivery, sub: auto-merge }`, `pr-events.ts` line 34). `runAutoMerge` re-checks live status
   and calls `decideReadiness` (auto-merge.ts 190–223): state open, auto-merge allowed, checks passing,
   `merge_state` is `"mergeable"` (not `conflicting`, not `unknown`), checks not unknown/pending →
   **falls through to `{ disposition: "merge" }`.** No "blocked" branch exists. ← criterion 4 gap.
4. **[OBS]** `performMerge` (261–296) first calls `removeThoughtsBeforeMerge` → `removeThoughtsAndPush`
   (**pushes a cleanup commit** — this is the branch re-push each lap), then `hosting.mergePR`.
5. **[OBS]** The host rejects (branch protection). `classifyMergeError` (github-hosting.ts 701–712) maps
   by HTTP status: `405→not_mergeable`, `409→conflict`, else `→transient`.
   - `not_mergeable` → `classifyMergeFailure` → `needs_human_merge` → `autoMergeNext` **`done`** (terminal
     hand-off — the *correct* arm, and it already exists: commit 92c7bb7). **[INF]** If the rejection came
     back as a clean 405 the loop would already break — so the live rejection did **not** reliably surface
     as 405.
   - `conflict` (409) → `merge_conflict` → `autoMergeNext` **`jump` to `Phases.execution`** → full rework.
     This is the observed `auto-merge → execution/implement` transition.
   - `transient` → `retry_wait` → return to review wait → re-polled → back to step 1.
6. **[OBS]** After rework re-pushes, the PR is `mergeable` again, `/approve` still present → poller
   re-promotes (step 1). **Loop. No counter ever increments.** Matches the live evidence exactly
   (`total_reworks` climbing, cost $19.86→~$28, branch re-pushed each lap, ended only by admin force-merge).

**[INF] The single most important design consequence:** the misroute happens at the *merge-failure
classification* of a doomed attempt, and the exact HTTP code GitHub returns for a branch-protection block
is **not reliable** (405 vs 409 vs other, possibly perturbed by the pre-merge thoughts push which itself
can make GitHub briefly recompute mergeability / return "base was modified"). Depending on
`classifyMergeError` to catch "blocked" is fragile. The robust fix is to **detect "blocked" in readiness,
before ever calling `mergePR`**, so the doomed attempt (and its unreliable failure code) never happens.
This is exactly what criterion 4 asks for.

---

## 4. Two promotion paths, both blind to "blocked"

There are **two** ways a PR becomes `pr_ready_to_merge`. Both must be handled or the fix has a hole:

- **[OBS] Formal-approval path** — `derivePrEvents` (github-hosting.ts 479–509, line 504) emits
  `pr_ready_to_merge` when `review.approved && checks_state==="passing" && merge_state==="mergeable"`.
  This needs a *formal host approval*. **[INF]** For the *review-required* block specifically, a formal
  approval would *satisfy* protection, so `mergeable_state` would read `"clean"` — this path largely
  won't hit "blocked" for the review reason. But it **can** hit "blocked" for other protection reasons
  (branch out of date / "behind", admin-only merge, other required gates), so readiness in auto-merge
  must still guard it.
- **[OBS] `/approve`-comment path** — `pr-event-poller.ts` `shouldPromoteApproval` (the single-contributor
  convention, gated by `enable_comment_approval`). **This is the path the issue's live incident took**
  (owner `/approve` comments, no formal review). It synthesizes `pr_ready_to_merge` itself.

**[INF]** Because the two paths converge on the same `pr_ready_to_merge` → auto-merge entry, fixing
`decideReadiness` (auto-merge) to recognize "blocked" covers *both* paths in one place — the natural home
for the Core wait/escalate/route policy (criterion 6). The poller's `shouldPromoteApproval` is a *second,
optional* place to gate/escalate the `/approve` case earlier (avoiding even the re-entry). Design owns
whether to fix one or both (see §6).

---

## 5. The host signal — what GitHub actually exposes

- **[OBS]** `doGetPRStatus` already calls `octokit.pulls.get` and reads `pr.mergeable`, `pr.state`,
  `pr.merged`, `pr.draft`, `pr.head.sha`. **The same response object carries `pr.mergeable_state`**
  (GitHub REST PR object) — so reading it costs **no extra API call**.
- **[INF/known-API]** `mergeable_state` values and their meaning:
  - `"clean"` → host will merge → `mergeable`
  - `"dirty"` → real textual conflict → `conflicting` (**criterion 7: must still rework**)
  - `"blocked"` → protection/required-review not satisfied → **new `blocked`** (wait/escalate, never rework)
  - `"behind"` → base moved, branch out of date; protection may require up-to-date → **design call**
    (arguably `blocked` — no textual conflict, so *not* rework; but "base moved" overlaps the conflict story)
  - `"unstable"` → non-required checks red but PR *is* mergeable → still `mergeable` (host will merge)
  - `"has_hooks"` → mergeable with hooks → `mergeable`
  - `"unknown"` / null → not yet computed → `unknown` (existing wait behavior — preserve)
  - `"draft"` → draft PR → not ready (won't occur on a ready PR)
- **[OBS]** `reviewDecision` (`REVIEW_REQUIRED`/`APPROVED`/…) is a **GraphQL-only** field; the plugin is
  REST/Octokit-based. **[INF]** For a REST plugin, `mergeable_state === "blocked"` is the correct,
  already-available signal — no GraphQL migration needed. `getBranchProtection` exists (returns
  `required_reviews`) if design wants to enrich the escalation message with *why* it's blocked, but that's
  an extra call and optional.
- **[OBS]** `mapMergeState` today (line 537) ignores `mergeable_state` entirely. The mapping precedence
  when both fields are read is a design decision (e.g. `mergeable===false || dirty → conflicting`;
  `blocked → blocked`; `null → unknown`; else `mergeable`). **Note the ordering trap:** a `"blocked"` PR
  can have `mergeable === true`, so a naive `mergeable===true → "mergeable"` check *first* would mask
  "blocked". The mapping must inspect `mergeable_state` before collapsing on the boolean.

---

## 6. Design forks the owner explicitly delegated (surfaced, NOT decided here)

These are open by the owner's own instruction ("Decide the exact reconciliation and escalation policy
during design"). Research states the trade-offs; the design phase chooses.

1. **Where escalation lives / how many places to gate.**
   - (a) *Auto-merge only:* add a `blocked` branch to `decideReadiness` → route to the existing terminal
     `needs_human_merge` hand-off (→ `done`, task leaves the poll set → loop cannot recur). Smallest
     change; covers **both** promotion paths; reuses the existing hand-off + notification. **[INF]** This
     alone satisfies criteria 1, 3, and 5, and — because `done` removes the task from
     `getBlockedTasksByReason(pr_review_pending)` — inherently bounds the re-entry (criterion 3) without a
     new counter.
   - (b) *Poller too:* also gate `shouldPromoteApproval` to not promote a blocked PR, escalating directly
     (avoids even one wasteful re-entry). More surgical to the `/approve` story (criterion 2 wording) but
     adds a second escalation site to keep consistent.
2. **Terminal `done` vs. blocked-awaiting-owner.** The existing `needs_human_merge` treats the task as
   **complete** (deliverable = the PR; owner finishes the merge). Criterion 2's suggested message
   ("approve the PR on the host … and I'll merge") hints the owner might want the engine to *resume and
   auto-merge* after a formal approval — which argues for a `blocked (awaiting_human / awaiting_pr_review)`
   state that keeps polling, not `done`. **Tension to resolve:** hand-off-and-done (consistent with today,
   no re-poll) vs. block-and-retry (matches the "then I'll merge" phrasing, re-introduces bounded polling).
3. **The loop bound itself (criterion 3).** If design picks (1a) `done`, the bound is *structural* (task
   terminal). If design keeps the task in the poll set (block-and-retry), it needs an explicit bound — a
   new counter (mirroring `consecutive_blocker_reentries`) or extending `max_blocker_reentries` coverage to
   the `pr_ready_to_merge` path.
4. **`"behind"` handling** (§5) — treat as `blocked` (wait/escalate) or as its own "update the branch"
   action. Out-of-date-branch is not a textual conflict, so it must **not** land in the `conflicting →
   rework` arm (criterion 7 guard cuts both ways).
5. **Escalation message content (criterion 2).** Reuse the generic `notifyHostBlockedMerge` message, or
   enrich it with the actionable reason ("branch protection needs a formal approval — approve on the host,
   or adjust protection"). `getBranchProtection` can supply the specifics at the cost of one call.

---

## 7. Regression guards the fix must preserve (from acceptance criteria)

- **[OBS] Criterion 5 — genuine merge still works:** `derivePrEvents`/`decideReadiness` must keep routing a
  `clean` + approved + green PR to `merge`. The `mergeable_state` mapping must map `"clean"` (and
  `"unstable"`/`"has_hooks"` where the host will still merge) to `mergeable`, not `blocked`.
- **[OBS] Criterion 7 — genuine conflict still reworks:** `mergeable===false` / `mergeable_state==="dirty"`
  must still map to `conflicting` → `merge_conflict` → `execution` rework. The new "blocked never reworks"
  rule keys off `blocked`, a **distinct** value from `conflicting` — do not fold the two.
- **[OBS] `unknown` waits, never reworks:** the existing `null → unknown → retry_wait` behavior (and the
  parallel CI-`unknown` wait) is load-bearing; the new mapping must not disturb it.

---

## 8. Test surface (for execution/review — criterion 8)

Existing unit tests to extend (all present, conventions confirmed):
- `tests/unit/plugins/git-hosting/github-hosting/github-hosting.test.ts` — `mapMergeState` /
  `getPRStatus` cases (lines 265–305) + `derivePrEvents` (603–694). **[OBS]** Current `pulls.get` mock
  fixtures set `mergeable` but **not** `mergeable_state` (default mock line 29–39; per-case 276–304). Once
  `mapMergeState` reads `mergeable_state`, fixtures need the new field (missing → treat as `unknown`/undefined,
  so add a `"blocked"` case and keep the existing `null`→`unknown`, `false`→`conflicting` cases green).
- `tests/unit/core/orchestrator/pipeline/delivery/auto-merge.test.ts` — `decideReadiness` disposition
  matrix (`merge_state: "conflicting"|"unknown"` cases at 192–206; failure-classification at 231–270).
  Add a `merge_state: "blocked"` → (needs_human_merge or new disposition) case + its `autoMergeNext` route.
- `tests/unit/core/daemon/pr-event-poller.test.ts` — `shouldPromoteApproval` promotion cases. Add a
  blocked-PR case asserting **no promotion / escalation instead**.
- `tests/unit/core/orchestrator/pipeline/pr-events.test.ts` — if a new event type or routing entry is
  added, cover `entryFor`/`arbitrate` for it.

**[OBS]** Gates (from CONTRIBUTING / requirements): `pnpm test:all && pnpm run lint && pnpm run typecheck`.
Note: `node_modules` is **not installed** in this worktree — execution phase must `pnpm install` (or
`pnpm setup`) before running gates.

---

## 9. Simplest-thing check (challenging my own findings)

- **[INF]** The genuinely smallest change that closes the loop is **§6 option (1a)**: read `mergeable_state`
  in the plugin, add `"blocked"` to the `merge_state` contract, and give `decideReadiness` a `blocked →
  needs_human_merge` branch. That reuses the *existing* terminal hand-off and notification, makes the task
  go `done` (structurally unbounded-loop-proof, no new counter), and covers both promotion paths at one
  Core site. It touches 3 files of logic + 1 doc + tests. Everything else in §6 is *additional* polish the
  owner delegated (earlier poller gating, richer message, block-and-retry semantics).
- **[INF]** Adding a whole new `PrEvent` type (e.g. `pr_merge_blocked`) is **probably unnecessary** — the
  existing `merge_state` contract value + `needs_human_merge` disposition already express "host won't
  merge, hand to human." Prefer extending the enum over growing the event vocabulary unless design finds a
  reason the poller must escalate *without* re-entering auto-merge.
- **Unverified assumption I'm flagging honestly:** the exact `mergeable_state` string GitHub returns for
  *this repo's* protection config (`"blocked"` vs `"behind"`) is not observable without a live API call I
  can't make here. The mapping in §5 is from GitHub's documented contract; the design/execution phase
  should keep the mapping total (every string handled, unknown → `unknown`) so an unexpected value degrades
  to a safe wait rather than a doomed merge.

---

## 10. Open questions for the owner

None. The end-state is owner-expressed, the mechanism is verified, the architecture boundary is given, and
every remaining fork was explicitly delegated to design by the owner. Nothing requires a human answer to
proceed to design.
</content>
</invoke>
