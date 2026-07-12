# Self-Review — Issue #49

> Lens: self-review (holistic last look). Review only — `refine` applies fixes.
> Phase: review/self-review · 2026-07-12 · run 1
> Reviewed: `git diff main...HEAD` — commits `52d8c07` (source) + `46e3724` (trail).

## Verdict

**The change is correct, in scope, and well-tested. Four findings, none blocking the design — one
worth fixing before merge (F1), three cleanups.**

The core fix is right and the two traps the prior phases identified were both genuinely avoided:
`retryable: true` is set *explicitly* (requirements' Finding 4 — without it the whole fix is inert),
and the result-aware retry guard stops a retry from clobbering landed work (Finding 5). I verified
both by reading the code, not by trusting the reports.

---

## What I verified (not assumed)

| Claim | How I checked | Verdict |
|---|---|---|
| AC#1 — `is_error` fails the run at **both** sites | Read `claude-code-agent.ts:542-553` (salvage) and `:584-588` (clean exit) | ✅ both call `classifyResultEvent` |
| AC#2 — `retryable === true` explicitly set | `failedRunError` passes `retryable: verdict.retryable` into `createAdapterError` | ✅ not left at the `false` default |
| AC#3 — terminal not retried | Allowlist regex; unknown ⇒ `false` | ✅ (but see **F1**) |
| AC#5 — failure names the real cause | `agent-step.ts:134` → `failed("agent_unavailable", describe(run.error))`, and `no_result` is only reached when `run.error` is null (`:137-141`) | ✅ an API failure structurally *cannot* surface as `no_result` |
| AC#6 — validation boundary intact | Diff of the Core test file removes exactly **2** lines, both `import` churn. The three `no_result` tests are untouched | ✅ proven by non-modification |
| AC#7 — errored-after-valid-result not re-run | `hasValidResult` guard at `agent-step.ts:88-98` (in-diff) | ✅ and it sits *after* the `isRetryable`/`isLastAttempt` check, so terminal paths pay no extra disk read — good placement |
| `extractContent` really reads `result` | `claude-code-agent.ts:678-688` — handles `string` and `{text}` | ✅ no `[object Object]`, no second extractor written |
| AC#10 — gates green | Ran them myself | ✅ `lint` exit 0, `typecheck` exit 0, `test` exit 0 (**2865 passed / 148 files**) |
| No stray artifacts | Grepped the diff for `console.log`, `.only(`, `.skip(`, `TODO`, `debugger` | ✅ none. Source and trail cleanly separated into two commits |

**Test quality is genuinely high.** Every Core test rejects with a real `AdapterMethodError` carrying
an explicit `retryable` — not a plain `Error`, which would have exercised `isRetryable`'s message
heuristic, *a path production can never take*. The `agent.run` call-count assertions are
mutation-proof, and execution ran actual mutation testing to prove it. This is the difference between
a test that covers the fix and a test that only looks like it does.

---

## F1 — [medium] The transient allowlist misses common 5xx/429 message shapes, so those failures still burn the phase

**File:** `src/plugins/agent/claude-code-agent/claude-code-agent.ts:106-107`

`TRANSIENT_RUN_ERROR` only accepts a bare status code when it sits within two non-word characters of
the literal word `error` or `status` (`\b(error|status)\W{0,2}(429|500|...)\b`). That window cannot
span an intervening word. I ran the actual regex against realistic shapes:

| Message | Classified | Should be |
|---|---|---|
| `Request failed with status code 502` | **terminal** ❌ | transient |
| `Error code: 529` | **terminal** ❌ | transient |
| `HTTP 502 Bad Gateway` | **terminal** ❌ | transient |

**Why it matters.** These classify terminal → `agent-step`'s retry loop never fires → the phase burns
and the task parks on the owner. That is *exactly* the failure mode this issue exists to eliminate,
just wearing a different message. It fails safe (no retry storm, no cost amplification) and it is not
a regression against `main` — but AC#2 names "server error" as retryable, and for these shapes it is
not.

**The tests hide this.** The transient table's `"529 Overloaded"` and `"503 Service Unavailable"` cases
pass via the **word** branches (`overloaded`, `service unavailable`), *not* the numeric-code branch.
The numeric branch is only ever exercised by the two `API Error: NNN {...}` cases. So the table reads
as though bare status codes are covered when only one narrow shape is.

**Concrete fix** — allow an optional `code` token in the adjacency, add `bad gateway`, accept `http`
as an error context:

```ts
const TRANSIENT_RUN_ERROR =
  /connection (closed|error|reset)|econnreset|econnrefused|epipe|etimedout|socket hang up|timed out|timeout|rate[ _-]?limit|overloaded|service unavailable|bad gateway|server error|network error|\b(?:error|status|http)(?:\s+code)?\W{0,2}(?:429|500|502|503|504|529)\b/i;
```

I validated this against 21 cases: all three misses above become transient, and every terminal case
still classifies terminal — including `processed 500 files`, plus `migrated 502 records` and
`Wrote 429 lines`, which the current pattern also happens to reject but which nothing guards.

**Also add to the test tables** (`claude-code-agent.test.ts`, the `isTransientRunError` `it.each`):
`Request failed with status code 502`, `Error code: 529`, `HTTP 502 Bad Gateway` → transient;
`migrated 502 records` → terminal. Without these the numeric branch stays effectively untested.

---

## F2 — [low-medium] A sub-phase that *succeeds* now books $0 — the documented limitation understates this

**File:** `src/core/orchestrator/pipeline/agent-step.ts:121` (`spend: run.result ? … : null`) +
`docs/plugins/agent/claude-code-agent.md:81`

Plan §F3 knowingly accepted "cost is not attributed for errored runs," and the docs record it as:
*"Cost is not attributed for a run that **fails**."* That wording is too narrow, and it hides the
sharpest instance.

The AC#7 path — the agent writes a valid `session-result.json` and *then* the connection drops — is a
phase that **completes successfully**: `outcome: "ok"`, the work is preferred and used. But the plugin
now rejects, so `run.result` is `null`, `emitAgentCost` (`agent-step.ts:398`, inside `gatedRun`) never
fires, and the span's `spend` is `null`. **A passing sub-phase reports zero cost.** Against `main`
that same run resolved and its spend *was* booked.

This under-counts the ledger that the owner's per-task/day/month budget guardrails read. It is not a
correctness bug and the real fix (carrying spend on the adapter error) is a `public_api` change that
is rightly out of scope — but the limitation as written reads "only failed runs lose their cost,"
which a future reader will rely on and be wrong.

**Concrete fix (doc only):** reword the Limitations bullet to name the case, e.g. *"Cost is not
attributed for a run that ends in error — including a run that errored **after** writing a valid
result, where the work is still used and the sub-phase completes normally. That phase's spend does not
reach the cost ledger."* Worth a follow-up issue alongside plan §7.2 so the owner can judge whether
budget accuracy warrants the contract change.

---

## F3 — [low] Dead alternation branch: `internal server error` is subsumed by `server error`

**File:** `src/plugins/agent/claude-code-agent/claude-code-agent.ts:107`

`server error` is a substring of `internal server error`, so the `internal server error` alternative
can never be the branch that matches — it is unreachable. (Confirmed: `/server error/i.test("Internal
server error") === true`.) The test table's `"Internal server error"` case passes via `server error`.

**Fix:** delete `internal server error|` from the pattern. The test case stays and still passes —
which is the proof the branch was doing nothing.

---

## F4 — [low] `internal_error` vs `cli_error`: the truncated-stream reject contradicts the reasoning one site away

**File:** `src/plugins/agent/claude-code-agent/claude-code-agent.ts:576`

The no-result-event path rejects with code `internal_error`, while its own new comment describes it as
*"the same dropped connection, landing a moment earlier"* — i.e. an infrastructure failure. Meanwhile
`failedRunError`, ~440 lines up, deliberately chose `cli_error` with the plan's explicit reasoning:
*"the CLI ran and reported an error — it is not an internal defect."* The identical reasoning applies
here, and the change reaches the same conclusion at one site and the opposite at the other.

`code` is telemetry-only (I grepped `src/core` and `src/daemon` — nothing branches on it), so there is
**no behavioral impact**. This is purely a "would it surprise the next reader" defect, and it is a
one-word fix.

**Fix:** use `"cli_error"` at `:576` for consistency with `failedRunError`.

---

## Out of scope — noted, not to be fixed here

**`isSignalKill` is probably dead code** (`claude-code-agent.ts:556`):
`const isSignalKill = code === 137 || code === 143`. Node reports a signal-killed child as
`code === null` with the signal in the handler's **second** argument — `137`/`143` are *shell*
conventions (`128 + signum`) that Node does not synthesize, and this `close` handler only destructures
`(code)`. So a SIGTERM/SIGKILL likely lands as `code === null` → `isSignalKill === false` →
`retryable: true`.

This is **pre-existing and untouched by this diff** — boy-scout rule says note it, don't fix it. But
flagging it because the diff *edits the very Limitations bullet* that re-asserts "Signal kills
(SIGTERM/SIGKILL) are not retried," a claim that may not hold in practice. Worth its own issue.

---

## Scope check

Clean. No contract change, no schema change, no new dependency, nothing outside the issue's stated
surface (`src/plugins/agent/**`, the `AgentAdapter` run-outcome path, `agent-step`'s retry). The one
scope expansion — fixing the `:503` no-result-event path (plan D4) — is inside a file already being
changed, serves the issue's stated goal, and is `scope_expansion`, which is mine to decide for this
repo. The deviation from the plan's broken `\b500\b` mitigation was caught by execution's own test and
fixed rather than suppressed — the right call, and honestly reported.

Nothing here needs the owner. No new discretionary decision was made in this review.
