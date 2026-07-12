# Refine — Issue #49

> Phase: review/refine · 2026-07-12 · run 1
> Input: `review/self-review/findings.md` (4 findings) + my own read of `git diff main...HEAD`.
> Verdict: **ship** — all 4 findings fixed in place, gates green.

## Consolidation

One lens ran (self-review), so there were no cross-lens duplicates to merge. I re-derived every
finding against the actual code rather than trusting the report. **All four held up.** I found no
additional defects on my own pass.

| # | Finding | Held up? | Action |
|---|---|---|---|
| F1 | Transient allowlist misses bare status-code shapes | ✅ confirmed empirically | Fixed |
| F2 | Cost-attribution limitation understated in docs | ✅ confirmed by tracing `spend`/`emitAgentCost` | Fixed (doc) |
| F3 | `internal server error` alternation is redundant | ✅ confirmed | Fixed (folded into F1) |
| F4 | `internal_error` vs `cli_error` inconsistency | ✅ confirmed, telemetry-only | Fixed |

I also independently re-confirmed the two things the fix hinges on, because if either were wrong the
whole change would be inert: `retryable: verdict.retryable` is passed *explicitly* into
`createAdapterError` (not left at the `false` default), and the `hasValidResult` guard in
`agent-step.ts` sits inside the retry loop so an errored-after-valid-result run is handed back rather
than re-run. Both are correct.

---

## F1 — Transient allowlist missed common 5xx/429 shapes *(fixed)*

`src/plugins/agent/claude-code-agent/claude-code-agent.ts:106`

The old numeric branch (`\b(error|status)\W{0,2}(429|500|…)\b`) required the status code to sit within
**two non-word characters** of the word `error`/`status`. That window cannot span an intervening word,
so it missed every shape where `code` or `HTTP` sits between them. I ran the real regex rather than
reasoning about it:

| Message | Before | After |
|---|---|---|
| `Request failed with status code 502` | terminal ❌ | transient ✅ |
| `Error code: 529` | terminal ❌ | transient ✅ |
| `HTTP 502 Bad Gateway` | terminal ❌ | transient ✅ |

**Why this mattered enough to fix.** These classify terminal → the retry loop never fires → the phase
burns and parks on the owner. That is *precisely* the failure mode this issue exists to kill, just
wearing a different error string, and AC#2 names "server error" as retryable. It failed safe (no retry
storm) and was not a regression against `main` — but it was a real hole in the AC.

**The tests were hiding it.** The transient table's `529 Overloaded` / `503 Service Unavailable` cases
pass via the **word** branches (`overloaded`, `service unavailable`), not the numeric branch. Only the
tight `API Error: NNN` shape ever exercised the code branch, so the table *read* as though bare status
codes were covered when a single narrow shape was.

**Fix:** allow an optional `code` token in the adjacency, accept `http` as an error context, add
`bad gateway`. Validated against 25 messages: all three misses become transient and **zero** terminal
cases became false transients — including the count-prose guards (`processed 500 files`,
`migrated 502 records`, `Wrote 429 lines`). Added the three missed shapes plus two new count-prose
guards to the test tables, so the numeric branch is now actually covered in both directions.

## F2 — Cost limitation understated *(fixed — doc)*

`docs/plugins/agent/claude-code-agent.md`

I traced this rather than taking it on faith. The AC#7 path — agent writes a valid
`session-result.json`, *then* the connection drops — now has the plugin reject, so `run.result` is
`null`, `emitAgentCost` (inside `gatedRun`, only reached on success) never fires, and the span's
`spend` is `null`. The sub-phase still returns `ok` and the work is used. **So a sub-phase that
succeeds books $0**, and against `main` that same run's spend *was* booked.

The old wording ("Cost is not attributed for a run that **fails**") is too narrow and hides exactly
that case — a future reader would rely on it and be wrong. It under-counts the ledger the owner's
budget guardrails read.

**I did not fix the behavior, deliberately.** The real fix is carrying spend on the adapter error,
which is a change to the `AgentAdapter` contract — a `public_api` call, which my policy says I check
first, and which plan §F3 already knowingly accepted and scoped out. Fixing it here would be scope
creep on a contract I was not asked to touch. So I made the *documentation* honest about the sharpest
case and named the real fix. Flagged below as a follow-up for the owner to weigh.

## F3 — Redundant alternation branch *(fixed)*

`server error` is a substring of `internal server error`, so removing the longer alternative changes
no `.test()` result (`/server error/i.test("Internal server error") === true`). Deleted; the
`Internal server error` test case stays and still passes — which is the proof the branch was doing
nothing. Folded into the F1 rewrite.

*(Precision note: the lens called it "unreachable." Strictly it *does* match first at index 0 — regex
alternation is position-ordered. But it is genuinely **redundant**: the boolean result is identical
without it. The conclusion was right, the mechanism slightly mis-stated.)*

## F4 — `internal_error` → `cli_error` *(fixed)*

The no-result-event path rejected with `internal_error` while its own comment described it as *"the
same dropped connection, landing a moment earlier"* — an infrastructure failure. `failedRunError`, in
the same file, deliberately chose `cli_error` with the reasoning *"the CLI ran and reported an error —
it is not an internal defect."* Identical reasoning, opposite conclusion, one site apart.

I verified `code` is telemetry-only before touching it (grepped `src/core`, `src/daemon`, `src/cli` —
nothing branches on it; the only hits are doc strings), so this is zero-behavior-change. Switched to
`cli_error`, added the matching `severity`, and sharpened the message to `"No result event found in
CLI output (truncated stream)"` so the trail names the cause.

---

## Gates (all green, re-run after every fix)

| Gate | Result |
|---|---|
| `pnpm run lint` | exit 0 |
| `pnpm run typecheck` | exit 0 |
| `pnpm test` | **2870 passed / 148 files** (was 2865 — my 5 new cases) |
| `pnpm run test:integration` | **67 passed / 8 files** |

I also ran `pnpm run docs:bundle`. `src/cli/bundled/plugin-docs.ts` embeds the plugin docs as a
string literal, so editing the markdown without re-bundling would have shipped a stale doc through
the CLI. Regenerated and committed.

---

## Deliberately not fixed — for the owner

**`isSignalKill` is likely half-dead** (`claude-code-agent.ts:556`):
`const isSignalKill = code === 137 || code === 143`. Node reports a signal-killed child as
`code === null` with the signal in the handler's **second** argument; `137`/`143` are *shell*
conventions (`128 + signum`) that only appear when the CLI is behind a shell wrapper. The direct
signal case therefore falls through as `retryable: true`, contradicting the doc's "Signal kills are
not retried."

**Not fixed, on purpose.** It is pre-existing, untouched by this diff, and belongs to signal handling
rather than issue #49. Practical impact is near-zero: on our own abort, `agent-step` checks
`ctx.signal?.aborted` *before* retrying, so the abort path does not retry regardless. Changing it
would alter retry behavior for a case unrelated to this issue and deserves its own thought. Boy-scout
rule says note it, not fix it. **Worth its own issue.**

**Cost-on-error attribution** (F2's behavioral half) — worth a follow-up issue alongside plan §7.2, so
the owner can judge whether budget-ledger accuracy justifies the adapter-contract change.

## Verdict: ship

All four findings are fixed in place; none required re-implementation, a different approach, or a
requirements answer. The core fix was already right — these were a real AC gap (F1) and three clarity
defects. Both traps the earlier phases identified (explicit `retryable: true`, result-aware retry
guard) are genuinely avoided. Every acceptance criterion is met and all four gates are green. Nothing
material remains, and no new discretionary decision needs the owner.
