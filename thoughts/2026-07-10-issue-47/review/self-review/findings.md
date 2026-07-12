# Self-Review — Issue #47: Host-blocked merge loops into rework

Date: 2026-07-09
Reviewer pass: self-review (holistic last look)
Verdict: **Clean — ship it.** No blocking findings.

## What I reviewed

- Full `git diff main` across all 10 non-thoughts files (contract, plugin, two Core files, docs, bundle, 3 tests).
- Requirements, plan, and execution reports, walked against the diff.
- Ran the three affected unit suites live: **121 passed / 121** (pr-event-poller 20, auto-merge 25, github-hosting 76).
- Working tree clean except my own `thoughts/…/review/` folder; commit history is two clean commits (code + thoughts trail). No stray files, no debug logging, no leftover scaffolding.

## Does it do what was asked? — all 8 acceptance criteria walked against the code

1. **Host-won't-complete merge never reworks** — ✔ Three independent guards: `decideReadiness` diverts `blocked → needs_human_merge` *before* any `mergePR` (auto-merge.ts:224); the poller escalates instead of promoting (pr-event-poller.ts:159); `derivePrEvents` withholds both `pr_ready_to_merge` and `pr_merge_conflict` for a blocked PR (test at github-hosting.test.ts:729).
2. **Unhonored `/approve` surfaced with actionable reason** — ✔ `escalateMergeBlocked` blocks under `need_more_info`/`awaiting_human`, records a decision, and sends `alert` + `ticket_comment` with a concrete "approve on the host, then `engineer retry`" message.
3. **Re-entry path bounded** — ✔ Structural, not a counter: the escalation moves the task off the `pr_review_pending` poll set, so the next poll's `getBlockedTasksByReason(pr_review_pending)` no longer returns it. `pending_pr_event` is also cleared defensively. The auto-merge backstop routes to `done`. The dedicated loop-bound test confirms a second poll does nothing.
4. **Real host signal, not just boolean `mergeable`** — ✔ Plugin now reads `pr.mergeable_state` (already on the same `pulls.get` response — no extra API call) and maps the exact `"blocked"` string to the new contract value.
5. **Genuine merge unchanged** — ✔ Ordering in `mapMergeState` preserves `true → mergeable` for `clean`/`unstable`/`has_hooks`/`behind`; regression tests re-assert. Verified by deletion-sensitivity: removing the blocked branch makes the auto-merge test's `mergePR not called` fail, so the test exercises the real path.
6. **Plugin/Core boundary honored** — ✔ `mergeable_state` is read only inside the GitHub plugin; Core switches solely on the contract `merge_state` string. A second hosting plugin inherits the safety by returning `"blocked"`.
7. **Genuine conflict still reworks** — ✔ `mergeable === false → conflicting` is checked before the blocked branch and is unchanged; `conflicting → merge_conflict → execution` rework intact; regression test retained.
8. **Tests + gates** — ✔ New tests at all three seams; the 121 I ran pass; execution reports full `typecheck`/`lint`/`test:all`/`check:exports` green. #46 (CI debounce) correctly left out of scope.

## Does it earn its keep?

Yes. The change is minimal for what it accomplishes.
- The **two escalation sites** (poller front line + auto-merge race backstop) are genuine defense-in-depth, not duplication — different triggers (a live `/approve` vs. a detect→merge race), one shared contract value. The plan justified this (D5) and it holds up.
- No new config knob, no new `BlockCategory`, no new `PrEvent` type, no new counter — the fix reuses the existing `awaiting_human`/`need_more_info` block ladder and the proven `needs_human_merge → done` hand-off. This is the smaller-than-the-first-draft shape.
- `mapMergeState`'s ordering carries real structural meaning (the "blocked reports mergeable === true" trap) and the doc comment names it — cut noise, not this.

## Would it surprise the next reader?

No. Names say what they mean (`resolveApproveDisposition`, `escalate_blocked`, `escalateMergeBlocked`). The tri-state refactor of `shouldPromoteApproval` reads cleanly and is documented. Comments explain the non-obvious ordering and the `false` argument to `notifyHostBlockedMerge` (no cleanup push happened in the readiness path). Consistent with the surrounding `escalateBlockerCap` pattern it mirrors.

## Non-blocking observations (recorded, not defects)

