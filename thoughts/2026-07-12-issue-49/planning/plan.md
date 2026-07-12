# Plan — Issue #49

> A dropped API connection is reported as a successful agent run, so the phase fails with
> `no_result` instead of retrying.
>
> Source: `github_issue FarzamMohammadi/the-engineer#49`
> Phase: planning · 2026-07-12 · run 1

## 0. What I verified myself

I treated requirements and research as claims, not conclusions. Re-derived from source:

| Claim | Verdict |
|---|---|
| `:480` salvage + `:508` clean-exit gate on `subtype` alone | ✅ read both; neither reads top-level `is_error` |
| `:503` (exit 0, no result event) is `retryable: false` | ✅ `createAdapterError` called with no options |
| `createAdapterError` defaults `retryable: false` | ✅ `errors.ts:23` |
| `AdapterMethodError` passes through `AgentAdapter.run()` **unwrapped** | ✅ `agent.ts:45-47` — a plugin-set `retryable: true` survives to `isRetryable` |
| `isRetryable` short-circuits on `AdapterMethodError` | ✅ `agent-step.ts:388` — the message heuristic is dead code for plugin throws |
| Retry loop sits entirely before `readResult` | ✅ `runAgent` awaited `:110`; `readResult` `:111`; `resetResultFile` once at `:89` |

**Two things I found that neither prior doc caught:**

1. **`resultEvent["result"]` is not always a string.** The repo's own mock CLI emits
   `"result":{"type":"text","text":"..."}`; the observed failure emits a bare string. Research's §H1 fix
   ("source the message from `result`") is right but under-specified — a naive `String(event["result"])`
   yields `[object Object]`. There is already a helper that normalizes exactly this shape:
   **`extractContent` (`:609`)**. Reuse it; do not write a second extractor.

2. **The salvage path sets `this.lastRateLimits` before resolving (`:481`); the reject paths do not.**
   Once the salvage path starts *rejecting* on `is_error`, a **rate-limited** run — precisely when quota
   headers matter most — would silently drop its rate-limit info from `getQuotaStatus()`. Must set
   `lastRateLimits` on the new reject path too.

Everything else in requirements and research holds. No premise conflict.

---

## 1. Approaches considered

### Approach A — Plugin-local classification on the existing `retryable` contract ✅ **CHOSEN**

The plugin already has a failure channel: throw `AdapterMethodError` with `AdapterError.retryable`.
Core already honors it (`isRetryable` → the retry loop). **Nothing needs inventing.** The fix is to
(a) notice the run failed, (b) say whether it is transient, (c) stop Core's retry from clobbering work
that already landed.

- `claude-code-agent.ts` — one pure exported classifier consulted at both decision sites.
- `agent-step.ts` — one guard so the retry never re-runs a run that already wrote a valid result.
- **Zero** contract/schema change. **Zero** `public_api` surface.

### Approach B — A typed run-outcome on the `AgentAdapter` contract (rejected)

Add `outcome`/`error` to `AgentRunResult` so plugins report failure by returning rather than throwing.

**Rejected.** It buys nothing we don't already have and costs a lot:
- The contract *already* expresses "the run failed, and here's whether to retry" — `AdapterMethodError` +
  `retryable`. All three shipped plugins already set `retryable` somewhere. B reinvents a working channel.
- It changes `AgentRunResultSchema` (`schemas/adapters.ts:322`) — a **`public_api`** decision, which is
  *always check-first* under my autonomy policy. It would gate this fix on the owner for no benefit.
