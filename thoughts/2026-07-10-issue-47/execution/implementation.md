# Execution — Issue #47: Auto-merge blocked by branch protection loops into endless rework

Source: `github_issue FarzamMohammadi/the-engineer#47`
Base: `main` (top = `5c3dd53`)
Date: 2026-07-09
Builds on: `../planning/plan.md` (Approach A), `../research/research.md`, `../requirements/requirements.md`.

Implemented Approach A from the plan verbatim, with no deviations. All gates green
(typecheck, lint, `test:all`, `check:exports`). Committed as one cohesive unit:
`8a5d87f #47: Route a host-blocked merge to wait/escalate instead of rework`.

---

## What changed, by file

### 1. Contract — `src/schemas/adapters.ts`
- `PRStatusSchema.merge_state` enum gains `"blocked"`: `["mergeable", "conflicting", "blocked", "unknown"]`.
- Extended the field doc: `blocked` = mergeable in shape but the host will not complete the merge
  (branch protection / required review). Core waits or hands off, never reworks. Distinct from `conflicting`.
- Additive enum change; typecheck confirmed no exhaustive `never` switch over `merge_state` breaks.

### 2. Plugin — `src/plugins/git-hosting/github-hosting/github-hosting.ts`
- `mapMergeState(mergeable, mergeableState)` — new second param + return type `... | "blocked" | ...`.
  Ordering (the ordering trap from research §5): `null/undefined → unknown`; `false → conflicting`;
  `mergeableState === "blocked" → blocked` (checked **before** collapsing `true → mergeable`, since a
  blocked PR reports `mergeable === true`); else `mergeable`.
- `"behind"` deliberately stays `mergeable` (D3) — out-of-date branch, not a conflict; GitHub merges it
  when protection does not require up-to-date branches.
- Call site in `doGetPRStatus`: `mapMergeState(pr.mergeable, pr.mergeable_state)` — `pr.mergeable_state` is
  on the same `pulls.get` response already fetched, so **no extra API call**.
- `derivePrEvents` needed no edit: it already gates `pr_ready_to_merge` on `merge_state === "mergeable"`, so
  a `blocked` PR now emits neither `pr_ready_to_merge` nor `pr_merge_conflict` for free (Step 6, confirmed).

### 3. Core auto-merge — `src/core/orchestrator/pipeline/delivery/auto-merge.ts` (robust backstop)
- `decideReadiness`: new branch after `conflicting`, before `unknown` — `blocked → needs_human_merge`,
  decided **before** any `mergePR` call (so no doomed merge, no branch re-push).
- `runAutoMerge` switch: explicit `case "needs_human_merge"` **before** `default` (pre-mortem #1 — without
  it the disposition would fall through to `performMerge` and re-open the bug). Logs, calls
  `notifyHostBlockedMerge(ctx, prNumber, false)` (no cleanup push happened → no dismissal), returns
  `resolved("needs_human_merge", …)`.
- `MERGE_DISPOSITION_OPTIONS` gains a `needs_human_merge` entry so `recordMergeReadiness` stays complete.
- `autoMergeNext("needs_human_merge")` already routes to `{ go: "done" }` (existing default arm) — unchanged.

### 4. Core poller — `src/core/daemon/pr-event-poller.ts` (front line)
- `shouldPromoteApproval` (boolean) refactored into tri-state
  `resolveApproveDisposition → "promote" | "escalate_blocked" | "wait"` from a single live re-check:
  open+passing+mergeable → promote; open+passing+blocked → escalate_blocked; else/throw/disabled → wait.
  The blocked arm is gated on `checks_state === "passing"` (symmetric with promote), so a red-CI blocked PR
  falls through to `wait` and the normal CI-rework path (pre-mortem #4).
- `actionableEvents` acts on the tri-state: `escalate_blocked` calls `escalateMergeBlocked(task, deduped)`
  and returns `[]` (no event routes this poll).
- `escalateMergeBlocked` mirrors `escalateBlockerCap`: records the `approve_comment_merge_blocked` decision,
  clears `pending_pr_event` (defensive, pre-mortem #3), blocks under
  `{ reason: need_more_info, category: awaiting_human, sub_phase: await-review, needed: <actionable msg> }`
  (which takes the task off the `pr_review_pending` poll set → structural loop bound, criterion 3), and
  notifies the owner via `alert` + `ticket_comment` with the actionable "approve on the host, then retry".
- Reused `awaiting_human` / `need_more_info` — no new BlockCategory, config knob, or ReviewState field (D4).

### 5. Docs — `docs/plugins/git-hosting/{github-hosting,README}.md` + regenerated bundle
- Source markdown updated (PR-status + event-detection paragraphs, the `PRStatus` type comment) to describe
  the `blocked` state and the ordering/`behind` rationale.
- `pnpm run docs:bundle` regenerated `src/cli/bundled/plugin-docs.ts` (the file is `// GENERATED` — edited
  source, not the bundle, then regenerated; CI fails on drift).

### 6. Tests (criterion 8)
- `github-hosting.test.ts`: new `mergeable:true, mergeable_state:"blocked" → blocked`; new
  `"behind" → mergeable` (D3 regression); new `derivePrEvents(blocked)` emits neither ready nor conflict.
  Existing `true→mergeable`, `false→conflicting`, `null→unknown` re-assert green.
- `auto-merge.test.ts`: new `merge_state:"blocked"` resolves to `needs_human_merge` with **mergePR never
  called**, owner notified, decision records `needs_human_merge` among options and as chosen, routes to done.
  Existing conflict-reworks / mergeable-merges regressions re-assert green.
- `pr-event-poller.test.ts`: new `/approve` on `open+passing+blocked` → no promotion, blocked under
  `need_more_info`/`awaiting_human`, `pending_pr_event` cleared, owner alerted; new loop-bound test (once
  escalated, the task leaves the poll set and a later poll does nothing). Existing promote/wait cases green.
  (Exposed `getBlockedTasksByReason` from the `setup` helper for the bound test.)

---

## Acceptance criteria — status

1. Host-won't-complete merge never reworks — ✔ (auto-merge readiness `blocked → needs_human_merge` before
   any mergePR; poller escalates instead of promoting).
2. Unhonored `/approve` surfaced/escalated with actionable reason, not looped — ✔ (poller `escalateMergeBlocked`).
3. `pr_ready_to_merge` / `/approve` re-entry bounded — ✔ (structural: escalation → off the poll set; backstop → done).
4. Readiness uses the host's real signal — ✔ (`mergeable_state === "blocked"`, not just the boolean).
5. Genuine merge still auto-merges — ✔ (only exact `"blocked"` diverts; `clean`/`unstable`/`has_hooks`/`behind`
   stay `mergeable`; regression tests re-assert).
6. Host detection in plugin, wait/escalate policy in Core — ✔ (plugin reports the fact; Core switches on the
   contract value; a 2nd plugin inherits the safety by returning `blocked`).
7. Genuine conflict still reworks — ✔ (`conflicting` is a distinct value; unchanged; regression tests re-assert).
8. Unit tests + gates pass, #46 out of scope — ✔ (typecheck, lint, test:all all green; no CI-debounce work).

## Gates
- `pnpm run typecheck` — pass
- `pnpm run lint` — pass (biome + tsc + knip + madge, no circular deps)
- `pnpm test:all` — pass (unit 2823, integration 67, e2e 16)
- `pnpm run check:exports` — pass

## Deviations from the plan
None. Approach A implemented as specified. The one small mechanical addition — exposing
`getBlockedTasksByReason` from the poller test `setup` helper — was needed for the loop-bound test and is
test-only.
