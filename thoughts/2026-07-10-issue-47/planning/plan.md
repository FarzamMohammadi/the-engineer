# Plan — Issue #47: Auto-merge blocked by branch protection loops into endless rework

Source: `github_issue FarzamMohammadi/the-engineer#47`
Base: `main` (top = `5c3dd53`, PR #45 merged)
Date: 2026-07-09
Builds on: `../requirements/requirements.md` and `../research/research.md` (read both first).

This plan verifies the prior phases against the live code (done — every mechanism claim confirmed),
picks the approach, stress-tests it, runs a pre-mortem, and lays out an ordered, checkbox-tracked
implementation with a verification step and a regression-test per part. No code is written here.

---

## 1. Problem, in one paragraph

An owner `/approve` comment on a PR that GitHub reports `mergeable === true` **but**
`mergeable_state === "blocked"` (branch protection needs a *formal* review a comment can't give) drives an
infinite loop: the poller re-checks, sees `merge_state === "mergeable"` (because the plugin only reads the
boolean `mergeable`, never `mergeable_state`), promotes `pr_ready_to_merge` every poll → auto-merge attempts
a doomed merge → GitHub rejects with an **unreliable** HTTP code (often 409 → `conflict` → **execution
rework**, sometimes transient → wait) → the branch is re-pushed → back to `mergeable` → repeat. The
`max_blocker_reentries` cap never fires because `pr_ready_to_merge` is not classed as an automated blocker.

The robust fix (research §3): **detect "blocked" from the host's real signal *before* any merge attempt**,
represent it as a first-class `merge_state`, and route it to a wait/escalate hand-off — never to rework.

---

## 2. Approaches evaluated

### Approach A — Add a first-class `blocked` merge-state; escalate at the two Core decision points (CHOSEN)

The host plugin reads `mergeable_state` and reports a new host-agnostic `merge_state: "blocked"`. Core then
handles `blocked` honestly at the **two** places it decides merge-readiness:

1. **auto-merge `decideReadiness` (the merge-decision authority, robust backstop):** `blocked →
   needs_human_merge` **before** any `mergePR` call → the *existing, regression-tested* terminal hand-off
   (`needs_human_merge → done`, PR #28 test). No doomed merge, no rework, task leaves the poll set → the
   loop is structurally impossible. Covers **every** path that reaches auto-merge (a detect→merge race, the
   formal-approval path).
2. **PR-event poller (the front line, where the live incident occurs):** an authorized `/approve` on a
   `blocked` PR is **not** promoted (that would be a false "ready to merge"); it is **escalated to the owner**
   with the actionable reason and the task is blocked under an owner-wait so it leaves the `pr_review_pending`
   poll set (bounded; no re-promote, no rework).

Because both sites key off the contract's `blocked` value and the plugin only reports the *fact*, a second
hosting plugin inherits the whole safety with zero Core changes (criterion 6).

### Approach B — Bound the `pr_ready_to_merge` re-entry with a new counter (rejected)

Mirror `consecutive_blocker_reentries` for the `pr_ready_to_merge` path: count re-entries, escalate past a
cap. **Rejected** — it treats the *symptom* (unbounded re-entry) not the *cause* (a merge that structurally
cannot complete is attempted at all). It still burns N doomed merges + N branch re-pushes before the cap
fires, still relies on the unreliable `classifyMergeError`, and adds config + state for a bound that
Approach A gets *structurally for free* (the task goes `done`/owner-wait and leaves the poll set on the
first detection). More moving parts, strictly worse behavior. Approach A subsumes criterion 3 without a
counter.

### Approach C — Promote `blocked` through `pr_ready_to_merge` and let auto-merge escalate (rejected)

Let the poller still promote a blocked PR into auto-merge, which hands it off. **Rejected** — the
`pr_ready_to_merge` event and its "…green — merging" ticket notice would be emitted for a PR the poller
*already observed is blocked*: a dishonest interim signal that would need downstream state-threading to
correct, and a wasted re-entry round-trip. Escalating directly in the poller (Approach A.2) is honest and
cheaper. (auto-merge keeps its `blocked` branch anyway, as the race backstop — that part of C is retained.)

**Decision: Approach A.** It is the smallest change that fully and *robustly* meets every criterion, reuses
the proven `needs_human_merge → done` hand-off, adds no new config/counter, and honors the plugin/Core
boundary. Complexity earns its place only in the two-site handling, which is genuine defense-in-depth (front
line + race backstop), not duplication.

---

## 3. Stress-test of the chosen plan

- **Plugin Opacity — would Core compile with every plugin deleted?** Yes. The new `blocked` value lives in
  the **Core contract** (`src/schemas/adapters.ts`). Core's `decideReadiness` and the poller switch on the
  contract string, never on anything GitHub-specific. `mergeable_state` is read *only* inside the GitHub
  plugin and mapped to the contract value there. No Core file imports the plugin. ✔
- **Isolation — shared mutable state / cross-task bleed?** None added. The escalation writes only to the
  single task's own fields (`blocked`, `pending_pr_event`) via `taskEngine.updateTaskField`, exactly as the
  existing `escalateBlockerCap` does per-task inside `Promise.allSettled`. `mapMergeState` is pure. No module
  state introduced. ✔
- **Boundaries — contracts, not internals?** Yes. Core reads `PRStatus.merge_state` (a contract field); the
  plugin reads GitHub's raw fields behind `doGetPRStatus`. The poller escalation reuses the public
  `taskEngine`/`notifications` surfaces and the existing `BlockedDetails` shape. ✔
- **Reversibility — name the hard-to-undo decisions:**
  - **`merge_state` enum gains `"blocked"`** (`src/schemas/adapters.ts`) — an *additive* enum change. All
    three consumers are `if`-chains with safe fallthroughs (verified: poller L204, auto-merge L201/206;
    no exhaustive `never` switch over `merge_state`), so adding the value breaks no build and is easy to
    revert. Low-risk, but it is a contract change — recorded as a decision (§6, D1).
  - **No new `BlockCategory`, no new config knob, no schema field on `ReviewState`** — deliberately avoided
    (§6, D4) to keep the change reversible and small. The escalation reuses the existing `awaiting_human`
    category + `need_more_info` reason.

All checks pass — no redesign needed.

---

## 4. Pre-mortem — assume it ships with a subtle flaw

1. **`needs_human_merge` disposition silently falls through to `performMerge`.** `runAutoMerge`'s switch has
   no `needs_human_merge` case today; its `default` arm is `performMerge`. If `decideReadiness` returns
   `needs_human_merge` and we forget an explicit `case`, a blocked PR would still attempt the doomed merge —
   re-opening the exact bug. **Mitigation:** Step 3 adds an explicit `case "needs_human_merge"` in the switch
   *and* a test asserting a `blocked` status resolves to `disposition: needs_human_merge` with `mergePR`
   **never called** (Step 8). This is the single highest-risk spot — the test is mandatory.
2. **The `mergeable_state` mapping masks a genuine merge or a genuine conflict (criteria 5 & 7 regression).**
   A `"blocked"` PR has `mergeable === true`; a naive `if (mergeable === true) return "mergeable"` *first*
   would mask the block (research §5 "ordering trap"), and over-eagerly mapping states like `"behind"` to
   `blocked` would wrongly stall PRs that GitHub *would* merge. **Mitigation:** the mapping (Step 1) inspects
   the two definitive answers first (`null → unknown`, `mergeable === false → conflicting`), then diverts
   **only** the exact `mergeable_state === "blocked"` string to `blocked`, and lets everything else
   (`clean`, `unstable`, `has_hooks`, `behind`, `unknown`, undefined) preserve today's boolean-driven
   `mergeable`. `"behind"` is deliberately **not** treated as blocked (D3) — it is not a textual conflict and
   GitHub still merges it when up-to-date is not required, so mapping it to `blocked` would regress
   criterion 5. Tests cover `blocked` (new) and re-assert `true→mergeable`, `false→conflicting`,
   `null→unknown` stay green.
3. **The poller escalation loops or re-fires every poll.** If the escalation left the task in
   `pr_review_pending`, the next poll would see the same `/approve` + `blocked` and re-escalate forever
   (a new loop). **Mitigation:** the escalation blocks the task under `reason: need_more_info` (≠
   `pr_review_pending`), so `getBlockedTasksByReason(pr_review_pending)` no longer returns it and the poller
   stops polling it — structurally bounded to one escalation. It also clears `pending_pr_event` defensively
   (as `escalateBlockerCap` does). Test asserts exactly one escalation and no `pr_ready_to_merge` promotion
   (Step 8).
4. **Checks-failing + blocked routes to escalate instead of legitimate CI rework.** A blocked PR with red CI
   should still let CI rework happen (existing behavior). **Mitigation:** the poller escalates blocked **only
   when `checks_state === "passing"`** (symmetric with the promote condition), so a failing-CI PR falls
   through to the normal rework/wait path.

---

## 5. Ordered implementation

Legend: each step lists the file(s), the change, and its **Verify** (a command or a specific assertion).
`node_modules` is **not** installed in this worktree (research §8) — Step 0 bootstraps it.

### [ ] Step 0 — Bootstrap the toolchain
- Run `pnpm install` (or `pnpm run setup`) so the gates can run.
- **Verify:** `pnpm run typecheck` runs (may pass now; it is the baseline).

### [ ] Step 1 — Plugin: read `mergeable_state`, report the new `blocked` state
File: `src/plugins/git-hosting/github-hosting/github-hosting.ts`
- Change `mapMergeState` signature to `mapMergeState(mergeable: boolean | null | undefined,
  mergeableState: string | null | undefined)` and return type to
  `"mergeable" | "conflicting" | "blocked" | "unknown"`. New body, in this exact order:
  1. `mergeable === null || mergeable === undefined` → `"unknown"` (host still computing — unchanged).
  2. `mergeable === false` → `"conflicting"` (definitive textual conflict — unchanged, criterion 7).
  3. `mergeableState === "blocked"` → `"blocked"` (branch protection / required review — **new**).
  4. otherwise → `"mergeable"` (preserves today's `true → mergeable` for `clean`/`unstable`/`has_hooks`/
     `behind`/`unknown`/undefined — criterion 5).
- Update the call site in `doGetPRStatus` (~L200): `mapMergeState(pr.mergeable, pr.mergeable_state)`.
  (`pr.mergeable_state` is on the same `octokit.pulls.get` response already fetched — no extra API call.)
- Update the function's doc comment to describe the `blocked` case and the ordering rationale.
- **Verify:** `pnpm run typecheck`; add/extend unit tests in Step 8a and run
  `pnpm test:unit tests/unit/plugins/git-hosting/github-hosting`.

### [ ] Step 2 — Contract: add `"blocked"` to `merge_state`
File: `src/schemas/adapters.ts` (`PRStatusSchema.merge_state`, ~L409)
- Enum becomes `z.enum(["mergeable", "conflicting", "blocked", "unknown"])`.
- Extend the field's doc comment: `blocked` = "mergeable shape, but the host will not complete the merge
  (branch protection / required review). Core waits or hands off — never reworks."
- **Verify:** `pnpm run typecheck` (confirms no exhaustive consumer breaks — there is none).

### [ ] Step 3 — Core auto-merge: `blocked → needs_human_merge` (robust backstop)
File: `src/core/orchestrator/pipeline/delivery/auto-merge.ts`
- In `decideReadiness`, add a branch after the `conflicting` check and before the `unknown`/checks branches:
  `if (status.merge_state === "blocked") return { disposition: "needs_human_merge", reasoning: "the host's
  branch protection blocks the merge — a human must complete or unblock it" };`
- In `runAutoMerge`'s `switch (readiness.disposition)`, add an explicit
  `case "needs_human_merge":` **before** the `default` (which is `performMerge`). It must: log an info,
  call `notifyHostBlockedMerge(ctx, prNumber, false)` (reuse — no thoughts push happened, so no dismissal),
  and `return resolved("needs_human_merge", …)`. **This case is mandatory** (pre-mortem #1) — without it a
  `needs_human_merge` disposition falls through to `performMerge` and attempts the doomed merge.
- Add a `{ id: "needs_human_merge", description: "Host blocks the merge — hand off to the owner" }` entry to
  `MERGE_DISPOSITION_OPTIONS` so the `recordMergeReadiness` decision stays complete.
- `autoMergeNext("needs_human_merge")` already returns `{ go: "done" }` (verified, tested at L100) — no
  change.
- **Verify:** `pnpm test:unit tests/unit/core/orchestrator/pipeline/delivery/auto-merge` — Step 8b assertions.

### [ ] Step 4 — Core poller: escalate an `/approve` on a `blocked` PR (front line)
File: `src/core/daemon/pr-event-poller.ts`
- Refactor `shouldPromoteApproval` (boolean) into a tri-state resolver
  `resolveApproveDisposition(task, hosting, events): Promise<"promote" | "escalate_blocked" | "wait">` that
  fetches live status **once**:
  - guard fails (comment-approval disabled / no authorized approval / no PR) or `getPRStatus` throws →
    `"wait"` (unchanged safe default; the throw path keeps its existing warn log).
  - `state === "open" && checks_state === "passing" && merge_state === "mergeable"` → `"promote"`.
  - `state === "open" && checks_state === "passing" && merge_state === "blocked"` → `"escalate_blocked"`.
  - else → `"wait"`.
- In `actionableEvents` (or `pollSingleTask`), act on the tri-state:
  - `"promote"` → `recordApprovePromotion` + return `[{ type: pr_ready_to_merge }]` (unchanged behavior).
  - `"escalate_blocked"` → call new `escalateMergeBlocked(task)` (side effect) and return `[]` so no event
    routes this poll.
  - `"wait"` → `deduped.filter(isActionableRework)` (unchanged).
- Add `escalateMergeBlocked(task)` mirroring `escalateBlockerCap`'s structure:
  - `recordMergeBlockedEscalation(task)` — a `recordDecision` with alternatives
    `[promote_to_merge, escalate]`, chosen `escalate`, reasoning "branch protection blocks the merge — a
    /approve comment cannot satisfy a required formal review; looping only re-pushes the branch."
  - `taskEngine.updateTaskField(task.id, "pending_pr_event", null)` (defensive — pre-mortem #3).
  - `taskEngine.updateTaskField(task.id, "blocked", { reason: BlockReasons.need_more_info, category:
    BlockCategories.awaiting_human, sub_phase: "await-review", needed: <actionable message> })` — this takes
    the task out of the `pr_review_pending` poll set (bounded) and onto the owner-escalation ladder.
  - `notifications.notify({ kind: alert, … })` and `{ kind: ticket_comment, … }` with the **actionable**
    message (criterion 2), e.g.: *"PR #N is approved and green, but the host's branch protection blocks the
    merge — it needs a formal review approval a `/approve` comment can't provide. Approve the PR on the host
    (or adjust its branch protection), then run `engineer retry` to resume and I'll merge it."*
  - `observer.warn("PR /approve blocked by branch protection — escalating to the owner", { … })`.
- **Verify:** `pnpm test:unit tests/unit/core/daemon/pr-event-poller` — Step 8c assertions.

### [ ] Step 5 — Keep the bundled plugin doc in sync (drift hazard, research §2)
File: `src/cli/bundled/plugin-docs.ts` (GitHub Hosting doc string, the **PR status** paragraph, ~L50)
- Add one sentence: a PR that is mergeable-in-shape but blocked by branch protection / a required review
  (GitHub `mergeable_state: "blocked"`) is reported as `merge_state: blocked` and handed to the owner —
  never reworked.
- **Verify:** `pnpm run docs:bundle` if the doc is generated/checked; otherwise `pnpm run typecheck` +
  `pnpm run lint` (it is a string constant).

### [ ] Step 6 — (No change) confirm `derivePrEvents` needs no edit
File: `src/plugins/git-hosting/github-hosting/github-hosting.ts` (`derivePrEvents`, L504)
- It already gates `pr_ready_to_merge` on `merge_state === "mergeable"`; after Steps 1–2 a blocked PR reads
  `"blocked"`, so it **stops** emitting `pr_ready_to_merge` from the formal path for free (desired — no doomed
  merge from that path). `merge_state === "conflicting"` still emits `pr_merge_conflict` (criterion 7).
- **Verify:** the existing `derivePrEvents` tests (L672–694) stay green; add a `blocked` assertion in Step 8a.

### [ ] Step 7 — Full-project gates
- `pnpm run typecheck` → `pnpm run lint` → `pnpm test:all` (CONTRIBUTING gate:
  `pnpm test:all && pnpm run lint && pnpm run typecheck`).
- **Verify:** all three exit 0. A non-zero exit is a failure to fix, never to wave off.

---

## 6. Regression strategy — tests that must be added (criterion 8)

These guard the behavior *permanently*, each targeting a specific failure mode above. All are unit tests in
the existing suites (conventions confirmed by reading the files).

### [ ] Step 8a — Plugin mapping (`tests/unit/plugins/git-hosting/github-hosting/github-hosting.test.ts`)
- **New:** `getPRStatus` maps `mergeable: true, mergeable_state: "blocked"` → `merge_state: "blocked"`
  (add `mergeable_state` to the `pulls.get` mock fixture for this case).
- **Regression re-assert (must stay green):** `mergeable: true` (no/other `mergeable_state`) → `"mergeable"`
  (criterion 5); `mergeable: false` → `"conflicting"` (criterion 7); `mergeable: null` → `"unknown"`.
- **New:** `derivePrEvents(status({ merge_state: "blocked" }), approved, [])` emits **no**
  `pr_ready_to_merge` (and no `pr_merge_conflict`).

### [ ] Step 8b — auto-merge readiness/route (`tests/unit/…/delivery/auto-merge.test.ts`)
- **New (highest priority, pre-mortem #1):** a live status with `merge_state: "blocked"` resolves to
  `disposition: "needs_human_merge"`, `mergePR` is **never called**, `notifyHostBlockedMerge` fires, and
  `autoMergeNext(okResult("needs_human_merge"))` → `{ go: "done" }`.
- **Regression re-assert:** `merge_state: "conflicting"` still → `merge_conflict` (→ execution rework);
  `merge_state: "mergeable"` + green still merges (records merge, notifies milestone) — criteria 7 & 5.
- **New:** the `recordMergeReadiness` decision lists `needs_human_merge` among its options and records it as
  chosen for a blocked PR.

### [ ] Step 8c — poller escalation (`tests/unit/core/daemon/pr-event-poller.test.ts`)
- **New (criteria 2 & 3):** an authorized `/approve` on a PR whose live status is
  `open + passing + blocked` → **no** `pr_ready_to_merge` promotion (assert `requestTransition` / the
  `pending_pr_event = pr_ready_to_merge` write did **not** happen), the task is blocked with
  `{ reason: need_more_info, category: awaiting_human }`, `pending_pr_event` is cleared, and an owner
  notification is sent.
- **New (bound):** a *second* poll of the now-escalated task does nothing (it is no longer in the
  `pr_review_pending` set the poller queries) — assert the loop cannot re-form.
- **Regression re-assert:** `/approve` on `open + passing + mergeable` still promotes to `pr_ready_to_merge`
  (existing test at L248, keep green — criterion 5's `/approve` path); `/approve` on a not-green PR still
  waits (L260).

---

## 7. Decision log (what I chose, rejected, and what it locks in)

- **D1 — `blocked` is a new value on the existing `merge_state` contract enum**, not a new `PrEvent` type.
  Rejected adding `pr_merge_blocked` to the event vocabulary (research §9): the contract value +
  `needs_human_merge` disposition already express "host won't merge → hand off." Locks in: a second hosting
  plugin implements the safety by returning `blocked` from its own status mapping — no new event or Core
  wiring. Reversible additive enum change.
- **D2 — Detect `blocked` in *readiness* (before `mergePR`), not by classifying the merge *failure*.** The
  live incident proved GitHub's rejection HTTP code is unreliable (405 vs 409 vs other; the pre-merge
  thoughts push can perturb it), so `classifyMergeError` cannot be trusted to catch the block (research §3).
  Deciding in `decideReadiness` avoids the doomed merge and the branch re-push entirely. `classifyMergeError`
  is left unchanged (still the correct backstop for a *genuine* 405/409 after a real attempt).
- **D3 — `mergeable_state === "behind"` maps to `mergeable`, NOT `blocked`.** `behind` is an out-of-date
  branch, not a textual conflict, and GitHub merges it when protection does not require up-to-date branches;
  mapping it to `blocked` would stall PRs GitHub would merge (criterion 5 regression). Only the exact
  `"blocked"` string diverts. Locks in: the surgical scope the incident calls for; a require-up-to-date repo
  hitting `behind` still relies on the existing failure routing (a narrower, pre-existing, out-of-scope path).
- **D4 — Reuse `awaiting_human` / `need_more_info` for the poller escalation; add no new `BlockCategory`,
  config knob, or `ReviewState` field.** The block is an owner-action wait; `awaiting_human` fits and its
  coarse label is accurate — the *specific* reason lives in the `needed` text and the notification. Avoids
  touching `task.ts`, `blockLogLevel`, and the dashboard vocabulary. Keeps the change small and reversible.
- **D5 — Two escalation sites are defense-in-depth, not duplication.** Poller = the foreseeable
  `/approve` + blocked case (honest, actionable, resumable-via-retry). auto-merge = the rare
  detect→merge race / formal-approval path (terminal `done`, reusing the proven hand-off). Different
  triggers, one shared contract value.
- **D6 — The poller escalation is resumable (owner approves/adjusts + `engineer retry` → merges); the
  auto-merge backstop is terminal `done` (owner merges).** The slight asymmetry is intentional: the poller
  path is the primary UX where "approve on the host, then I'll merge" is the desired flow; the backstop is a
  rare race where the existing terminal hand-off is the safe, established behavior.

---

## 8. Scope / autonomy notes

- Files touched: 2 plugin/contract (`github-hosting.ts`, `adapters.ts`), 2 Core (`auto-merge.ts`,
  `pr-event-poller.ts`), 1 doc string (`plugin-docs.ts`), 3 test files. This is a **scope_expansion** beyond
  the single "core" file into the doc string and tests — within my autonomy to decide alone; recorded for
  visibility, not as an open question.
- **No** broad refactor, dependency, public-API, destructive, or security change. The `merge_state` enum is
  an internal adapter contract, not a public API. No owner sign-off gate is triggered.
- Off-limits files (`.env*`, `secrets/**`, `*.pem`, `*.key`) — untouched.

## 9. Open questions

None. Every design fork the owner delegated is resolved above (escalate-vs-wait → escalate with resumable
block; `/approve`-vs-required-review → do not promote a blocked PR, escalate with the actionable reason;
loop bound → structural, via leaving the poll set + the terminal hand-off). Requirements and research both
recorded "no questions for the owner," and this plan needs none to proceed to execution.
