# Execution — Issue #25: Require an explicit prefix for inbound chat commands

_Phase run: 2026-06-15 · Builds on requirements + research + plan. Source: github_issue FarzamMohammadi/the-engineer#25_

## What I built

The classifier `classifyQuery` in `src/core/daemon/query-handler.ts` no longer substring-matches command
words anywhere in a message. A message is now a command **only** when, after `trim()`, it starts with the
`!` prefix immediately followed by a known keyword token (start-anchored, case-insensitive, `\b`
token-bounded). Everything downstream (`isQueryVocabulary`, `handleQuery`, the poller's `classifyInbound`
precedence) inherits the new rule unchanged because it all delegates to `classifyQuery`. The incident's
free-text reply ("...changes that **help** capture...") now classifies as `unknown` and routes to the sole
blocked task instead of the help menu.

This followed Approach A from the plan (narrow the classifier in place); no new files, no new abstraction,
no config knob.

## Changes (one logical commit)

**Behavior — `src/core/daemon/query-handler.ts`**
- Replaced the unanchored `includes()` if-chain + loose `PROGRESS_RE.test` gate with a single
  start-anchored regex `COMMAND_RE = /^!(status|cost|help|progress)\b/i`.
- `classifyQuery`: `trim()` → match `COMMAND_RE` → `unknown` on no match. For `progress`, still requires an
  extractable `#N` (`PROGRESS_RE.test`) so the existing `progress ⇔ extractable number` invariant holds and
  `extractIssueNumber` never returns `#undefined`. `status`/`cost`/`help` return directly.
- `extractIssueNumber`, `formatResponse`, and all formatters left unchanged in logic.
- Reworded the stale `QueryKind` ("Slash-free by design") and `isQueryVocabulary` doc-comments to the
  `!`-prefix, start-anchored rationale.
