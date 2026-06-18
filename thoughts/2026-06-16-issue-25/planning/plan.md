# Plan — Issue #25: Require an explicit prefix for inbound chat commands

_Phase run: 2026-06-16 · Builds on `requirements/requirements.md` + `research/research.md`. Source: github_issue FarzamMohammadi/the-engineer#25_

## Verification of prior phases (what I re-checked, not inherited)

I opened every file the research cites and confirmed its claims at the line level before planning:

- `src/core/daemon/query-handler.ts` — `classifyQuery` (22-37) is exactly the unanchored substring/regex
  matcher described; `isQueryVocabulary` (44-46) delegates to it; `extractIssueNumber` (143-146) reuses
  `PROGRESS_RE` (19) on the raw content; `formatHelpResponse` (236-244) enumerates the bare vocabulary.
- `src/core/daemon/response-poller.ts` — `classifyInbound` (80-92) precedence is linked → query-vocabulary
  → sole-blocked → none/multi, routing through `isQueryVocabulary`. Confirmed it needs **no logic change**.
- Both unit tests assert the old substring behavior at the exact lines listed (query-handler.test.ts
  57-207; response-poller.test.ts 118-147, 369-435).
- `telegram-comm.ts:230-239` drops `/start` and `/`-prefixed messages and passes everything else
  (including `!`) through untouched — confirmed, **no transport change needed**.
- The bundled-docs gate is real: `tests/unit/cli/bundled/plugin-docs.test.ts:38-43` asserts byte-for-byte
  parity, and `.github/workflows/ci.yml:21-29` runs `pnpm run docs:bundle` then `git diff --exit-code`.
  `scripts/gen-bundled-docs.ts` renders **only** `docs/plugins/**/*.md`, so `overview.md` is not bundled.
- `grep classifyQuery|isQueryVocabulary` across `src` + `tests` returns **only** query-handler.ts,
  response-poller.ts, and query-handler.test.ts — no integration/e2e test exercises the classifier. The
  integration/e2e files that matched the vocabulary words use them as generic English, not commands.

**One gap the prior phases under-specified (now folded in):** `formatUnrecognizedResponse`
(`query-handler.ts:252`) contains a second user-facing pointer at the bare command —
`... or send "status" to see them.` It must also move to `!status` (AC #5: do not instruct the owner to
use the now-inert bare form). Prior inventories named only `formatHelpResponse`.

The two prior phases are accurate. No open question requires a human.

---

## Approaches considered

### Approach A — Narrow `classifyQuery` in place (CHOSEN)

Change only the classifier gate in `src/core/daemon/query-handler.ts`: after `trim()`, a message is a
command only if it **starts** with `!` immediately followed by a known keyword token (start-anchored,
case-insensitive). `isQueryVocabulary`, `handleQuery`, and `classifyInbound` all inherit the new behavior
unchanged because they delegate to `classifyQuery`. Update two user-facing strings in the same file
(`formatHelpResponse`, `formatUnrecognizedResponse`), the two unit tests, the three docs, and regenerate
the bundle. **No new files, no new abstraction, no config.**

### Approach B — Introduce a centralized command-vocabulary table (REJECTED)

Replace the if-chain/regex with a `const COMMANDS = [{ keyword, kind, needsArg }]` table as the single
source of truth for both the matcher and the help text, removing the small vocabulary duplication.

**Why rejected:** it buys nothing the spec asks for. The duplication is four words across two places in
one file; eliminating it adds a new abstraction and more surface area for a vocabulary that changes
rarely. The research explicitly flagged centralizing as a taste call, not a correctness requirement, and
warned against "also refactoring." Per "complexity must earn its place," A wins. If a future change adds
many commands, B becomes worth revisiting — but not now.

**Decision: Approach A.**

### A subtlety that rules out the *naive* minimal diff

Tempting "smallest diff": keep the existing `includes()` if-chain but first `return "unknown"` unless the
trimmed text starts with `!`, then run `includes` on the remainder. **This is buggy.** For `!help me with
status`, the remainder `help me with status` contains `status`, and `status` is checked before `help` in
the chain → it would return `status` for a message that is plainly the `!help` command. The keyword match
must be **start-anchored on the remainder**, which `includes` cannot express. A start-anchored regex is
therefore the *correct* mechanism, not merely a tidier one. This is a load-bearing reason for the design
below — record it so execution does not "simplify" back into the bug.

---

## Design (the contract execution implements against)

