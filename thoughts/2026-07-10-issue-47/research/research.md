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

---

# Re-run pass — 2026-07-09: reconcile the two host-blocked paths (reviewer feedback)

Source: the review comment captured in `../requirements/requirements.md` "Re-run pass" (criteria 9–13).
Builds on: the loop fix that already landed on this branch (commit `8a5d87f`). Code state read = `8a5d87f`
(the newer commit `a0848eb` adds only `thoughts/` trail files, no source change — verified via
`git show --stat a0848eb`).

This pass does **not** re-investigate the original loop (Sections 1–10 stand). It maps the *reconciliation*
the reviewer asked for: the loop fix introduced **two** code paths that resolve the *same* host-blocked
condition to **opposite** task lifecycle states and make **opposite** promises to the owner. Investigation
only — the contract choice and message wording are delegated to design.

Legend unchanged: **[OBS]** verified by reading. **[INF]** concluded from observations.

---

## 11. The contradiction, verified line-by-line (not inherited)

Both paths fire on the identical signal — `merge_state === "blocked"` (the new contract value the loop fix
added) — yet land differently.

**Path A — Poller** (`src/core/daemon/pr-event-poller.ts`):
- **[OBS]** `resolveApproveDisposition` (211–243): an authorized `/approve`, PR open + `checks_state==="passing"`,
  `merge_state==="blocked"` → returns `"escalate_blocked"` (231–233).
- **[OBS]** `escalateMergeBlocked` (309–334): writes `blocked` with `reason: need_more_info`,
  `category: awaiting_human`, `sub_phase: "await-review"` (314–319); clears `pending_pr_event` defensively
  (313); message (318, 332): *"…run `engineer retry` to resume and **I'll merge it**."*
- **[OBS]** Lifecycle: `awaiting_human → need_more_info` (via `toBlockReason`, `orchestrator/index.ts:85–97`).
  `need_more_info` ≠ `pr_review_pending`, so the task **leaves the PR-event poll set**
  (`getBlockedTasksByReason(pr_review_pending)`, poller:60) — structural loop bound — and sits on the
  owner-escalation ladder. State `blocked` ∈ `RETRYABLE_STATES` (`task.ts:380`) → **resumable** via
  `engineer retry`. **Promise: the Engineer completes the merge after retry.**

