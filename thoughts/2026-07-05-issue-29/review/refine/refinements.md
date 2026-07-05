# Refine — Issue #29: Transient PR check-status lookup errors misread as CI failures

_Phase: review · refine (final quality gate) · Date: 2026-07-05_

## Verdict: **ship**

The change is correct, complete, clean, and every project gate passes on my own independent
re-run. The one review lens that ran (self-review) found nothing; I did not take that on faith —
I re-derived the correctness- and completeness-critical claims from the source and re-ran all
gates myself. No code fixes were required.

---

## Pass 1 (2026-07-05)

### 1. Findings consolidation

Lenses that ran: **self-review** (1). Its verdict was "clean — ship it," zero findings. There were
no other lenses' findings to group or dedupe. Rather than rubber-stamp a no-findings review, I
treated "assume issues exist until proven otherwise" as the job and independently verified the
change below. Nothing survived that would change the code.

### 2. Independent verification (below the surface, not a re-read of the lens)

**Scope is exactly issue #29.** Local `main` is stale (`6252bfb`, 7 commits behind
`origin/main` = `ccb7e56`), so `git diff main...HEAD` is misleading. The true shipping diff is
`git diff ccb7e56..HEAD` — **18 files**: 3 production (`schemas/adapters.ts`,
`github-hosting.ts`, `auto-merge.ts`), 3 docs+bundle, 4 test files, and the `thoughts/` trail.
Working tree is clean apart from this `review/` deliverable. No stray files, no debug logging,
no scaffolding.

**The fix's two load-bearing claims — verified from source, not assumed:**

- **No partial salvage.** `getChecksState` (`github-hosting.ts:563-589`) wraps both API calls in a
  single `Promise.all`; any rejection lands in the `catch`, which returns `"unknown"` directly.
  A partial failure therefore never salvages the other source's answer — it cannot claim `passing`
  on an unverified lookup. ✔
- **`combineCheckStates`'s `unknown: 0` is genuinely unreachable.** I read both producers:
  `resolveStatusApiState` (592-604) yields only `none|passing|pending|failing`, and
  `resolveChecksApiState` (606-632) yields only `none|passing|pending|failing`. Neither can emit
  `unknown`, and the `catch` returns `unknown` *before* the combiner is reached. The `unknown: 0`
  entry exists solely to keep `Record<ChecksState, number>` exhaustive (TS won't compile without
  it); priority 0 makes it a no-op even in the impossible case. Correct to keep. ✔

**Consumer audit — re-grepped independently, every reader accounted for:**

| Consumer | Handling of `unknown` | Safe? |
|---|---|---|
| `derivePrEvents` (`github-hosting.ts:488,504`) | `pr_ci_failure` gated on `=== "failing"`; `pr_ready_to_merge` gated on `=== "passing"`. `unknown` matches neither → emits nothing. | ✔ waits |
| `decideReadiness` (`auto-merge.ts:212`) | New branch routes `unknown → retry_wait` **before** the `merge` fall-through. | ✔ never merges |
| `shouldPromoteApproval` (`pr-event-poller.ts:204`) | `=== "passing"` required to promote; `unknown` doesn't. | ✔ never promotes |
| `auto-merge.ts:171,175,222,238` | Log/reasoning string interpolation only. | ✔ |
| `github-hosting.ts:206,216,332` | Value producer / log only. | ✔ |

There is **no exhaustive `switch` on `checks_state`** anywhere in `src`, so widening the enum
breaks nothing silently. The exhaustive `switch`es in `pr-events.ts` (`entryFor`, `reentryCarry`)
are keyed on `PrEventType`, not `checks_state`, and since `unknown` produces no `pr_ci_failure`
event, they are never reached with a phantom event. ✔

**Transient ≠ failing, structurally.** The only ways to produce `failing` are a real Status-API
`state` of `failure`/`error` or a real completed check-run with a non-success conclusion — both are
*read* check results, not lookup errors. Lookup errors (ECONNRESET, dropped connection, rate-limit)
throw from Octokit and are caught → `unknown`. So a single transient/flaky *lookup* can never yield
`failing`, which is exactly what AC 8 requires regardless of the confirmation policy chosen.

**Tests drive the real path.** The regression tests use
`mockRejectedValueOnce(new Error("read ECONNRESET"))` on **both** the Checks API and the Status API
— exercising the actual `catch`, not a stubbed default — and assert `unknown` + no `pr_ci_failure`
+ no merge + no promotion, plus an end-to-end `detectPrEvents → []`. A revert of the fallback to
`"failing"` would redden them. Schema test accepts all five values and rejects an invalid one. ✔

### 3. Confirmation policy (AC 8) — settled upstream, not re-opened here

The design resolved the "confirm a failing reading before rework?" question to **P0 (no
confirmation)**: a genuine red check still routes to rework immediately. This is a *settled*
decision recorded in `plan.md §2`, the `catch` comment, and the docs — I am not re-surfacing it as
an open choice (it isn't one). It is sound: the "single flaky reading never triggers rework"
property is delivered by mapping lookup errors to `unknown` (never `failing`), so it holds
independently of the confirmation policy. Residual risk (a genuinely flaky *check conclusion*
flipping, as opposed to a lookup error) is out of scope for #29 and bounded by the existing
`max_blocker_reentries` cap.

### 4. Fixes applied this pass

**None.** The change needed no correction. Nothing to commit in `src/`.

### 5. Gates — re-run independently by refine

| Gate | Result |
|---|---|
| `pnpm run typecheck` | ✅ exit 0 |
| `pnpm run lint` (biome + tsc + knip + madge) | ✅ exit 0, no circular deps |
| `pnpm run docs:bundle` (regenerate + drift) | ✅ zero drift (`git status` clean for `src/cli/bundled/`) |
| `pnpm run test:unit` | ✅ 2817 passed (147 files) |
| `pnpm run test:integration` | ✅ 67 passed (8 files) |

Every acceptance criterion (1–11) is met. The change is the minimal shape — one enum member, one
changed return value, one new readiness branch, docs + tests — and mirrors the already-shipped
`merge_state.unknown` precedent, so it reads as idiomatic to the next maintainer. **Ship.**