All in `src/core/daemon/query-handler.ts`. Illustrative snippets show **intent**; execution writes the
final code to match house style (`biome`: double quotes, 2-space indent, 120 cols).

```ts
/** Commands are explicitly marked: the prefix, then a known keyword token, at the very start. */
const COMMAND_PREFIX = "!";

// Unchanged — still the single regex used to EXTRACT the issue number for a progress command.
const PROGRESS_RE = /progress.*#(\d+)|#(\d+).*progress/;

// Start-anchored, token-bounded, case-insensitive. NO `g`/`y` flag (see pre-mortem #1).
const COMMAND_RE = /^!(status|cost|help|progress)\b/i;

export function classifyQuery(content: string): QueryKind {
  const trimmed = content.trim();
  const match = COMMAND_RE.exec(trimmed);
  if (!match) {
    return "unknown";
  }
  const keyword = match[1].toLowerCase();
  if (keyword === "progress") {
    // `!progress` is the progress command ONLY when it carries an issue number (`#N`); this keeps the
    // existing invariant "progress kind ⇔ a number is extractable", so the #undefined path is unreachable.
    return PROGRESS_RE.test(trimmed.toLowerCase()) ? "progress" : "unknown";
  }
  return keyword as QueryKind;
}
```

`isQueryVocabulary`, `handleQuery`, `formatResponse`, `extractIssueNumber`, `formatProgressResponse`, and
all other handler internals stay **unchanged** in logic. `extractIssueNumber` keeps running
`PROGRESS_RE.exec(content.toLowerCase())` on the raw content — it is now only reached when the classifier
has already confirmed `#N` is present, so it always returns a real number.

### Resolved parser dispositions (low-stakes; settled here, not owner decisions)

The research flagged these two as "(planning call)". Both are settled below by the spec's own wording and
the existing design's invariants; neither is something I would stop to ask the owner about, so they live
here in prose (not in the decisions-to-confirm list).

| Input | Disposition | Why |
|---|---|---|
| `!progress` (prefix + keyword, **no `#N`**) | `unknown` → routes as free text (when blocked) / help fallback (when not) | The spec's only progress form is `!progress #N`. Requiring `#N` preserves the existing `progress ⇔ extractable number` invariant, so the broken `Issue #undefined not found.` string is **unreachable**, and matches today's behavior for the unprefixed analog (`progress` alone is `unknown`). Consistent with the requirements-phase `!foo`→free-text disposition. |
| `! status` (space **between** `!` and keyword) | **not** a command → free text | Req #1 says the prefix is "immediately followed by" the keyword. `COMMAND_RE` has no `\s*`, so a gap is not tolerated. "Surrounding whitespace tolerated" is handled by `trim()` (leading/trailing on the whole message). Stricter = less chance of misreading emphatic prose like `! yes do that`. |

### Full classification table this design produces (execution + review check against this)

| Input | `classifyQuery` | Routing when exactly one task blocked |
|---|---|---|
| `!status` / `!cost` / `!help` | that command | query (wins over sole-blocked) |
| `!progress #42` | `progress`, extracts `42` | query |
| `  !STATUS ` (space + case) | `status` | query |
| `!status please` (trailing prose) | `status` | query |
| `!help me with status` | `help` (start-anchored beats mid-text `status`) | query |
| `…changes that help capture…` (**the incident**) | `unknown` | **sole-blocked reply → unblocks the task** |
| `help` / `status` / `cost` (bare) | `unknown` | sole-blocked reply |
| `#42 progress` (no prefix) | `unknown` | sole-blocked reply |
| `!helpme` / `!statuses` (keyword is a substring of a longer token) | `unknown` (token boundary `\b`) | sole-blocked reply |
| `!foo` / `!important: use option B` (prefix + unknown keyword) | `unknown` | sole-blocked reply |
| `!progress` (no `#N`) | `unknown` | sole-blocked reply |

---

## Stress test of the chosen plan

- **Plugin Opacity.** The change is 100% in Core (`query-handler.ts`), a pure function with no plugin
  dependencies and no adapter-boundary contract. Core compiles with every plugin deleted. The Telegram
  plugin is **not** touched (it already passes `!` through). ✅
- **Isolation.** `classifyQuery` is pure: input string → output enum, no mutation, no I/O. `COMMAND_PREFIX`,
  `COMMAND_RE`, `PROGRESS_RE` are module-level immutable consts. No shared mutable state, no cross-task
  bleed. ✅
