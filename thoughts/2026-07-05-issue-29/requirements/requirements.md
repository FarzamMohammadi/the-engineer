# Requirements — Issue #29: Transient PR check-status lookup errors misread as CI failures

_Phase: requirements · Source: github_issue FarzamMohammadi/the-engineer#29 · Date: 2026-07-05_

## Context Summary

**What this task is asking (in my words).** When The Engineer polls an open PR, the GitHub
hosting plugin resolves the PR's CI/check status. That resolution (`getChecksState`) wraps two
GitHub API calls in a single `try/catch`; on **any** error it returns `checks_state: "failing"` as a
"pessimistic fallback". That fallback conflates two genuinely different things:

- **"CI failed"** — we successfully checked, and the checks are red.
- **"We couldn't check CI"** — the *lookup itself* errored (network blip, `ECONNRESET`, dropped
  connection, rate-limit), so the CI state is genuinely *unknown*.

Today both collapse to `"failing"`, so a transient lookup error derives a `pr_ci_failure` event,
which re-enters the task into a full rework cycle (dismiss review → re-execute → review → re-push →
notify) to "fix" a failure that never existed. The owner wants a transient lookup error treated as a
distinct **`unknown`** state on which the engine takes **no action** — don't rework, don't
auto-merge, just leave the task waiting and re-check next poll — while preserving the original safety
property that the engine never claims CI is *passing* on unverified data (so it never auto-merges
unverified code).

**Stated vs. reconstructed.** The owner stated a great deal directly and precisely: the symptom, the
live evidence (PR #28), the root cause (the failing/unknown conflation), the exact desired end-state
(`unknown` state, no action on unknown, wait-and-recheck), and the safety property to preserve.
The owner also **explicitly delegated** one sub-decision to this work: *"whether a failure signal
should require brief confirmation (a re-check / small retry) before it drives a real rework at all …
Decide the exact policy as part of the work."* The only things I reconstructed from the code (all
verifiable facts, not guesses about intent) are the precise call sites that must change and one
**latent safety bug** that adding `unknown` exposes in `auto-merge.ts` (detailed below). This is an
unusually well-specified task; the owner even pointed at the relevant code ("the hosting plugin's
CI-state resolution and the PR-event poller").

**Sufficiency verdict.** The expressed end-state is concrete and checkable, and the one open
sub-policy is explicitly the engineer's to decide. I would stake the build on the acceptance criteria
below. → `ok`.

## The System As It Is Today (verified in code)

The CI-state contract is `checks_state: z.enum(["passing", "failing", "pending", "none"])`
(`src/schemas/adapters.ts:410`). There is **no `unknown`** value — unlike its sibling `merge_state`,
which is already `z.enum(["mergeable", "conflicting", "unknown"])` (line 409) and whose `unknown`
means "the host hasn't finished computing it — wait, don't act." **This exact pattern is the
precedent the issue asks me to mirror for `checks_state`.**

Trace of the bug (all confirmed):

1. `getChecksState` (`github-hosting.ts:556-587`) runs `Promise.all([getCombinedStatusForRef,
   checks.listForRef])`. On any rejection the `catch` logs *"Checks-state lookup failed — reporting
   CI as failing"* and returns `"failing"` (line 580-586). The local type is
   `type ChecksState = "passing" | "failing" | "pending" | "none"` (line 547).
2. `doGetPRStatus` (line 198) puts that into `PRStatus.checks_state`.
3. `derivePrEvents` (line 488): `if (status.checks_state === "failing") → push pr_ci_failure`.
4. The PR-event poller (`pr-event-poller.ts`) arbitrates, and `pr_ci_failure` is an "automated
   blocker" → `routeBlockerEvent` → re-enter at execution → **the phantom rework cycle.**

Every consumer of `checks_state` (audited — all are `if` comparisons, **no exhaustive `switch`**, so
adding an enum value won't break the build via exhaustiveness, but each must be checked for correct
`unknown` handling):

| Consumer | File:line | Behavior with a new `unknown` value | Action needed |
|---|---|---|---|
| `derivePrEvents` red-check branch | `github-hosting.ts:488` (`=== "failing"`) | `unknown` ≠ failing → **no `pr_ci_failure`** | ✅ correct by falling through |
| `derivePrEvents` ready-to-merge branch | `github-hosting.ts:504` (`=== "passing"`) | `unknown` ≠ passing → **no `pr_ready_to_merge`** | ✅ correct by falling through |
| `shouldPromoteApproval` (`/approve` path) | `pr-event-poller.ts:204` (`=== "passing"`) | `unknown` ≠ passing → **won't promote**, task keeps waiting | ✅ correct by falling through |
| `decideReadiness` (auto-merge) | `auto-merge.ts:190-214` | `unknown` matches **none** of failing/pending/conflicting/unknown-merge → **falls through to `return { disposition: "merge" }`** | ❌ **BUG — would auto-merge on unverified CI**, violating the exact safety property the owner wants preserved. Must add an `unknown → retry_wait` branch. |

The `auto-merge.ts` gap is the single non-obvious, must-fix consequence. `runAutoMerge` calls
`hosting.getPRStatus` directly (`auto-merge.ts:123`), so its own live re-check can hit the same
transient error and return `checks_state: "unknown"`; the current `decideReadiness` would then
proceed to merge. Fixing it is not scope-expansion — it is *required* to honor the owner's stated
safety property. (`merge_state === "unknown"` is already handled at line 206 → `retry_wait`; the CI
`unknown` needs the symmetric branch.)

## Probing To The Edges

**"Lookup error" — what counts?** `getChecksState` does a `Promise.all` of two calls; a rejection of
*either* rejects the whole thing today. Reading any error from the check-status lookup as `unknown`
is faithful to the issue ("the *lookup* that failed"). Whether a *partial* success (one API answers,
the other errors) could yield a real answer instead of `unknown` is a refinement inside the delegated
"decide the exact policy" space — the safe default (any lookup error → `unknown`) satisfies the
requirement and I treat richer partial handling as optional, planning's call.

**A separate, already-safe failure path.** The poller's outer `detectPrEvents` call is already
wrapped (`pr-event-poller.ts:109-115`): if the whole detect throws, it logs, ticks the
`recentFailures` window, and returns with **no** rework. So a *total* detect failure was never the
bug. The bug is specifically that `getChecksState`'s *internal* catch turns a checks-only lookup blip
into a **successful** `PRStatus` carrying `checks_state: "failing"`. Note a side effect of the fix:
once `getChecksState` returns `unknown` instead of throwing, a checks-lookup blip no longer ticks the
poller's failure window — which is desirable (a check blip shouldn't pause all polling), but worth
stating.

