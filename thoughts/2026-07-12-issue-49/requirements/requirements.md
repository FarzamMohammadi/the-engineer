# Requirements — Issue #49

> A dropped API connection is reported as a successful agent run, so the phase fails with
> `no_result` instead of retrying.
>
> Source: `github_issue FarzamMohammadi/the-engineer#49`
> Phase: requirements · 2026-07-12

## Context Summary

**What the task asks.** When an agent run dies to a transient infrastructure failure (dropped API
connection, server error, rate limit), the agent plugin resolves the run as a *success*. Core then
finds `session-result.json` untouched, fails the phase with `no_result`, and blocks the task on the
owner — blaming the agent for an infrastructure failure. The existing transient-retry machinery in
`agent-step.ts` never fires, because it is only consulted on a *thrown* error and the plugin never
throws one. The owner wants the engine's error signal honored so the run is reported as a failure,
classified as retryable, and handled by the retry path that already exists — without weakening the
validation boundary that makes Core refuse to route a lie.

**Stated vs. reconstructed.** This is an unusually complete brief, and almost nothing here is
reconstruction. The owner stated: the symptom, the live evidence (task `01KX4RWRD995523203YTYE7SPW`,
`design` sub-phase, the exact result event), the root cause with file-level precision, a four-point
`What we want` that *is* the end-state, four design calls **explicitly delegated** to the design
phase, and an explicit scope-out of partial-work recovery to #34. I did not have to reconstruct
intent anywhere. What I added is verification (every factual claim in the issue checks out — see
below) and two consequences the issue did not anticipate (§ Findings 4 and 5), which shape the work
but do not change what "done" means.

**I verified rather than assumed.** Every load-bearing claim in the issue is true:

| Owner's claim | Verdict |
|---|---|
| Plugin decides success/failure from `subtype` alone | ✅ `claude-code-agent.ts:508` (`subtype === "error"`) and `:480` (salvage path) |
| Top-level `is_error` is never read | ✅ The only `is_error` read is `:188`, on *tool_result* activity blocks |
| Retry machinery already exists and is only consulted on a throw | ✅ `agent-step.ts:328-348` loop, gated by `isRetryable` at `:387` |
| `no_result` → blocked on owner, no retry | ✅ `no_result` → `pipeline_failed` → **no counter, no retry, no notification** |
| #34 is adjacent, not a duplicate | ✅ #34 is still OPEN; it covers good-work/bad-handoff, this covers a genuinely failed run |

No premise conflict. Nothing in the issue is stale or wrong.

---

## Findings

### 1. The defect, exactly

`claude-code-agent.ts` gates the run outcome on the `subtype` string at **two** sites, not one:

- `:508` — clean-exit path: `if (parsed.resultEvent["subtype"] === "error")` → reject.
- `:480` — non-zero-exit *salvage* path: `if (parsed.resultEvent && parsed.resultEvent["subtype"] !== "error")` → **resolve as success**.

Both ignore the top-level `is_error`. The observed event was
`{ subtype: "success", is_error: true, result: "API Error: Connection closed mid-response…" }` — it
passes both checks and resolves as a successful run. A fix must cover both sites; patching only the
clean-exit path leaves the salvage branch happily resolving an errored event.

The `subtype` check is also **too narrow independently of `is_error`**: any subtype other than the
literal `"error"` (e.g. `error_during_execution`, `error_max_turns`) passes today. Honoring
`is_error` regardless of `subtype` — as the owner asks — subsumes these.

Confirmed in the repo's own fixture (`tests/.../fixtures/claude-stream.ndjson:11`), where a real
result event carries `"subtype":"success","is_error":false` — the field is right there in the
stream, simply never read.

### 2. Core's two failure paths diverge sharply — this is *why* the bug hurts

| Cause | Block reason | Counter | Auto-retry? | Owner impact |
|---|---|---|---|---|
| `agent_unavailable` | `agent_unavailable` | `consecutive_agent_unavailable_count` | **Yes** — daemon re-queues, backoff `[2,5,10,15,15]` min, `max_attempts: 5` | Alerts, then stays blocked |
| `no_result` | `pipeline_failed` | none | **No** | Sits blocked; 4h reminder → 8h self-unblock → **2d → `failed`** |