- `formatHelpResponse` and `formatUnrecognizedResponse`: user-facing strings now show the prefixed forms
  (`!status`, `!progress #N`, `!cost`, `!help`) so they never instruct the owner to use the now-inert bare
  form (AC #5).

**Prose parity — `src/core/daemon/response-poller.ts`** (comments only, no logic change)
- Two doc-comments that spelled the vocabulary as bare `status/cost/progress/help` now use the `!`-prefixed
  forms. `classifyInbound` precedence is unchanged — it was already correct and tested.

**Tests**
- `tests/unit/core/daemon/query-handler.test.ts`: positives moved to `!`-prefixed; added negatives that
  prove the prefix is *required* (`classifyQuery("help") === "unknown"`, the incident prose, bare
  `status`/`cost`/`progress #42`/`#42 progress`), token-boundary cases (`!helpme`, `!statuses`, `!foo`,
  `! status`, `!progress` without `#N`), and whitespace/case tolerance (`  !STATUS `). Help-text test now
  asserts the **literal** `!status` / `!progress #N` / `!cost` so the prefix render is genuinely exercised
  (not masked by substring overlap).
- `tests/unit/core/daemon/response-poller.test.ts`: `classifyInbound` query case → `!status`; added the
  incident case and `!foo` → `sole_blocked_reply`. Integration `runWithMessage` query cases → `!status`;
  added an end-to-end incident test proving a free-text reply containing "help" calls
  `resolver.tryUnblock` (with the content) and does **not** call `notifications.notify` (AC #1).

**Docs (user-facing) + bundle**
- `docs/plugins/communication/README.md` — "Inbound queries": vocabulary table and "Query vs. unblock
  reply" precedence reworded to the `!`-prefix rule; "slash-free" framing replaced.
- `docs/plugins/communication/telegram-comm.md` — "Querying from Telegram": prefixed forms + `!`-prefix
  rationale (distinct from Telegram's native `/`-commands, which the plugin still drops). The transport
  line ("Filters out bot commands ... starting with `/`") left as-is — still accurate.
- `docs/user-flows/communication/overview.md` — key-files row, the classify diagram, and the vocabulary
  list → prefixed forms; added the inert-mid-text note.
- Regenerated `src/cli/bundled/plugin-docs.ts` via `pnpm run docs:bundle` (the two `docs/plugins/` files are
  byte-mirrored there). Verified the render is idempotent and the byte-for-byte drift test passes.
- `docs/archived/**` left untouched (historical build journal, out of scope).

## Deviation from the plan (noted)

The plan listed adding `const COMMAND_PREFIX = "!"`. I dropped it: the `!` is already encoded in the regex
literal `COMMAND_RE`, so a separate constant would be **unused**, and biome runs with `"all": true`
(`correctness/noUnusedVariables` is an error) — it would fail lint as dead code. The prefix's intent lives
in the regex's doc-comment instead. The requirements explicitly allowed "a named constant is fine" but did
not require one; an unused constant earns nothing ("complexity must earn its place").

Second small deviation: the plan's illustrative `classifyQuery` ended with `return keyword as QueryKind`.
Under strict TS, `match[1]` is `string | undefined` and the cast would also mask a future typo. I used
explicit equality checks (`keyword === "status" || ...`) that narrow to the literal types — no cast, no
non-null assertion (biome's `noNonNullAssertion` is on), and the final `return "unknown"` is the catch-all.

## Gates (all green)

- `pnpm run typecheck` → exit 0.
- `pnpm run lint` (`biome check` + both tsc + knip + madge) → exit 0 **when run as CI runs it**
  (`CI=true`). See the note below — this is not a wave-off.
- `pnpm test` → 139 files, **2632 tests passed**, including the bundled-docs byte-for-byte guard.

### The knip/lefthook gate detail (investigated, not waved off)

Running `pnpm run lint` locally **without** `CI` set reports `lefthook` as an unused devDependency and
exits non-zero. I confirmed this is **pre-existing and unrelated to this change**: with all my edits
stashed (working tree at HEAD `1a658a0`), `knip` reports the identical failure.

Root cause, read from `node_modules/knip/dist/plugins/lefthook/index.js`: the lefthook plugin only marks
the `lefthook` binary dependency as "used" when `process.env.CI` is set —
`const lefthook = process.env.CI ? enablers.filter(...) : []`. GitHub Actions sets `CI=true`, so the gate
is green in CI (where it is enforced). Locally, the env var is absent, so knip flags it. Running the gate
in the same environment CI uses — `CI=true pnpm run lint` — passes fully (biome, both typechecks, knip,
madge all green; the only output is 3 pre-existing biome cognitive-complexity *warnings*, not errors, in
files I did not touch). The repo's `lefthook.yml` is present and valid; nothing about lefthook needs fixing.

## Completeness checks (proved, not assumed)

- `grep includes("status"|"cost"|"help") src` → none (the substring matcher is gone, not shadowed).
- No user-facing string in `query-handler.ts` instructs the owner to send a bare command.
- No active doc (`docs/**` minus `docs/archived/**`) presents a bare command form for the chat vocabulary.
  (Remaining bare `status` hits in `docs/cli.md`, `gemini-cli-agent.md`, `observability.md` are the
  `engineer status` CLI command and tool-result field names — unrelated surfaces.)
- `src/cli/bundled/plugin-docs.ts` is a clean, idempotent `docs:bundle` render (CI's
  `git diff --exit-code` passes).

## Outcome

ok — change complete, all gates green, committed.

---

## Re-run 2 (2026-06-15) — fix the red `lint` gate

### What the verification flagged

The prior pass reported `ok` while `pnpm run lint` was actually **red** — exactly the "success around a
red gate" anti-pattern. The failure:

```
knip → Unused devDependencies (1): lefthook  package.json:100:6
ELIFECYCLE Command failed with exit code 1
```

The prior pass diagnosed this correctly (knip's lefthook plugin is `CI`-gated) but then *waved it off* as
"pre-existing, passes with `CI=true`" and shipped `ok`. The verification harness runs `pnpm run lint`
**without** `CI` set, so the gate is genuinely red there. That is a failure to fix, not a warning. This
re-run fixes it.

### Root cause (re-verified at the source, not inherited)

- `node_modules/knip/dist/plugins/lefthook/index.js`: for a `.yml` config, the plugin counts the
  `lefthook` binary as a *used* dependency only via `process.env.CI ? enablers.filter(...) : []`. Outside
  CI it returns `[]`, so `lefthook` (a `devDependency`) is reported unused.
- `lefthook.yml`'s `run:` commands invoke `pnpm biome` / `pnpm tsc` / `pnpm check:exports` /
  `pnpm check:circular` / `pnpm vitest` — never the `lefthook` binary — so the plugin's non-CI
  script-scan path can't find it either.
- Commit `66ff148` ("Remove lefthook from knip's ignoreDependencies", an ancestor of `origin/main`, 2
  commits before this branch's base) deleted `lefthook` from `ignoreDependencies`. That is what made
  `pnpm run lint` fail for every non-CI run.
- Reproduced both directions: `npx knip` → **exit 1** (flags lefthook); `CI=true npx knip` → **exit 0**.
  Independent of this branch's feature change.

### Fix (commit `ecb3b1b`)

Re-added `"lefthook"` to `ignoreDependencies` in `knip.json` (restores the pre-`66ff148` state). This is
the correct classification and matches the repo's own convention: `ignoreDependencies` already lists many
tooling/runtime-only deps that aren't imported in `src/**` (`pino-roll`, `tailwindcss`, the `@radix-ui/*`
set, etc.). `lefthook` is genuinely *used* — it is the git-hooks runner, configured in `lefthook.yml` and
declared in `onlyBuiltDependencies` — just never imported as code. Listing it makes the gate robust in
every environment instead of relying on the fragile `CI`-gated detection.

I chose this over the alternatives: editing the `lint` script to force `CI` semantics (changes build
tooling, out of scope) or adding a contrived `lefthook` invocation to `lefthook.yml` just to satisfy
knip's scanner (a hack that alters hook behavior). One-line config restore is the smallest correct fix.

**This reverts the effect of a recent, deliberately-titled owner commit (`66ff148`)** — surfaced as a
discretionary decision (`details.decisions`, category `dependencies`) so the owner can confirm or veto via
their autonomy policy.

### Gates (re-run, all green)

- `pnpm run lint` **without `CI` set** (exactly how the harness runs it) → **exit 0**. Only output: 3
  pre-existing biome cognitive-complexity *warnings* in files this task never touched (warnings, not
  errors — they do not fail the gate).
- `pnpm test` → **139 files, 2632 tests passed**, including the bundled-docs byte-for-byte guard.
- `pnpm run docs:bundle` then `git diff --exit-code src/cli/bundled/plugin-docs.ts` → clean (bundle in
  sync; no doc drift).

### State

- Feature change: commit `d7fa004` (unchanged, intact).
- Lint fix: commit `ecb3b1b`.
- `git status`: clean except untracked `thoughts/` (the engineer-workspace deliverables, intentionally not
  committed to the source branch — the prior phase left them untracked too; committing internal planning
  docs into the PR branch would be wrong).

ok — lint gate now genuinely green in the verification environment; both commits in place.

---

## Re-run 3 (2026-06-18) — independent verification of the committed work

This pass found the work already committed (commits `d7fa004` feature + `ecb3b1b` lint fix) with the
`session-result.json` reset to a placeholder template. Rather than inherit the prior passes' claims, I
re-checked every gate and acceptance criterion at the source. Nothing needed changing — the work is
complete and correct — so this pass only re-verified and finalized the result.

### Re-verified at the code level (not inherited)

- `src/core/daemon/query-handler.ts` — confirmed `COMMAND_RE = /^!(status|cost|help|progress)\b/i` is
  start-anchored, `\b`-token-bounded, case-insensitive, **no `g`/`y` flag**. `classifyQuery` trims, matches,
  returns `unknown` on no match; `progress` still requires an extractable `#N` via `PROGRESS_RE.test`;
  `status`/`cost`/`help` returned via explicit equality (no `as` cast, no non-null assertion). The substring
  `includes()` matcher is gone (`grep 'includes("status"|"cost"|"help")' src` → none).
- `formatHelpResponse`/`formatUnrecognizedResponse` — render the `!`-prefixed forms; no bare command form
  instructs the owner anywhere in the file.
- Tests genuinely prove the acceptance criteria, not by substring coincidence:
  - `classifyQuery("help"|"status"|"cost"|"progress #42"|"#42 progress") === "unknown"` (prefix **required**).
  - The incident prose `"...should help capture why..."` → `unknown` (unit) **and** the response-poller
    integration test routes that exact long reply to `resolver.tryUnblock({ taskId: "task-1", content })`
    while asserting `notifications.notify` was **not** called (AC #1, end-to-end).
  - Token boundary: `!helpme`/`!statuses`/`!foo`/`! status`/`!progress` (no `#N`) → `unknown`.
  - `!status` wins over the sole-blocked reply (AC #2/#5) and is routed as a query with 0, 1, and 2+ blocked.
  - The `!help` text test asserts the **literal** `!status`/`!progress #N`/`!cost` (so the prefix render is
    truly exercised, not masked by `"status" ⊂ "!status"`).

### Gates (re-run this pass, all green)

| Gate | Command (exactly as the harness runs it) | Result |
|---|---|---|
| typecheck | `pnpm run typecheck` | exit 0 |
| lint | `pnpm run lint` (no `CI` set) | exit 0 — 3 pre-existing biome cognitive-complexity *warnings* in untouched files, no errors |
| test | `pnpm test` | **139 files, 2632 tests passed**, incl. the bundled-docs byte-for-byte guard |
| docs drift | `pnpm run docs:bundle` then `git diff --exit-code src/cli/bundled/plugin-docs.ts` | clean (idempotent render) |

### Docs re-checked

- README/telegram-comm/overview all show the `!`-prefixed vocabulary; the "slash-free" framing is reworded
  to the `!`-prefix rationale. The only remaining "no leading" hit in active docs is `no leading @` for a
  Telegram username in `operator-setup.md` — unrelated to the command vocabulary, correctly left alone.
- `src/cli/bundled/plugin-docs.ts` contains the `!status` table (2 occurrences) and is a clean render.

### State

- Branch is ahead of `origin/main` by exactly the two task commits: `d7fa004`, `ecb3b1b`. No new commit was
  needed this pass — the work was already complete and correct, and a no-op verification produces no diff.
- `git status`: clean except untracked `thoughts/` (engineer-workspace deliverables; the orchestrator reads
  them from disk — they are deliberately not committed into the feature/PR branch, consistent with both
  prior passes and the feature commit, which excluded them). No modified tracked files are uncommitted.

### Carry-forward decision (still surfaced for the owner)

The `ecb3b1b` lint fix re-adds `lefthook` to `knip.json`'s `ignoreDependencies`, which reverts the *effect*
of owner commit `66ff148` ("Remove lefthook from knip's ignoreDependencies"). I reviewed and agree with the
fix: `lefthook` is genuinely used (the git-hooks runner in `lefthook.yml`, declared in
`onlyBuiltDependencies`, never imported in `src/**`), and knip's auto-detection only counts it as used when
`CI` is set — so without the ignore entry, `pnpm run lint` is red in every non-CI environment (a
pre-existing main-branch issue, not introduced by this feature). The fix is the minimal correct way to make
the required lint gate green everywhere. Because it does revert the effect of a deliberately-titled owner
commit, I carry it forward as a `dependencies` discretionary decision in `session-result.json` so the
owner's autonomy policy can confirm or veto it — it was surfaced by the prior pass too.

ok — independently verified; all gates green; both task commits in place; nothing to re-commit.

---

## Re-run 4 (2026-06-18) — owner confirmed the lefthook/knip decision; final verification

The owner answered the carried-forward discretionary decision (the `ecb3b1b` lint fix). Their answer is
authoritative:

> "Yes, proceed. Re-adding lefthook to knip's ignoreDependencies is the correct classification: lefthook is
> a real, used dependency (devDependency, in onlyBuiltDependencies, drives the lefthook.yml pre-commit
> hooks) that is simply never imported in src/, so excluding it from knip's unused-dependency analysis is
> right and matches the existing convention in that list. Reverting 66ff148 is intended — that commit
> removed an entry it should have kept. Go ahead."

**Effect on this pass:** the lefthook/knip call is now *settled* by the owner, not an open choice. Per the
decision-surfacing rule, a choice the owner has already decided for you is **not** re-surfaced in
`details.decisions` (doing so would re-ask an answered question). It is recorded here in prose and carried
as a finished fact. `session-result.json` for this pass therefore reports `ok` with **no** open decisions.

### State confirmed at the source (not inherited)

- `knip.json:13` — `"lefthook"` is present in `ignoreDependencies` (the `ecb3b1b` fix the owner approved).
- `src/core/daemon/query-handler.ts:30` — `COMMAND_RE = /^!(status|cost|help|progress)\b/i` (start-anchored,
  `\b`-bounded, case-insensitive, no `g`/`y` flag). `classifyQuery` (35) trims → matches → `unknown` on no
  match; `progress` still gated on an extractable `#N` via `PROGRESS_RE.test` (43). `extractIssueNumber`
  still reuses `PROGRESS_RE` (157).
- `grep 'includes("status"|"cost"|"help")' src` → none (substring matcher gone, not shadowed).

### Gates re-run this pass (exactly as the harness runs them)

| Gate | Command | Result |
|---|---|---|
| typecheck | `pnpm run typecheck` | exit 0 |
| lint | `pnpm run lint` (no `CI` set) | exit 0 — 3 pre-existing biome cognitive-complexity *warnings* in untouched files, no errors |
| test | `pnpm test` | **139 files, 2632 tests passed**, incl. the bundled-docs byte-for-byte guard |
| docs drift | `pnpm run docs:bundle` then `git diff --exit-code src/cli/bundled/plugin-docs.ts` | clean (idempotent render, exit 0) |

### Final state

- Branch ahead of `origin/main` by exactly the two task commits: `d7fa004` (feature) + `ecb3b1b` (lint fix,
  owner-approved). No new commit was needed — the code is complete and correct, and a no-op verification
  produces no diff.
- `git status` clean except untracked `thoughts/` (engineer-workspace deliverables; deliberately not
  committed into the feature/PR branch, consistent with every prior pass and the feature commit).

ok — owner-confirmed decision absorbed; all gates green; both task commits in place; no uncommitted source
changes; nothing left to do.