**Persistent unknown → indefinite wait?** If the check lookup keeps failing, the task waits forever,
re-checking each poll, with no escalation. The issue explicitly prescribes this: *"leave the task
waiting and re-check on the next poll."* So indefinite wait-and-recheck is the **accepted** behavior,
not a gap. Adding escalation-on-persistent-unknown would exceed the stated want; if planning wants
observability here it lives inside the delegated policy space. Not a requirements blocker.

**Scenario A (the reported bug).** CI green → 27 min later a poll hits `ECONNRESET` fetching checks →
today: `checks_state = "failing"` → `pr_ci_failure` → rework. **After:** `checks_state = "unknown"` →
no event → task stays in `blocked(pr_review_pending)` → next poll re-reads real (green) state →
proceeds normally. ✅

**Scenario B (real red CI).** A check genuinely fails → lookup succeeds → `checks_state = "failing"`
→ `pr_ci_failure` → rework, exactly as today (modulo the delegated confirmation policy). Must remain
unchanged. ✅

**Scenario C (auto-merge re-check blips).** Task is `pr_ready_to_merge`; `auto-merge`'s live
re-check hits a transient error → `checks_state = "unknown"`. Today (post-enum-change, pre-fix) it
would **merge unverified code**. Required: `unknown → retry_wait` (return to the review wait, retry
next poll). ✅ preserves "never auto-merge on unverified status."

## Acceptance Criteria

1. The `checks_state` contract (`PRStatusSchema` in `src/schemas/adapters.ts`) gains a distinct
   `"unknown"` value alongside `passing | failing | pending | none`, meaning "the CI status could not
   be determined." The `ChecksState` local type in `github-hosting.ts` is updated to match.
2. When the check-status lookup errors (network blip / `ECONNRESET` / dropped connection /
   rate-limit / any failure of the status or checks API call), `getPRStatus` returns
   `checks_state: "unknown"` — **never** `"failing"`.
3. On `checks_state === "unknown"`, **no `pr_ci_failure` event is derived** (`derivePrEvents` emits
   nothing for it), so the task is not re-entered into rework.