- **Boundaries.** Works through the existing exported contract (`classifyQuery` / `isQueryVocabulary`).
  `response-poller` consumes `isQueryVocabulary` unchanged; nothing reaches into another module's
  internals. ✅
- **Reversibility.** No schema change, no new interface, no public-API change. `QueryKind` is unchanged.
  The only lock-in is the `!` constant and one regex — both trivially reversible. ✅

All four checks pass; no redesign needed.

## Pre-mortem — most likely subtle flaws, and their mitigations

1. **Regex statefulness / backtracking.** A future edit that adds a `g`/`y` flag to `COMMAND_RE` would make
   `.exec`/`.test` stateful (advancing `lastIndex`), causing intermittent misclassification across calls.
   *Mitigation:* `COMMAND_RE` carries only `/i`; `PROGRESS_RE` carries no flags — so `.test` (in the
   classifier) and `.exec` (in `extractIssueNumber`) on the same `PROGRESS_RE` are fully independent (no
   `lastIndex` carryover). A short comment on `COMMAND_RE` records why no `g`. `PROGRESS_RE` has a single
   `.*` per alternative (no nested quantifiers) and inputs are ≤4096 chars (Telegram cap) → linear, no
   catastrophic backtracking. Acceptable.

2. **Incomplete test migration → false green (highest risk).** Migrating *some* bare-word test inputs to
   `!`-prefixed while missing one, or the help-text assertions passing by substring coincidence
   (`"status"` ⊂ `"!status"`) and thus never proving the prefix is actually rendered. *Mitigation:* (a)
   the exhaustive per-line migration list in Parts 3–4 below; (b) add **negative** assertions that prove
   the prefix is *required* — `classifyQuery("help") === "unknown"`, `classifyQuery("…help…") ===
   "unknown"` — so a regression to substring matching turns the suite red; (c) assert the help text
   contains the **literal** `!status` / `!progress #N` / `!cost`, so the prefix render is genuinely
   exercised, not masked by substring overlap. This directly defeats the "test still passes when the code
   is reverted" anti-pattern: reverting to `includes("help")` makes `classifyQuery("help")` return `help`,
   failing assertion (b).

3. **Bundled-docs drift → red gate.** Editing the two `docs/plugins/` files without regenerating the
   bundle fails both `plugin-docs.test.ts` (byte-for-byte) and CI (`git diff --exit-code`). *Mitigation:*
   Part 6 makes `pnpm run docs:bundle` a mandatory ordered step right after the doc edits, with
   `git diff --exit-code src/cli/bundled/plugin-docs.ts` as its verification. `overview.md` is **not**
   under `docs/plugins/`, so it needs the prose edit only (no regen).

---

## Ordered execution plan

> Convention reminders for execution: `biome` style (double quotes, 2-space, 120 col). Tests, docs, and
> the doc-comment rewordings are part of this unit of work, not follow-ups (AGENTS.md). Keep
> `classifyQuery` and `isQueryVocabulary` exported (the test imports both; `knip` flags unused exports).

### Part 1 — Narrow the classifier (the behavior change)

File: `src/core/daemon/query-handler.ts`

- [ ] Add `const COMMAND_PREFIX = "!";` and `const COMMAND_RE = /^!(status|cost|help|progress)\b/i;` near
      the existing `PROGRESS_RE` (keep `PROGRESS_RE` as-is — still used for extraction).
- [ ] Rewrite `classifyQuery` to the start-anchored design above: `trim()`, match `COMMAND_RE`, return
      `unknown` on no match; for `progress`, require `PROGRESS_RE.test(trimmed.toLowerCase())` else
      `unknown`.
- [ ] Leave `isQueryVocabulary`, `handleQuery`, `formatResponse`, `extractIssueNumber`,
      `formatProgressResponse`, `formatStatusResponse`, `formatCostResponse` logic untouched.
- [ ] Reword the now-stale `QueryKind`/"Slash-free by design" doc-comment (13-16) to describe the
      `!`-prefix, start-anchored rule (the prefix is chosen to stay clear of Telegram's native `/`-commands
      and to keep classification in Core, channel-agnostic).
- [ ] Reword the `isQueryVocabulary` doc-comment (39-43): the in-text example `status` → `!status`.
- **Verify:** `pnpm run typecheck` passes; reread the diff to confirm no `g` flag on either regex and that
  `extractIssueNumber` is unchanged.

### Part 2 — Update the two user-facing response strings (AC #5)

File: `src/core/daemon/query-handler.ts`