Once the plugin throws, `agent-step.ts:129` already maps the exhausted-retry case to
`agent_unavailable`, which already lands on the daemon retry ladder **and already carries the real
error message** (`failed("agent_unavailable", describe(run.error))` — the adapter error text
contains `API Error: Connection closed mid-response`).

**Consequence: owner requirement #3 ("the message names the real cause") largely falls out of
requirement #1 for free.** Fixing the plugin to throw routes the failure away from the
`no_result`/"the agent didn't write its result" message and onto a path whose message already names
the API failure. Design should confirm this end-to-end rather than build a second mechanism.

### 3. The plugin's *only* channel for reporting failure is a throw

`AgentRunResult` = `{ content, cost_usd, duration_ms, usage }`. There is **no** success flag, error,
or stop-reason field. `AgentAdapter.run()` (`src/adapters/agent.ts:41-58`) resolves ⇒ the run
succeeded, by definition. This is precisely the "typed run-outcome on the contract vs. per-plugin
mapping" fork the owner delegated to design — and it is the reason the plugin *cannot* today say
"the CLI ran, and it failed."

### 4. ⚠️ The retry will NOT fire on message text alone — `retryable: true` must be set explicitly

`AgentAdapter.run()` wraps every non-`AdapterMethodError` throw into an `AdapterMethodError` whose
`retryable` **defaults to `false`** (`createAdapterError`, `src/adapters/errors.ts:11-27`). And
`isRetryable` (`agent-step.ts:387`) short-circuits on `AdapterMethodError` and returns
`error.adapterError.retryable` — it never reaches its own message-substring heuristic
(`timeout | rate limit | 429 | 503 | 529 | overloaded`).

**So that heuristic is effectively dead code for anything thrown from inside `doRun`.** A naive fix
that simply throws on `is_error` — without explicitly passing `{ retryable: true }` — would convert
the bug from "reported as success → `no_result`" into "reported as a *non-retryable* failure → still
no in-step retry." The observed symptom would change; the burned phase would not. This is the single
most important implementation constraint in this issue, and the issue does not mention it.

### 5. ⚠️ Do not let the retry discard work that already succeeded

