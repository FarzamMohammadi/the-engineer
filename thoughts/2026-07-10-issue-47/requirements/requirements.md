# Requirements — Issue #47: Auto-merge blocked by branch protection loops into endless rework

Source: `github_issue FarzamMohammadi/the-engineer#47`
Base branch: `main` (PR #45 already merged — top of `main` is `5c3dd53`)
Date: 2026-07-09

## Context Summary

**What the task asks (in my words):** When an open PR is approved through The Engineer's `/approve` comment convention but the git host's *branch protection* will not honor the merge (GitHub reports `MERGEABLE` yet `mergeStateStatus: BLOCKED` / `reviewDecision: REVIEW_REQUIRED` — it wants a *formal* review approval a comment does not provide), the engine falls into an **infinite rework loop**: the PR-event poller re-promotes the same `/approve` to `pr_ready_to_merge` every poll → `delivery/auto-merge` attempts the merge → the host refuses → instead of *waiting* or *escalating*, the task drops into `execution/implement` and runs a full rework cycle → re-push re-blocks at await-review → the poller sees the same `/approve` again → forever. Each lap burns an agent cycle and re-pushes the branch, and the existing `max_blocker_reentries` cap does not apply because `pr_ready_to_merge` is not classified as an automated blocker. The owner wants: (1) a merge that cannot complete must never drive rework — it waits/re-checks or escalates; (2) a `/approve` the host's branch protection will not honor is surfaced/escalated to the owner, not looped; (3) genuine (approved + green + host-will-merge) PRs still merge automatically, unchanged.

**Stated vs. reconstructed:** Almost entirely **owner-stated**. The issue is a spec-quality write-up by the owner (Farzam) that states the problem, gives live evidence (task #29 / PR #45), diagnoses the two conflations at the root, lists three concrete desired outcomes, and **explicitly delegates the open design decisions** ("Decide the exact reconciliation and escalation policy during design"; a whole "Worth deciding during design (delegated)" section). It also fixes the architectural boundary (host-specific merge-blocked detection in the hosting plugin behind the adapter contract; wait/escalate/route policy in Core) and the scope split from sibling #46 (CI non-final — out of scope here). I reconstructed only the *mechanism in the current code* (below) to confirm the bug is real and still open — not to infer intent, which the issue supplies directly.

## Grounding notes (project)

- **Stack:** TypeScript, ESM, Node ≥22, **pnpm** (`pnpm@10.32.0`). Three-tier architecture: Core (invariant) → Adapters (contracts) → Plugins (swappable). `docs/coding-standards.md` is "the law"; Biome-only, max TS strictness (`noExplicitAny` error, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Functional Core / Imperative Shell, guard clauses, `snake_case` for Zod/YAML/DB fields.
- **Verification gate (from `CONTRIBUTING.md`):** `pnpm test:all && pnpm run lint && pnpm run typecheck`. Captured in `details.verification.commands`.
- **Off-limits per my brief:** `.env*`, `secrets/**`, `*.pem`, `*.key` — none relevant here.

## Mechanism in the current code (confirmed by reading, not assumed)

The bug is **still present on `main`** despite substantial prior machinery. Notably, the host-blocked → owner hand-off (`needs_human_merge`, commit `92c7bb7`, dated 2026-06-16) already existed when the loop was observed live, so that hand-off is *not sufficient* — the loop routes around it. The decisive spots:

1. **`src/plugins/git-hosting/github-hosting/github-hosting.ts` → `mapMergeState` (lines ~537–545):** maps only GitHub's boolean `pr.mergeable` (true→`mergeable`, false→`conflicting`, null→`unknown`). GitHub's `mergeable` reflects **textual conflicts only**, *not* branch protection — that lives in the separate `mergeable_state` string (`"blocked"`, `"behind"`, `"clean"`, …), which the plugin never reads. So a branch-protection-BLOCKED PR reports `merge_state: "mergeable"`.
2. **`src/schemas/adapters.ts` → `PRStatus.merge_state` (line ~409):** enum is `["mergeable","conflicting","unknown"]` — **there is no "blocked" value**, so the contract cannot represent "mergeable shape but the host won't merge it."
3. **`src/core/daemon/pr-event-poller.ts` → `shouldPromoteApproval` (lines ~190–213):** promotes an authorized `/approve` to `pr_ready_to_merge` whenever a live re-check reads `state==="open" && checks_state==="passing" && merge_state==="mergeable"`. For a BLOCKED PR all three hold, so it promotes **on every poll**. `routeEvent` (lines ~271–283) sends `pr_ready_to_merge` down the **unbounded** `reenter` path — `isAutomatedBlocker` covers only `pr_merge_conflict`/`pr_ci_failure`, so `max_blocker_reentries` never counts this cycle.
4. **`src/core/orchestrator/pipeline/delivery/auto-merge.ts` → `decideReadiness` (lines ~190–223) + `classifyMergeFailure`/GitHub `classifyMergeError` (lines ~362–382 / ~701–712):** `decideReadiness` has no "blocked" branch, so it falls to `merge` → `performMerge` → `mergePR`. The host rejects. GitHub's `classifyMergeError` maps by HTTP status: `405→not_mergeable` (→ terminal `needs_human_merge`, the *correct* arm), `409→conflict` (→ `merge_conflict` → **`execution/implement` rework** — the endless-rework arm), anything else `→transient` (→ `retry_wait`, endless wait). Because branch-protection rejections do not reliably surface as a clean 405, the merge falls onto the rework or wait arm instead of the terminal hand-off, and — with the branch re-pushed each rework lap — the PR reads `mergeable` again and the loop repeats with no counter ever incrementing.

This matches the live evidence (`delivery/auto-merge` immediately followed by `execution/implement`, `total_reworks` climbing, branch re-pushed each lap, only ended by an admin force-merge). **Conclusion: the premise is valid and the task is genuinely open — not already fixed.** I record this so the design/execution phases build on the existing machinery rather than rebuilding it.

## Task breakdown — values, outcomes, actors, edges

- **Actors:** the PR-event poller (Core daemon); the auto-merge sub-phase (Core delivery); the GitHub hosting plugin (host-specific truth); the adapter contract (`schemas/adapters.ts`); the owner (receives escalation / performs the real merge); a second/future hosting plugin (must inherit the safety).
- **The "will the host actually merge?" states to distinguish:** (a) *mergeable and the host will merge* → merge; (b) *mergeable shape but blocked by branch protection / required review* → surface/escalate (or bounded wait), never rework; (c) *genuine conflict* → legitimate rework; (d) *not-yet-computed / transient* → wait and re-check (already handled). The current contract collapses (a) and (b) into `mergeable`.
- **`/approve` vs. required review fork (delegated to design):** should an owner `/approve` attempt a merge at all when the host requires a *formal* review, or escalate immediately? And how to reconcile the comment-approval convention with the host's formal-review requirement.
- **Loop bound (delegated to design):** the `pr_ready_to_merge` re-entry path is currently **unbounded**; a promotion that cannot complete needs its own bound or an escalation path.
- **Wait vs. escalate (delegated to design):** when to keep waiting and re-check vs. escalate to the owner.
- **End-to-end scenarios walked:**
  1. `/approve` on a BLOCKED-by-required-review PR, checks green → today: promote every poll → doomed merge → rework/wait loop. Wanted: surfaced/escalated to owner with an actionable reason; no rework; bounded.
  2. Genuine approved + green + host-will-merge PR → must still merge automatically (regression guard).
  3. Genuine merge conflict (base moved) → must still route to execution rework (this is legitimate rework, must not be swept into the new "never rework on a blocked merge" rule).
  4. `/approve` on a not-yet-green PR → keeps waiting (already correct; must stay correct).

## Acceptance Criteria

1. A merge that the host will not complete because of branch protection / a required review / not-actually-mergeable state **never routes the task into `execution/implement` rework** (no rework loop on a blocked-but-otherwise-clean PR).
2. When an authorized `/approve` cannot produce a merge because the host's branch protection requires a formal review the comment does not satisfy, the task is **surfaced/escalated to the owner with an actionable reason** (e.g. "branch protection needs a formal approval — approve the PR on the host, or adjust protection") rather than silently re-promoted every poll or looped.
3. The `pr_ready_to_merge` / `/approve`-promotion re-entry path is **bounded or gated** so a promotion that structurally cannot complete cannot loop unbounded (closing the gap that `max_blocker_reentries` does not cover today).
4. The engine decides readiness using the host's real "will this merge?" signal (e.g. GitHub `mergeable_state`/`mergeStateStatus` and/or `reviewDecision`), **not just the boolean `mergeable`** — so "mergeable shape but blocked by protection" is distinguished from "mergeable and the host will merge."
5. A genuinely approved + green + host-will-merge PR **still merges automatically, with no behavior change** (regression preserved).
6. **Architecture boundary honored:** host-specific merge-blocked detection lives in the git-hosting plugin behind the adapter contract; the wait/escalate/route policy lives in Core — so a second hosting plugin inherits the safety without re-implementing it.
7. A **genuine** merge conflict (base moved, branch no longer merges cleanly) still routes to execution rework as today — the new "blocked merge never reworks" rule must not swallow real conflicts.
8. The change is covered by unit tests exercising the blocked-merge routing (poller promotion + auto-merge readiness/failure classification), and the project's gates pass (`pnpm run typecheck`, `pnpm run lint`, `pnpm test` / `pnpm test:integration`).

**Explicitly out of scope:** the CI non-final / re-running-checks debounce — that is sibling issue **#46**, a separate ticket living in different code. This ticket is the surgical auto-merge / `/approve` / branch-protection routing fix and lands first.

## Decision provenance (per requirement)

- Criteria 1, 2, 5 — **owner-expressed** verbatim in the issue's "What we want" (items 1–3).
- Criterion 3 — **owner-expressed** ("the `pr_ready_to_merge` re-entry path is currently *unbounded* … needs its own bound or escalation").
- Criterion 4 — **owner-expressed** ("The 'can this actually merge?' signal … likely the host's `mergeStateStatus` / equivalent, not just a boolean `mergeable`"); the exact current-code gap is a **researchable fact** I confirmed by reading `mapMergeState`.
- Criterion 6 — **owner-expressed** ("Where the fix lives" — plugin vs. Core split).
- Criterion 7 — **inferred and safe**: the issue's item 3 ("genuine merges still work") plus the existing legitimate conflict→rework path; no other reading survives (the owner explicitly separates a *blocked* merge from a *conflicting* one), so this is a guardrail on the fix, not a new intent.
- Criterion 8 — **project convention** (the verification gate).

The open forks (wait vs. escalate; whether `/approve` attempts a merge at all under required review; the exact loop bound) are **explicitly delegated by the owner to the design phase** — so they are not requirements gaps and are not questions to ask now.

## Open questions for the owner

None. The desired end-state is owner-expressed, the current-code mechanism is an established fact, the architecture boundary and scope split are given, and every remaining fork was explicitly delegated to design by the owner (who demonstrably knows the current code — they cite the exact `max_blocker_reentries` gap, the poller promotion path, the `mergeStateStatus` vs `mergeable` distinction, and the relevant files). Asking would re-ask what the owner already answered.

## Complexity

**complex** — spans four areas (GitHub hosting plugin, the adapter contract enum, the Core PR-event poller, and the Core auto-merge readiness/failure routing), carries real design unknowns the owner delegated (escalate-vs-wait, `/approve` reconciliation, loop bound), and must add a new host-agnostic representation for "blocked" while preserving genuine-merge and genuine-conflict behavior. Not a localized change.

---

# Re-run pass — 2026-07-09: reviewer feedback on the open PR

Source: review comment by **@FarzamMohammadi (owner)** on the open PR for this task. Incorporate before merge; do **not** restart from scratch. The loop fix already landed (commit `8a5d87f`); this pass reconciles two paths inside that fix.

## Context Summary (this pass)

**What the feedback asks (in my words):** The loop fix introduced two code paths that both handle the *same* underlying condition — the host's branch protection won't let the Engineer complete the merge (`merge_state === "blocked"`) — but they resolve it *contradictorily*:

- **Poller** (`escalateMergeBlocked`, `src/core/daemon/pr-event-poller.ts:309`): blocks the task under `need_more_info` / `awaiting_human` (**resumable**) and promises the owner *"approve on the host, run `engineer retry`, and I'll merge it"* — i.e. the Engineer finishes the merge.
- **Auto-merge** (`needs_human_merge`, `src/core/orchestrator/pipeline/delivery/auto-merge.ts:178`): `resolved()` returns `outcome:"ok"`, so `autoMergeNext` (line 82–96) falls to `default → { go:"done" }` — the task **completes (terminal)** and the message (`notifyHostBlockedMerge`, line 438) says *"the host won't let me complete the merge… Merge it when you're ready"* — i.e. a human merges.

Same condition → opposite task lifecycle (blocked-resumable vs. done-terminal) and opposite promise to the owner (Engineer merges vs. human merges). The owner wants: **(1)** one contract for "host blocks the merge," with both paths routed to it (and reconsider marking a task `done` while its PR is still unmerged — a "completed" that never delivered its PR); **(2)** the owner-facing message must be **honest about what the Engineer can actually do next** — "I'll merge it after you approve" is true only when the block is *a missing formal review the owner can add*, and false when the block is *no merge permission* (the Engineer can never merge), so either distinguish the block reason or word the message so it holds in both cases; **(3)** a **regression test** proving both paths land in the *same* state for the *same* condition. Optional/lower-priority: turn `mapMergeState`'s `mergeable_state` denylist (`"blocked"` only) into an allowlist (`clean`/`unstable`/`has_hooks`/`behind` → mergeable; everything else, e.g. `draft`, → hand off) — explicitly **"Not required for this fix."**

**Stated vs. reconstructed:** The *problem* and the *desired end-state* are **entirely owner-stated** in the review comment — the owner names the exact functions, the exact contradiction, the exact honesty gap, and the required regression test. The owner **explicitly delegates the design**: *"Do your own design on the exact reconciliation — the ask is coherence between the two paths and honesty in the messaging, not a prescribed implementation."* I reconstructed only the *current-code mechanism* (the two paths, their line numbers, their divergent lifecycle/message) by reading the files, purely to confirm the feedback is accurate — it is, verbatim — not to infer intent.

## Verification of the contradiction (confirmed by reading, not assumed)

- `autoMergeNext` (auto-merge.ts:82–96): switch handles `ci_failure`, `merge_conflict`, `retry_wait`; `needs_human_merge` is **not** a case, so it hits `default → { go:"done" }`. And `resolved()` (line 504) returns `outcome:"ok"`. ⇒ **terminal, task done, human merges.**
- `escalateMergeBlocked` (pr-event-poller.ts:314–333): `updateTaskField(..., "blocked", { reason: need_more_info, category: awaiting_human, sub_phase: "await-review" })` with the message *"…run `engineer retry` to resume and I'll merge it."* ⇒ **blocked, resumable, Engineer merges.**
- Both fire on the identical signal `status.merge_state === "blocked"` (poller `disposition==="escalate_blocked"` at line 231; auto-merge `decideReadiness` at line 226). Contradiction confirmed exactly as the owner describes.

## Task breakdown — the reconciliation forks (all delegated to design by the owner)

1. **Which single contract?** *blocked-and-resumable* (Engineer retries and completes the merge once unblocked) vs. *handed-off-done* (human completes it). Both are defensible — but the owner **explicitly delegated the choice** and **steered** with two hints: (a) "reconsider marking the task `done` while the PR is still unmerged" (a nudge away from done-terminal), and (b) the honesty point below, which implies the *right* contract may depend on *which kind of block* it is.
2. **Distinguish the block reason, or word the message universally?** The owner offers both as acceptable. Whether GitHub's API can cleanly distinguish "required formal review the owner can add" (Engineer *can* merge after) from "no merge permission at all" (Engineer *never* can) is a **researchable fact** (candidates: `reviewDecision`, viewer-permission fields) for research/design to settle — not an owner question.
3. **The optional `mapMergeState` allowlist** — a judgment call the owner delegated ("only if it's cheap here… Not required for this fix").

None of these three is a requirements gap: each is a design decision the owner **explicitly handed to design**, exactly as the original issue delegated wait-vs-escalate. Re-asking a delegated decision would re-ask what the owner already answered ("you decide").

## Acceptance Criteria (this pass — additive to the criteria above)

9. **One contract, both paths.** The poller's host-blocked path and auto-merge's host-blocked path resolve the *same* `merge_state === "blocked"` condition to the *same* task lifecycle state — no longer one blocked-resumable and the other done-terminal. (Design picks which single contract; both must route to it.)
10. **No false "completed."** The chosen contract does not mark the task successfully `done` while its PR remains unmerged and undelivered unless that state is a genuine, honest terminal hand-off (the owner explicitly flagged "done while PR unmerged" as wrong).
11. **Honest owner-facing message.** The message the owner receives matches what the Engineer can actually do next: it must not promise "I'll merge it" in a case where the Engineer can never complete the merge. Either the block reason is distinguished (required-review-the-owner-can-add vs. Engineer-can-never-merge) and the message branches on it, or the wording is true in both cases.
12. **Regression test for coherence.** A unit test proves both paths (poller promotion/escalation + auto-merge readiness/routing) land in the *same* state for the *same* host-blocked condition; the existing genuine-merge and genuine-conflict regressions still hold; the project's gates pass (`pnpm test:all && pnpm run lint && pnpm run typecheck`).
13. **(Optional, not required.)** `mapMergeState` may switch from a `mergeable_state` denylist to an allowlist so states GitHub won't merge (e.g. `draft`) hand off rather than falling through to `mergeable`. Do only if cheap; not a gate on this pass.

## Decision provenance (this pass)

- Criteria 9, 11, 12 — **owner-expressed** verbatim in the review comment (asks 1, 2, and the "keep a regression test" line).
- Criterion 10 — **owner-expressed** ("reconsider marking the task `done` while the PR is still unmerged — a 'completed' that hasn't actually delivered its PR").
- Criterion 13 — **owner-expressed** and **owner-marked optional** ("Not required for this fix").
- The three reconciliation forks — **explicitly delegated to design by the owner** ("Do your own design on the exact reconciliation… not a prescribed implementation"), so they are not questions to ask now.

## Open questions for the owner (this pass)

**None.** The owner *is* the reviewer; the feedback is fresh, direct, and names the exact code, the exact contradiction, the exact honesty gap, and the required test. The end-state is owner-expressed and checkable (coherence + honest messaging + regression test); every remaining fork (which contract, distinguish-reason vs. word-message, the optional cleanup) was **explicitly delegated to design** by an owner who demonstrably knows the code. Asking would re-ask what the owner already answered. I would stake the build on criteria 9–13.

## Complexity (this pass)

**moderate** — clear direction with the machinery already built (commit `8a5d87f`); the work is reconciling two existing paths onto one contract and making one message honest, plus one regression test. Bounded to the poller's escalate path, auto-merge's `needs_human_merge` routing/message, and possibly a block-reason distinction (which *may* touch the adapter contract if design chooses to distinguish reasons rather than reword). Some design exploration (which contract, can the API distinguish the two block reasons) but no broad multi-system unknowns — the hard architectural work is already done.

---

# Re-run pass — 2026-07-11: re-entry with no new owner input (intake re-affirmed)

This is the **third** requirements run on this task. Its purpose is narrow: establish *why* intake re-opened, verify whether the owner has said anything new, and confirm the requirements of record still hold. It does **not** restate the analysis above — that analysis is still the requirement set.

## Context Summary (this pass)

**What re-entered, and why.** No new owner input exists. I checked the live PR (#48) directly:

- The **only** owner comment is the review at `2026-07-10T02:05:48Z` — the *same* comment the pass-2 section above already processed. There are no PR reviews and no inline review comments at all.
- The PR's `updatedAt` is `2026-07-10T02:05:48Z` — identical to that comment. **Nothing has happened on the PR since.**

So this re-entry carries **no new scope**. Reading the pipeline's own trail, pass 2 (the reconciliation pass) completed requirements (`02:05–02:09Z`) and research (`02:09Z`), then **planning started at `02:17Z` and never wrote a result** — `planning/session-result.json` is still the unwritten template, and its pass-1 result sits in a `.bak`. Intake re-opened ~47h later (`2026-07-12T01:07Z`). The honest reading: **the pass-2 chain stalled at planning and the task was restarted from intake**, not that new information arrived. I record this so the next phases do not go hunting for a fresh instruction that does not exist.

**What this means for the work:** the requirements of record are unchanged — the 13 acceptance criteria above stand exactly as written. Criteria 1–8 are **implemented and committed** (`8a5d87f`); criteria **9–13 are still open**. The remaining work is the reconciliation pass, and research for it is already done (`research.md` §§11–18).

## Verification that criteria 9–13 are genuinely still open (read, not assumed)

I re-read both paths on the current branch head rather than trusting the trail:

- **auto-merge** (`src/core/orchestrator/pipeline/delivery/auto-merge.ts`): `decideReadiness` (:226) and the failure path (:398) both resolve `merge_state === "blocked"` to `needs_human_merge`; `resolved()` (:505) returns `{ outcome: "ok" }`; `autoMergeNext` (:74–95) has no `needs_human_merge` case, so it falls to `default → { go: "done" }`. ⇒ **terminal / task completed**, and `notifyHostBlockedMerge` (:438) tells the owner *"completing for the owner to merge"*.
- **poller** (`src/core/daemon/pr-event-poller.ts`): the same signal (`merge_state === "blocked"`, :231) routes to `escalateMergeBlocked` (:309), which sets `blocked` / `need_more_info` / `awaiting_human` (:314–318) — **resumable** — and tells the owner *"…run `engineer retry` to resume and I'll merge it."* (:318, :332).

Same condition → opposite lifecycle (done-terminal vs. blocked-resumable) → opposite promise (human merges vs. Engineer merges). **The contradiction the owner flagged is fully intact.** The reconciliation has not been implemented.

## Live confirmation of the bug class — on this task's own PR

Worth stating plainly, because it is both a validation and an operational consequence. PR #48 right now reports:

`mergeable: MERGEABLE` · `mergeStateStatus: BLOCKED` · `reviewDecision: REVIEW_REQUIRED` · checks: lint/test/build all **SUCCESS**

That is *precisely* the condition this task exists to fix — the Engineer's own delivery PR is mergeable in shape, green, and blocked by branch protection requiring a formal review. The pass-1 fix (`8a5d87f`) is what stops this from becoming the endless rework loop described in the issue. **Operational note for delivery:** when this reconciliation lands and the branch is re-pushed, PR #48 will still be `BLOCKED` — it needs a **formal GitHub review approval from the owner** (a `/approve` comment cannot satisfy it). The Engineer cannot merge it unaided; that is the expected, correct behavior after this fix, not a failure.

## Acceptance Criteria (this pass)

**Unchanged.** The 13 criteria above are the criteria of record and are carried forward verbatim into `details.acceptance_criteria`. Criteria 1–8: already met by `8a5d87f`. Criteria 9–13: the open work.

## Decision provenance (this pass)

Every criterion's provenance is unchanged from the passes above (owner-expressed, or an established fact of the current code). This pass adds no new requirement and infers no new intent — it only re-verifies that the recorded intent is still the owner's latest word, which the PR timeline confirms it is.

## Open questions for the owner (this pass)

**None** — and I want to be explicit about why, because the bar here is "would the owner's input make the work more right?", not "could I defend a reading?"

The three remaining forks are the reconciliation choice (blocked-resumable vs. handed-off-done), distinguish-the-block-reason vs. word-one-truthful-message, and the optional `mapMergeState` allowlist. I re-read the owner's comment first-hand rather than trusting the earlier pass's summary of it. On each fork the owner did not leave a gap — they **explicitly handed the decision to me**:

> *"Do your own design on the exact reconciliation — the ask is coherence between the two paths and honesty in the messaging, not a prescribed implementation."*

and, on the two sub-forks, *"Either distinguish the reason or word the message so it holds in both cases"* and, on the allowlist, *"Not required for this fix."*

The owner enumerated both contract options themselves, stated the end-state (coherence + honesty + a regression test), and delegated the mechanism. Asking "which contract?" would re-ask a question the owner has already answered with *"you decide"* — the settled-choice anti-pattern, and a waste of their time. The one sub-question that could have been a gap — *can the host actually distinguish "required review the owner can add" from "no merge permission"?* — is a **researchable fact**, not an intent question, and research already settled it (§§11–18: the REST plugin reads only `mergeable` + `mergeable_state`; `reviewDecision` is GraphQL-only, so distinguishing is expensive and the word-one-honest-message route is the cheap one).

Intent is sufficient, the end-state is owner-expressed and checkable, and I would stake the build on criteria 9–13.

## Complexity (this pass)

**moderate** — unchanged from pass 2. The reconciliation is bounded (two existing paths onto one contract, one honest message, one coherence regression test), the architecture work is already done, and research is already in hand.