4. On `checks_state === "unknown"`, the PR is **never auto-merged and never promoted to
   ready-to-merge**: `auto-merge`'s readiness treats `unknown` as wait-and-retry (not `merge`), and
   the `/approve` promotion path does not promote on `unknown`. (Preserves "never auto-merge on
   unverified status.")
5. On `checks_state === "unknown"`, the task simply stays waiting (`blocked(pr_review_pending)`) and
   is re-checked on the next poll — no rework notice, no approval dismissal, no re-push, no phantom
   `pr_ci_failure` notification.
6. Genuine `failing` and `passing` behavior is preserved: a real red check still routes to rework
   (subject to criterion 8's resolved policy); a real green + approved + mergeable PR still merges.
7. Every existing consumer of `checks_state` is audited and handles `unknown` safely — no consumer
   treats `unknown` as passing (→ merge) or as failing (→ rework). (Specifically covers the
   `auto-merge.ts:decideReadiness` fall-through fix.)
8. The owner-delegated confirmation policy is resolved and documented during design: whether a
   *genuine* `failing` reading is confirmed by a re-check / small retry before it drives rework.
   **Whichever policy is chosen, a single transient/flaky reading never triggers a rework cycle,** and
   the resolved policy is recorded (decision log + doc/code comment) so a reviewer can see what was
   decided and why.
9. Documentation describing `checks_state` is updated to include `unknown`:
   `docs/plugins/git-hosting/README.md` (the `PRStatus` type block, ~line 92) and
   `docs/plugins/git-hosting/github-hosting.md` (event-detection description). The generated bundle
   `src/cli/bundled/plugin-docs.ts` is regenerated via `pnpm run docs:bundle` (CI fails on drift —
   it is auto-generated, never hand-edited).
10. A regression test proves the fix: a transient check-status lookup error yields
    `checks_state: "unknown"` and produces **no `pr_ci_failure` event and no merge** — exercising the
    real error path (not a default that masks whether the change ran). Existing check-state tests
    (`tests/unit/plugins/git-hosting/github-hosting/github-hosting.test.ts`), the `derivePrEvents`
    tests, and the `auto-merge`/poller tests are updated/extended as needed.
11. The project's own gates pass: `pnpm run typecheck`, `pnpm run lint`, `pnpm test` (unit), and
    `pnpm run test:integration`.

## Source Of Each Requirement (the intake decision)

| Requirement | Source | Basis |
|---|---|---|
| Introduce distinct `unknown` checks state | **Owner expressed** | *"Treat a check-status lookup error as **unknown** — a state distinct from both passing and failing."* |
| Lookup error → `unknown`, not `failing` | **Owner expressed** | The stated root cause + *"a momentary network error should not drive a rework."* |
| No action on `unknown` (no rework, no auto-merge, wait & re-check) | **Owner expressed** | *"On unknown, the engine should take no action … just leave the task waiting and re-check on the next poll."* |
| Preserve "never auto-merge on unverified status" | **Owner expressed** | *"This preserves the original safety property (never auto-merge on unverified status)."* |
| Fix `auto-merge.ts` `decideReadiness` fall-through so `unknown ≠ merge` | **Researchable fact** (derived from the expressed safety property) | Verified in code: `unknown` currently falls through to `disposition: "merge"`. This is the concrete site where the owner's stated safety property would otherwise break. No intent guessed. |
| Audit all `checks_state` consumers | **Researchable fact** | Enumerated the 5 call sites directly from `grep`. |
| Update docs + regenerate bundle | **Researchable fact** | The doc files and the generated-bundle mechanism (`gen-bundled-docs.ts`, "CI fails on drift") verified in-repo. |
| Confirmation-before-rework policy for *genuine* failures | **Owner expressed (explicit delegation)** | *"Worth considering during design … Decide the exact policy as part of the work."* The owner handed this decision to the work; re-asking would re-ask an answered question. Planning owns it. |

No requirement rests on an un-delegated inference. The one design decision the owner floated is
**explicitly delegated**, so it is recorded for planning rather than blocked on. Nothing in the third
("inferred") bucket survives — the sole code-derived requirement (the `auto-merge` fix) is an
objective fact about what breaks the owner's stated safety property, not a guess about intent.

## Why This Is `ok` And Not `needs_human`

The deciding end-state is owner-expressed and concrete; the one open sub-policy is owner-delegated by
explicit instruction. I looked for a genuine fork where the owner's input would make the work *more
right* and found none that isn't already answered: the state name (`unknown`) is given and mirrors
`merge_state`; the "no action" behavior is spelled out; the safety property is stated; the
confirmation policy is delegated ("decide as part of the work"). Asking "unknown-only, or also add
confirmation?" would re-ask a decision the owner deliberately handed over — the opposite of helpful.

## Notes / Signposts For Later Phases (not blockers)

- **Latent safety bug is the sharpest edge:** `auto-merge.ts:decideReadiness` must gain an
  `unknown → retry_wait` branch, or the enum change silently enables merging on unverified CI.
- **Mirror the existing precedent:** `merge_state`'s `unknown` handling (`auto-merge.ts:206`,
  `github-hosting.ts` `mapMergeState`, the "definitive conflict only" comment at `github-hosting.ts:491`)
  is the established design to copy for symmetry and reviewer familiarity.
- **Generated docs:** after editing `docs/plugins/git-hosting/*.md`, run `pnpm run docs:bundle` to
  refresh `src/cli/bundled/plugin-docs.ts` or lint/CI will fail on drift.
- **Confirmation policy (delegated):** the minimal fix (Scenario A) already resolves the reported
  bug; the confirmation-before-rework idea is an *additional* robustness lever for *genuine* failure
  readings. Planning should decide and record whether to include it and its exact shape (re-check
  next poll vs. small in-lookup retry), keeping the payload/architecture consistent with the existing
  stateless-poller design.
- **Contract-surface awareness:** `checks_state` is part of the `GitHostingAdapter` contract other
  hosting plugins implement; the change is *additive* (a new enum member) and the only in-repo
  implementer is `GitHubHostingPlugin`, but the contract/docs are the public shape.
