# Research — Issue #25: Require an explicit prefix for inbound chat commands

_Phase run: 2026-06-16 · Builds on `requirements/requirements.md`. Source: github_issue FarzamMohammadi/the-engineer#25_

## How to read this

**Observations** are facts I verified by reading the code at the cited line. **Inferences** are what I
conclude from them, labelled as such. The requirements doc's grounding table was treated as a set of
claims to verify, not facts to inherit — every file below I opened and read.

---

## 1. The bug, located precisely

**Observation.** The entire misclassification lives in one function, `classifyQuery`, in
`src/core/daemon/query-handler.ts:22-37`:

```ts
const PROGRESS_RE = /progress.*#(\d+)|#(\d+).*progress/;   // line 19

export function classifyQuery(content: string): QueryKind {
  const lower = content.toLowerCase();
  if (PROGRESS_RE.test(lower)) return "progress";   // matches "progress … #N" ANYWHERE
  if (lower.includes("cost"))   return "cost";       // substring, anywhere
  if (lower.includes("status")) return "status";     // substring, anywhere
  if (lower.includes("help"))   return "help";        // substring, anywhere ← the incident
  return "unknown";
}
```

`lower.includes("help")` is the exact line that classified the owner's prose ("…changes that **help**
capture…") as the `help` command. Every clause is an unanchored substring/regex test — a command word
anywhere in the body wins.

**Observation.** `isQueryVocabulary` (line 44-46) is a thin wrapper: `classifyQuery(content) !== "unknown"`.
So fixing `classifyQuery` fixes routing too — there is one source of truth for "is this a command."