- It touches the 4-plugin contract suite and every plugin, converting a small, independently shippable
  fix (the owner's words) into a cross-plugin migration.
- It does not make Core any less engine-specific: Core reads `retryable` either way.

**Complexity must earn its place. B earns nothing.** Taking A.

---

## 2. Decisions (what I chose, what I rejected, what it locks in)

### D1 — Per-plugin mapping, not a contract change *(delegated design call #1: "the error signal across engines")*

Engine specifics (`is_error`, `subtype`, Claude's error strings) stay **inside** the plugin. Core reads
only `AdapterError.retryable` — already part of the adapter contract, already consumed. **Plugin Opacity
is preserved exactly**: delete every plugin and Core still compiles.

*Locks in:* the cross-engine convention is "each plugin classifies its own engine's errors into
`retryable`". Reversible; no contract surface.

### D2 — Claude Code only. Gemini/OpenCode are **not** fixed in this PR *(delegated design call #1, cont.)*

Research confirmed all three plugins share the defect *class*. I am still scoping this to Claude Code:

- Every acceptance criterion names Claude Code (AC#1 is literally `claude-code-agent.ts:508` and `:480`).
- The owner said the fix is "small and independently shippable."
- **I have no live evidence of what a dropped connection looks like in Gemini's or OpenCode's streams.**
  Fixing them means *guessing* at their error shapes — and a test written against a guessed shape is
  exactly the test that passes when the code it covers is deleted. I will not ship that.
- Touching all three plugins + the contract suite is `refactoring_broad`, which is **always check-first**
  for this repo. Scoping down keeps this PR shippable today.

D1 makes the pattern trivially reusable when someone has real evidence for those engines.
*Follow-up filed in §7.*

### D3 — Transient classification is an **allowlist**; unknown ⇒ terminal *(delegated design call #2)*

Only an explicitly-recognized transient string sets `retryable: true`. Anything else `is_error: true` is
still a **failure** (that's the whole bug) but is **not retried**.

*Why allowlist, not denylist:* a denylist ("everything except auth") would retry unknown errors, risking
cost amplification on deterministic failures. An allowlist fails safe — an unrecognized error preserves
today's escalate-to-owner behavior. Auth failures need no special case: they contain no transient token,
so they fall through to terminal naturally. **One list, not two.** This satisfies AC#3.

### D4 — Fix site `:503` too (exit 0, no result event) *(research §H2)*

A connection dropped *before* the CLI emits its result line = clean exit + truncated stream = `:503`,
currently `retryable: false`. That is **the same bug wearing a different hat, one line away** from the
sites in scope. Leaving it means the next dropped connection burns a phase anyway.

One field (`{ retryable: true }`). `scope_expansion` is mine to decide under my autonomy policy, and this
is inside a file I am already changing, serving the issue's stated goal. **Taking it.**

### D5 — Core's `run.error` → `agent_unavailable` mapping (`:129`) is **not** touched

*Consequence I am accepting knowingly:* once the plugin throws on terminal errors, those land on
`agent_unavailable` → the daemon's retry ladder (5 attempts, `[2,5,10,15,15]` min) before escalating —
i.e. a *terminal* error still gets task-level retries.

I considered splitting `:129` (retryable ⇒ `agent_unavailable`, terminal ⇒ `agent_failed`). **Rejected:**
it changes Core's failure taxonomy for *every* plugin throw that exists today (`spawn_error`, signal-kill,
`cli_error`) — real blast radius, unasked-for, and `spawn_error` genuinely *is* "agent unavailable" and
*should* keep the ladder.

AC#3 says a terminal failure "is not retried" — in the issue's own frame that is **`agent-step`'s retry
loop** (AC#2: "agent-step's existing retry loop actually fires"; AC#3's own example is a pipeline stop,
which is a plain `Error` judged by `isRetryable`). D3 satisfies that literally. The daemon ladder is a
distinct, pre-existing, **bounded** mechanism that escalates rather than loops — which is exactly what
delegated call #3 (retry budget) asks for. *Follow-up in §7.*

### D6 — The retry becomes result-aware *(research §4 — the sharpest finding in either doc)*

`resetResultFile` runs **once**, before the loop. So post-fix, a run that wrote a valid result and *then*
dropped its connection would be re-run — and attempt 2 **overwrites `session-result.json`**. If attempt 2
dies early, `readResult` sees attempt 2's template/garbage → `no_result`. **The naive fix turns a run that
passes today into one that fails.** This is not merely a cost regression; it is a correctness regression.

Fix: before retrying, check for a valid result on disk. If one exists, stop — return the error and let
Core's existing "prefer the work over the error" branch (`:120`) take it. This makes the retry loop agree
with a policy Core *already has*; it is alignment, not new behavior. Satisfies AC#7.

*This is the one place Core must move, and it is not #34's session-resume: "don't re-run work that already
landed" ≠ "resume the dead session." AC#8 holds — a retry restarts the sub-phase cold.*

---

## 3. Stress test

**Plugin Opacity** — ✅ Core learns nothing about `is_error`, `subtype`, or Claude error strings. It reads
`AdapterError.retryable`, already in the adapter contract. The Core change (D6) concerns Core's *own*
handoff file, not any engine. **Delete every plugin: Core still compiles.**

**Isolation** — ✅ The classifier is a pure function. No shared mutable state added. `hasValidResult` reads
only the task's own step directory. No cross-task bleed. *Caught during this check:* `lastRateLimits` is
instance state that the new reject path must still set (§0.2) — folded into Step 2.

**Boundaries** — ✅ Plugin reports failure through the documented `AdapterMethodError` channel; Core consumes
`adapterError.retryable`. No reaching into internals. No schema/contract change ⇒ no `public_api` gate.

**Reversibility** — ✅ No new interfaces, no schema changes, no migrations, no data touched. Everything is
behavior inside two source files + tests. The only new exported symbols are plugin-local pure helpers
(exported solely for unit tests, per the house pattern of `processNdjsonLine` / `dominantModelId`).
**Hardest thing to undo:** nothing. This is a clean revert.

---

## 4. Pre-mortem — it ships with a subtle flaw. What is it?

**F1 — Retry storm: a deterministic error misclassified as transient burns 3 in-step × 5 daemon = ~15 runs
(~$30 at observed rates).**
*Mitigations:* (a) D3's allowlist — unknown never retries, so only an explicitly-matched string can trigger
this; (b) match bare numeric codes (`429`, `503`, `529`…) with **word boundaries**, so "processed 500 files"
cannot false-positive; (c) the bound is hard — `MAX_AGENT_RETRIES = 3` and the daemon's `max_attempts: 5`
mean it **escalates, never loops**.
*Accepted:* this amplification bound is **pre-existing**, not introduced — `cli_error` is already
`retryable: !isSignalKill`, so a repeatedly-failing non-zero exit already gets 3×5 today.

**F2 — The D6 guard suppresses a retry that was actually needed** (agent writes a valid result *early*, then
dies before finishing real work).
*Assessment: not a new risk.* The result file is the end-of-run handoff by convention, and Core **already**
prefers a written result over a run error (`:120`, a deliberate, commented decision). D6 makes the retry
loop obey a policy Core already enforces one line later. If that policy is ever wrong, it is wrong today.
*Accepted.*

**F3 — Cost attribution is lost for errored runs.** ⚠️ *A real regression the fix introduces.* Today a
dropped-connection run "succeeds", so `emitAgentCost` fires and the ~$2.28 is recorded. Post-fix it throws,
`gatedRun` never reaches `emitAgentCost`, and that spend **vanishes from the ledger**.
*Why I accept it:* carrying spend on a failure requires a field on the adapter error contract — a
**`public_api`** change, always check-first, and out of proportion here. And the status quo is strictly
worse: it books a failed run as a *successful* $2.28 run **and** burns the phase. Correct-and-unbilled beats
wrong-and-billed. *Named honestly; follow-up in §7.*

**F4 — Breaking the existing salvage test.** The repo's `claude-exit1-output` mock emits `subtype:"success"`
with **no `is_error` key** and must keep salvaging. *Mitigation:* check strictly `is_error === true`, never
truthiness on a possibly-absent field. Step 6 keeps that test green as an explicit gate.

---

## 5. Ordered implementation

Concrete paths. Each part carries its own verification. **Do not write code before reading §0.**

### Step 1 — The pure classifier (`src/plugins/agent/claude-code-agent/claude-code-agent.ts`)

- [ ] Add a module-level **exported pure** helper (house pattern: `processNdjsonLine`, `dominantModelId` are
      exported solely to be unit-tested without spawning a process):

      type ResultEventVerdict =
        | { readonly kind: "ok" }
        | { readonly kind: "failed"; readonly message: string; readonly retryable: boolean };

      export function classifyResultEvent(event: Record<string, unknown>): ResultEventVerdict

- [ ] **Failure detection:** `event["is_error"] === true || event["subtype"] === "error"`.
      Strict `=== true` (see F4). Honoring `is_error` regardless of `subtype` also subsumes
      `error_during_execution` / `error_max_turns`, which the `subtype === "error"` check misses today.
- [ ] **Message:** reuse **`extractContent(event)`** (`:609`) — it already normalizes `string | {text}`.
      Fall back to `String(event["error"] ?? "")`, then `"unknown error"` when empty.
      **Do not** copy `:513`'s `event["error"]` read — that key does not exist on Claude's result event
      (§0.1); copying it surfaces `"CLI returned error: unknown"` and silently guts AC#5.
- [ ] **Retryability:** `retryable: isTransientRunError(message)`.
- [ ] Add a second exported pure helper `isTransientRunError(message: string): boolean` — a single
      case-insensitive regex, **allowlist only** (D3), numeric codes **word-bounded** (F1b):
      connection closed/error/reset · `ECONNRESET` · `ECONNREFUSED` · `EPIPE` · `ETIMEDOUT` · socket hang up ·
      timeout / timed out · rate limit · `\b(429|500|502|503|504|529)\b` · overloaded · service unavailable ·
      internal server error · server error · network error.
      Doc-comment it in house style — state **why** unknown ⇒ terminal (fail safe: preserve today's
      escalate-to-owner rather than risk a retry loop), and that auth failures need no special case because
      they match nothing here.

**Verify:** `pnpm run typecheck`.

### Step 2 — Wire the classifier into all three decision sites (same file)

- [ ] **`:508` clean-exit path** — replace the `subtype === "error"` check with `classifyResultEvent`.
      On `failed`: set `this.lastRateLimits = parsed.rateLimits` (§0.2), then reject with
      `new AdapterMethodError(createAdapterError("cli_error", message, { retryable, severity: AdapterErrorSeverities.error }))`.
      *(`cli_error`, not `internal_error`: the CLI ran and reported an error — it is not an internal defect.)*
- [ ] **`:480` salvage path** — call `classifyResultEvent` on the captured event. Only `kind: "ok"` salvages
      and resolves. A `failed` verdict must **reject**, not resolve. Keep the existing
      `this.lastRateLimits = parsed.rateLimits` assignment on **both** branches.
- [ ] **`:503` no-result-event path** — add `{ retryable: true }` (D4). Comment **why**: a clean exit with no
      result line is a truncated stream, i.e. the same dropped connection this issue is about.
- [ ] The `close` handler already carries a *justified* `biome-ignore noExcessiveCognitiveComplexity` (`:452`).
      Pulling the outcome decision into `classifyResultEvent` should **reduce** its branching. If Biome still
      complains, extract further — **do not** widen the suppression.

**Verify:** `pnpm run lint && pnpm run typecheck`.

### Step 3 — Result-aware retry (`src/core/orchestrator/pipeline/agent-step.ts`)  *(D6)*

- [ ] Thread the step `directory` into `runAgent` (it is already computed at `:88` in `runStep`).
- [ ] In the `catch` (`:331`), **before** deciding to retry, bail out when a valid result already exists:

      const hasResult = readResult(directory);            // helper already exists at :427
      if (hasResult !== null && hasResult !== "invalid") { return { result: null, error }; }

      Emit an `ctx.observer.info` naming why ("agent errored but already wrote a valid result — not
      retrying"), so the trail explains the non-retry.
- [ ] Doc-comment **why** on the guard: `resetResultFile` runs once, before the loop, so a retry would
      **overwrite** a good result — turning a passing run into `no_result` (D6).
- [ ] Do **not** touch `:129`'s `agent_unavailable` mapping (D5). Do **not** touch `isRetryable`, the retry
      counts, or the daemon ladder.

**Verify:** `pnpm run typecheck && pnpm test`.

### Step 4 — Plugin regression tests (`tests/unit/plugins/agent/claude-code-agent/claude-code-agent.test.ts`)

Table-drive the pure helpers, then drive the **real `doRun`** through new bash mock CLIs (existing pattern,
`:20-94`).

- [ ] **Table tests on `classifyResultEvent`** — the observed event (`is_error:true` + `subtype:"success"` +
      the API-Error string) ⇒ `failed`, `retryable: true`, message **contains "Connection closed"**
      (this is the assertion that guards §0.1 / AC#5 — a message-blind test would let the regression back in);
      `subtype:"error"` ⇒ failed; `is_error:false` ⇒ ok; **absent** `is_error` ⇒ ok (F4);
      `result` as `{type:"text",text:…}` ⇒ message is the text, not `[object Object]`.
- [ ] **Table tests on `isTransientRunError`** — transient: dropped connection, `529`, `overloaded`,
      rate limit, timeout. Terminal: `"Invalid API key · Please run /login"`, an auth failure, an unknown
      string. **And `"processed 500 files"` ⇒ terminal** (guards the word-boundary mitigation, F1b).
- [ ] **New mock CLI — clean-exit error (AC#1a):** exits **0**, emits
      `{"type":"result","subtype":"success","is_error":true,"result":"API Error: Connection closed mid-response. The response above may be incomplete."}`
      ⇒ `run()` **rejects** with `AdapterMethodError`, `adapterError.retryable === true`, message contains
      the API-Error text. *This is the exact observed failure — the headline regression test.*
- [ ] **New mock CLI — salvage-path error (AC#1b):** same event, exits **1** ⇒ rejects (does **not** salvage).
- [ ] **New mock CLI — terminal error (AC#3):** exit 0, `is_error:true`, `result:"Invalid API key · Please run /login"`
      ⇒ rejects with `adapterError.retryable === false`.
- [ ] **New mock CLI — truncated stream (D4):** exit 0, emits an assistant line and **no result event**
      ⇒ rejects with `retryable === true`.
- [ ] **Keep green, do not modify:** the existing `claude-exit1-output` salvage test (F4) and the
      `is_error:false` happy path — proof the fix does not weaken the success path.
- [ ] Add fixture `tests/unit/plugins/agent/claude-code-agent/fixtures/claude-stream-error.ndjson` — the
      observed stream, sibling to the existing `claude-stream.ndjson`.

**Verify:** `pnpm test`.

### Step 5 — Core regression tests (`tests/unit/core/orchestrator/pipeline/agent-step.test.ts`)

⚠️ **Research §H3 is the trap here.** `fakeAgent` is a bare cast, **not** an `AgentAdapter` subclass — it does
**not** inherit `run()`'s error wrapping. Every existing failure test rejects with a **plain `Error`**, which
reaches `isRetryable`'s *message heuristic* — **a path production can never take**, because the base class has
already wrapped plugin throws into an `AdapterMethodError`. A retry test built on a plain `Error` would pass
even if the plugin's `retryable: true` were never set — the classic test that proves nothing.

> **Every test below MUST reject with a real `new AdapterMethodError(createAdapterError(…, { retryable }))`
> and MUST assert the adapter's `run` call count.** The call count is the mutation-proof assertion: delete
> the fix and it fails.

- [ ] **AC#4 — transient failure retried, then succeeds:** agent throws `AdapterMethodError`(`retryable: true`)
      on call 1; on call 2 writes a valid `session-result.json` and resolves.
      ⇒ `outcome: "ok"`, and **`agent.run` called exactly twice**. *(No `no_result`, no owner involvement.)*
- [ ] **AC#3 — terminal failure is not retried:** agent throws `AdapterMethodError`(`retryable: false`).
      ⇒ **`run` called exactly once**, `category: "agent_unavailable"`.
- [ ] **AC#5 — the surfaced failure names the real cause:** with retries exhausted on a transient error whose
      message is the API-Error string ⇒ result `detail` **contains "Connection closed"** and **does not**
      contain `"session-result.json was not updated"`. *This is the AC#5 assertion; without it the fix can
      regress to a correct-but-mute failure.*
- [ ] **AC#7 — errored-but-valid-result is NOT re-run:** agent writes a valid `session-result.json`, **then**
      throws `AdapterMethodError`(`retryable: true`).
      ⇒ `outcome: "ok"` and **`run` called exactly ONCE**. *This is the test that proves the D6 guard exists —
      remove the guard and the call count becomes 3.*
- [ ] **AC#6 — the validation boundary did not weaken:** the existing `no_result` tests (untouched template,
      malformed file, stray-result hint) must **pass unmodified**. Do not edit them.

**Verify:** `pnpm test`.

### Step 6 — Full gates (AC#10)

- [ ] `pnpm run lint` (Biome + tsc ×2 + knip + madge). **Knip will flag the new exported helpers as unused if
      the tests do not import them** — they must be imported by name in Step 4.
- [ ] `pnpm run typecheck`
- [ ] `pnpm test`
- [ ] `pnpm run test:integration`

A non-zero exit is a **failure**, never a warning to wave off. Make it pass, or report it red and why.
No new integration test is warranted: both boundaries (plugin parse, Core retry) are covered at unit level,
which is where the defect lives.

---

## 6. Acceptance criteria → where each is proved

| AC | Proved by |
|---|---|
| 1. `is_error` fails the run at **both** sites | Step 2; tests Step 4 (clean-exit + salvage mocks) |
| 2. Transient ⇒ `retryable === true`, retry loop fires | Steps 1–2; test Step 5 (call count = 2) |
| 3. Terminal ⇒ not retried | D3 allowlist; tests Step 4 (auth mock) + Step 5 (call count = 1) |
| 4. Retry succeeds ⇒ phase completes normally | Test Step 5 (`outcome: "ok"`, no `no_result`) |
| 5. Exhausted failure names the real cause | Step 1 (message via `extractContent`); test Step 5 (`detail` contains "Connection closed") |
| 6. Validation boundary intact | Step 5 — existing `no_result` tests pass **unmodified** |
| 7. No cost regression on result-over-error | D6 guard; test Step 5 (call count = **1**) |
| 8. No session resume | D6 is "don't re-run landed work", not "resume". Retry restarts the sub-phase cold. |
| 9. Regression coverage | Steps 4 + 5 |
| 10. Gates green | Step 6 |

---

## 7. Follow-ups (noted, deliberately **not** done here)

Out of scope by the boy-scout rule — I saw them, I am not fixing them:

1. **Gemini CLI + OpenCode share the defect class** (D2). Needs real evidence of each engine's error shape
   before it can be tested honestly.
2. **Cost is not attributed for errored runs** (F3). Needs a spend field on the adapter error contract —
   a `public_api` change.
3. **A terminal run error still rides the daemon's `agent_unavailable` ladder** (D5). Correct-but-slow; the
   cleaner taxonomy is a `agent_failed`-style terminal cause, which is a Core failure-taxonomy change with
   cross-plugin blast radius.

---

## 8. Open questions for the owner

**None.** All four calls the owner delegated to design are resolved above: the cross-engine error signal (D1,
D2), retryable-vs-terminal (D3), the retry budget's composition with the existing counters (D5 — bounded at
3 in-step × 5 daemon, escalates rather than loops), and partial-work recovery (out of scope per AC#8; D6 is a
*different* thing — don't clobber landed work).

**No decision here needs the owner's sign-off:** no contract/schema change, no new dependency, no destructive
or security-touching call. The one scope call I made (D4, fixing `:503` in a file I am already changing) is
`scope_expansion`, which is mine to decide for this repo. F3 is a knowingly-accepted regression, documented
rather than hidden.