- [ ] `formatHelpResponse` (236-244): prefix each listed command — `!status`, `!progress #N`, `!cost`,
      `!help`.
- [ ] `formatUnrecognizedResponse` (252): change `... or send "status" to see them.` →
      `... or send "!status" to see them.` (the gap the prior phases missed).
- **Verify:** `pnpm run typecheck`; grep the file for a bare `"status"`/`"cost"`/`"help"`/`"progress #N"`
  in any user-facing string to confirm none remain unprefixed.

### Part 3 — Update `query-handler.test.ts` (AC #7)

File: `tests/unit/core/daemon/query-handler.test.ts`

- [ ] `classifyQuery` block (57-66): change positives to prefixed forms —
      `classifyQuery("!status") === "status"`, `("!cost") === "cost"`, `("!progress #42") === "progress"`,
      `("!help") === "help"`. Keep `("looks good, go ahead") === "unknown"`. **Add negatives that prove the
      prefix is required:** `("help") === "unknown"`, `("what's the status?") === "unknown"`,
      `("#42 progress") === "unknown"`, and the incident `("...changes that help capture why...") ===
      "unknown"`. **Add token/edge:** `("  !STATUS ") === "status"`, `("!helpme") === "unknown"`,
      `("!foo") === "unknown"`, `("!progress") === "unknown"` (no `#N`).
- [ ] `isQueryVocabulary` block (68-76): `("!status")`, `("!cost")`, `("!progress #1")`, `("!help")` → true;
      keep `("use the second option")` → false; add `("...that help capture...")` → false and `("!foo")` →
      false.
- [ ] `handleQuery` tests: change every bare `payload("…")` to its prefixed form — `payload("!status")`
      (94, 108, 119), `payload("!progress #42")` (143), `payload("!cost")` (161), `payload("!help")` (171),
      `payload("!progress #999")` (202). Leave `payload("hello there")` (182) and `payload("yes go ahead")`
      (191) — they are intentionally unrecognized.
- [ ] Help-text test (168-177): assert the **literal prefixed** strings `!status`, `!progress #N`, `!cost`
      (pre-mortem #2c), not the bare substrings.
- **Verify:** `pnpm test tests/unit/core/daemon/query-handler.test.ts` is green.

### Part 4 — Update `response-poller.test.ts` (AC #7)

File: `tests/unit/core/daemon/response-poller.test.ts`

- [ ] `classifyInbound` block: line 125 — change `classifyInbound(false, "what's the status", 1)` to
      `classifyInbound(false, "!status", 1)` (still expects `query`/`query_vocabulary`/blockedCount 1). The
      linked-reply case (120) may stay (content is irrelevant when `hasLinkedTask` is true). The free-text
      (133), no-blocked (137), and multi-blocked (141) cases stay as-is (already prefix-free free text).
- [ ] **Add** two `classifyInbound` cases: the incident
      `classifyInbound(false, "the desc should help capture why", 1)` → `{ route: "sole_blocked_reply" }`;
      and `classifyInbound(false, "!foo", 1)` → `{ route: "sole_blocked_reply" }` (prefix + unknown keyword
      is free text).
- [ ] Integration `runWithMessage` tests: change the four `runWithMessage("status", …)` calls (392, 410,
      417, 427) to `runWithMessage("!status", …)` so they still exercise the query path (with bare
      `status` they would now misroute / return the unrecognized fallback). Leave
      `runWithMessage("use the second approach", …)` (401) unchanged.
- [ ] **Add** an integration test for the incident (AC #1): `runWithMessage("...that help capture...",
      [oneBlockedTask])` asserts `resolver.tryUnblock` **was** called with that content and
      `notifications.notify` was **not** — proving a free-text reply containing a command word unblocks the
      task instead of hitting the command handler.
- **Verify:** `pnpm test tests/unit/core/daemon/response-poller.test.ts` is green.

### Part 5 — Optional doc-comment parity in the poller (no behavior change)

File: `src/core/daemon/response-poller.ts`

- [ ] Low priority: where comments spell the vocabulary as `status/cost/progress #N/help` (74-79, 110),
      reword to the `!`-prefixed forms for prose accuracy. No code changes; skip if it risks churn.
- **Verify:** `pnpm run typecheck` (comments-only; nothing should change behaviorally).

### Part 6 — Update user-facing docs + regenerate the bundle (AC #4/#6)

- [ ] `docs/plugins/communication/README.md` — "Inbound queries" (74-92): replace the "plain words
      (slash-free…)" framing with the start-anchored `!`-prefix rule (a command is the `!` prefix
      immediately followed by a keyword at the start; a command word anywhere else is inert). Prefix the
      vocabulary table (`!status`, `!progress #N`, `!cost`, `!help`). In the precedence list, update item 2
      (88) `ask "status" mid-block` → `!status`.
