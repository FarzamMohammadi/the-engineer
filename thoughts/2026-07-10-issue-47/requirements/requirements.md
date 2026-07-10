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