`agent-step.ts:120-122` deliberately prefers a valid `session-result.json` over a run error ("*the
agent may have written a valid result before dying — prefer the work over the error*"). But the
retry loop lives **inside** `runAgent`, entirely *before* `readResult`.

So once the plugin starts throwing, a run that wrote a **valid result** and *then* lost the
connection on its closing message would be re-run from scratch — up to 3 in-step attempts — even
though its work is complete and sitting on disk. `resetResultFile` runs once before the loop, so the
good result survives and the phase still passes (correctness holds), but we would pay for up to 3
full agent runs to reach an answer we already had. At the observed ~$2.28 / ~8 min per run, that is a
real cost regression introduced *by the fix*.

This is a no-regression constraint, not a new feature: today that run passes on the first attempt.
It is settled by existing deliberate behavior — I am not inferring new intent — but it materially
constrains where the retry may sit. Design must make the retry result-aware (or reorder it), and this
is deliberately *not* the same thing as #34's session-resume.

### 6. Cross-engine: all three shipped plugins share the defect *class*

Not just Claude Code — the owner's design bullet on "the error signal across engines" is well-founded:

- **`gemini-cli-agent`** — a `result` event with `status: "error"` is consulted **only** through a
  rate-limit regex (`/exhausted.*capacity|quota|rate.?limit/i`). A dropped connection sets no failure
  flag at all; on a clean exit the run resolves as success with whatever partial text accumulated.
- **`opencode-agent`** — stream `error` events are **dropped on the floor entirely**
  (`processOpenCodeNdjsonLine` returns `skip` for them). Only a non-zero exit or a rate-limit-shaped
  *stderr* line can fail a run.

All three treat "process exited 0" as success. The owner explicitly delegated *how* to handle this
(per-plugin mapping vs. a typed run-outcome on the `AgentAdapter` contract, keeping Core out of
engine specifics), so the mechanism is design's call — but design should make it with this evidence
in hand, and decide deliberately whether the sibling plugins are fixed now or tracked as follow-ups.
The owner's note that "the fix is small and independently shippable" is a genuine input to that call.

---

## Acceptance Criteria

1. A Claude Code result event carrying `is_error: true` fails the run **regardless of its `subtype`**
   — including the observed `subtype: "success"` — at **both** decision sites: the clean-exit path
   (`claude-code-agent.ts:508`) and the non-zero-exit salvage path (`:480`).
2. A run-ending **transient/infrastructure** failure (dropped connection, server error, rate limit,
   timeout) is reported to Core as a **retryable** failure — `AdapterError.retryable === true`,
   explicitly set — so that `agent-step`'s existing retry loop actually fires. A fix that throws but
   leaves `retryable` at its `false` default does **not** satisfy this criterion (see Finding 4).
3. A run-ending failure that is **not** transient (e.g. authentication failure, a rejected /
   `ask_human` pipeline stop) is classified terminal and is **not** retried.
4. When a transient failure is retried and a subsequent attempt succeeds, the sub-phase completes
   normally: no burned phase, no `no_result`, no owner involvement, no manual `engineer retry`.
5. When retries are exhausted, the surfaced failure **names the real cause**. An API/connection
   failure must not be reported as `no_result` / "session-result.json was not updated by the agent".
6. The validation boundary does not weaken: a run that genuinely produced no valid result — the agent
   ran to completion and wrote nothing, a template, or a malformed file — still fails exactly as it
   does today (`no_result`, including the existing stray-result hint). Core never routes a lie.
7. **No cost regression on result-over-error:** a run that errored *after* writing a valid
   `session-result.json` still has its work preferred and is **not** re-run by the new retry path
   (see Finding 5).
8. Partial-work recovery / session resume is **out of scope** — it belongs to #34. A retry here
   restarts the sub-phase; it does not resume the dead session.
9. Regression coverage exists for the defect and its edges: `is_error: true` + `subtype: "success"`
   → retryable failure; the salvage path; a terminal (non-retryable) error; a genuinely
   result-less run still failing `no_result`; and the errored-but-valid-result run not being re-run.
10. The project's own gates are green: `pnpm run lint`, `pnpm run typecheck`, `pnpm test`,
    `pnpm run test:integration`.

## Explicitly Delegated to Design (by the owner, verbatim scope)

Not requirements questions — the owner assigned these to the design phase, and I am deliberately not
re-asking them:

1. **The error signal across engines** — per-plugin mapping vs. a typed run-outcome on the
   `AgentAdapter` contract. Keep Core out of engine specifics (Plugin Opacity). *Note: a contract
   change here is a `public_api` decision and will need the owner's confirmation at that point.*
2. **Retryable vs. terminal** — which run-ending errors earn a retry. Extend the existing
   `isRetryable` / `AdapterError.retryable` convention rather than reinvent it.
3. **Retry budget** — how the in-step loop (3 attempts, 1s/2s backoff) composes with the daemon's
   `agent_unavailable` ladder (5 cycles, `[2,5,10,15,15]` min) so a persistently failing engine still
   escalates instead of looping.
4. **Partial-work recovery** — deferred to #34.

## Open Questions for the Owner

**None.** The owner expressed the end-state directly (the four-point `What we want`), delegated the
four design calls explicitly, and scoped partial-work recovery out to #34. Every remaining fork I
found is either one of those delegated calls or settled by existing deliberate behavior in the code.
I would stake the build on the acceptance criteria above.

## Complexity

**complex** — the owner is right that the *core* fix is small, but the work spans the agent plugin
layer (up to three plugins), potentially the `AgentAdapter` contract (a public plugin API with its
own contract test suite), and Core's retry/failure taxonomy. Finding 4 (retryability must be
explicit) and Finding 5 (the retry must not discard completed work) are real unknowns that a naive
implementation gets wrong, and the cross-engine question is a genuine open design fork.

## Verification Commands

| Name | Command |
|---|---|
| lint | `pnpm run lint` (Biome + tsc ×2 + knip + madge) |
| typecheck | `pnpm run typecheck` |
| test | `pnpm test` (vitest unit — includes the agent contract suite) |
| integration | `pnpm run test:integration` |