- **Escalation message wording vs. block cause.** The owner-facing message says the block "needs a formal review approval a `/approve` comment cannot provide." `mergeable_state === "blocked"` *can* also arise from a required status check rather than a required review. The `checks_state === "passing"` gate makes the required-review case by far the most likely, and the message's fallback ("or adjust its branch protection") plus the correct routing (escalate, never loop) hold regardless of the precise cause. Not worth widening now; noting for awareness.
- **Formally-approved-but-blocked PR waits silently.** A PR with a *formal* approval that is nonetheless `blocked` emits no events (derivePrEvents → `[]`) and no `/approve` comment, so it neither escalates nor reworks — it simply waits in the poll set. This is correct per the requirements ("waits … or escalates") and is a pre-existing, out-of-scope edge (the ticket is specifically about the `/approve` comment path). No regression.

## Bottom line

Correct, complete against every criterion, appropriately small, well-named, and covered by deletion-sensitive tests. Nothing to send back.

---
---

# Re-run pass — 2026-07-11: the reconciliation (criteria 9–13)

Reviewer pass: self-review (holistic last look) over the **reconciliation** commits — `fbc45df` (one contract,
both paths) and `d70304e` (the `mapMergeState` allowlist), on top of the pass-1 loop fix `8a5d87f`.

Verdict: **the change is correct, complete, and earns its keep — two test-quality findings, no behavior defects.**

## What I reviewed (and what I ran, not assumed)

- Full `git diff main...HEAD` across all 12 non-thoughts files: the new contract module, the two Core paths,
  the plugin mapping, the adapter enum, docs + regenerated bundle, and 4 test files.
- I did **not** trust the trail on the load-bearing claims. I read the mechanisms myself:
  - `blockTask` → `deliverBlockedQuestion` (`orchestrator/index.ts:456–476`, `outreach.ts:44–59`) — confirms
    the `awaiting_human` block **does** post a ticket comment + a chat question, so deleting
    `notifyHostBlockedMerge` loses no owner-facing message and avoids the double-message (plan F1). Verified
    auto-merge writes no outreach files, so `consumeOutreach` returns null and `needed` is the delivered text.
  - `response-poller.ts:181` — resumption is keyed on `blocked.reason !== pr_review_pending`, **not** on the
    notification kind. So the two paths' differing kinds (poller `alert` vs. block-delivery `question`) are
    presentational only: both land `need_more_info`, so both are equally resumable by an owner reply. **Not a
    coherence gap** — I chased this specifically because it looked like one.
  - Every `merge_state` consumer in `src/` (grep) — 4 files, all handled; no exhaustive switch broken by the
    new enum value; no dashboard/reaper consumer left behind.
- **Gates, run by me on the branch head:** `typecheck` ✔ · `lint` ✔ (biome + tsc + knip + madge, no cycles) ·
  `test:unit` **2837 passed** ✔ · `test:integration` 67 ✔ · `test:e2e` 16 ✔. All exit 0.
- **What ships:** 12 source/doc/test files, nothing else. No stray files, no generated-output drift (bundle
  regenerated from source, as the drift test demands), no debug logging, no `.only`/`.skip`, no dangling
  reference to the deleted `notifyHostBlockedMerge`. Commit history is clean.

## Criteria 9–13, walked against the code

9. **One contract, both paths** — ✔ Both resolve `merge_state === "blocked"` to `awaiting_human` (⇒
   `need_more_info`) and to the *identical* message string from the shared module.
   `host-blocked-merge-contract.test.ts` drives **both** paths on the same `PRStatus` and asserts the same
   category and `toBe(message)` — identity, not similarity. The `sub_phase` asymmetry (`await-review` vs
   `auto-merge`) is correct: each names where the task genuinely is, and both resumes converge on the merge.
10. **No false "completed"** — ✔ `autoMergeNext` now has an explicit `case "needs_human_merge"` → `{go:"block"}`
    before the `default → done`. Asserted directly (`route.go).not.toBe("done")`). `merged` /
    `auto_merge_disabled` correctly *stay* `done` — genuine hand-offs, not scope creep.
