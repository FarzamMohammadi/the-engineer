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

---
---

# Re-run pass — 2026-07-11: reconcile the two host-blocked paths (criteria 9–13)

Source: the owner's review comment on PR #48 (requirements §"Re-run pass — 2026-07-09", criteria 9–13).
Base: this branch, HEAD `a0848eb` (source state = `8a5d87f`; `a0848eb` touches only `thoughts/`).
Builds on: `../requirements/requirements.md` and `../research/research.md` (read both first).

**The sections above (pass 1) are the plan for criteria 1–8 — already implemented and committed in `8a5d87f`.
They stand as the record of that work. This section plans the remaining, open work: criteria 9–13.**

---

## 27. What I verified myself (not inherited) — including two findings the prior phases missed

I re-read every claim against HEAD rather than trusting the trail. Research §§11–26 check out. Two facts
that change the design were **not** established by either prior phase:

### 27.1 `go: "done"` is not a neutral "hand-off" — it emits a false completion and destroys the worktree

`autoMergeNext` (auto-merge.ts:95) falls to `default → { go: "done" }` for `needs_human_merge`. Following
that through: runner `planRoute` → `{kind:"complete"}` → daemon `handleCompletedOutcome`
(`task-scheduler.ts:233–277`), which:

1. transitions the task to `completed` — **not in `RETRYABLE_STATES`** (`task.ts:380` = failed/blocked/cancelled),
   so `engineer retry` can never bring it back;
2. calls `workspaceManager.cleanupWorkspace(taskId, true)` (:256) — **the worktree is destroyed**;
3. posts a ticket comment: **`"Task completed successfully."`** (:264–268) — on a PR that is *not merged*;
4. eagerly reaps and frees the idempotency key.

So today the owner literally receives, on the same unmerged PR, *"the host won't let me complete the merge…
Merge it when you're ready"* immediately followed by *"Task completed successfully."* **Criterion 10's "no
false completed" is not an abstraction — it is a message the engine emits.** (Verified non-destructive:
`workspace-reaper/index.ts:312–321` keeps the branch when `merged_at` is null. The PR survives; the harm is
the false completion, the destroyed worktree, and the lost resumability.)

### 27.2 The block path ALREADY notifies the owner — so the obvious fix double-messages them

`blockTask` (`orchestrator/index.ts:449–458`) computes `isHumanWait = category === awaiting_human ||
awaiting_human_decision`, and for a human wait calls **`deliverBlockedQuestion`**, which
(`outreach.ts:44–59`) sends **a `ticket_comment` AND a `question` notification to the owner's chat**, and
persists the text as `needed` for the dashboard.

⇒ If I route `needs_human_merge` to `{go:"block", category: awaiting_human, needed: …}` **and** leave
`runAutoMerge`'s existing `notifyHostBlockedMerge(...)` call in place, the owner gets **two** ticket comments
for one event. The naive implementation of the chosen contract has this bug baked in. The fix is not
incidental — it is a required part of the design: **the block's `needed` becomes the single owner-facing
message on the auto-merge path, and `notifyHostBlockedMerge` is removed.**

(`retry_wait` does not hit this: `awaiting_pr_review` is not a human wait, so `blockTask` does not deliver.
The `needs_human` branch at auto-merge.ts:75–80 *does* — and it relies on exactly this delivery, which is the
proof the pattern works.)

### 27.3 The rest, confirmed

- `decideReadiness` (:226) and `classifyMergeFailure` (:396–401) both resolve host-blocked → `needs_human_merge`. ✔
- `resolved()` (:504) returns `outcome: "ok"` → disposition-driven routing. ✔
- Poller `escalateMergeBlocked` (:309–334): `blocked` / `need_more_info` / `awaiting_human` /
  `sub_phase: "await-review"`, message *"…run `engineer retry` to resume and **I'll merge it**."* ✔
- `toBlockReason(awaiting_human) → need_more_info` (`index.ts:91–93`) ⇒ **off** the `pr_review_pending` poll
  set (`poller:60`) ⇒ the loop is structurally impossible under `block`, exactly as it is under `done`.
  **Loop-safety does not differentiate the two contracts** — everything else does.