- [ ] `docs/plugins/communication/telegram-comm.md` — "Querying from Telegram" (68): `Send !status,
      !progress #N, !cost, or !help …`; reword the `/`-rationale to the `!`-prefix rationale (commands use
      `!`, distinct from Telegram's native `/`-commands which the plugin drops). Leave the transport line
      (66, "Filters out bot commands … starting with `/`") as-is — it is accurate.
- [ ] `docs/user-flows/communication/overview.md` — line 20 (`status / cost / progress #N / help`), line
      210-211 (`a status typed while…`), and line 212 (`the query vocabulary (status, cost, progress #N,
      help)`) → prefixed forms. **Not bundled** — prose edit only.
- [ ] **Regenerate the bundle:** run `pnpm run docs:bundle` (renders `docs/plugins/**` into
      `src/cli/bundled/plugin-docs.ts` and `biome format`s it). Commit the regenerated file. Do **not**
      hand-edit it.
- [ ] Leave `docs/archived/**` untouched (historical build journal, out of scope by project convention).
- **Verify:** `git diff --exit-code src/cli/bundled/plugin-docs.ts` is clean **after** running
  `docs:bundle` (i.e. the committed bundle matches a fresh render); grep the three docs for any remaining
  bare `status`/`cost`/`progress #N`/`help` used as a command form.

### Part 7 — Full gate run (AC #8)

- [ ] `pnpm run typecheck` — `tsc --noEmit` for src and test.
- [ ] `pnpm run lint` — `biome check` + typecheck + `knip` (no dead exports) + `madge` (no cycles).
- [ ] `pnpm test` — full unit suite, including `plugin-docs.test.ts` (byte-for-byte bundle guard).
- **Verify:** all three exit 0. A non-zero exit on any is a failure to fix, not a warning to wave off.

---

## Completeness check (prove zero stragglers, don't assume)

Before declaring done, execution should confirm:

- [ ] `grep -rn 'includes("status"\|includes("cost"\|includes("help")' src` returns nothing (the substring
      matcher is gone, not merely shadowed).
- [ ] No user-facing string in `src/core/daemon/query-handler.ts` instructs the owner to send a bare
      command (`status`/`cost`/`help`/`progress #N` without `!`).
- [ ] No active doc (`docs/**` minus `docs/archived/**`) presents a bare command form.
- [ ] `src/cli/bundled/plugin-docs.ts` is a clean `docs:bundle` render (CI's `git diff --exit-code` passes).
- [ ] Every previously-bare-word test input is either prefixed (positive cases) or intentionally bare
      (negative cases asserting `unknown`/free-text).

## Decision log (what this plan locks in)

- **Chose Approach A** (narrow `classifyQuery` in place) over a centralized vocabulary table — smallest
  change that meets all five requirements; the table buys nothing the spec requires and adds an
  abstraction. Locks in: the matcher stays a single regex + a `progress` `#N` check in one Core file.
- **Start-anchored regex, not `includes` on the stripped remainder** — the naive minimal diff misclassifies
  `!help me with status` as `status`. Locks in: keyword matching is anchored with a `\b` token boundary.
- **`!progress` without `#N` → `unknown`** (not a `progress` command that 404s) — preserves the existing
  `progress ⇔ extractable #N` invariant and never emits `Issue #undefined not found.`
- **`! status` (gap after prefix) → not a command** — honors Req #1 "immediately followed"; `trim()` covers
  only whole-message surrounding whitespace.
- **Help/unrecognized text updated to `!`-prefixed forms** — resolves the Req #4 ("responses stay the
  same") vs AC ("update docs to prefixed") tension on the dominant reading the requirements phase settled:
  vocabulary and returned data are unchanged; only the documented *invocation* shows `!`.
- **`response-poller.ts` gets no logic change** — its precedence is already correct and tested; it inherits
  the new rule through `isQueryVocabulary`. Resisting an unrequested routing refactor.

No decision in this plan is the owner's to make: the prefix (`!`) and command forms are owner-given, and
the two parser edges are low-stakes calls the spec and existing-design invariants already resolve.
