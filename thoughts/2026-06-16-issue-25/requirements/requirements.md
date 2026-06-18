# Requirements — Issue #25: Require an explicit prefix for inbound chat commands

_Phase run: 2026-06-16 · Source: github_issue FarzamMohammadi/the-engineer#25 · Author/owner: Farzam Mohammadi_

## Context Summary

**What the task asks (in my words):** Today, an inbound chat message is classified as a
command (`status` / `cost` / `progress #N` / `help`) whenever a command word appears *anywhere*
in the text (substring match). That silently swallows genuine free-text answers — the reported
incident is an owner reply containing the word "help" buried in prose, which got classified as the
`help` command and never reached the blocked task. The fix is to recognize a command **only** when
the message, after trimming, **starts** with an explicit prefix (`!`) immediately followed by a
known command keyword. A command word appearing mid-text must have no effect on classification.
Everything else (the command vocabulary, the data each command returns, the routing precedence that
lets a query win over the sole-blocked-reply fallback) stays as-is — only the *trigger* changes.

**How much of this did the owner state vs. how much am I reconstructing?** Almost entirely stated.
This is an unusually complete, owner-authored spec: it names the root cause, the desired end-state,
the exact prefix (`!`), the exact command forms (`!status`, `!cost`, `!help`, `!progress #N`), five
numbered requirements, five acceptance criteria, and explicit constraints (single-user,
channel-agnostic classification in Core, `!` chosen to stay clear of Telegram's native `/`-commands).
It even pre-resolves the one decision someone might revisit — "`!` is the agreed default; if research
surfaces a strong reason against it, raise it during **planning**, not now." My reconstruction is
limited to (a) confirming the spec against the actual code so the acceptance criteria are checkable,
and (b) pinning down a few edge-case behaviors that the spec implies but does not spell out (recorded
below as resolved interpretations, not new intent). I found no point where the build hinges on intent
the owner did not express.

**Where the work lives (grounding, for the downstream phases):**

| Concern | File | Note |
|---|---|---|
| Command classifier (the bug) | `src/core/daemon/query-handler.ts` | `classifyQuery()` uses `lower.includes("cost"/"status"/"help")` + a loose `PROGRESS_RE`. `isQueryVocabulary()` wraps it. The doc-comment "Slash-free by design" becomes stale. `formatHelpResponse()` enumerates the vocabulary in-chat. |
| Routing precedence | `src/core/daemon/response-poller.ts` | `classifyInbound(hasLinkedTask, content, blockedCount)` — order: linked → query-vocabulary → sole-blocked → none/multi. The order is correct and must stay; only the *definition* of "query vocabulary" changes. |
| Telegram transport | `src/plugins/communication/telegram-comm/telegram-comm.ts` | Drops `/`-prefixed messages (native bot-commands); passes `!`-prefixed text through unchanged. No transport change needed — confirms why `!` (not `/`) was chosen. |
| Existing tests | `tests/unit/core/daemon/query-handler.test.ts`, `tests/unit/core/daemon/response-poller.test.ts` | Both assert the *old* substring behavior (`classifyQuery("what's the status?") === "status"`, `payload("status")`, `runWithMessage("status", …)`). These must be updated to the prefixed forms. |
| User-facing docs | `docs/plugins/communication/README.md` (Inbound queries), `docs/user-flows/communication/overview.md`, `docs/plugins/communication/telegram-comm.md:68` | All currently describe bare-word commands and the "slash-free" rationale. Must be updated to the `!`-prefixed form. |

GitHub Comm does **not** have the `receive` capability (`github-comm.ts`: "receive deferred"), so
inbound GitHub replies arrive as metadata-linked replies, never through `classifyQuery`. Chat
commands are therefore in practice a Telegram (and dashboard) concern — but per the spec,
classification stays channel-agnostic in Core, so the change is made once in `query-handler.ts` and
applies to any future `receive`-capable plugin.

## Probing the task to its edges

I walked the command vocabulary and the routing fork through concrete end-to-end scenarios. The
incident's free-text answer and four command forms are the actors; for each I traced what classifies
it and where it routes.

**Scenario 1 — the reported incident (must now work).** One task blocked on a requirements
question. Owner replies with prose containing "...changes that **help** capture why...".
- Old: `classifyQuery` substring-matches "help" → `isQueryVocabulary` true → query route wins over
  sole-blocked → owner gets the help menu, task stays blocked, answer lost.
- New: message has no leading `!` → not query vocabulary → falls to the sole-blocked-reply route →
  unblock-resolver unblocks the task. ✅ (AC #1)

**Scenario 2 — explicit command while blocked.** One task blocked; owner sends `!status`.
- New: trimmed, starts with `!` + known keyword `status` → query vocabulary → query route wins over
  sole-blocked (precedence unchanged) → status response, task stays blocked. ✅ (AC #2, Req #5)

**Scenario 3 — bare `help` (no prefix), nothing blocked.**
- New: no leading `!` → `classifyQuery` returns `unknown` → routed to query handler with reason
  `no_blocked_task` → falls to the "I didn't understand that. [help]" fallback. So bare `help` is
  **not** treated as the `help` command. ✅ (AC #3). Note: a side effect is that bare `status`/`cost`
  with nothing blocked, which today returns real data, now returns the unrecognized/help fallback —
  this is intended (Req #1: a command is *only* `!`+keyword).

**Scenario 4 — `!progress #42`.** Keyword immediately after prefix, then ` #N`.
- The classifier must (a) recognize it as the `progress` command and (b) still extract `42`. The
  existing `extractIssueNumber`/`PROGRESS_RE` reads the number from the content; planning decides the
  exact parser, but the number-extraction path must continue to work for the prefixed form.

**Edge values enumerated and their resolved dispositions** (implied by the spec; settled here so
planning/execution inherit them — these are interpretations of stated intent, not new intent):

| Input | Disposition | Basis |
|---|---|---|
| `!status`, `!cost`, `!help`, `!progress #N` | command | Req #1, explicit forms |
| `  !STATUS ` (leading/trailing space, mixed case) | command | Req #1: "casing and surrounding whitespace should be tolerated" |
| `...help...` mid-prose | **not** a command → free-text reply | Req #3 |
| `help` / `status` (no prefix) | **not** a command | Req #1, AC #3 |
| `!important: use option B` / `!foo` (prefix but **unknown** keyword) | **not** a command → routed as free-text reply (per existing precedence) | Req #1 gates on prefix + *known* keyword; Req #2's spirit (never misread free text as a command) → unknown-keyword content must not be swallowed |
| `!helpme` (prefix + keyword-as-substring of a longer token) | **not** the `help` command | Req #1: the keyword is a marked *token*, not a substring (the whole point of the change); planning to pin token boundary (`!progress` then `#N`; others followed by whitespace/end) |
| `! status` (space between prefix and keyword) | minor parser detail | Req #1 says "immediately followed"; "surrounding whitespace" reads as around the whole message. Low-stakes `code_style` call left to planning/execution; not an owner decision |

## Acceptance Criteria

A reviewer can verify this task is complete by checking all of the following:

1. **Mid-text command words are inert.** A free-text reply containing `help`/`cost`/`status`/
   `progress` anywhere in the body, sent while exactly one task is blocked, is routed to that blocked
   task (unblocks it) and is **never** sent to the command handler. (Req #1, #3; AC bullet 1)
2. **Prefixed commands work, including mid-block.** `!status`, `!cost`, `!help`, and `!progress #N`
   each invoke the corresponding command and return the same data as today, including while a task is
   blocked. `!progress #N` still resolves the task tracking issue `N`. (Req #2, #4, #5; AC bullets 2)
3. **Start-anchored only.** A message is classified as a command **only** when, after trimming, it
   begins with `!` immediately followed by a known command keyword; casing and surrounding whitespace
   are tolerated. A command keyword appearing anywhere else has no effect. (Req #1, #3)
4. **Bare words are not commands.** A plain message that is exactly `help` (or `status`/`cost`/
   `progress #N`) with no `!` prefix is **not** treated as a command. A non-prefixed message routes as
   a free-text reply when a task is blocked, or is handled as today when nothing is blocked. (Req #2;
   AC bullet 3)
5. **Vocabulary and responses unchanged.** The set of commands and the data each returns are
   identical to today; only the trigger changes. The in-chat `help` text and other user-facing
   command documentation now show the **prefixed** form (`!status`, `!cost`, `!progress #N`, `!help`)
   so they do not instruct the owner to use the now-inert bare form. (Req #4; AC bullets 4)
6. **User-facing docs updated.** `docs/plugins/communication/README.md` (Inbound queries),
   `docs/user-flows/communication/overview.md`, and `docs/plugins/communication/telegram-comm.md`
   are updated from bare-word to `!`-prefixed command forms (and the "slash-free" rationale reworded
   to the `!`-prefix rationale). Archived build-journal docs under `docs/archived/` are a historical
   record and are **not** changed. (AC bullet 4)
7. **Covered by tests.** The classification behavior is exercised by unit tests: a free-text reply
   containing a command word routes to the blocked task; each `!`-prefixed form classifies as its
   command; bare words and prefix-without-known-keyword do not. Existing tests in
   `query-handler.test.ts` and `response-poller.test.ts` that assert the old substring behavior are
   updated to the prefixed forms. (AC bullet 5)
8. **Gates pass.** `pnpm run typecheck`, `pnpm run lint`, and `pnpm test` all pass.

## Source of each requirement (intent interrogation)

For every acceptance criterion above, the source is one of: owner-expressed, researchable fact, or my
inference. The deciding question for this gate is whether anything rests on an inference that could
defensibly have meant something else.

- **AC 1, 2, 3, 4 (classification behavior, prefix value, command forms)** — **Owner-expressed.**
  Stated verbatim in the issue's "What we want", numbered Requirements 1–5, and Acceptance criteria.
  The prefix (`!`) and the four forms are given explicitly. Trusted; proceed.
- **AC 5 (help text shows the prefixed form)** — **Owner-expressed, via the AC** "User-facing
  documentation that currently tells the owner to send bare `status` / `help` / etc. is updated to
  the prefixed form." The in-chat `help` response is exactly such user-facing documentation. There is
  a *literal-reading* tension with Req #4 ("vocabulary and responses stay the same"), but the
  dominant reading is unambiguous: "vocabulary/responses stay the same" means *the set of commands and
  the data each returns* are unchanged, while "only the trigger — how a command is invoked — changes"
  and the docs AC require the documented invocation to show `!`. Freezing the help string to bare
  words would re-create the exact confusion the issue exists to remove. I am settling this on the
  stated AC, not inventing intent — but flagging the tension here so a reviewer can confirm at a
  glance. No equally-defensible alternative survives the issue's own anti-confusion purpose.
- **AC 6 (which docs; archived excluded)** — **Researchable fact.** I searched the repo for active
  docs describing the bare-word vocabulary and found the three listed; the `docs/archived/` tree is
  explicitly a historical build journal (README in that tree), so it is out of scope by the project's
  own convention. Verified by inspection, not assumed.
- **AC 7 (tests)** — **Owner-expressed** ("The classification behavior is covered by tests") and
  reinforced by project convention (`AGENTS.md`: "Code changes without corresponding tests... are
  unfinished work"). The specific existing tests that assert old behavior were found by search
  (researchable fact).
- **AC 8 (gates)** — **Researchable fact.** The commands are the project's own gates from
  `package.json` and `AGENTS.md`.

**Resolved interpretations (stated intent, made concrete — not new intent):**
- *Prefix-without-known-keyword (`!foo`) and unknown content route as free text*, not as an
  unrecognized command — follows directly from Req #1 (command only if prefix + *known* keyword) and
  Req #2's intent that free text is never misread as a command.
- *The `!` prefix is a fixed constant, not a new configuration option.* The spec supplies a concrete
  value and does not ask for configurability; adding a config knob would be unrequested scope. The
  issue explicitly defers any reconsideration of the value to the planning phase. Execution should
  hardcode `!` (a named constant is fine), not introduce settings.
- *The keyword is a marked token, not a substring* (`!helpme` ≠ `!help`); the exact token-boundary
  rule is a planning/execution detail consistent with the start-anchored intent.

None of these is an open fork the owner needs to settle: each has a single reading that survives the
issue's stated purpose; the alternatives I could name (e.g. swallow `!foo` as an unknown command,
make the prefix configurable) actively contradict the spec or expand its scope. I would not stop the
line to ask about any of them — so they are documented here, not raised as questions.

## Decision: ready to build

The owner expressed what "done" means in detail; every acceptance criterion traces to an explicit
statement in the issue or to a verifiable fact about the codebase. The implementation forks I probed
are all resolved by the spec's own requirements, and the one value someone might revisit (the prefix)
the issue itself routes to the planning phase. There is no point where the owner's input would change
the build that the issue has not already answered. **Outcome: ok — no outreach needed.**

## Complexity & Verification

- **Complexity:** moderate. Clear direction and a contained blast radius (two Core files —
  `query-handler.ts`, `response-poller.ts` — plus their two unit tests and three docs), but it is a
  behavior change with real edge cases (token-boundary parsing, `!progress #N` extraction, preserving
  the query-wins-over-sole-blocked precedence), so it is beyond trivial.
- **Verification commands** (project gates, from `package.json` + `AGENTS.md`):
  - typecheck — `pnpm run typecheck`
  - lint — `pnpm run lint`
  - test — `pnpm test` (unit tests; the changed classifier and its two unit specs live here)
