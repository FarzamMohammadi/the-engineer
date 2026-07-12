# Research — Issue #49

> A dropped API connection is reported as a successful agent run, so the phase fails with
> `no_result` instead of retrying.
>
> Source: `github_issue FarzamMohammadi/the-engineer#49`
> Phase: research · 2026-07-12 · run 1

## How to read this

**Observations** are facts I verified by reading the code (file:line given). **Inferences** are what I
conclude from them, labelled as such. I treated the requirements phase's findings as *claims to
verify*, not facts to inherit — every one is re-checked below against the source.

**Bottom line:** the premise is correct and every load-bearing claim in the issue and in requirements
holds. But I found **three hazards that are not in either document**, and one of them (§H1) means the
most natural implementation of the fix would silently fail acceptance criterion #5 while looking
correct. There is no premise conflict.

---

## 1. Verification of prior claims

I re-derived each claim from source rather than trusting the requirements table.

| Claim (from issue / requirements) | Verdict | Evidence |
|---|---|---|
| Plugin decides success/failure from `subtype` alone | ✅ **Confirmed** | `claude-code-agent.ts:508` (`subtype === "error"` → reject) and `:480` (salvage: `subtype !== "error"` → resolve) |
| Top-level `is_error` is never read | ✅ **Confirmed** | `grep -rn "is_error" src/` returns **exactly one** hit: `:188`, on *tool_result* content blocks. The result event's `is_error` is read nowhere. |
| Retry machinery exists, consulted only on a throw | ✅ **Confirmed** | Loop `agent-step.ts:328-348`; gated by `isRetryable` at `:334`/`:387` |
| `no_result` → blocked on owner, no retry | ✅ **Confirmed** | `toBlockReason` (`orchestrator/index.ts:92`) sends everything but `agent_unavailable`/`awaiting_*` to `default: pipeline_failed`. In `task-scheduler.ts:484-497`, `pipeline_failed` falls to the `else` branch — logs "Task blocked awaiting human input", **no counter, no re-queue, no retry**. |
| `agent_unavailable` gets the retry ladder | ✅ **Confirmed** | `task-scheduler.ts:484` → `handleAgentUnavailableBlocked` (`:401`) → `retryPolicy.recordFailure` → backoff `[2,5,10,15,15]` min, `max_attempts: 5` (`config.ts:213-214`) |
| Retryability must be set **explicitly** (Finding 4) | ✅ **Confirmed** | `createAdapterError` defaults `retryable: false` (`errors.ts:23`); `AgentAdapter.run()` wraps every non-`AdapterMethodError` throw with that default (`agent.ts:48-53`); `isRetryable` short-circuits on `AdapterMethodError` and returns `.retryable` (`agent-step.ts:388`), never reaching its message heuristic. |
| Retry sits before `readResult` (Finding 5) | ✅ **Confirmed** | `runAgent` (with its loop) is awaited at `:110`; `readResult` runs at `:111`. `resetResultFile` runs once at `:89`, **before** the loop. |
| Sibling plugins share the defect class (Finding 6) | ✅ **Confirmed** | Gemini `:81` consults `status: "error"` *only* through a rate-limit regex (`RATE_LIMIT_STDOUT_RE`); a non-rate-limit error sets no failure flag and the clean-exit path resolves as success. OpenCode drops stream `error` events (`skip`). |
| #34 is adjacent, not a duplicate | ✅ **Confirmed** (no re-derivation needed — orthogonal concern) | — |

**Nothing in the issue is stale or wrong. The need is not already satisfied elsewhere.** No
`premise_conflict`.

---

## 2. The execution path, end to end

Traced at runtime, not inferred from signatures.

```
runStep (agent-step.ts:82)
  :89   resetResultFile(directory)        ← writes template, ONCE. Returns mtime floor.
  :110  run = await runAgent(...)         ← ⟵ THE RETRY LOOP LIVES ENTIRELY IN HERE
          └ loop :328-348, 3 attempts
              └ gatedRun :356  → actionPipeline.execute → agent.run(request)
                                              └ AgentAdapter.run :41 (wraps throws)
                                                  └ doRun → spawnAndParse → child.on("close")
              └ on throw: isRetryable(error) :387 → retry w/ backoff, else return {error}
  :111  parsed = readResult(directory)    ← ⟵ ONLY NOW is the result file consulted
  :120  if (parsed is valid) → mapResult  ← "prefer the work over the error"
  :129  if (run.error)       → failed("agent_unavailable", describe(run.error))
  :136  else                 → failed("no_result", withStrayHint(...))
```

