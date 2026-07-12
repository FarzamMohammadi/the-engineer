# Implementation — Issue #49

> A dropped API connection is reported as a successful agent run, so the phase fails with
> `no_result` instead of retrying.
>
> Phase: execution · 2026-07-12 · run 1
> Commit: `52d8c07` — *#49: Fail an errored agent run so transient blips retry, not burn the phase*

## 1. What shipped

The plan (Approach A) held up in full: plugin-local classification on the existing `retryable`
contract. **Zero contract change, zero schema change, zero new dependency, no `public_api` surface.**
Four files of source + docs, two of tests.

| File | Change |
|---|---|
| `src/plugins/agent/claude-code-agent/claude-code-agent.ts` | `classifyResultEvent` + `isTransientRunError` (pure, exported); wired into all three decision sites |
| `src/core/orchestrator/pipeline/agent-step.ts` | Result-aware retry guard (`hasValidResult`) so a retry can't clobber landed work |
| `docs/plugins/agent/claude-code-agent.md` | New **Run outcome** + **Retry classification** sections; corrected the stale salvage limitation |
| `src/cli/bundled/plugin-docs.ts` | Regenerated (`pnpm run docs:bundle`) — the plugin docs are bundled and byte-compared by a test |
| both test files | Regression coverage (see §4) |

### The plugin (Steps 1–2)

- **`classifyResultEvent(event)`** → `{kind:"ok"}` | `{kind:"failed", message, retryable}`.
  Fails on `is_error === true` **or** `subtype === "error"`. Strict `=== true`, so the existing
  `claude-exit1-output` salvage mock (which has no `is_error` key) keeps salvaging — plan's F4.
  Message comes from `extractContent(event)`, the helper that already normalizes `string | {text}`;
  no second extractor was written.
- **Three sites wired**: `:508` clean-exit, `:480` salvage (now rejects instead of resolving on an
  errored event), `:503` no-result-event (now `retryable: true` — D4).
- `lastRateLimits` is now set **before** both salvage branches, so a rate-limited run no longer drops
  its quota headers when it rejects (plan §0.2).

### Core (Step 3)

`runAgent` takes an `AgentStepScope { stepName, directory }` and, before backing off for a retry,
bails when a valid result is already on disk. `resetResultFile` runs **once**, before the loop — so
re-running an agent that errored *after* writing a good result would overwrite it with a fresh
template, and a second early death would turn a **passing** run into `no_result`. The guard hands the
error back and lets `runStep`'s existing "prefer the work over the error" branch take it. Alignment
with a policy Core already had, not new behavior.

## 2. Where I deviated from the plan (and why)

**The plan's word-boundary mitigation (F1b) was simply wrong, and my own test caught it.**

The plan specified matching bare status codes as `\b(429|500|502|503|504|529)\b`, asserting the word
boundaries would stop `"processed 500 files"` from reading as a transient 500. They do not — in that
string `500` *is* a standalone word, so `\b500\b` matches it. The plan's own guard test failed on the
first run.

I fixed the pattern rather than deleting the test: a bare status code now only counts **in an error
context** — `\b(error|status)\W{0,2}(429|500|502|503|504|529)\b`. This matches the real shape Claude's
CLI reports (`API Error: 429 {...}`, `status 503`) and rejects prose about counts. A false *transient*
is the expensive direction to be wrong in — it retries a deterministic failure three times — so
tightening here is strictly the safe move. Added both real API-error shapes to the transient table.

Two smaller calls:
- **No `claude-stream-error.ndjson` fixture.** The plan wanted one as a sibling to `claude-stream.ndjson`.
  That fixture exists because `activityEventsFromLine` needs *many* real stream lines. Classification
  needs exactly one event, and a literal object in the table test is more readable than a file nobody
  opens. The observed event instead appears verbatim in both the table test and a mock CLI — stronger
  coverage, one fewer artifact. (Simplicity test.)
- **A doc I had to fix that no phase flagged:** `docs/plugins/agent/claude-code-agent.md:76` claimed
  "Non-zero exit codes trigger output salvage: if valid NDJSON was produced, the result is used." That
  is now false — salvage is conditional on the event reporting success. Updated in the same commit as
  the code. It also turned out the plugin docs are **bundled** into `src/cli/bundled/plugin-docs.ts` and
  byte-compared by a unit test, so `pnpm run docs:bundle` had to run. Neither the plan nor research
  mentioned this; the test suite caught it.

