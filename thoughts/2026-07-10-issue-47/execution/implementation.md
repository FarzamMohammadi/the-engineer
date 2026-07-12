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

---
---

# Re-run pass — 2026-07-11: reconcile the two host-blocked paths (criteria 9–13)

Source: the owner's review comment on PR #48 (requirements/plan §"Re-run pass", criteria 9–13).
Base: this branch, HEAD `a0848eb` (source state = `8a5d87f`, the pass-1 loop fix).
Builds on: `../planning/plan.md` §§27–35 (Approach A: one shared Core contract module, both paths route to it).

**The sections above (pass 1) stand as the record of criteria 1–8, already landed in `8a5d87f`.**
This pass implements the remaining open work: criteria 9–13.

Implemented the plan's Approach A. All gates green (`test:all`, `lint`, `typecheck`, `check:exports`).
Committed as two logical units:
- `fbc45df #47: Resolve a host-blocked merge to one contract on both paths` (criteria 9–12)
- `d70304e #47: Map mergeable_state by allowlist so an unknown state never merges` (criterion 13, the
  owner-optional step)

---

## The problem this pass closes

Pass 1 stopped the loop, but it left **two paths resolving the same host condition to opposite ends**:

| | poller (`/approve` on a blocked PR) | auto-merge (`needs_human_merge`) |
|---|---|---|
| lifecycle | `blocked` / `need_more_info` / `awaiting_human` — **resumable** | `done` → `completed` — **terminal** |
| message | "…run `engineer retry` to resume and **I'll merge it**." | "…the host won't let me complete the merge. **Merge it when you're ready**." |

Same signal, two lifecycle states, two contradictory promises — on the same PR. Following `go: "done"`
through the daemon showed it is not a neutral hand-off: it marks the task `completed` (not a retryable
state), destroys the worktree, and posts **"Task completed successfully."** on a PR that is *not merged* —
so the owner received the hand-off and a false completion on the same thread, and the retry the poller's
message promised was *impossible* on the auto-merge path.

## What changed, by file

### 1. `src/core/orchestrator/pipeline/host-blocked-merge.ts` — **new**, the shared contract
The one place both paths resolve to. Pure; imports only `schemas/task.js`.
- `HOST_BLOCKED_MERGE_CATEGORY = BlockCategories.awaiting_human` — the single lifecycle target.
- `hostBlockedMergeNeeded(prNumber, approvalDismissed)` — the one owner-facing message (both variants).
- A header recording *why* the contract is blocked-resumable and not `done`, so the next reader cannot
  "simplify" it back into a false completion.

