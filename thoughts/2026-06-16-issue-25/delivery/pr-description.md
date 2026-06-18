# Require an explicit `!` prefix for inbound chat commands

## What and why

Inbound chat messages are classified in Core as either a **command** (`status` / `cost` /
`progress #N` / `help`) or a **free-text reply** to a blocked task. The old classifier decided
"this is a command" by checking whether a command word appeared *anywhere* in the message
(substring match), and that decision wins over the sole-blocked-reply route. So any genuine answer
that merely *mentioned* a command word was silently swallowed: in the reported incident, an owner's
long requirements answer containing the phrase "...changes that **help** capture why..." was
classified as the `help` command, the owner got the help menu, and the blocked task never received
the answer.

This change makes a command recognizable **only** when the trimmed message *starts* with an explicit
`!` prefix immediately followed by a known keyword (`!status`, `!cost`, `!progress #N`, `!help`). A
command word buried in ordinary prose now has no effect on classification, so free-text answers
reliably reach the blocked task — while the owner can still issue a command mid-block by marking it
with `!`.

## How

- **Replaced the substring matcher with a start-anchored regex** in `src/core/daemon/query-handler.ts`:
  `COMMAND_RE = /^!(status|cost|help|progress)\b/i`. The `^` anchors to the start of the trimmed
  message, `\b` makes the keyword a whole token (so `!help me` → `help`, `!helpme` → unknown), and it
  is case-insensitive. Deliberately **no** `g`/`y` flag — those would make `.exec`/`.test` stateful
  across calls and cause intermittent misclassification.
- **Preserved the `progress` ⇔ extractable-`#N` invariant.** `!progress` classifies as the
  `progress` command only when the message also carries an issue number (the existing `PROGRESS_RE`
  still gates it), so `extractIssueNumber` always returns a real number. `!progress` with no `#N` is
  `unknown`.
- **Kept the routing precedence untouched** in `src/core/daemon/response-poller.ts`. The decision
  order (linked → command vocabulary → sole-blocked reply → none/multi-blocked) is unchanged; only
  the *definition* of "command vocabulary" narrowed. A command match still wins over the sole-blocked
  reply, which is exactly what lets `!status` work mid-block. A non-prefixed message (or a prefix with
  an unknown keyword like `!foo`) is never a command and routes as the free-text reply.
- **Vocabulary and responses are identical** — only the trigger changed. The in-chat `!help` text
  and the "couldn't match" hint now show the prefixed forms so they no longer instruct the owner to
  type the now-inert bare words.
- **Updated the three active user-facing docs** (`docs/plugins/communication/README.md`,
  `docs/user-flows/communication/overview.md`, `docs/plugins/communication/telegram-comm.md`) from
  bare-word to `!`-prefixed forms, and reworded the "slash-free" rationale to the `!`-prefix
  rationale (`!` stays clear of platforms' native `/`-bot-commands and keeps classification
  channel-agnostic in Core). The generated `src/cli/bundled/plugin-docs.ts` was regenerated from
  those docs. Archived build-journal docs under `docs/archived/` are a historical record and were
  left untouched.

## Verification

- **Gates run green** (with `CI` unset, as the harness runs them): `pnpm run typecheck`,
  `pnpm run lint`, and `pnpm test`. The pre-existing knip cognitive-complexity warnings are in
  untouched files and are warnings, not errors.
- **Tests cover the classification behavior** in both `query-handler.test.ts` and
  `response-poller.test.ts`, rewritten from the old substring expectations:
  - The reported incident — a long reply with `help` buried in it, sent while exactly one task is
    blocked — asserts `resolver.tryUnblock` is called for that task and the command handler
    (`notifications.notify`) is **not**. Reverting the classifier to `includes("help")` flips the
    suite red, so the test pins the real prefix requirement rather than a fallback path.
  - Each `!`-prefixed form classifies and routes as its command, including mid-block; whitespace and
    casing are tolerated (`  !STATUS `); bare words (`status`, `help`) and prefix-without-known-keyword
    (`!foo`, `!helpme`, `! status`) are not commands.
- **Bundle drift checked:** `pnpm run docs:bundle` regenerates `plugin-docs.ts` with zero drift, so
  CI's `git diff --exit-code` guard stays clean.
- **End-to-end transport sanity:** the Telegram plugin drops only `/`-prefixed messages, so a
  `!`-prefixed command is not dropped and reaches Core's classifier — confirming the deliberate
  choice of `!` over `/` is viable through the transport, not just in the isolated classifier.

## Risks and follow-ups

- **Intended behavior change for bare words.** With nothing blocked, bare `status` / `cost` /
  `help` previously returned real data; they now fall to the unrecognized/help response. This is the
  point of the change (a command is *only* `!` + keyword), and the in-chat help and docs were updated
  to teach the prefixed forms. Worth a reviewer's eye since it's a visible UX shift.
- **`!progress` with no `#N` while a task is blocked** routes as the sole-blocked reply (an
  unrecognized message is treated as the answer to the one open question). This matches the
  pre-change behavior for token-less `progress` and the documented routing precedence — a minor UX
  edge, not a regression.
- **`knip.json` adds `lefthook` to `ignoreDependencies`.** This is outside the feature's strict
  scope but a settled, owner-approved call: without it the lint gate is red outside CI (`lefthook` is
  a real git-hooks runner that is never imported from `src/**`). It is already decided, included here
  only for full transparency on what the diff contains.
- **Scope is Core + Telegram/dashboard in practice.** GitHub Comm has no `receive` capability, so
  GitHub replies arrive as metadata-linked replies and never hit `classifyQuery`; the classifier
  nonetheless stays channel-agnostic in Core, so it applies to any future `receive`-capable plugin.