11. **Honest message** — ✔ The unconditional "I'll merge it" is gone; the wording holds in both worlds ("if the
    host lets me" / "otherwise merge it yourself"), and both variants (plain + approval-dismissed) are asserted.
    I checked the promise against what retry actually does on each path — it is true on both.
12. **Coherence regression test** — ✔ Exists, and it bites (execution mutation-tested it; the assertions are
    behavioral, not snapshot).
13. **(Optional) allowlist** — ✔ Done, and covered by a 9-case per-state matrix. The fail-safe direction is
    right: a merge attempt is not free (it pushes a cleanup commit that can dismiss an approval), so an
    unrecognized state hands off rather than gambling. `behind` correctly stays `mergeable` — no regression.

Criteria 1–8 (pass 1) re-verified as still intact: genuine merge merges, genuine conflict still reworks, the
plugin/Core boundary holds (`mergeable_state` is read only inside the plugin; Core switches on the contract).

## Does it earn its keep?

Yes — I pushed on each new piece and each survived:

- **`host-blocked-merge.ts` (a new file for one const + one function).** This is the shape that usually
  *fails* the "earn its keep" test. It passes: the two callers live in different layers (daemon vs. pipeline),
  so homing the contract in either would drag that layer's deps across the boundary — and message drift
  between two copies is *literally how this bug was born*. It is the anti-drift mechanism, not a wrapper.
  Keep.
- **`handedOff()` beside `resolved()`.** Not a forwarder — it carries `pr_number` + `approval_dismissed`,
  the two facts only the impure `run` knows and the pure `next` needs to word the message. Without it the
  "your approval was dismissed" nuance is silently lost (plan F2). Earns it.
- **`prNumber: number | null` in `hostBlockedMergeNeeded`.** The null arm looks like defensive code for an
  impossible state — but `RoutableResult.data` is `Record<string, unknown>`, so `next` genuinely cannot prove
  the field is present. A total function beats a `?? 0` sentinel. Keep.
- **Deleting `notifyHostBlockedMerge` rather than keeping it "just in case"** is the right cut — verified
  above that the block's own delivery covers both surfaces.

## Would it surprise the next reader?

No. Names say what they mean. The module header explains *why* the contract is blocked-resumable and not
`done`, which is exactly the reasoning a future reader would otherwise "simplify" away. Consistent with the
`escalateBlockerCap` pattern it mirrors.

---

## Finding 1 — the loop-bound test is vacuous: it passes with the entire escalation deleted

**File:** `tests/unit/core/daemon/pr-event-poller.test.ts` — `it("cannot re-form the loop — once escalated,
the task leaves the poll set and a later poll does nothing")` (the third test added in the `/approve` block).

**The defect.** The test calls `getBlockedTasksByReason.mockReturnValueOnce([])` and then polls **once**:

```js
getBlockedTasksByReason.mockReturnValueOnce([]);
await poller.poll();
expect(requestTransition).not.toHaveBeenCalled();
expect(notify).not.toHaveBeenCalled();
```

`poll()` starts with `const tasks = prefetched ?? taskEngine.getBlockedTasksByReason(...)` and returns
immediately at `if (tasks.length === 0)` (`pr-event-poller.ts:63–66`). The single poll therefore gets an
**empty task list and exits before touching any escalation code** — the `events: [approve()]` and
`prStatus: { merge_state: "blocked" }` fixtures are never consulted. Both assertions are trivially true for
an empty list. There is no "first poll" and no "later poll"; there is one poll over nothing.

**Why it matters.** This is the *only* test claiming to guard **acceptance criterion 3** — the previously
unbounded `pr_ready_to_merge` re-entry path, which is the headline of issue #47. It would stay green if
`escalateMergeBlocked` were deleted, if the blocked PR were promoted again, if the loop came back wholesale.
It is precisely the "test that still passes when the code it covers is deleted" anti-pattern, sitting on the
issue's most important invariant. To be clear about severity: **the behavior is correct** — the bound is
structural (`need_more_info ≠ pr_review_pending`) and the sibling test asserts the written reason — so this
is false confidence, not a live bug. But a guard that cannot fail is not a guard.

**Concrete fix** — make it a genuine two-poll test that proves the escalation happens exactly once:

```js
const { poller, requestTransition, updateTaskField, getBlockedTasksByReason } = setup({
  events: [approve()],
  prStatus: { merge_state: "blocked" },
});
const blockWrites = () => updateTaskField.mock.calls.filter((call) => call[1] === "blocked");

await poller.poll();                              // first poll: escalates
expect(blockWrites()).toHaveLength(1);

// The escalation wrote reason `need_more_info`, so the daemon's pr_review_pending re-query no longer
// returns this task — model that, and confirm no second escalation and no promotion can form.
getBlockedTasksByReason.mockReturnValue([]);
await poller.poll();                              // second poll: nothing to act on

expect(blockWrites()).toHaveLength(1);            // not re-escalated
expect(requestTransition).not.toHaveBeenCalled(); // and never promoted to pr_ready_to_merge
```

Stronger still (and closer to what the test *claims*): make `setup`'s `getBlockedTasksByReason` fake filter on
the `blocked.reason` the poller actually wrote, so the test proves *the write itself* removes the task from
the poll set, instead of asserting that by fiat.

---

## Finding 2 — the coherence chain has one unasserted link: `awaiting_human ⇒ need_more_info`

**File:** `tests/unit/core/host-blocked-merge-contract.test.ts:181–187` (and the same shape duplicated at
`tests/unit/core/daemon/pr-event-poller.test.ts`, `expect(BlockCategories.awaiting_human).toBe(HOST_BLOCKED_MERGE_CATEGORY)`).

**The defect.** The test reads:

```js
expect(HOST_BLOCKED_MERGE_CATEGORY).toBe(BlockCategories.awaiting_human);
```

That restates the constant's own one-line definition — it cannot fail except by someone editing the constant,
in which case they would edit this line too. Meanwhile its comment claims it proves *"awaiting_human ⇒
need_more_info ⇒ off the PR-event poll set"* — and that `⇒ need_more_info` link, which is the **entire
loop-safety argument on the auto-merge path**, is never exercised. The poller path is safe here because it
writes `reason: need_more_info` literally and the test asserts it. The auto-merge path does **not**: it
returns only a *category*, and the reason is derived by `toBlockReason()` (`orchestrator/index.ts:85–97`),
which no test in this change touches. If `toBlockReason` ever mapped `awaiting_human → pr_review_pending`, the
auto-merge path would silently rejoin the review-poll set — the loop returns — with every test still green.

The plan called for exactly this assertion (§32 Step 4: *"and `toBlockReason(awaiting_human) === need_more_info`"*).
It was dropped in execution, almost certainly because `toBlockReason` is not exported.

**Honest severity:** low. `toBlockReason` is shared by every `needs_human` block in the pipeline, so changing
it would break plenty of other tests first. This is about closing the one link in the chain that nothing
checks — not about a likely regression.

**Concrete fix.** Export `toBlockReason` from `src/core/orchestrator/index.ts` (it is a pure 12-line mapper;
exporting it is harmless and it is arguably schema-level anyway), then replace the tautology with the
behavioral assertion:

```js
expect(toBlockReason(HOST_BLOCKED_MERGE_CATEGORY)).toBe(BlockReasons.need_more_info);
expect(toBlockReason(HOST_BLOCKED_MERGE_CATEGORY)).not.toBe(BlockReasons.pr_review_pending);
```

That is the assertion the comment already promises, and it makes the auto-merge path's loop-safety
non-regressable. If exporting is unwanted, delete the tautology rather than keep a guard that cannot fail.

---

## Non-blocking observations (recorded, not defects — do not "fix")

- **The self-unblock re-check cycle (plan F5)** is real but correctly accepted: each lap costs one
  `getPRStatus`, **no agent rework and no branch push**, and a lap after the owner approves *merges the PR*.
  That is the "wait and re-check" the issue asked for. Documented in the plan and execution; not smuggled in.
- **The poller sends `alert` + `ticket_comment`; the auto-merge block sends `ticket_comment` + `question`.**
  I chased this as a possible criterion-9 gap and it is not one (see `response-poller.ts:181` above): both
  paths land the same lifecycle state and the same text on the same two surfaces. Leave it.
- **The negative assertion `not.toMatch(/resume and I'll merge it\b/i)`** is pinned to the *old* wording, so a
  differently-phrased dishonest promise would slip past it. The positive assertions in the same loop
  (`/if the host lets me/`, `/merge it yourself/`) are the real guard and they hold. Not worth churn.

## Bottom line

The reconciliation is right, and it is right for the right reasons — the contract is single-sourced, the
lifecycle is honest, the message is honest, and the boundary holds. Both findings are **test-quality**, not
behavior: the shipped code does what criteria 9–13 ask. Finding 1 is worth fixing before merge — it is a
dead guard standing exactly where the issue's headline invariant needs a live one.