- `checkBlockedEscalation` (`health-monitor.ts:164–170`) covers every blocked task **except**
  `pr_review_pending` ⇒ a `need_more_info` block gets the ladder: 4h repeating reminder → 8h self-unblock
  check → 48h `escalation_alert` → **task → `failed`** (:285–289). An undelivered task ends `failed`, not
  `completed` — criterion 10 satisfied by an *existing* mechanism.
- `Route` (`types.ts:100–105`) already has `{go:"block", category, needed}`. No type change needed.
- `mapMergeState` (github-hosting.ts:549–563) is a denylist: `mergeable===null→unknown`,
  `false→conflicting`, `mergeable_state==="blocked"→blocked`, **else `mergeable`**. ✔
- Existing tests encoding the old contract: `auto-merge.test.ts` lines 92/96/99–100/202–219/274–291/322–332
  (four `{go:"done"}` assertions for `needs_human_merge`); `pr-event-poller.test.ts:295–333` (Path A's
  category, already the target contract).
- `node_modules` **is** installed. Gates run directly.

---

## 28. Approaches evaluated

### Approach A — One shared Core contract module; both paths route to it (CHOSEN)

A single Core module owns the host-blocked hand-off contract: **the block category, and the one honest
message**. Both paths import it.

- **auto-merge** gains `case "needs_human_merge"` in `autoMergeNext` → `{go:"block", category:
  awaiting_human, needed: <shared message>}`, and **drops** `notifyHostBlockedMerge` (the block's canonical
  delivery is the single message — §27.2).
- **poller** keeps writing its own block (it is not in the pipeline and cannot call `blockTask`), but takes
  its `needed`/notification text from the same module — so the two paths land on the **same (state, reason,
  category)** and say the **same true thing**.
- One message, worded true whether or not the Engineer can ever finish the merge (§29).

**Cost:** 1 new ~40-line pure module, 1 switch case, 1 message swap, test updates. No schema change, no new
`BlockCategory`, no new `PrEvent`, no config knob, no new API call.

### Approach B — Distinguish the block reason (required-review vs. no-merge-permission) and branch the message

Criterion 11's other permitted route. Would need `reviewDecision` (**GraphQL-only**; the plugin is REST) or
`getBranchProtection` + matching the engine's own identity against `restrictions` — an extra API call per
poll and a new identity concept. Research §13 established `mergeable_state === "blocked"` is a **catch-all**
that cannot separate the two on its own.

**Rejected.** It buys a *nicer* message and nothing else — no lifecycle correctness, no loop safety, no
coherence — at the cost of a new API call, a GraphQL dependency or identity-matching heuristic, and a new
failure mode (a wrong guess produces a *confidently wrong* message, worse than an honestly conditional one).
The owner offered wording-that-holds as an equal alternative. **Complexity must earn its place; this doesn't.**

### Approach C — Make the poller terminal to match auto-merge (`done` on both)

The other way to achieve coherence. **Rejected outright:** §27.1 shows `done` is the *worse* contract on
every axis the owner named — it emits "Task completed successfully." on an unmerged PR (violates criterion
10 explicitly), destroys the worktree, and makes the task non-retryable, so the outcome the message promises
(approve → retry → merge) becomes *impossible*. The owner's own steer ("reconsider marking the task `done`
while the PR is still unmerged") points away from it.

**Decision: Approach A.** It is the simplest path that fully meets criteria 9–12, and it reuses three
existing, tested mechanisms (the `needs_human` → block shape, the canonical blocked-question delivery, and
the health-monitor escalation ladder) instead of building anything new.

---

## 29. The single honest message (criterion 11)

The REST plugin cannot cheaply tell *"a required review the owner can add"* (Engineer **can** merge after)
from *"no merge permission"* (Engineer **never** can) — research §13. So the message must be true in **both**
worlds. It must therefore drop Path A's unconditional *"I'll merge it"*.

**Canonical text** (built by the shared module, used verbatim as `needed` by both paths):