## 3. Deliberately NOT done (plan §7 follow-ups stand)

1. **Gemini CLI + OpenCode share the defect class.** Not fixed — I have no live evidence of their error
   shapes, and a test written against a guessed shape is the test that passes when the code is deleted.
   `classifyResultEvent` is the pattern to copy when someone has real traces.
2. **Cost is not attributed for errored runs** (plan's F3 — a knowingly-accepted regression). A run that
   errors now throws, so `emitAgentCost` never fires and that spend leaves the ledger. Carrying spend on
   a failure needs a field on the adapter error contract — a `public_api` change, out of proportion here.
   The status quo was strictly worse: it booked a failed run as a *successful* $2.28 **and** burned the
   phase. **Now documented in the plugin's Limitations** rather than left silent.
3. **A terminal run error still rides the daemon's `agent_unavailable` ladder** (D5). Bounded (5 attempts)
   and escalates rather than loops; splitting Core's failure taxonomy has cross-plugin blast radius.
4. **Session resume for a cut-off run** — out of scope, belongs to #34. A retry here restarts the
   sub-phase cold.

## 4. Regression coverage — and proof it is real

Every Core test rejects with a real `AdapterMethodError` carrying an explicit `retryable`, never a plain
`Error`. This matters: `isRetryable` short-circuits on `AdapterMethodError`; a plain `Error` would fall
to its *message heuristic* — a path production can never take — so a retry test built on one passes even
if the plugin never sets `retryable`. The **`agent.run` call counts** are the mutation-proof assertions.

I did not take that on faith. I mutated each guard and confirmed the tests fail:

| Mutation | Result |
|---|---|
| Remove the D6 result-aware retry guard | ✅ 1 failed — AC#7 call count goes 1 → 3 |
| Ignore `is_error`, honor only `subtype` (**the original defect**) | ✅ 5 failed |
| Force `retryable: false` (throw, but never set the flag) | ✅ 2 failed |

Restored source after each; final diff verified clean.

| AC | Covered by |
|---|---|
| 1. `is_error` fails the run at both sites | plugin: dropped-connection mock (exit 0) + exit-1 salvage mock |
| 2. Transient ⇒ `retryable === true`, retry loop fires | plugin: `retryable` asserted; Core: `run` called **2×** |
| 3. Terminal ⇒ not retried | plugin: auth mock ⇒ `retryable === false`; Core: `run` called **1×** |
| 4. Retry succeeds ⇒ phase completes normally | Core: `outcome: "ok"`, no `no_result` |
| 5. Exhausted failure names the real cause | Core: `detail` contains "Connection closed", **not** "session-result.json was not updated" |
| 6. Validation boundary intact | the 3 existing `no_result` tests pass **unmodified** |
| 7. No cost regression on result-over-error | Core: errored-after-writing ⇒ `run` called **1×**, `outcome: "ok"` |
| 8. No session resume | retry restarts the sub-phase; nothing resumes |
| 9. Regression coverage | 2 helper tables + 4 mock-CLI runs + 4 Core retry tests |
| 10. Gates green | §5 |

## 5. Gates — all green (exit 0)

| Gate | Result |
|---|---|
| `pnpm run lint` | ✅ exit 0 — biome clean (I introduced a `noMisplacedAssertion` warning with a test helper and **fixed it**, not suppressed it); knip's 3 warnings are pre-existing and unchanged; no circular deps |
| `pnpm run typecheck` | ✅ exit 0 |
| `pnpm test` | ✅ **2865 passed / 148 files** |
| `pnpm run test:integration` | ✅ **67 passed / 8 files** |

## 6. Honest uncertainty

- **The transient allowlist is matched on message strings**, which are the engine's, not ours — a future
  Claude Code release could reword "Connection closed mid-response" and the match would silently go
  terminal. That fails *safe* (escalate, as today) rather than into a retry loop, and it is the same
  coupling the pre-existing `isRetryable` heuristic already had. I judged a stronger contract not worth a
  `public_api` change here, but it is the thing most likely to need revisiting.
- I have **no live trace** of a rate-limited or 5xx run through this path — only the observed
  dropped-connection one (which is covered end-to-end). Those alternates are covered by unit table, not
  by an observed stream.