### The four outcome-decision sites inside `spawnAndParse`'s `close` handler

| # | Line | Condition | Today's behavior | `retryable` |
|---|---|---|---|---|
| 1 | `:480` | exit ≠ 0, `resultEvent` present, `subtype !== "error"` | **resolve success** (salvage) | — |
| 2 | `:491` | exit ≠ 0, no salvageable event | reject `cli_error` | **`!isSignalKill`** ✅ |
| 3 | `:503` | exit 0, **no result event at all** | reject `internal_error` | **`false`** ⚠️ |
| 4 | `:508` | exit 0, `subtype === "error"` | reject `internal_error` | **`false`** ⚠️ |

The observed event — `{subtype: "success", is_error: true, result: "API Error: Connection closed
mid-response…"}` — passes site 1 *and* site 4's guard, so it resolves as a **successful run** on the
clean-exit path (`:521`).

---

## 3. New hazards — not in the issue, not in requirements

These are the findings that change how the fix must be built.

### H1. ⚠️ The result event has **no `error` field** — the naive fix destroys the real cause

`claude-code-agent.ts:513` builds its message as:

```ts
`CLI returned error: ${String(parsed.resultEvent["error"] ?? "unknown")}`
```

**Observation.** Claude's result event carries no `error` key. I dumped the keys of the real captured
result event in the repo's own fixture
(`tests/unit/plugins/agent/claude-code-agent/fixtures/claude-stream.ndjson:11`):

```
['type', 'subtype', 'is_error', 'result', 'total_cost_usd', 'session_id']
```

The human-readable cause lives in **`result`** — and in the observed failure, `result` is exactly
`"API Error: Connection closed mid-response. The response above may be incomplete."`

**Inference.** The most natural implementation — "route `is_error: true` into the existing `:508`
rejection" — would surface the message **`"CLI returned error: unknown"`**. That throws away the one
string that names the real cause, and **fails acceptance criterion #5** ("the surfaced failure names
the real cause") while appearing to work: the run *does* fail, it *does* retry, and only the operator-
facing message is silently gutted. A test that asserts only "it throws / it retries" would pass.

**Constraint for design/execution:** the failure message must be sourced from the result event's
**`result`** field (falling back to `error`, then `"unknown"`).

### H2. ⚠️ Site `:503` is a third instance of the same defect class

`"No result event found in CLI output"` (exit 0, stream ended with no result line) is created with
**no options** → `retryable: false`.

**Inference.** A connection dropped *before* the CLI emits its result line — a clean exit with a
truncated stream — lands here and is classified **non-retryable**, producing the identical
"transient failure treated as terminal" outcome the issue is about. The acceptance criteria name only
`:480` and `:508`. This is the same bug wearing a different hat, one line away from the sites in
scope. **Design must make a deliberate call** on whether it is fixed here or tracked; silently leaving
it means an adjacent dropped-connection shape still burns a phase.

### H3. ⚠️ `fakeAgent` does not behave like a real adapter — tests can prove nothing

`tests/helpers/test-mock-pipeline.ts:208`:

```ts
return { run: vi.fn(run), getCapabilities: ..., manifest: { id: "fake-agent" } } as unknown as AgentAdapter;
```

**Observation.** It is a bare object literal **cast**, not an `AgentAdapter` subclass — so it does
**not** inherit `AgentAdapter.run()`'s error wrapping (`agent.ts:41-55`). Every existing failure test
in `agent-step.test.ts` rejects with a **plain `Error`** (`"spawn ENOENT"`, `"SIGTERM"`,
`"killed mid-write"`), which reaches `isRetryable`'s *message heuristic* — a path that, in
production, is **unreachable for anything thrown from a plugin**, because the base class has already
wrapped it into an `AdapterMethodError`.

**Inference.** The fake and production disagree about the exact mechanism this issue turns on. A new
retry test that rejects with a plain `Error("…connection closed…")` would exercise a code path that
cannot occur in production, and would keep passing even if the plugin's `retryable: true` were never
set — precisely the "test that passes when the code it covers is deleted" hazard. **Any regression
test for criterion #2 must throw a real `AdapterMethodError` with an explicit `retryable`,** and
should assert the adapter's `run` was actually *called more than once*.

