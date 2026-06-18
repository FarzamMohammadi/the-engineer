# Refine — Issue #25: Require an explicit prefix for inbound chat commands

## Pass 1 — 2026-06-18

_Final quality gate. Consolidated the review lenses, re-derived correctness/completeness from the
actual code (not the lens summaries), ran the project's gates myself, and checked the one end-to-end
risk the unit tests cannot cover. **No code changes were needed — nothing to fix or commit.**_

### Verdict: **ship**

The change is correct, complete against every acceptance criterion, minimal, well-tested, and viable
end-to-end. Gates re-run green in this environment. The single review lens (self-review) reported
"clean, no findings"; that verdict holds up under independent scrutiny.

---

### Lenses consolidated

Only one lens ran: **self-review** (`../self-review/findings.md`) — "Clean. No findings requiring
action." I did not take that on faith. I re-traced every claim against the diff and the live source.
Every claim checked out. No duplicate or non-holding findings to drop, because there were no findings.

### What I verified independently (assume-issues-exist, then disprove)

1. **Classifier logic — correct.** `COMMAND_RE = /^!(status|cost|help|progress)\b/i`
   (`src/core/daemon/query-handler.ts:30`). Start-anchored (`^`), prefix-then-keyword, `\b` token
   boundary, case-insensitive, **no** `g`/`y` flag (so `.exec`/`.test` are not stateful across calls).
   Traced edge cases by hand: `!help me`→help, `!helpme`→unknown, `! status`→unknown (no `\s*`, so
   "immediately followed" is honored), `…that help capture…`→unknown.

2. **`!progress` `#N` invariant — preserved.** `classifyQuery` returns `"progress"` only when
   `PROGRESS_RE.test` passes (`query-handler.ts:43`); `extractIssueNumber` reuses the *same*
   `PROGRESS_RE` (`:157`), so `match?.[1] ?? match?.[2]` is always a real number. The pre-existing
   `as string` cast is safe under this invariant and is untouched (correctly out of scope).

3. **Migration is complete, not shadowed.** `grep -rE 'includes\("(status|cost|help|progress)"\)' src`
   → **none**. The old substring matcher is gone, not merely bypassed. The only callers of
   `classifyQuery`/`isQueryVocabulary` are `query-handler.ts` and `response-poller.ts:84` — both
   exercise the new path.

4. **Incident path is tested on the REAL route, not a fallback.** Unit:
   `classifyQuery("…should help capture…") === "unknown"`. Integration
   (`response-poller.test.ts`): the exact incident-style long reply routes to
   `resolver.tryUnblock({ taskId: "task-1", content })` **and** asserts `notifications.notify` was
   NOT called. Reverting the classifier to `includes("help")` would flip the suite red, so the test
   pins the actual prefix requirement.

5. **End-to-end viability (the one thing unit tests can't prove).** The Telegram plugin drops only
   `/`-prefixed messages (`telegram-comm.ts:237` `msg.text.startsWith("/")`). A `!`-prefixed command
   is **not** dropped and reaches Core's `classifyInbound`. So the deliberate choice of `!` over `/`
   is validated through the transport, not just in the isolated classifier — the feature is not dead
   on arrival.

6. **All 8 acceptance criteria** map to assertions in the diff (mid-text inert → blocked task;
   prefixed commands incl. mid-block; start-anchored; bare word not a command; vocabulary unchanged +
   help text prefixed; 3 active docs updated + archived untouched; tests; gates).

7. **Docs + bundle.** Three active docs reworded to the `!` form; `docs/archived/**` untouched;
   `pnpm run docs:bundle` regenerates `plugin-docs.ts` with **zero drift** (CI's `git diff --exit-code`
   would be clean). Remaining doc hits for "status"/"help" are unrelated (`engineer status` CLI, agent
   event types, observability span status) — correctly left alone.

### Gates re-run (exactly as the harness runs them, `CI` unset)

| Gate | Command | Result |
|---|---|---|
| lint (biome + tsc ×2 + knip + madge) | `pnpm run lint` | **exit 0** (3 pre-existing knip cognitive-complexity warnings in untouched files — warnings, not errors) |
| affected unit tests | `vitest run query-handler.test.ts response-poller.test.ts` | **43 passed** |
| bundled-docs byte guard | `vitest run plugin-docs` | **2 passed** |
| bundle drift | `pnpm run docs:bundle` then `git diff` | **in sync, no drift** |

### Considered and dismissed (non-blockers — not fixed by design)

- **`!progress` with no `#N` → routes as the sole-blocked reply when one task is blocked.** This is
  identical to the pre-change behavior (bare `progress` without `#N` was already `unknown`), it is
  consistent with the documented routing precedence, and it is the correct call when a task is blocked
  (an unrecognized message is the answer to the one open question). A minor UX edge, not a regression.
- **`knip.json` adds `lefthook` to `ignoreDependencies`.** Outside the feature's strict scope, but a
  **settled** decision: execution surfaced it as a `dependencies` discretionary call and the owner
  explicitly approved it (execution re-run 4) because the lint gate is red outside CI without it
  (`lefthook` is a real git-hooks runner, never imported in `src/**` — correct classification). It is
  already decided by the owner, so I am neither undoing it nor re-surfacing it. Lint passes with it.

### Why ship (not a rework)

No root cause lives in an earlier phase. Requirements were clear and fully met; the approach (narrow
the classifier in place — one regex + one `#N` guard, no new files/abstraction/config) is sound; the
implementation is correct, complete, and minimal. There is nothing to patch here and no earlier phase
to send it back to. Deliver it.
