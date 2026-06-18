# Self-Review — Issue #25: Require an explicit prefix for inbound chat commands

_Review run: 2026-06-18 · Lens: holistic last look (correct, complete, simple). Review only — no code changed._

## Verdict

**Clean. No findings requiring action.** The change is correct, complete against every acceptance
criterion, minimal in scope, and well-tested. Gates verified green in this environment. Details below.

## What I reviewed

`git diff` from base `1a658a0` → HEAD. Nine files, +141/−72:

- `src/core/daemon/query-handler.ts` — the behavior change (classifier) + two user-facing strings + doc-comments
- `src/core/daemon/response-poller.ts` — comments only (no logic change)
- `tests/unit/core/daemon/query-handler.test.ts`, `tests/unit/core/daemon/response-poller.test.ts` — test migration + new cases
- `docs/plugins/communication/README.md`, `docs/plugins/communication/telegram-comm.md`, `docs/user-flows/communication/overview.md` — user-facing docs
- `src/cli/bundled/plugin-docs.ts` — regenerated bundle (the two `docs/plugins/` files mirrored)
- `knip.json` — added `lefthook` to `ignoreDependencies` (lint-gate fix, see note)

## Does it do what was asked?

Walked all 8 acceptance criteria from `requirements.md` against the diff:

- **AC1 (mid-text command words inert → blocked task)** ✅ — `classifyQuery("…should help capture why…") === "unknown"` (unit) **and** the response-poller integration test routes the exact incident-style long reply to `resolver.tryUnblock({ taskId: "task-1", content })` while asserting `notifications.notify` was **not** called. End-to-end, real path.
- **AC2 (prefixed commands work, incl. mid-block)** ✅ — `!status` classified as `status` and routed as a query winning over the sole-blocked reply, tested with 0/1/2+ blocked. `!progress #42` classifies as `progress` and `extractIssueNumber` returns `42`.
- **AC3 (start-anchored only)** ✅ — `COMMAND_RE = /^!(status|cost|help|progress)\b/i`: start-anchored, `\b` token-bounded, `/i` only (no `g`/`y`). Whitespace via `trim()`, casing via `/i` — both tested (`  !STATUS `).
- **AC4 (bare words not commands)** ✅ — `classifyQuery("help"|"status"|"cost"|"progress #42"|"#42 progress") === "unknown"`, all asserted.
- **AC5 (vocabulary unchanged; help text prefixed)** ✅ — `formatHelpResponse` and `formatUnrecognizedResponse` now render `!status`/`!progress #N`/`!cost`/`!help`; the help-text test asserts the **literal** prefixed strings, so the prefix render is genuinely exercised (not masked by the `"status" ⊂ "!status"` substring overlap).
- **AC6 (docs updated, archived untouched)** ✅ — all three active docs reworded from bare-word to `!`-prefixed and from the "slash-free" rationale to the `!`-prefix rationale; bundle regenerated and byte-for-byte guard passes; `docs/archived/**` untouched.
- **AC7 (tests)** ✅ — see "tests prove the real path" below.
- **AC8 (gates)** ✅ — re-run this review (below).

## Does it earn its keep?

Yes — this is a tight, minimal change.

- **No new files, no new abstraction, no config knob.** Approach A (narrow the classifier in place). The substring `includes()` if-chain is replaced by one regex + one `#N` guard. `grep 'includes("status"|"cost"|"help"|"progress"' src` → none; the old matcher is gone, not shadowed.
- **`COMMAND_PREFIX` constant correctly dropped** — execution noted it would be an unused variable (biome `correctness/noUnusedVariables` is an error) since `!` is encoded in the regex literal. The intent lives in the doc-comment. Right call.
- **`response-poller.ts` is comments-only** — its precedence was already correct and tested; it inherits the new rule through `isQueryVocabulary`. No unrequested routing refactor. Good restraint.
- **`match[1]?.toLowerCase()`** — the `?.` is the idiomatic way to satisfy strict TS without a non-null assertion (biome `noNonNullAssertion` is on); the unreachable-`undefined` branch falls through to the catch-all `return "unknown"`. Not over-defensive given the tsconfig.