---

## 4. Confirming Finding 5 — and strengthening it

Requirements said the retry-before-`readResult` ordering causes a **cost** regression but that
"correctness holds". I verified the ordering (§2) and agree on the cost. **I do not think correctness
strictly holds.**

**Observation.** `resetResultFile` runs once at `:89`, before the loop. A retried attempt re-runs the
*same agent with the same prompt in the same directory*.

**Inference.** On attempt 1 the agent writes a valid `session-result.json`, then the connection drops.
Post-fix, the plugin throws retryably, and attempt 2 launches — and that agent will, in the normal
course of doing its job, **overwrite** `session-result.json`. If attempt 2 then dies early or
mid-write, the file that `readResult` (`:111`) finally reads is attempt 2's — possibly a template,
possibly malformed → `"invalid"` → **`no_result`**. So the naive fix can convert a run that *passes
today* into one that *fails*, not merely one that costs 3×.

This raises Finding 5 from a cost concern to a **correctness** constraint, and it is the strongest
argument that the retry must become result-aware (check for a valid result before re-running) rather
than simply be handed a throwing plugin. Distinct from #34's session-resume: this is "don't re-run
work that already landed", not "resume the dead session".

---

## 5. Existing mechanisms to reuse (the best code is the code you don't write)

**Observation.** There is **no** shared transient-classification helper anywhere in `src/` (grep for
`isTransient` / `TRANSIENT` → nothing). `AdapterError.retryable` **is** the convention, and all three
agent plugins already set it:

- `claude-code-agent.ts:494` — `retryable: !isSignalKill` on the `cli_error` path
- `gemini-cli-agent.ts:453, :467` — `retryable: true` on rate-limit and non-zero-exit
- `opencode-agent.ts:393, :406` — same

**Inference.** The owner's instruction to "extend the existing `isRetryable` / `AdapterError.retryable`
convention rather than reinvent it" is well-founded and cheap: the fix is to set an existing flag at
sites that currently omit it, plus classify the error string. Engine-specific classification belongs
**inside the plugin** (Plugin Opacity) — Core already consumes `retryable` generically and needs no
change to honor it.

**Consequence:** Core's `agent-step.ts` may need **no change at all** for criteria #1–#5, *except*
for the result-aware-retry constraint in §4. That is the one place Core must move.

---

## 6. Blast radius — every file that must or may change