### 2. `src/core/orchestrator/pipeline/delivery/auto-merge.ts`
- `autoMergeNext` gains `case "needs_human_merge"` → `{ go: "block", category: HOST_BLOCKED_MERGE_CATEGORY,
  needed: hostBlockedMergeNeeded(...) }`. This was the mandatory case (plan pre-mortem #1): the `default`
  arm is `performMerge`/`done`, so omitting it would have silently kept the old behavior.
- **Deleted `notifyHostBlockedMerge`** and both call sites. `blockTask` → `deliverBlockedQuestion` already
  posts a ticket comment *and* a chat question for an `awaiting_human` block, so keeping the notify would
  have told the owner **twice per event** (plan F1). The block's `needed` is now the single message.
- Added `handedOff(prNumber, approvalDismissed, summary)`: threads `pr_number` + `approval_dismissed`
  through `result.data` so the **pure** `next` can still select the "my cleanup commit dismissed your
  approval" variant — a nuance only `run` knows, which the naive fix would have dropped (plan F2).
- `merged` / `auto_merge_disabled` deliberately **stay `done`** — those are genuine hand-offs (the PR is
  merged, or the owner turned auto-merge off). Criterion 10 is scoped to the host-blocked case.

### 3. `src/core/daemon/pr-event-poller.ts`
- `escalateMergeBlocked` takes its category and message from the shared module — dropping the
  hand-written *"and I'll merge it"*, a promise the Engineer cannot always keep.
- Still writes the block directly (the poller is not in the pipeline, so it cannot call `blockTask`) and
  still sends its own `alert` + `ticket_comment`, now with the shared text. Both paths therefore reach the
  same two surfaces (chat + ticket) with the same words.
- The `/approve` + `checks_state === "passing"` gate is **untouched** (plan F3 — see the new guard below).

### 4. `src/plugins/git-hosting/github-hosting/github-hosting.ts` — criterion 13 (owner-optional)
- `mapMergeState` denylist → **allowlist**: `clean | unstable | has_hooks | behind → mergeable`;
  `unknown` / absent → `unknown` (wait, never merge on an unverified state); **everything else** —
  `blocked`, `draft`, any state GitHub adds later → `blocked` (hand off).
- Rationale: a doomed merge attempt is *not* free even post-fix — it first pushes a thoughts-cleanup commit
  that can dismiss a formal approval. Never attempting a merge on a state we cannot vouch for is the
  fail-safe direction.
- `behind` stays `mergeable` — no behavior change (an out-of-date branch is not a conflict).
- Doc updated at its **source** (`docs/plugins/git-hosting/github-hosting.md`) and re-bundled via
  `pnpm docs:bundle` — see "What I got wrong" below.

## Deviations from the plan

**None in substance.** Two things worth recording:

1. **Message signature.** The plan had `hostBlockedMergeNeeded(prNumber: number, ...)`. `next` is pure and
   its `data` is typed `Record<string, unknown>`, so `pr_number` is *optionally* present at the type level.
   Rather than fake a `?? 0`, the parameter is `number | null` and the message reads "The pull request"
   when absent. Total, honest, no sentinel.
2. **Poller notification text.** The plan left the `alert`/`ticket_comment` wording open; both now carry the
   shared message verbatim. One event, one set of words, on every surface.

## What I got wrong, and caught

- **I edited the generated bundle, not its source.** `src/cli/bundled/plugin-docs.ts` is generated from
  `docs/plugins/**` by `pnpm docs:bundle`, and a test asserts the two match. `test:all` caught it (1 failing
  test). Fixed by editing the markdown source and re-running the bundler — which is the correct workflow and
  why that test exists.
- **The allowlist broke two test fixtures** that set `mergeable: true` with **no** `mergeable_state`. I did
  **not** weaken the mapping to make them pass: real GitHub *always* returns `mergeable_state` alongside a
  non-null `mergeable`, so the fixtures were simply unfaithful to the API. Made them realistic
  (`mergeable_state: "clean"`) instead. Weakening the mapping to satisfy an unrealistic mock would have
  re-opened the exact hole this change closes.

## Verification

Beyond the gates, I **mutation-tested the new guard**: reverting `autoMergeNext`'s `needs_human_merge` case
back to `{ go: "done" }` makes the coherence test fail on exactly the two assertions that matter (same
contract; no false completion), and pass again when restored. A test that still passes when the behavior it
covers is deleted proves nothing — this one bites.

Gates: `pnpm test:all` (2837 unit + 67 integration + 16 e2e, all green) · `pnpm run lint` ·
`pnpm run typecheck` · `pnpm run check:exports` — all exit 0.

## Regression guards added

| Guard | Where | Protects |
|---|---|---|
| **Coherence** — both paths driven on the same `blocked` status land on the same (state, reason, category) + the **identical** message | `tests/unit/core/host-blocked-merge-contract.test.ts` (new) | Criteria 9, 12. Fails if the contract re-splits or the messages drift. |
| **No false completion** — `needs_human_merge` never yields `{go:"done"}` | same file | Criterion 10 — and transitively that "Task completed successfully." cannot fire on an unmerged PR. |
| **No rework on a blocked merge** — neither path routes to `execution` | same file | Criterion 1 (the original infinite loop). |
| **Honest message** — never an unconditional "I'll merge it"; always "if the host lets me" + "otherwise merge it yourself" | same file | Criterion 11. |
| **Normal review wait untouched** — a `blocked` PR with **no** authorized `/approve` produces no escalation and no promotion; its comments still rework | `pr-event-poller.test.ts` (new) | The dangerous false positive (plan F3): a PR *awaiting* its required review reports `blocked` too — escalating on `blocked` alone would break the highest-traffic path in the system. |
| **Genuine merge still merges** | `auto-merge.test.ts` + the `mapMergeState` per-state matrix | Criterion 5 (most at risk from the allowlist). |
| **Genuine conflict still reworks** | `auto-merge.test.ts` (`conflicting → jump execution`) | Criterion 7 — the new rule must not swallow real conflicts. |
| **Loop cannot re-form** | `pr-event-poller.test.ts` (existing, kept green) | Criterion 3. |

## Known, deliberate, and recorded

- **`sub_phase` differs by path** ("await-review" vs "auto-merge") — each names where the task genuinely
  *is*, and both resume routes end in the same place (re-check, then merge if the host now allows it).
  Forcing one string for cosmetic symmetry would make the dashboard lie. Criterion 9's "same state" is met
  on the routing-relevant tuple (state, reason, category) + the same message.
- **The self-unblock re-check cycle** (plan F5): `awaiting_human` is eligible for the 8h
  `evaluate_self_unblock`. If it ever answers "resolvable", the task re-checks and re-blocks, restarting the
  escalation ladder. Accepted deliberately — each lap costs one status re-check, **no rework and no branch
  push**, and if the owner has approved on the host in the meantime that lap **merges the PR**, which is
  precisely the "wait and re-check" the issue asked for. This is also today's existing poller behavior, not
  something new introduced here. Recorded as a follow-up candidate, not smuggled in.
- **Out of scope, not closed:** the third path (a *formally* approved + green + host-blocked PR with no
  `/approve` comment emits no event, so it waits with a misleading "waiting for review" reminder). It does
  not loop and does not rework — mild harm — and closing it means escalating on `blocked` from a state where
  `blocked` is *also* the normal "awaiting required review" condition, risking the highest-traffic path to
  fix a rare benign one. Deserves its own ticket. Issue #46 (CI debounce) also remains out of scope.
