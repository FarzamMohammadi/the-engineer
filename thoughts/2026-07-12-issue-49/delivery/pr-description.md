# Delivery — Issue #49

> Phase: delivery · 2026-07-12 · run 1
> Source: `git diff main...HEAD` (5 commits), requirements, and the refine trail.

## PR Title

```
Fail an errored agent run so transient blips retry, not burn the phase
```

## PR Body

---

When an agent run dies to a transient infrastructure failure — a dropped API connection, a server
error, a rate limit — the Claude Code plugin reported it as a **successful** run. It decided the
outcome from the result event's `subtype` alone, so the observed event
`{"subtype": "success", "is_error": true, "result": "API Error: Connection closed mid-response..."}`
sailed through as a success. Core then found `session-result.json` untouched, failed the phase with
`no_result` — *"the agent didn't write its result"* — and parked the task on the owner, blaming the
agent for an infrastructure failure. The transient-retry machinery in `agent-step` already existed;
it just was never told the run had failed. This makes the plugin honor the engine's own error signal,
classify the failure, and let that existing retry loop absorb the blip. Observed cost of one
occurrence: ~$2.28 and ~8 minutes of work discarded, plus a manual `engineer retry`.

### How

- **Honor `is_error` regardless of `subtype`.** A new `classifyResultEvent` is the single place the
  run outcome is decided, and it is applied at **both** sites that previously read `subtype`: the
  clean-exit path and the non-zero-exit *salvage* path (which was happily salvaging errored events).
  It also subsumes the `error_during_execution` / `error_max_turns` subtypes the old
  `subtype === "error"` check missed. `is_error` is compared strictly against `true` — it is absent on
  healthy events, and a truthiness check would have failed those runs.
- **Retryability is set explicitly, not left to default.** `AdapterMethodError`'s `retryable` defaults
  to `false`, and `agent-step`'s `isRetryable` short-circuits on it — so merely *throwing* would have
  swapped one burned phase for another. The plugin passes `retryable: verdict.retryable` into
  `createAdapterError`, which is what actually makes the retry loop fire.
- **Transient vs. terminal is an allowlist.** `TRANSIENT_RUN_ERROR` matches dropped connections, socket
  resets, timeouts, rate limits, and 429/5xx **in an error context** (`API Error: 429`, `status code
  502`, `HTTP 502`). Requiring the error context is deliberate: a bare word-boundary match also fires on
  the `500` in *"processed 500 files"*, and a false transient is the expensive direction to be wrong in.
  Anything unrecognized — an auth failure, a rejected action — is terminal and escalates as it does
  today, rather than looping and burning money on a deterministic fault.
- **A clean exit with no result event is a truncated stream** — the same dropped connection landing a
  moment earlier — so it now fails retryably as `cli_error` with a message that names the cause,
  instead of `internal_error` / *"No result event found in CLI output"*.
- **The retry never destroys completed work.** `resetResultFile` runs once *before* the retry loop, so
  a run that wrote a valid `session-result.json` and *then* lost the connection would have had its work
  overwritten by a retry. A `hasValidResult` guard inside the loop hands the error back instead, and
  `runStep`'s existing prefer-the-work-over-the-error policy uses it. Without this the fix would have
  introduced a cost regression — up to 3 full runs to reach an answer already sitting on disk.
- **Engine specifics stay in the plugin.** Core reads only `retryable`; no adapter-contract change.

### Verification

All four gates green: `pnpm run lint`, `pnpm run typecheck`, `pnpm test` (**2870 passed / 148 files**),
`pnpm run test:integration` (**67 passed / 8 files**). `pnpm run docs:bundle` was re-run, since
`src/cli/bundled/plugin-docs.ts` embeds the plugin doc as a string literal and would otherwise ship stale.

New regression coverage, one test per acceptance criterion:

- `is_error: true` + `subtype: "success"` (the observed event) → a **retryable** failure — the defect itself.
- The non-zero-exit salvage path no longer salvages an errored result event.
- A transient failure retries and the sub-phase then **completes normally** — no `no_result`, no owner.
- A non-transient error is terminal and is **never** retried.
- Retries exhausted → the surfaced failure **names the API cause**, never `no_result`.
- A run that errored *after* writing a valid result is **not** re-run.
- `classifyResultEvent` / `isTransientRunError` unit tables, including count-prose guards
  (*"processed 500 files"*, *"migrated 502 records"*) that must stay terminal.

Worth a reviewer's own eye: **the validation boundary is deliberately untouched.** The pre-existing
`no_result` tests (untouched template, malformed file, missing file) still pass exactly as before — a
run that genuinely produced no valid result still fails, stray-result hint included. This change only
alters *why* we conclude the result is missing, and retries what is retryable.

### Risks and follow-ups

- **Cost is not attributed for a run that ends in error.** `emitAgentCost` only fires on success, so a
  failed run's spend never reaches the ledger the budget guardrails read. The sharp edge: a run that
  errored *after* writing a valid result now books **$0** where it previously booked its real spend —
  the sub-phase still succeeds and the work is still used, but the ledger under-counts. Documented in
  the plugin's Limitations. The real fix is carrying spend on the adapter error — an `AgentAdapter`
  contract change, which is a `public_api` call I check first, so it is deliberately out of scope.
  **Worth a follow-up issue.**
- **`isSignalKill` is likely half-dead** (`claude-code-agent.ts`): it tests `code === 137 || code === 143`,
  but Node reports a signal-killed child as `code === null` with the signal in a separate argument —
  `137`/`143` are *shell* conventions that only appear behind a wrapper. So the direct signal case falls
  through as retryable, contradicting the doc's "signal kills are not retried". Pre-existing, untouched by
  this diff, and practically inert (on our own abort, `agent-step` checks `ctx.signal?.aborted` before
  retrying). Noted, not fixed — it deserves its own issue.
- **The sibling plugins share the defect class.** `gemini-cli-agent` consults a `status: "error"` result
  only through a rate-limit regex; `opencode-agent` drops stream `error` events on the floor entirely.
  Both treat "process exited 0" as success. Not fixed here — this fix was scoped to be small and
  independently shippable, and Claude Code is the default plugin where the bug was observed.
- **Session resume stays out of scope** (belongs to #34). A retry here restarts the sub-phase cold; it
  does not resume the dead session, so a cut-off run's in-context work is still lost.
- **The transient allowlist is a heuristic on message text.** It fails safe — an unrecognized transient
  classifies terminal and escalates, exactly as today — so the failure mode is a missed retry, never a
  retry storm. Expect to widen it as new error shapes show up in the wild.

---

## Notes on how this was written

The body describes the whole PR as it now stands, not round-by-round. The bare-status-code shapes in
the allowlist (`status code 502`, `Error code: 529`, `HTTP 502`), the `cli_error` code on the
truncated-stream path, and the cost-attribution limitation all came out of the review round
(`review/refine/refinements.md` F1–F4) and are folded in as if they landed with the original work.

The two follow-ups above (cost-on-error attribution, `isSignalKill`) are honest gaps the reviewer
should see. Neither is a regression against `main` except the cost-attribution edge, which is called
out explicitly rather than buried.