### Must change
| File | Why |
|---|---|
| `src/plugins/agent/claude-code-agent/claude-code-agent.ts` | Sites `:480`, `:508` (criteria #1); explicit `retryable` (#2); message from `result` (#5, §H1); site `:503` (§H2, design call) |

### Must change (per §4 — the no-regression constraint)
| File | Why |
|---|---|
| `src/core/orchestrator/pipeline/agent-step.ts` | Retry loop (`:328-348`) must not re-run a run that already wrote a valid result (criterion #7, §4) |

### Critical context — read before touching
| File | What it gives you |
|---|---|
| `src/adapters/errors.ts` | `createAdapterError` (`retryable` defaults **false**), `AdapterMethodError` |
| `src/adapters/agent.ts` | `AgentAdapter.run()` wrapping; `AgentRunResult` has **no** outcome/error channel — a throw is the plugin's only way to report failure |
| `src/schemas/adapters.ts:322` | `AgentRunResultSchema` = `{content, cost_usd, duration_ms, usage}` — the contract that would change if design chooses a typed run-outcome (**`public_api`** decision) |
| `src/core/orchestrator/pipeline/types.ts:31` | `FailureCause` = `no_result \| details_invalid \| agent_failed \| agent_unavailable` |
| `src/core/orchestrator/index.ts:92` | `toBlockReason` — the fork that decides retry-ladder vs. blocked-on-owner |
| `src/core/daemon/task-scheduler.ts:401,484` | The `agent_unavailable` retry ladder + owner alerts |
| `src/schemas/config.ts:213` | `agent_unavailable` budget: `[2,5,10,15,15]` min × 5 attempts |

### Possibly in scope — design's call (owner explicitly delegated "the error signal across engines")
| File | Same defect class |
|---|---|
| `src/plugins/agent/gemini-cli-agent/gemini-cli-agent.ts:81` | `status: "error"` consulted only via rate-limit regex |
| `src/plugins/agent/opencode-agent/opencode-agent.ts` | stream `error` events dropped (`skip`) |

### Tests
| File | State |
|---|---|
| `tests/unit/plugins/agent/claude-code-agent/claude-code-agent.test.ts` (450 L) | Has the pattern to copy: `:237` already asserts `adapterError.retryable === true` for `cli_error`. No mock CLI emits `is_error: true`, and none exits 0 without a result line. |
| `tests/unit/core/orchestrator/pipeline/agent-step.test.ts` (384 L) | Covers `no_result`, stray hint, `agent_unavailable`, partial-write recovery. **Zero retry coverage.** |
| `tests/helpers/contract-suites/agent-contract.ts` (148 L) | ⚠️ **Zero failure-semantics assertions.** Run by 4 plugins. The natural enforcement point if design puts run-outcome on the contract. |
| `tests/helpers/test-mock-pipeline.ts:208` | `fakeAgent` — see §H3. |
| `tests/unit/plugins/agent/claude-code-agent/fixtures/claude-stream.ndjson` | Real captured stream; result event on line 11 carries `is_error:false`. A sibling `is_error:true` fixture is the obvious regression asset. |

**Observation.** `MAX_AGENT_RETRIES`, `RETRY_BASE_MS`, `isRetryable`, `sleep` appear in **zero** test
files. No test drives a fail-then-succeed agent or asserts a retry happened. Criterion #9 is building
on bare ground — and it means the retry loop this fix *depends on* has never itself been verified to
work.

---

## 7. Conventions to follow

Observed in the files I'd touch:

- **Plugin-local, pure, exported helpers**: `processNdjsonLine`, `activityEventsFromLine`,
  `dominantModelId` are exported purely so they can be unit-tested without spawning a process. A new
  classifier (e.g. `isTransientResultError(event)`) should follow exactly this shape — pure, exported,
  module-level, tested directly.
- **Defensive field reads**: every field access on a parsed event is `typeof x === "..." ? x : fallback`.
  Never trust the shape.
- **Structured errors, never bare throws**: `new AdapterMethodError(createAdapterError(code, msg, {retryable, severity}))`.
- **Doc comments explain *why*, not what** — see the `dominantModelId` comment for the house style
  (states the bug it prevents and the cost of getting it wrong).
- **Biome `noExcessiveCognitiveComplexity`** is already suppressed with a *justified* reason on the
  `close` handler (`:452`). Adding branches there will strain it; extracting the outcome decision into
  a pure helper is both the house style and the way to keep the gate green.

---

## 8. Challenging the findings

**What is the genuinely simplest approach?** Judging by §5, remarkably small: read `is_error` at the
two (three, per §H2) sites, classify the `result` string as transient-or-not, and throw
`AdapterMethodError` with `retryable` set explicitly. Core needs no change to *honor* it. The only
Core change forced on us is the §4 result-aware-retry guard. A typed run-outcome on the
`AgentAdapter` contract is *possible* but is a `public_api` change with a 4-plugin contract suite
behind it — design should justify it against the per-plugin mapping, not assume it.

**Are these patterns good, or legacy to avoid copying?** The `subtype`-only check is legacy and
narrow — it misses `error_during_execution` / `error_max_turns` too. Honoring `is_error` subsumes
them. Do not copy the `resultEvent["error"]` message read (§H1) — it reads a field that does not exist.

**What have I not verified?**
- I have **not** observed the exact raw event Claude Code emits for an auth failure or a
  `max_turns` stop. My transient-vs-terminal reasoning rests on the issue's observed event plus the
  fixture. Design's classifier should be built to **fail safe** — an unrecognized `is_error` is still
  a *failure*; the open question is only whether it is retryable, and defaulting an unknown error to
  non-retryable preserves today's escalate-to-owner behavior rather than risking a retry loop.
- I have not run the test suite; I made no code changes, so the gates' current state is unchanged.

**Is there an existing mechanism?** Yes — `AdapterError.retryable` + `agent-step`'s loop + the daemon's
`agent_unavailable` ladder. All three already exist and compose. Nothing new needs inventing; the
retryable flag simply is never set at the sites that matter.

---

## 9. Open questions for the owner

**None.** Every fork I found is either (a) one of the four calls the owner explicitly delegated to
design, or (b) settled by existing deliberate behavior in the code. The two hazards I added (§H1,
§H2) and the strengthened §4 are *implementation constraints*, not choices the owner needs to make —
they narrow the design space rather than open it.