## Would it surprise the next reader?

No.

- Names are accurate (`classifyQuery`, `COMMAND_RE`, `isQueryVocabulary` unchanged contract).
- The two non-obvious decisions carry load-bearing comments: why no `g`/`y` flag (statefulness across `.exec`/`.test`), and why `!progress` requires `#N` (preserves the `progress ⇔ extractable number` invariant so `extractIssueNumber` never returns `#undefined`).
- `extractIssueNumber` reuses `PROGRESS_RE` unchanged; it is only reached for the `progress` kind, which `classifyQuery` only returns after `PROGRESS_RE.test` already passed — so the match and capture group are guaranteed. The pre-existing `as string` cast is untouched (not in scope).

## Correctness spot-checks (regex edge cases traced by hand)

| Input | Result | Correct? |
|---|---|---|
| `!status` / `!cost` / `!help` | that command | ✅ `\b` at end-of-string |
| `!STATUS ` (case + trailing space) | `status` | ✅ `/i` + `trim()` |
| `!status please` | `status` | ✅ `\b` before space |
| `!help me with status` | `help` (start-anchored beats mid-text `status`) | ✅ |
| `!helpme` / `!statuses` | `unknown` | ✅ no `\b` between keyword and trailing word-char |
| `! status` (gap after prefix) | `unknown` | ✅ no `\s*` in regex; "immediately followed" honored |
| `!progress` (no `#N`) | `unknown` | ✅ `PROGRESS_RE.test` fails → unknown (no 404 with `#undefined`) |
| `!progress #42` | `progress`, extracts `42` | ✅ |
| `…that help capture…` (incident) | `unknown` → sole-blocked reply | ✅ |

## Tests prove the real path (not a fallback)

The negatives are the proof: `classifyQuery("help") === "unknown"`. Reverting the classifier to `includes("help")` makes that return `"help"`, turning the suite red — so the test exercises the actual prefix requirement, not a default that would pass regardless. The incident integration test asserts the real unblock call with the real content. This defeats the "test still passes when the code is deleted" anti-pattern.

## What ships (whole commit, not just the diff)

- `git status`: clean except untracked `thoughts/` (engineer-workspace deliverables — correctly not committed to the feature branch).
- No stray files, no generated output beyond the intended `plugin-docs.ts` regen, no debug logging, no leftover scaffolding.
- Branch is exactly two commits ahead of base: `d7fa004` (feature) + `ecb3b1b` (lint fix).

## Note on the `knip.json` change (checked, acceptable — not a finding)

`knip.json` adds `lefthook` to `ignoreDependencies`. This is **outside the feature's strict scope** but is a
justified gate fix: knip's lefthook plugin only counts the binary as "used" when `process.env.CI` is set, and
the verification harness runs `pnpm run lint` **without** `CI`, so without this entry the required lint gate
is red (a pre-existing condition introduced by ancestor commit `66ff148`, not by this feature). `lefthook` is
genuinely used (git-hooks runner in `lefthook.yml`, declared in `onlyBuiltDependencies`, never imported in
`src/**`), so excluding it from unused-dependency analysis is the correct classification and matches the
existing convention in that list. Execution surfaced this as a `dependencies` discretionary decision and the
**owner explicitly approved it** (execution re-run 4). It reverts the *effect* of a deliberately-titled owner
commit, which is exactly why it was surfaced — and it is now settled. I agree with the call; flagging only for
visibility, not as an action item.

## Gates re-run this review (exactly as the harness runs them)

| Gate | Command | Result |
|---|---|---|
| lint (incl. typecheck ×2, knip, madge) | `pnpm run lint` (no `CI` set) | **exit 0** — 3 pre-existing biome cognitive-complexity warnings in untouched files (warnings, not errors) |
| relevant unit tests + bundle guard | `vitest run query-handler.test.ts response-poller.test.ts plugin-docs.test.ts` | **45 passed** |

The bundled-docs byte-for-byte guard (`plugin-docs.test.ts`) passes, confirming the regenerated bundle matches the edited source docs (no drift; CI's `git diff --exit-code` would also be clean).