> PR #N is approved and green, but the host's branch protection won't let me complete the merge — it needs a
> formal review approval that a "/approve" comment cannot provide. Approve the PR on the host (or adjust its
> branch protection), then run "engineer retry": I'll re-check and merge it **if the host lets me**. If it
> still refuses (for example, I don't have merge permission), merge it yourself — the branch and PR are ready.

**Approval-dismissed variant** (reachable only from the merge-failure backstop, when the pre-merge
thoughts-cleanup push dismissed a formal approval — this nuance exists today and must not be lost):

> PR #N is ready, but my thoughts-cleanup commit dismissed your earlier approval, and the host's branch
> protection now blocks the merge. Re-approve the PR on the host, then run "engineer retry": I'll re-check
> and merge it **if the host lets me**. If it still refuses (for example, I don't have merge permission),
> merge it yourself — the branch and PR are ready.

Honesty check against what retry actually does (research §14, re-verified):
- *auto-merge path* retry → resumes at `auto-merge` (its own checkpoint) → re-checks → merges if now clean, re-blocks if not. ✔ true.
- *poller path* retry → resumes at `await-review` → re-parks → back on the poll set → promotes → merges. ✔ true.
- *no-merge-permission* → both re-block; the message already told the owner to merge it themselves. ✔ true.

---

## 30. Stress test of the chosen plan

| Check | Verdict |
|---|---|
| **Plugin opacity** — would Core compile with every plugin deleted? | **Yes.** The new module imports only `schemas/task.js`. Core reads the host-agnostic `PRStatus.merge_state === "blocked"`; only the GitHub plugin knows `mergeable_state`. Step 5 (optional) is entirely inside the plugin, behind the contract. Criterion 6 preserved. |
| **Isolation** — shared mutable state / cross-task bleed? | **None.** The module is pure functions + constants. No caches, no counters, no module-level state. |
| **Boundaries** — contracts, not internals? | **Yes.** The poller importing a Core policy module from `orchestrator/pipeline/` is the *established* precedent — it already imports `pr-events.js` (`arbitrate`, `dedupePrEvents`, `findAuthorizedApproval`). No cycle: the new module depends on `schemas/` only. Neither path reaches into the other. |
| **Reversibility** — what is hard to undo? | Named honestly: **(a)** the `autoMergeNext` route change — one switch case, trivially revertible; **(b)** the new module — purely additive; **(c)** *step 5's `mapMergeState` allowlist is the least reversible in effect* — it changes which host states are allowed to merge. That is why it is **last, isolated, and droppable**. **No schema change, no new `BlockCategory`, no new `PrEvent`, no new config key, no new API call — nothing that locks in a contract a second hosting plugin would inherit.** |

---

## 31. Pre-mortem — it ships with a subtle flaw. What is it?

**F1 — The owner gets two messages (highest probability).** The naive implementation keeps
`notifyHostBlockedMerge` *and* adds the block, so `deliverBlockedQuestion` and the notify both post a ticket
comment. **Mitigation:** delete `notifyHostBlockedMerge`; the block's `needed` is the single message. Test
asserts `notify` is **not** called on the readiness path and that `needed` carries the text (Step 2).

**F2 — The approval-dismissed nuance is silently lost.** Removing the notify would drop the "my cleanup
commit dismissed your approval" variant, which only `run` knows about — and `autoMergeNext` is *pure*, so it
cannot see it. **Mitigation:** thread `approval_dismissed` (and `pr_number`) through `result.data` so the
pure `next` can select the right message. Both variants tested (Step 2).

**F3 — A PR merely *awaiting* its required review gets escalated (the dangerous false positive).** A PR with
required reviews and no approval yet **also** reports `mergeable_state === "blocked"` — that is the *normal*
waiting state. Escalating on `blocked` alone would break the highest-traffic path in the system. **Mitigation:
do not touch the existing gates.** The poller escalates only when an **authorized `/approve` + green** is
present; `decideReadiness`'s `blocked` branch is reached only once a task has *entered* auto-merge (i.e.
something already signalled ready). Both gates are preserved verbatim, and a **new regression test** proves a
blocked PR with **no** `/approve` produces no escalation and no promotion (Step 3).

**F4 — The optional allowlist stalls a genuine merge (criterion 5).** An allowlist means any state not on it
stops merging. **Mitigation:** Step 5 is last, isolated, droppable, and carries a per-state unit matrix
(`clean`/`unstable`/`has_hooks`/`behind` → mergeable → still merges). If it is not clean, it is dropped —
the owner marked it explicitly optional.

**F5 (accepted, not mitigated) — the slow self-unblock re-check cycle.** `awaiting_human` is eligible for the
8h `evaluate_self_unblock` (only `awaiting_human_decision` is skipped, `health-monitor.ts:250–256`). If the
agent answers "resolvable", the task goes active → resumes at `auto-merge` → re-checks → re-blocks →
`last_transition_at` resets → the ladder restarts, so the 48h `failed` escalation may never fire.
**Accepted, deliberately:** each lap costs one status re-check and no agent rework, **no branch push, no
rework, no fast loop** — and if the owner *has* approved on the host in the meantime, that lap **merges the
PR by itself**, which is precisely the "wait and re-check" the original issue asked for. The 4h reminders
keep firing, so the owner is never in the dark. The alternative — a new `BlockCategory` to force determinism
— means schema growth plus a change to the shared health monitor, and would misrepresent a merge block as a
"discretionary decision". **This is also not a new behavior:** it is exactly what the poller's
`awaiting_human` block does today, which the owner reviewed and did not object to. Documented as a follow-up
candidate, not smuggled in here.

---

## 32. Ordered implementation

### Step 1 — The shared contract module *(new file)*
- [ ] Create `src/core/orchestrator/pipeline/host-blocked-merge.ts` — the **one** contract both paths resolve to. Pure; imports only `schemas/task.js`. Exports:
  - `HOST_BLOCKED_MERGE_CATEGORY = BlockCategories.awaiting_human` — the single lifecycle target.
  - `hostBlockedMergeNeeded(prNumber: number, approvalDismissed: boolean): string` — the honest message of §29 (both variants). This string is what both paths persist as `needed`.
  - A file header explaining *why* the contract is blocked-resumable and not `done` (§27.1) — so the next reader cannot "simplify" it back into a completion.
- [ ] Note in the header that `awaiting_human` ⇒ `need_more_info` ⇒ off the `pr_review_pending` poll set (the structural loop bound) **and** on the health-monitor escalation ladder (the honest `failed` terminal).
- **Verify:** `pnpm run typecheck` && `pnpm run lint`.

### Step 2 — auto-merge: route the host-blocked merge to the contract *(criteria 9, 10, 11)*
- [ ] `src/core/orchestrator/pipeline/delivery/auto-merge.ts`: add `case "needs_human_merge":` to `autoMergeNext` (before `default`) returning `{ go: "block", category: HOST_BLOCKED_MERGE_CATEGORY, needed: hostBlockedMergeNeeded(prNumber, approvalDismissed) }`, reading `pr_number` / `approval_dismissed` from `result.data`.
- [ ] Extend `resolved(...)` so the `needs_human_merge` results carry `pr_number` and `approval_dismissed` in `data` (F2). Keep `outcome: "ok"` — the disposition drives the route (the proven `retry_wait` shape); do **not** switch to `outcome: "needs_human"`, which would hit the generic "merge ambiguity" branch.
- [ ] **Delete `notifyHostBlockedMerge`** and both of its call sites (readiness :188, failure backstop :370). The block's canonical delivery (`blockTask` → `deliverBlockedQuestion`) is now the single owner-facing message (F1). Keep the `observer.info` logs.
- [ ] Update the sub-phase header comment (:46–48) — it currently documents "host-blocked → done … we stop, never loop". Replace with the blocked-resumable contract and *why* (`done` would emit a false completion and destroy the worktree). **Leave `merged` and `auto_merge_disabled` on `done`** — those are genuine, honest terminal hand-offs (the owner *configured* auto-merge off; the PR is the deliverable). Criterion 10 is about the *host-blocked* case only; over-correcting them would be scope creep.
- **Verify:** `pnpm vitest run tests/unit/core/orchestrator/pipeline/delivery/auto-merge.test.ts`.
- [ ] Update `auto-merge.test.ts`: the four `{go:"done"}` assertions for `needs_human_merge` (lines 100, 212, 284, 331–332) → the block route; retitle the "resolves **terminally**" cases (281, 322, 327). Assert: **no** `notify` from the readiness path, `needed` equals the shared message, and both message variants (plain + approval-dismissed). **Keep green:** `merged`/`auto_merge_disabled` → `done`; `conflicting` → `jump execution` (criterion 7); `merge` → merges (criterion 5); `retry_wait` → `awaiting_pr_review`.

### Step 3 — poller: same contract, same words *(criteria 9, 11)*
- [ ] `src/core/daemon/pr-event-poller.ts` → `escalateMergeBlocked`: take `category` and `needed` from the shared module (drop the hand-written *"…and I'll merge it"* — the promise the Engineer cannot keep). Keep writing `blocked` directly (the poller is not in the pipeline) and keep its `alert` + `ticket_comment` notifications, now with the honest text.
- [ ] Keep `sub_phase: "await-review"` — it is where the task genuinely is, and it is what resume reads. The auto-merge path will be stamped `"auto-merge"` by the runner. **This asymmetry is correct and intended:** criterion 9's "same state" is the routing-relevant tuple **(state, reason, category)** + the same message + both resumable + neither terminal + neither reworking. The `sub_phase` differs because the task genuinely *is* at a different point, and both resume routes end in the same place (merge, if the host now allows it — §29).
- [ ] Do **not** relax the `/approve` + `checks_state === "passing"` gate (F3).
- **Verify:** `pnpm vitest run tests/unit/core/daemon/pr-event-poller.test.ts`.
- [ ] Update `pr-event-poller.test.ts` (295–333): message assertion → the shared text; **keep** the `blocked`/`need_more_info`/`awaiting_human` assertions and the "cannot re-form the loop" test. **Add a regression test (F3): a `blocked` PR with NO authorized `/approve` ⇒ no escalation, no promotion, task stays waiting.**

### Step 4 — The coherence regression test *(criterion 12 — the owner's explicit ask)*
- [ ] New `tests/unit/core/host-blocked-merge-contract.test.ts` — a cross-cutting contract test that drives **both** paths on the **same** `merge_state: "blocked"` status and asserts they land on the **same** contract:
  - auto-merge: `runAutoMerge` → `autoMergeNext` → `{go:"block", category: awaiting_human, needed: M}`, and `toBlockReason(awaiting_human) === need_more_info`.
  - poller: `escalateMergeBlocked` writes `blocked` with `{reason: need_more_info, category: awaiting_human, needed: M}`.
  - **the same `M`** — assert the *identical string*, from the shared module, on both.
  - Assert **neither** path routes to `execution` and **neither** returns `{go:"done"}` (the two failures this whole issue is about).
- This is the permanent guard: it fails if anyone re-splits the contract, re-terminalizes the hand-off, or lets the two messages drift.
- **Verify:** `pnpm test:unit`.

### Step 5 — *(Optional, droppable)* `mapMergeState` denylist → allowlist *(criterion 13)*
Do **only if steps 1–4 are green and this stays clean.** The owner marked it explicitly not a gate.
- [ ] `github-hosting.ts` `mapMergeState`: keep `mergeable === null/undefined → unknown` and `mergeable === false → conflicting` (criterion 7) unchanged, then for `mergeable === true` switch to an allowlist:
  `clean | unstable | has_hooks | behind → mergeable` · `unknown | absent → unknown` (wait — never merge on an unverified state) · **everything else (`blocked`, `draft`, any future state) → `blocked`** (hand off).
- Rationale: a doomed merge attempt is not free even post-fix — it first pushes a thoughts-cleanup commit, which can *dismiss a formal approval* (`dismiss_stale_reviews`). Never attempting a merge on a state we do not recognize is the fail-safe. `behind` **stays `mergeable`** (today's exact behavior — an out-of-date branch is not a conflict and GitHub merges it when protection allows; changing it is a separate question).
- [ ] Update the `mapMergeState` doc comment **and** the duplicated prose in `src/cli/bundled/plugin-docs.ts:50` (a known drift hazard — the doc string currently describes the denylist and the `behind` rationale verbatim).
- [ ] `github-hosting.test.ts`: per-state matrix — `clean`/`unstable`/`has_hooks`/`behind` → `mergeable` (criterion 5), `blocked`/`draft`/unrecognized → `blocked`, absent/`unknown` → `unknown`, `mergeable === false` → `conflicting` (criterion 7).
- **Verify:** `pnpm vitest run tests/unit/plugins/git-hosting/github-hosting/github-hosting.test.ts`.

### Step 6 — Gates
- [ ] `pnpm test:all && pnpm run lint && pnpm run typecheck` — all green. A non-zero exit is a failure, never a warning to wave off.

---

## 33. Regression strategy — what guards this permanently

| Guard | Test | Protects |
|---|---|---|
| **Coherence** | `host-blocked-merge-contract.test.ts` (new) | Criterion 9/12: both paths → same (state, reason, category) + the *identical* message. Fails if the contract re-splits or the messages drift. |
| **No false completion** | same file: assert `needs_human_merge` never yields `{go:"done"}` | Criterion 10 — and, transitively, that "Task completed successfully." can never fire on an unmerged PR. |
| **No rework on a blocked merge** | same file: assert neither path routes to `Phases.execution` | Criterion 1 — the original infinite loop. |
| **Genuine merge still merges** | `auto-merge.test.ts` merge case + `mapMergeState` matrix | Criterion 5 (the regression most at risk from step 5). |
| **Genuine conflict still reworks** | `auto-merge.test.ts` `conflicting → jump execution` | Criterion 7 — the new rule must not swallow real conflicts. |
| **Normal review wait is untouched** | `pr-event-poller.test.ts` new case: blocked + **no** `/approve` ⇒ nothing happens | F3 — the dangerous false positive. |
| **Loop cannot re-form** | existing `pr-event-poller.test.ts:325` | Criterion 3. |
| **Honest message** | assert the `needed` text contains no unconditional "I'll merge it" | Criterion 11. |

---

## 34. Decisions — what I chose, what I rejected, what it locks in

| # | Decision | Rejected | Locks in |
|---|---|---|---|
| D1 | **Blocked-resumable** is the single contract; both paths write `blocked`/`need_more_info`/`awaiting_human`. | `done`-terminal (Approach C) — it emits "Task completed successfully." on an unmerged PR, destroys the worktree, and forbids the retry its own message promises (§27.1). | One switch case. Trivially reversible. |
| D2 | **One honest message**, conditional on the host ("I'll merge it *if the host lets me*; otherwise merge it yourself"). | Distinguishing the block reason (Approach B) — GraphQL-only `reviewDecision` / extra API call / identity matching, for a nicer message and nothing else. | Nothing. Approach B stays open as a later enhancement. |
| D3 | **A shared Core module** owns the category + message; both paths import it. | Duplicating the string in two files (drifts — that is *how* this bug was born), or exporting from `auto-merge.ts` (drags the pipeline's deps into the daemon). | One ~40-line pure file. Purely additive. |
| D4 | **Delete `notifyHostBlockedMerge`**; the block's canonical delivery is the single message. | Keeping it → two ticket comments per event (F1). | Nothing — `deliverBlockedQuestion` already reaches chat + ticket + dashboard. |
| D5 | **`awaiting_human`**, not a new `BlockCategory`. | A new category to force the 48h escalation deterministically (F5) — schema growth + a change to the shared health monitor + it would misrepresent a merge block as a "discretionary decision". | The accepted slow re-check cycle (F5) — which is the "wait and re-check" the issue asked for, and is already today's poller behavior. |
| D6 | **`merged` / `auto_merge_disabled` stay `done`.** | Also de-terminalizing them — they are *genuine* hand-offs (the owner configured auto-merge off; the PR is the deliverable). | Nothing. Criterion 10 is scoped to the host-blocked case. |
| D7 | **`sub_phase` deliberately differs** ("await-review" vs "auto-merge") — each path names where the task genuinely is, and both resumes end in the same place. | Forcing one string for cosmetic symmetry — it would make the dashboard lie about where the task is parked. | Criterion 9 is met on the routing-relevant tuple + message, which is what "same state" means operationally. |
| D8 | **Do the allowlist (step 5), last and droppable.** | Skipping it (it is optional) — but a doomed merge first *pushes* a cleanup commit that can dismiss a formal approval, so never attempting an unrecognized state is genuinely safer. `behind` stays `mergeable` (no behavior change). | The riskiest step; isolated and dropped if not clean. |

**Scope declined (recorded, not taken):** research §24's *third* path — a **formally**-approved + green +
host-blocked PR with **no** `/approve` comment emits no event, so it neither promotes nor escalates; it waits
with a misleading "waiting for review" reminder. I am **not** closing it here: it is outside the owner's
stated ask (criteria 9–13 name two paths), it does **not** loop or rework (it waits — mild harm), and closing
it means escalating on `blocked` from a state where `blocked` is *also* the normal "awaiting required review"
condition (F3) — a change that risks the highest-traffic path in the system to fix a rare, benign one. It
deserves its own ticket with its own thought, not a rider on this one.

## 35. Out of scope
- Issue **#46** (CI non-final / re-running-checks debounce) — the sibling ticket, explicitly excluded.
- The `behind` → "update the branch" question (§ step 5) — a separate behavior question.
- The third-path escalation above.