**Observation.** The doc-comment at lines 13-16 ("Slash-free by design… plain words the owner types
directly") is the rationale that this change overturns; it becomes stale.

---

## 2. Execution path, traced end-to-end (runtime, not signatures)

Verified by reading `response-poller.ts` and `query-handler.ts` in full.

1. **Telegram transport** (`telegram-comm.ts:205-256`, `doPollMessages`): `getUpdates` → for each text
   message, **drops** anything starting with `/start` (handshake) or `/` (other bot-commands, line
   231-239), then emits an `InboundMessage` with the raw `text` as `content` and **no** task metadata in
   `platform_metadata` (only `chat_id`/`message_id`/`from_id`, lines 247-251).
   - **Observation:** a `!`-prefixed message is *not* `/`-prefixed, so it passes through untouched. No
     transport change is needed — this confirms why `!` (not `/`) was chosen.
2. **Poller** (`response-poller.ts:236-261`, `processInboundMessage`): builds `linked = linkMessageToTask(msg)`
   (null for Telegram — no `task_id`/`external_ref` metadata), then
   `classifyInbound(linked !== null, msg.content, blockedTasks.length)` (line 80-92):
   - `hasLinkedTask` → `linked_reply`
   - **`isQueryVocabulary(content)` → `query` (reason `query_vocabulary`)** ← the precedence that lets a
     command win over the sole-blocked reply. **This is exactly where the bug bites:** for the incident's
     prose, `isQueryVocabulary` returned `true` (because of "help"), so the message routed to `query`
     instead of `sole_blocked_reply`.
   - `blockedCount === 1` → `sole_blocked_reply` (the free-text answer path)
   - else → `query` (`no_blocked_task` or `unmatched_multi_blocked`)
3. **Query route** → `handleQuery(...)` (`query-handler.ts:79-119`): calls `classifyQuery` **again** on the
   same content (line 85) to pick the formatter, formats a response, resolves the owner via
   `peopleDirectory.getOwner()`, and `notifications.notify(...)` a `status_response`. For the incident this
   produced the help menu.
4. **Reply route** → `unblockResolver.tryUnblock(input)` (line 257) where `input` is the sole blocked
   task's `task_id` (line 273-277). This is the path the answer *should* have taken.

**Inference.** The fix is entirely upstream of routing: redefine what `classifyQuery` recognizes as a
command. Because `isQueryVocabulary` and `handleQuery` both delegate to `classifyQuery`, a single change
to `classifyQuery` flips both the routing decision (step 2) and the formatter selection (step 3)
consistently. `classifyInbound`'s order (linked → query → sole-blocked → none/multi) is correct and must
stay; only the *definition* of "query vocabulary" narrows.

---

## 3. Other inbound surfaces — confirmed blast radius

| Surface | Reaches `classifyQuery`? | Evidence |
|---|---|---|
| **Telegram free-text** | **Yes** — no metadata, hits step 2/3 above | `telegram-comm.ts:241-252` emits content with empty-of-link metadata |
| **Dashboard "respond to blocked task"** | **No** | `src/dashboard/api/messages.ts:28-54` always writes `comm.message_received` with a concrete `task_id`. The poller's `scanEventBus` (`response-poller.ts:324-351`) only acts on rows with `payload.task_id`, calling `tryUnblock` directly — it **never** calls `classifyQuery`. Dashboard is a per-task reply box; it has no command vocabulary. **Unaffected.** |
| **GitHub comm inbound** | **No** | `github-comm.ts:37` — `"receive" deferred`. It has no `doPollMessages`, so the poller's `hasCapability("receive")` filter (`response-poller.ts:191-192`) excludes it. GitHub replies arrive metadata-linked → `linked_reply`. **Unaffected.** |

**Observation.** In the base adapter (`src/adapters/communication.ts:102-111`) `pollMessages`/`doPollMessages`
throw a capability error unless overridden. **Telegram is the only comm plugin that overrides
`doPollMessages`** (grep across `src/plugins/communication/`), so in practice Telegram free-text is the
sole producer of unlinked content that reaches `classifyQuery` today.

**Inference.** The spec's "classification lives in Core, channel-agnostic" is already true of the current
design — `classifyQuery` is in Core and platform-agnostic. The change is made once in `query-handler.ts`
and automatically applies to any future `receive`-capable plugin. No plugin code needs to change.

---

## 4. The non-obvious blast radius: bundled docs gate `pnpm test` and CI

This is the finding most likely to trip execution if missed.

**Observation.** `scripts/gen-bundled-docs.ts` renders **every** `docs/plugins/**/*.md` file
byte-for-byte into `src/cli/bundled/plugin-docs.ts` (the `ALL_PLUGIN_DOCS` array). Two of the three docs
that must change live under `docs/plugins/`:
- `docs/plugins/communication/README.md` (the "Inbound queries" section, vocabulary table at lines 74-92)
- `docs/plugins/communication/telegram-comm.md` (the "Querying from Telegram" paragraph, line 68)

I confirmed both are currently embedded in `src/cli/bundled/plugin-docs.ts` (grep matched the vocabulary
table and the "Send `status`, `progress #N`…" line inside the generated string).

**Observation — two independent drift gates:**
1. **Unit test** `tests/unit/cli/bundled/plugin-docs.test.ts:38-43` asserts each bundled doc matches its
   source file **byte-for-byte**. This runs under `pnpm test` — so editing either doc *without*
   regenerating the bundle **fails the test gate** (AC #8).
2. **CI** `.github/workflows/ci.yml:23-25` runs `pnpm run docs:bundle` then `git diff --exit-code
   src/cli/bundled/plugin-docs.ts` — fails if the committed bundle is stale.

**Inference.** Editing the two `docs/plugins/` files **requires** running `pnpm run docs:bundle` and
committing the regenerated `src/cli/bundled/plugin-docs.ts`. The third doc,
`docs/user-flows/communication/overview.md` (lines 199-213), is **not** under `docs/plugins/`, so it is
*not* bundled — it needs only the prose edit, no regen. (`pnpm run docs:bundle` also runs
`biome format --write` on the output per `package.json`.)

---

## 5. Exact inventory of what must change

### Code (the behavior change)

| File | What | Lines |
|---|---|---|
| `src/core/daemon/query-handler.ts` | Narrow `classifyQuery` to start-anchored `!`+known-keyword; reword the stale "Slash-free by design" doc-comment (13-16); keep `isQueryVocabulary` delegating; preserve `!progress #N` number extraction (`extractIssueNumber`/`PROGRESS_RE`, 143-146); update `formatHelpResponse` text (236-244) to the prefixed forms. | 13-46, 143-146, 236-244 |
| `src/core/daemon/response-poller.ts` | **Likely no logic change.** `classifyInbound` (80-92) and its precedence stay; it routes via `isQueryVocabulary`, which now reflects the new rule for free. Two doc-comments reference "query vocabulary (status/cost/progress #N/help)" (58-67, 72-79, 106-116) — reword for accuracy if planning wants prose parity, but no behavior depends on them. | (comments only) |

### Tests (must be updated — they assert the OLD substring behavior)

| File | Assertions that break under the new rule | Lines |
|---|---|---|
| `tests/unit/core/daemon/query-handler.test.ts` | `classifyQuery("what's the status?") === "status"`, `("how much cost so far") === "cost"`, `("progress #42") === "progress"`, `("#42 progress") === "progress"`, `("help") === "help"` (57-66); `isQueryVocabulary("status"/"cost"/"progress #1"/"help") === true` (68-76); every `handleQuery(payload("status"/"cost"/"progress #42"/"help"), …)` (94-202) feeds bare words that now classify as `unknown`. **All must move to `!`-prefixed inputs.** The `help` test (168-177) asserts the help text contains `status`/`progress #N`/`cost` — update to the prefixed forms. | 57-207 |
| `tests/unit/core/daemon/response-poller.test.ts` | `classifyInbound(false, "what's the status", 1)` expecting `query_vocabulary` (123-130) — `"what's the status"` has no `!` and is now `sole_blocked_reply`; the `runWithMessage("status", …)` integration tests (392-435) all use bare `status` and expect query routing. **Must move to `!status` etc.** Add coverage: a free-text reply *containing* a command word routes to the blocked task (the incident); `!foo`/prefix-unknown routes as free text. | 118-147, 369-435 |

### Docs (user-facing; AC #4/#6)

| File | What | Bundled? |
|---|---|---|
| `docs/plugins/communication/README.md` | Vocabulary table + "Query vs. unblock reply" (74-92): change `status`→`!status`, `cost`→`!cost`, `progress #N`→`!progress #N`, `help`→`!help`; reword "slash-free, because some platforms drop `/`-prefixed messages" to the `!`-prefix rationale. | **Yes → regen** |
| `docs/plugins/communication/telegram-comm.md` | "Querying from Telegram" (line 68): "Send `status`, `progress #N`, `cost`, or `help` (no leading `/`…)" → prefixed forms + reworded rationale. | **Yes → regen** |
| `docs/user-flows/communication/overview.md` | Query-handler description (line 20) and the classify diagram + vocabulary list (199-213): prefixed forms. | No |
| `src/cli/bundled/plugin-docs.ts` | **Regenerate** via `pnpm run docs:bundle` after the two `docs/plugins/` edits. Do not hand-edit. | (generated) |

**Observation (do NOT touch):** `docs/archived/**` is a historical build journal; the requirements doc
already scoped it out by the project's own convention. I did not find active command-vocabulary docs
outside the four files above (grep for the vocabulary terms across `docs/` minus `/archived/` returned
exactly these three `.md` sources).

---

## 6. Conventions of the files I'll touch (so new code isn't a regression)

- **Style** (`biome.json`): double quotes, 2-space indent, 120-col width. `pnpm run lint` =
  `biome check` + `tsc --noEmit` (src and test) + `knip` (dead-export check) + `madge` (circular-dep check).
- **`query-handler.ts` shape:** module-level `const` regex (`PROGRESS_RE`), small pure functions, a
  section-banner comment style (`// ── Query Vocabulary ──`), exported `QueryKind` union as the typed
  vocabulary. A new prefix would idiomatically be a named `const` (e.g. `COMMAND_PREFIX = "!"`), matching
  the requirements doc's resolved interpretation (hardcoded constant, **not** a config knob).
- **Comments policy** (`AGENTS.md:196-198`): tests, docs, and logging are part of the same unit of work,
  not follow-ups. The existing doc-comments explain *why* (precedence, single-user); keep that register
  and reword the ones the change makes stale rather than deleting them.
- **`knip`** will flag `classifyQuery`/`isQueryVocabulary` if a refactor leaves either unexported-but-unused
  — keep both exported (the tests import them directly).

---

## 7. Edge-case inventory — the contract for execution & review

This is the table execution implements against and review checks. Dispositions follow the spec + the
requirements doc's resolved interpretations; the two marked *(planning call)* are genuinely open
low-stakes parser details, not owner decisions.

| Input | Expected classification | Basis |
|---|---|---|
| `!status` / `!cost` / `!help` / `!progress #42` | the matching command | Req #1, explicit forms |
| `  !STATUS ` (lead/trail space, mixed case) | `status` command | Req #1: "casing and surrounding whitespace tolerated" → `trim()` + lowercase |
| `…changes that help capture…` (mid-prose) | **not** a command → free-text reply (unblocks sole blocked task) | Req #3 + AC #1 — **the incident** |
| `help` / `status` / `cost` (bare, no `!`) | **not** a command → free text / handled-as-today | Req #1, AC #3 |
| `!helpme` (keyword is a substring of a longer token) | **not** the `help` command | Req #1: keyword is a marked **token**, not substring → require a token boundary (`\b`/whitespace/end) after the keyword. The current `includes("help")` would wrongly match this. |
| `!foo` / `!important: use option B` (prefix + **unknown** keyword) | **not** a command → free-text reply | Req #1 (prefix + *known* keyword) + Req #2 (never swallow free text). `classifyQuery` returns `unknown`; routing falls through to `sole_blocked_reply`. |
| `!progress` (prefix + keyword, **no `#N`**) | *(planning call)* — either `progress` with empty number (→ "Issue #undefined not found") or `unknown`. Today bare `progress` w/o `#N` is `unknown`. | Spec only requires `!progress #N`; pick the cleaner of the two and cover it. |
| `! status` (space **between** `!` and keyword) | *(planning call)* — Req #1 says "immediately followed", so strictly not a command; tolerating it is a minor `code_style` choice. | Low-stakes; the requirements doc already flagged this as a planning detail. |

**Note on `!progress #N` extraction:** `extractIssueNumber` (`query-handler.ts:143-146`) runs
`PROGRESS_RE.exec(content.toLowerCase())` on the **raw** content and is only reached when `kind ===
"progress"`. `!progress #42` still contains `progress … #42`, so the *existing* regex still extracts `42`
without modification. **Inference:** number extraction needs no change; only the *gate* (is it a command?)
moves to the prefix. Planning should still add a test that `!progress #42` → `42` to lock this in.

---

## 8. Challenge — is there a simpler way, and are these patterns worth copying?

- **Simplest correct approach (recommended for planning):** change *only* `classifyQuery`. After
  `content.trim()`, if it doesn't start with `!`, return `"unknown"`; otherwise match the remainder
  start-anchored against the known keywords with a trailing token boundary (a single regex such as
  `/^!\s*(status|cost|help|progress)\b/i` captures it, with `progress` then reading `#N` via the existing
  `PROGRESS_RE`). This is the smallest change that satisfies all five requirements: `isQueryVocabulary`,
  `handleQuery`, and `classifyInbound` all inherit the new behavior unchanged. No new file, no new
  abstraction, no config.
- **Is the substring pattern legacy I shouldn't copy?** Yes — it's the bug. Replace it; don't extend it.
- **Is there an existing mechanism that already solves part of this?** Partially: the Telegram plugin
  already strips `/`-prefixed messages (`telegram-comm.ts:231-239`). That's deliberately *not* reusable —
  the spec wants classification in Core, channel-agnostic, and `!` precisely to stay clear of `/`. No
  Core-level prefix parser exists to reuse; one small regex is the whole mechanism.
- **Unverified assumptions I won't present as fact:** whether planning prefers a shared keyword list (one
  source of truth for both the matcher and `formatHelpResponse`) over the current if-chain — that's a
  local-refactor taste call, not a correctness requirement. The current code duplicates the vocabulary
  between the if-chain and the help string; the change is a reasonable moment to centralize, but it is not
  required and I did not assume it.
- **The best code not written:** `response-poller.ts` needs no logic change. Resist the urge to "also
  refactor" the routing — the precedence is already correct and tested.

---

## 9. Verification (project gates — `package.json` + `AGENTS.md`)

- `pnpm run typecheck` — `tsc --noEmit` for src and test.
- `pnpm run lint` — `biome check` + typecheck + `knip` + `madge` (circular).
- `pnpm test` — unit tests; **includes** `tests/unit/cli/bundled/plugin-docs.test.ts` (the byte-for-byte
  bundle-drift guard), so the doc edits + `pnpm run docs:bundle` regen must land together or this gate
  goes red.
- Reminder: after editing the two `docs/plugins/` files, run `pnpm run docs:bundle` and commit the
  regenerated `src/cli/bundled/plugin-docs.ts`, or both the unit gate and CI fail.

---

## 10. Open questions

**None require a human.** The spec is owner-authored and complete; the requirements phase already
resolved the prefix value (`!`, fixed constant) and the prefix-without-known-keyword disposition. The two
*(planning call)* edges in §7 (`!progress` with no `#N`; a space between `!` and keyword) are low-stakes
parser details for the planning/execution phases, not owner decisions. Outcome: **ok**.