**Path B — Auto-merge** (`src/core/orchestrator/pipeline/delivery/auto-merge.ts`):
- **[OBS]** Two sub-paths reach the same `needs_human_merge` disposition:
  1. **readiness** — `decideReadiness` (226–232): `merge_state==="blocked"` → `needs_human_merge`, decided
     **before any `mergePR` call** (the primary path; no doomed merge, no branch re-push).
  2. **merge-failure backstop** — `classifyMergeFailure` (396–401): a `mergePR` rejection typed
     `not_mergeable` (GitHub 405, `classifyMergeError` github-hosting.ts:719–730) → `needs_human_merge`.
     This is the race path (readiness said `merge`, but the live merge still 405'd).
- **[OBS]** `resolved("needs_human_merge", …)` returns `outcome:"ok"` (504–506). `autoMergeNext` (74–97)
  has **no `needs_human_merge` case** → falls to `default → { go:"done" }` (95). Message
  (`notifyHostBlockedMerge`, 438–448): *"…the host won't let me complete the merge (its rules need a human).
  **Merge it when you're ready**."*
- **[OBS]** Lifecycle: `go:"done"` → task **`completed`** (terminal; ∈ `TERMINAL_STATES`, `task.ts:22`; no
  exit edge). PR is unmerged. **Promise: a human completes the merge.**

**[OBS] The contradiction, exactly as the reviewer stated it:** same condition (`merge_state==="blocked"`)
→ **resumable-blocked** (Path A) vs **terminal-completed** (Path B); **"I'll merge it"** (A) vs **"you merge
it"** (B). Confirmed at the lines above — the requirements re-run's claim is accurate verbatim.

**[OBS] The existing tests encode the divergence** and will have to change with whatever contract design
picks:
- `auto-merge.test.ts` asserts `autoMergeNext(okResult("needs_human_merge")) === { go:"done" }` at lines
  **100, 212, 284, 332** — and line 322's case is literally titled *"a host-blocked merge resolves
  **terminally**"*. If design picks the blocked-resumable contract, these flip to `{ go:"block", category:
  awaiting_human, … }`.
- `pr-event-poller.test.ts` (295–333) already asserts the escalation lands `blocked / need_more_info /
  awaiting_human` — i.e. it already encodes Path A's contract.

---

## 12. What "same lifecycle state" means here (the criterion-9 target)

**[OBS]** The routing-relevant lifecycle identity of a paused task is the tuple **(task state, block
reason, block category)** — that tuple decides *which poller owns the task* and *whether it can loop*:

| Disposition | `go`/write | state | category | reason (`toBlockReason`) | poll set | resumable |
|---|---|---|---|---|---|---|
| Path A (poller today) | `updateTaskField blocked` | `blocked` | `awaiting_human` | `need_more_info` | **off** (escalation ladder) | yes (`engineer retry`) |
| Path B (auto-merge today) | `autoMergeNext → done` | `completed` | — | — | off (terminal) | **no** |
| normal PR wait (`await-review`) | `go:"block"` | `blocked` | `awaiting_pr_review` | `pr_review_pending` | **on** (PR-event poller) | via event |

**[INF]** Both current paths already prevent the loop (both leave the `pr_review_pending` poll set — A by
`need_more_info`, B by terminal). So **coherence, not loop-safety, is the open gap** — the reviewer's ask is
that the *same condition* not resolve to two different owner experiences.

**[OBS] The blocked-resumable contract is the natural single target**, for three verified reasons:
1. Criterion 10 (owner's explicit steer) rejects marking a task `completed` while its PR is unmerged unless
   it's a genuine terminal hand-off — that points away from Path B's `done`.
2. `autoMergeNext` **already** routes the sibling `outcome:"needs_human"` to
   `{ go:"block", category: awaiting_human }` (auto-merge.ts:75–80; test 122–127). Adding a
   `needs_human_merge → { go:"block", category: awaiting_human, needed: <msg> }` case reuses an existing,
   tested shape — a one-branch change in a pure function.
3. `awaiting_human → need_more_info` leaves the poll set, so the loop stays structurally impossible after
   the change (identical safety to today's `done`).

**[INF] Sub-phase coherence is a secondary nuance for design.** Path A blocks at `sub_phase:"await-review"`;
if Path B blocks via the runner, the runner stamps `detail.sub_phase = "auto-merge"`
(`runner.ts:291`). The (state, reason, category) tuple would then match, but the `sub_phase` string would
not, and `sub_phase` is where `engineer retry` resumes (`resolveResume` → `locateCursor`,
`index.ts:144–158`). Whether criterion 9's "same state" requires identical `sub_phase` too is a design call;
both resume routes eventually re-attempt the merge (see §14), so it is cosmetic-to-mild, not load-bearing
for safety.

---

## 13. Can GitHub distinguish the two block reasons? (the criterion-11 researchable fact)

Criterion 11 offers two acceptable routes: **(a)** distinguish "a required review the owner can add" (Engineer
*can* merge after) from "no merge permission" (Engineer *never* can) and branch the message; or **(b)** word
the message so it holds in both cases. Which is feasible turns on what the *REST* plugin can see.

- **[OBS]** `doGetPRStatus` (github-hosting.ts:190–219) reads only `pr.mergeable`, `pr.mergeable_state`,
  `pr.state`, `pr.merged`, `pr.draft`, `pr.head.sha`, `pr.html_url`. It does **not** read `reviewDecision`
  or any viewer-merge-permission field.
- **[INF/known-API]** `mergeable_state === "blocked"` is a **catch-all**: a required review OR a required
  status check OR restricted merge (no permission) OR another unmet gate. On its own it does **not**
  distinguish "owner-addable review" from "Engineer-never-can-merge."
- **[OBS]** `reviewDecision` (`REVIEW_REQUIRED` / `APPROVED`) — the field that would cleanly name the
  required-review case — is **GraphQL-only**; this plugin is REST/Octokit. Reading it means a GraphQL call
  the plugin does not make today.
- **[OBS]** `getBranchProtection` / `doGetBranchProtection` (adapters/git-hosting.ts:114;
  github-hosting.ts:373–405) returns `required_reviews` (count), `required_checks`, and `restrictions`
  (`users`/`teams` allowed to push/merge). It *could* hint "a review is required" (`required_reviews > 0`)
  and *could* in principle detect "no merge permission" by matching the engine's own identity against
  `restrictions` — but that needs the engine's login and an extra API call, and the loop fix's own review
  already flagged the required-status-check ambiguity (refinements.md, observation #1).
- **[OBS]** `getReviewStatus().approved` (used at auto-merge.ts:303 for the dismissal case) tells whether a
  *formal* approval already exists — useful context, but does not by itself separate the two block reasons.

**[INF]** A **cheap, reliable** distinction between the two block reasons is **not available** in the current
REST plugin — it would cost extra API calls (branch-protection and/or a GraphQL `reviewDecision` migration)
plus engine-identity matching, none of which the loop fix built. So criterion 11 option **(b)** — one message
worded to be true whether or not the Engineer can eventually merge — is the **low-cost path**, and option (a)
is the **expensive** one. This is exactly the trade the owner delegated ("distinguish the block reason … OR
word the message so it holds in both cases"); research states the cost, design picks. *(If design does pick
(b), the wording must avoid the current Path A promise "I'll merge it" — see §14.)*

---

## 14. Resume behavior — is "I'll merge it on retry" achievable? (message-honesty grounding)

**[OBS]** `engineer retry` moves `blocked → queued` (`RETRYABLE_STATES`, task.ts:380). A resumed dispatch
uses its `resume_from` checkpoint: `resolveResume` → `locateCursor(checkpoint.phase, checkpoint.sub_phase)`
(index.ts:144–158). Note the poller **does not itself write a runner checkpoint** — it directly
`updateTaskField(..., "blocked", …)` and sets `task.sub_phase = "await-review"`; the checkpoint that resume
reads is the last real dispatch's (the one `await-review.next` produced when it parked the task).

**[INF]** Tracing the two retry outcomes:
- **Path A retry** resumes at `await-review`, whose `next` re-parks under `awaiting_pr_review` →
  `pr_review_pending` → **back on the PR-event poll set**. If the owner added a *formal* approval, the PR is
  now `clean`/`mergeable`; the poller (or a `pr_ready_to_merge` event) promotes → auto-merge → merges. So
  **"I'll merge it" is honest for the required-review case.**
- **Both paths, no-merge-permission case:** retry → re-check → still `blocked` → re-escalate/re-block. The
  Engineer **never** merges. So **"I'll merge it" is FALSE** here — precisely criterion 11's honesty gap.

**[INF]** This confirms the honesty problem is real and asymmetric: Path A's *"I'll merge it"* over-promises
in the permission case; Path B's *"you merge it"* under-promises in the review case (it says done + human
merges even though a retry could have finished a review-blocked merge). A single reconciled message must not
inherit Path A's unconditional "I'll merge it." (Design owns the exact wording; a truthful form covers both:
approve/adjust protection on the host, and the Engineer finishes the merge on retry *if the host then allows
it*, otherwise the owner merges.)

---

## 15. The reconciliation design space (surfaced, NOT decided — delegated by the owner)

1. **Which single contract?** (criterion 9)
   - **(1a) blocked-resumable** — route Path B's `needs_human_merge` to
     `{ go:"block", category: awaiting_human, needed: <msg> }` in `autoMergeNext`, matching Path A.
     **[INF]** Smallest, safest, and honors criterion 10 (no false `completed`); reuses the existing
     `needs_human`→block shape; loop stays impossible (off poll set). Favored by the owner's own steer.
   - **(1b) done-terminal** — route Path A to `completed`. **[INF]** Disfavored: the poller is not in the
     pipeline (it would have to write `completed` directly, awkward), and criterion 10 explicitly flags
     "done while PR unmerged" as wrong. Only defensible if design distinguishes a genuine
     Engineer-can-never-merge terminal case (see §13 cost).
2. **Distinguish the block reason, or word one message for both?** (criterion 11) — §13: distinguishing is
   expensive/unreliable in the REST plugin; wording-that-holds is cheap. Design picks; if it words one
   message, drop Path A's unconditional "I'll merge it."
3. **Unify the message + (optionally) the `sub_phase`** across both paths so the owner sees one coherent
   hand-off regardless of which path fired (§12 nuance).
4. **Optional `mapMergeState` allowlist** (criterion 13, owner-marked *not required*) — today a denylist
   (`"blocked"` → blocked; else `mergeable`, github-hosting.ts:549–563). An allowlist
   (`clean`/`unstable`/`has_hooks`/`behind` → mergeable; else → blocked/hand-off) makes states GitHub won't
   merge (e.g. `draft`) hand off instead of falling through. **[INF]** Low value here — `derivePrEvents`
   (504) and the poller both gate on `approved + green + mergeable`, so a `draft` PR never reaches promotion
   anyway; do only if trivially cheap.

---

## 16. Test surface for the reconciliation (criterion 12)

- **[OBS]** `tests/unit/core/orchestrator/pipeline/delivery/auto-merge.test.ts` — the `{ go:"done" }`
  assertions for `needs_human_merge` (lines 100, 212, 284, 332) and the "resolves **terminally**" case
  (322) change to the chosen contract. Their *intent* (loop cannot form) is preserved by
  blocked/`need_more_info` also leaving the poll set — only the literal lifecycle assertion moves.
- **[OBS]** `tests/unit/core/daemon/pr-event-poller.test.ts` (295–333) already asserts Path A's
  `blocked / need_more_info / awaiting_human` + the loop bound — keep, and align the message assertion with
  the reworded honest message.
- **NEW (criterion 12):** a regression test proving **both** paths land in the **same** (state, reason,
  category) for the **same** `merge_state==="blocked"` condition — the coherence guard the reviewer named.
- **Preserve regressions:** mergeable-still-merges (criterion 5; `derivePrEvents` + `decideReadiness` "merge"
  arm) and conflict-still-reworks (criterion 7; `merge_state==="conflicting" → merge_conflict → execution`,
  unchanged and checked *before* the `blocked` branch at auto-merge.ts:217).
- **[OBS]** Gates unchanged: `pnpm test:all && pnpm run lint && pnpm run typecheck`. `node_modules` is not
  installed in this worktree — run `pnpm install` before the gates.

---

## 17. Simplest-thing check (challenging the reconciliation)

- **[INF]** The genuinely smallest coherent fix: **(a)** add one `needs_human_merge` case to `autoMergeNext`
  routing to `{ go:"block", category: awaiting_human, needed: <shared msg> }` (mirrors the existing
  `needs_human` branch); **(b)** make Path A's and Path B's owner message the same truthful wording that
  holds whether or not the Engineer can finish the merge (drop the unconditional "I'll merge it"); **(c)**
  one regression test asserting both paths → same (state, reason, category). Touches 2 source files
  (`auto-merge.ts`, `pr-event-poller.ts`) + tests. No adapter-contract change and **no** new API call are
  required if design takes the word-one-message route (§13).
- **[INF]** Distinguishing the two block reasons (branch-protection GraphQL / identity-vs-restrictions
  matching) is the *expensive* branch and is **not** required to satisfy criteria 9–12 — it is an
  enhancement the owner offered as an *alternative* to honest wording, not a mandate. Prefer the cheap route
  unless design finds the distinction trivially available.
- **Unverified assumption flagged honestly:** whether GitHub returns a clean 405 (→ `not_mergeable`) vs some
  other status for *this repo's* protection config on a live `mergePR` is not observable here — but the loop
  fix already made the **readiness** `blocked` branch the primary catch (before any merge), so Path B's
  failure backstop is now a narrow race, not the main route. Both must still land on the reconciled contract.

## 18. Open questions for the owner (this pass)

None. The contradiction is verified at the line level, the lifecycle mapping is established from the code,
the honesty gap and its cause (REST cannot cheaply distinguish the two block reasons) are grounded, and
every remaining fork — which single contract, distinguish-vs-word, the optional allowlist — was **explicitly
delegated to design** by the owner in the review comment. Nothing requires a human answer to proceed. No
`premise_conflict`: the two-path contradiction the reviewer described is real and present in the code (§11).
</content>
</invoke>

---

# Re-run pass — 2026-07-11: re-verification + the lifecycle consequences of `done`

Source: the same owner review comment (criteria 9–13). No new owner input exists (requirements pass 3
established the task restarted from intake after planning stalled — not that new scope arrived).

Purpose of this pass: **(a)** re-verify §§11–18 against the current branch head rather than inheriting them,
and **(b)** go one level deeper than the prior pass did — it described the two paths' *dispositions*, but never
followed what the orchestrator actually **does** to a task on each. That turned out to be where the decisive
facts live. Sections 1–18 stand; this pass corrects two of their details and adds four findings they missed.

Legend unchanged: **[OBS]** verified by reading. **[INF]** concluded from observations.

---

## 19. Re-verification of the prior passes (checked, not inherited)

- **[OBS]** `git show --stat a0848eb` — the head commit touches **only** `thoughts/` files (7 files, no `src`,
  no `tests`). The source state under test is therefore `8a5d87f` (the loop fix). §§11–18's code reading is
  still current.
- **[OBS]** The contradiction is **fully intact** on HEAD, re-read line by line:
  - **Path B (auto-merge)** — `decideReadiness` (:226) resolves `merge_state === "blocked"` →
    `needs_human_merge`; `resolved()` (:504–506) returns `outcome: "ok"`; `autoMergeNext` (:74–97) has **no
    `needs_human_merge` case** → `default → { go: "done" }` (:95). Message (`notifyHostBlockedMerge`, :438–448):
    *"the host won't let me complete the merge (its rules need a human). **Merge it when you're ready**."*
  - **Path A (poller)** — `resolveApproveDisposition` (:228–233) resolves the *same* `merge_state === "blocked"`
    → `escalate_blocked`; `escalateMergeBlocked` (:309–334) writes `blocked` / `need_more_info` /
    `awaiting_human` / `sub_phase: "await-review"` and says *"…run `engineer retry` to resume and **I'll merge
    it**."*
  - Same signal → **terminal-completed** vs **blocked-resumable**; **"you merge it"** vs **"I'll merge it"**.
    Criteria 9–13 are genuinely open. Not a `premise_conflict`.
- **[OBS] Correction to §8/§16:** `node_modules` **is** installed in this worktree now. The earlier "must
  `pnpm install` first" note is stale — the gates can be run directly.
- **[OBS] Correction to §16's line refs:** the `{ go: "done" }` assertions for `needs_human_merge` in
  `auto-merge.test.ts` are at lines **100, 212, 284, 331–332** (the "resolves terminally" comments at 281 and
  327). `pr-event-poller.test.ts:295–333` encodes Path A's `blocked / need_more_info / awaiting_human`.

---

## 20. What `go: "done"` ACTUALLY does — the finding the prior passes missed

§§11–15 treated Path B's `done` as "terminal hand-off, task marked complete." That is true but badly
under-describes it. **[OBS]** `go: "done"` → `runner.planRoute` (:288–289) → `{ kind: "complete" }` →
the daemon's `handleCompletedOutcome` (`task-scheduler.ts:233–277`), which does **four** things:

1. **[OBS]** Transitions the task to `completed`. **`completed` is NOT in `RETRYABLE_STATES`**
   (`task.ts:380` = `[failed, blocked, cancelled]`). ⇒ **The task can never be resumed.** `engineer retry`
   cannot bring it back.
2. **[OBS]** `workspaceManager.cleanupWorkspace(taskId, true)` (:256) → `git worktree remove --force`
   (`workspace-manager/index.ts:452–454`). ⇒ **The worktree is destroyed.** (`preserveBranch = true`, so the
   *branch* survives — see §21.)
3. **[OBS]** Posts a `ticket_comment`: **`"Task completed successfully."`** (:264–268), which
   `notification-router` (:346) writes to the **source ticket** — plus a `completion` notification to the owner.
4. **[OBS]** Eagerly reaps (`reapNow`, :275–277) → stamps `reaped_at`; and `completed ∈ KEY_FREEING_STATES`
   (`task.ts:39`) ⇒ the idempotency key is **freed**.

**[OBS] The concrete consequence, on the owner's own PR thread, today:** the owner receives
*"the host won't let me complete the merge … Merge it when you're ready"* and then, moments later,
**"Task completed successfully."** — two contradictory comments on the same unmerged PR.

**[INF]** This is criterion 10's "no false completed", not as an abstraction but as a literal message the
engine emits. And it makes Path B's hand-off **structurally irreversible**: worktree gone, task
non-retryable, key freed. So the outcome Path A promises ("approve on the host, retry, and I'll merge it")
is **impossible** on Path B — not merely worded differently. The two paths do not just disagree in wording;
they disagree in what the owner is *able to do next*.

---

## 21. Is the `done` path data-destructive? (checked, because it looked like it might be)

I checked this specifically, because a `completed` task with an **unmerged** PR is an unusual state and the
reaper deletes branches.

**[OBS]** `workspace-reaper/index.ts:312–321`: for a completed task it reads `review.merged_at`; when that is
`null` it treats the task as **push-only — "the pushed branch IS the deliverable, so keep it"** — marks it
reaped and deletes nothing. `reapMergedBranch` (which *does* delete) is reached only when `merged_at` is set.
A host-blocked hand-off never records a merge, so `merged_at` is null.

**[INF] Not data-destructive** — the branch and the PR survive, so the owner *can* still merge by hand. The
harm is confined to the false "completed", the destroyed worktree, and the lost resumability (§20). Worth
stating plainly so design does not over-correct against a danger that isn't there.

---

## 22. What `go: "block"` does — and why the blocked contract is materially better

**[OBS]** `go: "block"` → `runner.planRoute` (:290–291) → `{ kind: "block", detail: { category, sub_phase,
needed } }`, where `sub_phase` is the **current** sub-phase — i.e. `"auto-merge"`, not the poller's
`"await-review"`.

**[OBS]** `awaiting_human` → `toBlockReason` → `need_more_info` (`orchestrator/index.ts:91–93`).
`need_more_info ≠ pr_review_pending`, so the task **leaves the PR-event poll set** (`poller:60`) — the loop
stays structurally impossible, exactly as `done` does today. **Loop-safety is not a differentiator.**

**[OBS]** But `need_more_info` puts the task on the **health-monitor's blocked-escalation ladder**, which
`checkBlockedEscalation` (`health-monitor.ts:164–170`) applies to every blocked task **except**
`pr_review_pending`. Default stages (`config.ts:589–606`):

| after | stage | action |
|---|---|---|
| 4h (repeating) | `reminder` | `blocked_reminder` notification to the owner |
| 8h | `self_unblock_check` | `evaluate_self_unblock` |
| 48h | `escalation` | `escalation_alert` → **task → `failed`** (`health-monitor.ts:285–289`) |

**[INF]** So the blocked contract is not "wait forever": it **nudges the owner, tries once to self-unblock,
then fails honestly** — a task that never delivered its PR ends `failed`, not `completed`. That is precisely
criterion 10's ask, achieved by an *existing* mechanism rather than a new one. Combined with §20, the code
now argues for the **blocked-resumable** contract far more strongly than §15 could: `done` destroys the
worktree, forbids retry, and says "completed successfully"; `block` preserves the worktree, is retryable,
nudges, and fails honestly. (Design still owns the call — but the evidence is lopsided.)

---

## 23. A self-unblock nuance design must decide deliberately

**[OBS]** `evaluate_self_unblock` skips **only** `awaiting_human_decision` (`health-monitor.ts:250–256`) —
`awaiting_human` (what both paths use / would use) **is eligible**. `attemptSelfUnblock`
(`orchestrator/index.ts:507–530`) asks the agent *"Can this be automatically resolved?"*; on `true` the daemon
flips the task to `active` and clears the block (:257–270).

**[INF]** For a branch-protection block the honest answer is *no* (only the owner can approve on the host), and
the likely behavior is `can_resolve: false` → "continuing escalation" → the 48h `escalation_alert` fires. **But
if it ever answers `true`**, the task goes active → re-dispatches at its checkpoint → re-checks → is still
blocked → re-blocks → and `last_transition_at` **resets**, restarting the ladder from zero. That yields a slow
(~8h) re-check cycle in which the 48h escalation may never be reached. Low-cost and arguably the "wait and
re-check" the issue asked for — but it should be a **deliberate** choice, not an accident.

**[INF] Design's lever:** `awaiting_human` (self-unblock eligible → periodic re-check, escalation not
guaranteed) vs `awaiting_human_decision` (self-unblock skipped → reminders + a **guaranteed** 48h escalation to
`failed`). The latter buys determinism at the cost of stretching that category's stated meaning ("a
discretionary decision the agent made that the owner's autonomy policy asks them to confirm"), which a
merge-block is not. **Honest uncertainty:** I cannot verify from code what the agent answers for this block —
it is an LLM call. I flag it rather than assert it.

---

## 24. A THIRD path resolving the same condition — nobody has named it

Criteria 9–13 speak of "both paths". **[OBS]** There is a third, and it resolves `merge_state === "blocked"`
differently again:

- `derivePrEvents` (`github-hosting.ts:504`) emits `pr_ready_to_merge` **only** when
  `review.approved && checks_state === "passing" && merge_state === "mergeable"`. For a **blocked** PR it emits
  **nothing**.
- The poller's escalation (§19) fires only via `resolveApproveDisposition`, which requires
  `hasAuthorizedApproval(events)` — an `/approve` **comment** (`pr-event-poller.ts:246–253`). A **formal** host
  approval is a review, not a comment.

**[INF]** ⇒ A PR that is **formally approved + green + host-blocked** (and carries no `/approve` comment)
produces **no event, no promotion, and no escalation**. The task sits `blocked / awaiting_pr_review /
pr_review_pending`, which `checkBlockedEscalation` explicitly **excludes** — so it only receives
`checkReviewPendingReminders`' *"waiting for review"* nudges. Those are **misleading**: it is not waiting for a
review; the host is refusing the merge.

**[OBS/INF] Reachable in practice** whenever protection blocks for a reason a formal approval does not clear —
*require conversation resolution* (unresolved threads), merge restrictions (only certain users/teams may merge),
a required check that never reports, or a CODEOWNER approval from another party.

**[INF] Severity:** far milder than the headline bug — it does **not** loop and does **not** rework (it just
waits, with a misleading reminder). So it is **not** a premise conflict and **not** a blocker. But it is a
genuine third resolution of the one condition criterion 9 wants coherent, and closing it is cheap *if* design
wants to: auto-merge's `decideReadiness` already handles `blocked` correctly — the task simply never re-enters
auto-merge, because no event fires. **Design's call, and explicitly a scope question** (the owner scoped
criteria 9–13 to the two named paths). I surface it; I do not expand scope on my own authority.

---

## 25. Simplest-thing check (this pass)

- **[INF]** §17's minimal fix still stands and is now better evidenced: add a `needs_human_merge` case to
  `autoMergeNext` returning `{ go: "block", category: awaiting_human, needed: <shared msg> }` — mirroring the
  **already-tested** `needs_human` branch two lines above it (:75–80) — and make both paths emit the *same*
  truthful message. That is a one-branch change to a pure function plus a message, and it inherits the nudge
  ladder, retryability, and honest `failed` terminal for free (§22). **No adapter-contract change and no new
  API call.**
- **[INF] The honesty fix is a wording fix, not a capability fix.** §13's conclusion holds: the REST plugin
  cannot cheaply distinguish "a required review the owner can add" from "the Engineer may never merge"
  (`reviewDecision` is GraphQL-only; `mergeable_state: "blocked"` is a catch-all). Under the blocked contract,
  *"approve on the host (or adjust protection), then retry — I'll finish the merge **if the host then allows
  it**; otherwise merge it yourself"* is true in **both** cases. Path A's unconditional *"I'll merge it"* must
  go, and Path B's *"Task completed successfully."* must stop firing (it stops automatically once the route is
  `block` rather than `done` — §20.3).
- **[INF]** Criterion 13's `mapMergeState` allowlist remains low-value (§15.4): `derivePrEvents` and the poller
  both gate on `mergeable`, so `draft` never reaches promotion. Owner marked it optional. Do only if trivial.
- **[INF] The one thing NOT to do:** do not "fix" this by making the poller terminal to match auto-merge.
  §§20–22 show `done` is the *worse* of the two contracts on every axis the owner named.

---

## 26. Open questions for the owner (this pass)

**None.** The contradiction is re-verified on HEAD; the lifecycle consequences of both routes are now
established from the code rather than assumed; the honesty gap's cause and its cheap resolution are grounded;
and every remaining fork (which contract, distinguish-vs-word, the optional allowlist, and whether to close the
third path in §24) was **explicitly delegated to design** by the owner. Nothing requires a human answer to
proceed. No `premise_conflict`: the two-path contradiction is real and present (§19), and the pass-1 fix
(criteria 1–8) is genuinely landed, not duplicated work.
