# Plan — Issue #24: PR presentation (title + body) isn't updated after rework

_Source: github_issue FarzamMohammadi/the-engineer#24_
_Planning run: 2026-06-15 (first pass)_

Builds on `requirements/requirements.md` (final scope, owner-confirmed) and `research/research.md`.
I re-verified every file:line the prior phases cite against `src/` on this branch; the root cause,
the capability inventory, and the "change-detection trap" all hold. This plan resolves the design
decisions the owner delegated ("it's judgment, not mechanical") and lays out an ordered, verifiable
implementation. No open questions remain for a human.

---

## 1. What "done" looks like (from the owner-final acceptance criteria)

On every re-push to an existing PR, the PR's **title and body** are regenerated from the **full diff
against base** as one unified narrative (no per-round sections, no changelog), and pushed to the host
**only when the PR's substance actually changed** — a re-push that doesn't change what the PR
represents is a clean no-op. The title is no longer frozen to the original task. Push-only mode is
unchanged. Covered by tests; existing delivery/create-pr/auto-merge tests stay green.

---

## 2. Root cause (re-verified) and the three gaps to close

1. **Root cause — the rework path never pushes the regenerated presentation.**
   `src/core/orchestrator/pipeline/delivery/create-pr.ts:69-95` (`reworkExistingPr`) dismisses the
   stale approval, marks feedback `applied`, notifies — but **never reads `pr-description.md` and
   never calls `hosting.updatePR()`**. The freshly regenerated body sits on disk, unused. The
   new-PR path (`openNewPr`, `:131-182`) *does* read it and set the body via `createPR`. Only rework
   omits the push.
2. **Gap — there is no diff-derived title.** `create-pr.ts:149` builds the title as
   `composePrTitle(ctx.task.title, …)` — the *static task title*. `pr-description` produces a **body
   only** (`pr-description.ts:10`, `DELIVERABLE = "pr-description.md"`). Nothing generates a title
   from the work. Honoring "title represents the whole PR" requires producing one.
3. **Gap — there is no change-detection.** `updatePR` supports `{ title, body, … }`
   (`schemas/adapters.ts:362-369`, `null` = leave unchanged) and the GitHub plugin applies them
   (`github-hosting.ts:105-115`), but there is **no caller in core** and **no signal for "did the PR
   change since we last described it."** `getPRStatus` does not return title/body
   (`adapters.ts:378-389`), so the host can't be cheaply asked "what do you currently show."

**The capability we reuse, unchanged:** `GitHostingAdapter.updatePR` (contract at
`adapters/git-hosting.ts:56-58, 138`), `PRUpdates` (title+body+draft+labels), and the pure,
unit-tested `composePrBody` / `composePrTitle` (`create-pr.ts:202-235`). No parallel mechanism.

---

## 3. The hard part — change-detection under LLM nondeterminism (the decision that shapes everything)

The owner's stated mechanism ("regenerate from the diff → a no-op CI-fix naturally produces no
update") assumes regeneration is **deterministic**. It is not: the body (and any diff-derived title)
is written by the `pr-description` **LLM agent** (`pr-description.ts:56-68`), so re-running it on the
*same* diff yields *reworded* prose. A naive "compose the new body, compare strings, push if
different" therefore fires on nearly every no-op round → the **spurious update the owner explicitly
asked to avoid** (research §3).

So change-detection must key on the PR's **substance**, not the prose. The substance of a PR is its
**diff against base** (exactly what GitHub shows as the PR diff). Decision:

> **Gate the host update on a digest of the diff-against-base.** Store, on the task, the digest of the
> diff the *currently-shown* presentation was generated from. On a rework re-entry, recompute the
> current digest; if it equals the stored one, the PR's substance is unchanged → **skip the host
> update** (clean no-op). If it differs, regenerate-derived title+body genuinely reflect new substance
> → **push and store the new digest.**

This is the faithful implementation of the owner's own words — *"regenerate every time the **code**
changes and push whatever actually changed"* — with "code changed" made precise as "the diff against
base changed." It is mechanical (deterministic, unit-testable), robust to LLM reword-churn, and the
only judgment edge (a CI-fix that *does* alter the diff) resolves to "update the description to
reflect it," which is correct.

Trade-offs of this gate (accepted, documented):
- A pure-comment rework that changes **no code** → diff unchanged → no description update. Correct
  per "regenerate when the code changes."
- A rework where the diff changed but the LLM happens to regenerate an identical body → we push an
  identical body (host no-op edit). Harmless.
- A rework where the diff is unchanged but `requirements.md`/`refinements.md` changed → we skip
  (rare; the owner's model is code-driven). Acceptable.

**Rejected alternatives for change-detection:**
- _Compare composed title/body strings against a stored last-pushed copy (Philosophy A)._ Simplest,
  but LLM nondeterminism makes it fire on no-op rounds → violates AC#2. **Rejected.**
- _Read the live PR title/body from the host and compare._ Requires extending `PRStatus` /
  the adapter contract / **every** hosting plugin / the contract suite — broad blast radius — and it
  *still* compares LLM prose to LLM prose (nondeterministic). **Rejected** (cost + doesn't solve it).

---

## 4. Two approaches evaluated

### Approach S (simplest that actually meets the requirements) — CHOSEN
Three narrow additions, all reusing existing infrastructure:
1. `pr-description` also emits a **diff-derived title** as a second deliverable file (`pr-title.md`).
2. A **diff-digest** substance signal: a new `IWorkspaceManager.diffDigestAgainstBase(taskId)` method,
   and a nullable field `presented_diff_digest` on `ReviewState` storing the last-pushed digest.
3. `create-pr` **rework path** computes the digest, and when it changed, reads title+body, composes,
   and calls `updatePR` (spanned, best-effort — mirroring `dismissStaleApproval`), then persists the
   new digest. The **new-PR path** sources the title from the same deliverable and stores the
   creation-time digest, so the two paths generate the title identically (AC#4).

### Approach A (alternative) — host live-read
Extend the adapter to read the live PR title/body, compare against the regenerated presentation,
push on difference. **Rejected:** materially broader blast radius (adapter + `PRStatus` schema +
every git-hosting plugin + `tests/helpers/contract-suites/git-hosting-contract.ts`), and it does not
solve the nondeterminism problem it exists to solve.

**Why S over A:** S buys the same end-state with a fraction of the blast radius and *correctly* solves
no-op detection. Complexity did not earn the live-read path. (Within S, I also rejected shelling out
to `git` directly inside `create-pr` à la `push.ts` — see Decision D5 — in favor of a workspace-manager
method, for the boundary and testability.)

---

## 5. Chosen design — component by component

### 5.1 `pr-description` produces a diff-derived title (`src/core/orchestrator/pipeline/delivery/pr-description.ts`)
- Add `TITLE_DELIVERABLE = "pr-title.md"`.
- Extend `buildInstructions()` (and/or `buildResultContract` usage in `buildPrompt`) to instruct the
  agent to write, **in addition to** `pr-description.md`, a `pr-title.md` containing a **single line**:
  an imperative, concise PR title (~50–70 chars) that describes the **whole PR as it now stands**
  (original work + all rework), not just the original task. Reinforce that both title and body are
  drawn from `git diff` against base, so they always reflect everything the PR proposes to merge.
- The body instructions are unchanged in spirit (already regenerate from the full diff — research O2).
- The deliverable is still the agent's free-form output; `agentStep` validates only
  `session-result.json`. A missing `pr-title.md` is tolerated downstream (defensive fallback, 5.3).

### 5.2 Substance signal — `diffDigestAgainstBase`
- **Interface:** add to `src/core/interfaces/workspace-manager.interface.ts`:
  `diffDigestAgainstBase(taskId: string): string | null`.
- **Impl:** `src/core/workspace-manager/index.ts` — resolve the task's `WorkspaceRecord`; run
  `git diff origin/<baseBranch>...HEAD` (three-dot = the PR's diff since merge-base) in the worktree
  via the existing private `gitExec`; return `sha256(diffOutput)` hex (use `createHash` from
  `node:crypto`, mirroring `core/observer/blob-store.ts:computeHash`). Return `null` when the record/
  worktree is missing or git fails (no throw — this is a read used for a best-effort gate).
- The digest is a hash, never raw diff text, so no diff content (or secret) is stored on the task.
- Rationale for three-dot/diff (not HEAD sha): a merge-conflict resolution that merges base into the
  branch changes the HEAD sha but **not** the diff-against-base — three-dot correctly reads that as
  "no substance change." A sha would over-trigger.

### 5.3 `create-pr` (`src/core/orchestrator/pipeline/delivery/create-pr.ts`)
- Add `TITLE_DELIVERABLE = "pr-title.md"` and `readPrTitle(ctx): string | null` (mirror
  `readPrDescription`: first non-empty trimmed line, strip a leading `"# "`, return `null` if absent).
- **`openNewPr`:** source the title from the deliverable —
  `composePrTitle(sanitizeSecrets(readPrTitle(ctx) ?? ctx.task.title), ctx.task.external_ref)` — and,
  after `createPR` succeeds, store `presented_diff_digest: workspaceManager.diffDigestAgainstBase(id)`
  in the `review` object it already writes via `updateTaskField` (`:162-168`). (Body path unchanged.)
- **`reworkExistingPr`:** after dismissing the approval, run a new `refreshPrPresentation(...)` step:
  1. `current = workspaceManager.diffDigestAgainstBase(ctx.task.id)`.
  2. `last = ctx.task.review.presented_diff_digest ?? null`.
  3. If `current == null` → cannot verify → **skip** (warn; best-effort, never block).
  4. If `current === last` → unchanged → **skip** (clean no-op).
  5. Else: `title = composePrTitle(sanitizeSecrets(readPrTitle(ctx) ?? ctx.task.title), ref)`,
     `body = composePrBody(sanitizeSecrets(readPrDescription(ctx) ?? fallback), ref)`; call
     `hosting.updatePR(repo, prNumber, { title, body, draft: null, labels_add: null, labels_remove: null })`
     inside a `tool_execution` span named e.g. `update_pr_presentation` (`traceScope(ctx)`), **best-effort**
     and non-blocking exactly like `dismissStaleApproval` (`:102-128`): on failure, `setError` + `warn`
     + return without throwing.
  6. Fold the digest update into the **single** existing `review` write: persist `presented_diff_digest
     = (pushed && succeeded) ? current : last` alongside the `feedback_rounds … applied:true` update,
     so there is one `updateTaskField("review", …)` call.
  7. Record `{ description_updated: boolean }` (and reason) in the returned `data`, beside
     `approval_dismissed`.
- Ordering note (crash-safety): `updatePR` happens **before** the digest is persisted, so a crash
  between them causes at most one redundant (idempotent) re-push next round — never a missed update.

### 5.4 Schema (`src/schemas/task.ts`, `ReviewStateSchema`)
- Add `presented_diff_digest: z.string().nullable().optional()` with a doc comment: *"sha256 of the
  diff-against-base that the PR's currently-shown title/body were generated from — the change-detection
  baseline so a re-push updates the host only when the PR's substance changed."*
- **`.optional()` (no `.default`) is deliberate** (Decision D4): it keeps the output type
  `string | null | undefined`, so existing `ReviewState` literals and the schema test's
  parse-based `toEqual(...)` assertions (`tests/unit/schemas/task.test.ts:287-323`) compile and pass
  **unchanged**. Read it as `review.presented_diff_digest ?? null`.
- `review` is persisted as a single JSON `TEXT` column (`db/migrations/001_schema.sql:34`,
  `task-engine/index.ts:101` classifies it `"json"`), so this is **purely additive — no SQL
  migration, no `FIELD_TYPES` change**. Already-open PRs (pre-deploy) read the field as `undefined`
  → treated as "no baseline" → their next rework refreshes once. That is the desired catch-up.

---

## 6. Stress test (self-review of the chosen design)

- **Plugin opacity — Core compiles with every plugin deleted?** Yes. The rework path calls
  `hosting.updatePR(...)` through the abstract `GitHostingAdapter` contract, never a GitHub type. The
  digest method is pure Core (`workspace-manager`). No plugin import is added to Core.
- **Isolation — shared mutable state / cross-task bleed?** None. `presented_diff_digest` lives in the
  per-task `review` row; `pr-title.md`/`pr-description.md` live in the task's own worktree. Writes go
  through `updateTaskField` (existing optimistic locking). Nothing is process-global.
- **Boundaries — contracts, not internals?** The digest is fetched via a new
  `IWorkspaceManager` method (git is the workspace manager's domain), not by reaching into git from
  `create-pr`. The host update goes through the adapter contract. (We knowingly do **not** match
  `push.ts`'s direct `execFileSync` — see D5.)
- **Reversibility — what's hard to undo?** Two additive, low-risk commitments, both named here:
  (a) the `IWorkspaceManager.diffDigestAgainstBase` method (an internal contract — additive,
  one implementer), and (b) the `presented_diff_digest` field (a JSON sub-field — additive, no
  migration). Both are removable without data loss. The `pr-title.md` convention and the `updatePR`
  wiring are fully reversible.

---

## 7. Pre-mortem — assume it ships with a subtle flaw

1. **Spurious updates from LLM reword (most likely).** *Mitigated by the core design:* the diff-digest
   gate skips the host call whenever the diff is unchanged, so a reworded-but-same-substance body is
   never pushed. (A naive string compare would have shipped exactly this bug.)
2. **Title coherence on the first re-push.** Risk: the first rework rewrites an unchanged title.
   *Mitigated:* `openNewPr` stores the creation-time digest, and both paths generate the title the
   same way; a no-diff-change first rework matches the stored digest → no push → title stays. A real
   first rework regenerates the title from the now-larger diff → correct.
3. **`updatePR` host failure mid-delivery.** *Mitigated:* best-effort/non-blocking (mirrors
   `dismissStaleApproval`); the digest is **not** advanced on failure, so the next rework retries.
   Delivery is never blocked by a failed description refresh (the code is already pushed).
4. **git unavailable / odd worktree state → null digest.** *Mitigated:* `diffDigestAgainstBase`
   returns `null`; rework treats null as "cannot verify" and skips (warns), never blocks. `openNewPr`
   stores `null`, so the first rework refreshes once (acceptable).
5. **Crash between `updatePR` success and persisting the digest.** *Mitigated by ordering:* at most one
   redundant idempotent re-push next round; never a missed update or corrupted state.
6. **Unbounded growth / concurrency.** None introduced — the digest is a fixed-size string that
   replaces itself; all state is per-task; no new global or queue.

---

## 8. Ordered implementation steps (each with a verification step)

> Run from repo root. Gates (from `package.json`): `pnpm run typecheck`, `pnpm run lint`
> (biome + tsc + knip + madge), `pnpm test` (vitest). Note: `knip` flags `updatePR` as unused **until**
> step 4 adds the caller — that resolves itself here.

- [ ] **1. Schema field.** Add `presented_diff_digest: z.string().nullable().optional()` (with doc
      comment) to `ReviewStateSchema` in `src/schemas/task.ts`.
      _Verify:_ `pnpm run typecheck` is clean; `tests/unit/schemas/task.test.ts` still passes
      unchanged (optional ⇒ parse output is unchanged). Optionally add one assertion that a provided
      digest round-trips through `.parse`.

- [ ] **2. Workspace-manager digest method.** Add `diffDigestAgainstBase(taskId): string | null` to
      `src/core/interfaces/workspace-manager.interface.ts` and implement it in
      `src/core/workspace-manager/index.ts` (`git diff origin/<base>...HEAD` via `gitExec`, sha256 hex;
      `null` on missing record/worktree or git error).
      _Verify:_ `pnpm run typecheck`; add a focused unit test using the real-temp-git harness already
      used by `tests/unit/.../delivery/delivery.test.ts` (or `tests/helpers/test-workspace-manager.ts`):
      identical trees → identical digest; an extra commit that changes the diff → different digest.

- [ ] **3. `pr-description` emits a title.** Add `TITLE_DELIVERABLE = "pr-title.md"` and extend the
      prompt instructions in `src/core/orchestrator/pipeline/delivery/pr-description.ts` to write a
      single-line, whole-PR title to `pr-title.md` alongside the body.
      _Verify:_ `pnpm run typecheck`; in `tests/unit/.../delivery/delivery.test.ts` (or the
      pr-description test) assert `buildPrompt(ctx)` mentions `pr-title.md` and the "whole PR" framing.

- [ ] **4. `create-pr` wiring.** In `src/core/orchestrator/pipeline/delivery/create-pr.ts`: add
      `TITLE_DELIVERABLE` + `readPrTitle`; have `openNewPr` source the title from the deliverable and
      store the creation digest; add `refreshPrPresentation` and call it from `reworkExistingPr`
      (change-detection → spanned best-effort `updatePR` → single `review` write with the digest);
      record `description_updated` in result `data`.
      _Verify:_ `pnpm run typecheck`; `pnpm test tests/unit/core/orchestrator/pipeline/delivery/create-pr.test.ts`.

- [ ] **5. Tests for the new behavior** (see §9). Extend `create-pr.test.ts`'s `mockCtx` with
      `updatePR: vi.fn()` on `hosting` and `diffDigestAgainstBase: vi.fn()` on `workspaceManager`.
      _Verify:_ new cases pass; the existing rework/creation/span cases stay green.

- [ ] **6. Completeness + full gates.** Add `presented_diff_digest` only where a literal/expected
      object now *requires* it (the `.optional()` choice means most sites are untouched; the spread-based
      `updateTaskField` calls in `pr-event-poller.ts:293-335` already preserve it).
      _Verify:_ `pnpm run typecheck` && `pnpm run lint` && `pnpm test` all green. Grep proves no caller
      gap remains: `rg "updatePR" src/core` now shows the rework caller.

---

## 9. Test plan (project tier: vitest unit, matching the surrounding suite)

Primary file: `tests/unit/core/orchestrator/pipeline/delivery/create-pr.test.ts`
(extend `mockCtx`: `hosting = { createPR, dismissApprovals, updatePR }`; add
`workspaceManager.diffDigestAgainstBase`). New cases:
- **Rework, substance changed** (`diffDigestAgainstBase` returns a digest ≠ stored
  `review.presented_diff_digest`): `updatePR` is called once with the refreshed `title` **and**
  `body`; the `review` write persists the new digest; `data.description_updated === true`.
- **Rework, substance unchanged** (digest === stored): `updatePR` is **not** called; the stored digest
  is preserved; `data.description_updated === false`. (Approval still dismissed, feedback still applied.)
- **Rework, digest unavailable** (`null`): `updatePR` is **not** called; delivery still returns `ok`
  (best-effort).
- **Rework, `updatePR` rejects:** the rework still returns `ok` (non-blocking); the
  `update_pr_presentation` span is recorded `errored`; the digest is **not** advanced.
- **New PR:** still opens exactly one PR; title now sourced from `pr-title.md` (fallback to
  `ctx.task.title` when absent — the fake-worktree default keeps existing assertions valid since they
  don't assert the title); the creation digest is stored on `review`.

Must-stay-green: existing `create-pr.test.ts`, `delivery.test.ts` (skip-gates: the new host calls must
not fire in push-only mode — they're inside `createPr`/`prDescription`, both already `skipWhenPushOnly`),
`github-hosting.test.ts` `updatePR()` cases, `tests/unit/schemas/task.test.ts`, and the auto-merge /
pr-events / daemon / reaper suites.

Push-only safety: no new code path runs outside `createPr`/`prDescription`, both of which already skip
in push-only mode — so no host title/body call can occur there (AC#5). The `delivery.test.ts`
skip-gate assertions enforce this.

---

## 10. Decisions recorded (rationale execution inherits)

- **D1 — Change-detection = diff-against-base digest** (not string compare, not host live-read). The
  faithful, robust reading of the owner's "regenerate when the code changes; push what changed." Locks
  in a persisted `ReviewState` field + a workspace-manager method. (Surfaced — see session-result.)
- **D2 — Title is a diff-derived `pr-title.md` deliverable, sourced identically by create + rework.**
  Satisfies "title represents the whole PR" and AC#4 (creation consistent with update). Side effect:
  newly-opened PRs get an LLM-generated title instead of the raw task title. (Surfaced.)
- **D3 — `updatePR` failure is best-effort/non-blocking,** mirroring the neighboring
  `dismissStaleApproval`. The owner delegated this; best-effort is the low-risk default (code is
  already pushed; a stale-but-present description is recoverable next round).
- **D4 — `presented_diff_digest` is `.nullable().optional()` (no `.default`),** to keep blast radius
  tight: existing `ReviewState` literals and the schema test's parse-based `toEqual` assertions stay
  unchanged. (The sibling fields use `.default`; I trade that minor stylistic consistency for not
  editing ~6 unrelated test files. Read via `?? null`.)
- **D5 — Fetch the digest via a workspace-manager method, not raw `git` in `create-pr`.** Respects the
  git-ownership boundary and makes both rework branches unit-testable in `create-pr.test.ts`'s existing
  mock style. `push.ts` shelling out directly is pre-existing and intentionally left as-is (not in scope).

---

## 11. Out-of-scope observations (noted, not fixed — boy-scout boundary)
- `create-pr.ts:87` notification text ("Pushed rework addressing review feedback.") is inaccurate for
  CI-fix/conflict re-pushes. Pre-existing; not in this issue's surface.
- `github-hosting.ts:91-98` `doUpdatePR` logs `hasTitle`/`hasDraft` but not `hasBody`. Trivial plugin
  log gap; this change makes body-updates a real path, so a one-line `hasBody` add would be reasonable,
  but it's a plugin-internal log detail — left out of the core change.
- `schemas/task.ts:106,108` doc comments call the title "AI-generated"; with D2 that finally becomes
  literally true for the body and (post-rework) the title. No code change needed.

## 12. Open questions for a human
**None.** All product decisions were owner-settled in `requirements.md`; the design decisions above
were explicitly delegated ("it's judgment, not mechanical"). D1 and D2 are surfaced via
`session-result.json` `details.decisions` so the autonomy policy may confirm them, but they do not
block planning.

---

# Planning run 2 — 2026-06-15 (owner confirmed D1 + D2; one critical correction)

The owner answered the two surfaced decisions. **Both confirmed, and the answer carries two precise
build notes that this run folds in.** This is an amendment to the first pass above — everything in
§§1–11 stands **except** the digest-scope detail in §5.2 / step 2, which had a latent self-trigger
bug that the owner's build note #1 caught. I re-verified the relevant code on this branch before
writing this; the correction is grounded, not inherited.

## A. What the owner settled (quoting)

- **D1 confirmed — diff-digest change-detection.** *"A sha256 of the diff-against-base is exactly the
  deterministic reading of 'push what changed' — string-comparing LLM-regenerated prose would fire on
  every no-op… Additive, no migration, no adapter-contract change: good."* → The chosen design
  (Approach S, §4–5) is the intended one. The rejected alternatives (string-compare, host live-read)
  stay rejected, now with the owner's explicit backing.
- **D2 confirmed — title as a diff-derived deliverable, and the creation side-effect is intended.**
  *"A new PR SHOULD get a whole-PR title generated from the diff, not the raw task title… title and
  body are one unit, both representing the latest PR as a whole, sourced identically at creation and on
  rework. The fallback to the task title when pr-title.md is absent is the right safety net."* → §5.1
  and the `openNewPr` title sourcing in §5.3 are exactly right, including the `?? ctx.task.title`
  fallback.

Neither is an open decision any longer. This run reports **`ok`** with no pending `decisions`.

## B. CORRECTION (build note #1) — the digest MUST exclude the engine's own deliverables ⚠

Owner: *"compute the digest over the code that's actually being merged, NOT the engine's own
regenerated deliverables (pr-title.md and the thoughts/ files). If those are in the digest,
regenerating them each run changes the digest and re-triggers the very spurious push the digest exists
to prevent. Exclude them (mirror `exclude_thoughts_on_merge`)."*

**This is a real bug in the first pass, not a nuance.** §5.2 / step 2 specified the digest as
`git diff origin/<base>...HEAD` over the **whole** tree. But `push` runs **before** `create-pr`
(`pipeline.ts:65`: `[prDescription, push, createPr, …]`) and `commitStragglers` does `git add -A`
(`delivery/push.ts:73-84`) — so every round commits the freshly-regenerated `pr-title.md` /
`pr-description.md` (and every other `thoughts/` deliverable) into HEAD. A digest over the full tree
would therefore **change on every single round**, firing a spurious `updatePR` every time — precisely
the behavior the digest exists to suppress. The first pass would have shipped the bug it was designed
to avoid.

**Fix — scope the diff to merged code, excluding `thoughts/`** (which transitively covers
`pr-title.md` and `pr-description.md`, since the deliverables live under
`ctx.thoughtsDir ⊂ thoughts/` — confirmed: `create-pr.ts:189` joins `thoughtsDir/delivery/<file>`,
and `pr-manager.ts:43` / `policy-engine.ts:302` both scope thoughts handling to the literal
`thoughts/`). The digest command in §5.2 becomes:

```
git diff origin/<baseBranch>...HEAD -- . ":(exclude)thoughts/"
```

`":(exclude)thoughts/"` is the git magic-pathspec exclusion; `.` includes everything else. This
**mirrors `exclude_thoughts_on_merge`** exactly as the owner asked — the same `thoughts/` boundary
`removeThoughtsAndPush` (`pr-manager.ts:43`) and the merge-exclusion path use. A single `thoughts/`
exclusion is sufficient and is the established convention; do **not** enumerate the two deliverable
filenames separately.

This correction touches **only** the `diffDigestAgainstBase` implementation in
`src/core/workspace-manager/index.ts` (the `gitExec([...])` arg list — `gitExec` confirmed present at
`workspace-manager/index.ts:685`). Nothing else in §5 changes: the digest is still sha256-hex over the
command's stdout, still `null` on missing record / git error, still compared in `reworkExistingPr`,
still stored on `review.presented_diff_digest`.

## C. AFFIRMED (build note #2) — keep the title decorations wrapping the generated title

Owner: *"keep the existing title decorations (the issue-number prefix/suffix the trigger plugin
supplies) wrapping the generated title: generate the core title, then decorate, same as today."*

Already satisfied by the first pass and requires **no change**: §5.1/§5.3 generate the *core* title
into `pr-title.md`, then both `openNewPr` and `reworkExistingPr` wrap it via the existing pure
`composePrTitle(core, ctx.task.external_ref)` (`create-pr.ts:221-226`), which applies
`pr_decorations.title_prefix` / `title_suffix` around `sanitizeSecrets(core)`. The generated title is
the *input* to decoration, never a replacement for it. Re-stating it here so execution does not
accidentally bypass `composePrTitle` when wiring the new title source.

## D. Amended verification for the corrected digest (replaces step 2's test bullet)

The first pass's step-2 test asserted only "same tree → same digest; code commit → different digest."
Add the **exclusion regression guard** that proves build note #1, using the real-temp-git harness
(`tests/helpers/test-workspace-manager.ts` — the same `createTestWorkspaceManager` that
`tests/unit/core/orchestrator/remove-thoughts-and-push.test.ts` uses):

1. Baseline digest on a fresh worktree.
2. Commit a change to a **non-`thoughts/`** tracked file → digest **changes** (real code is captured).
3. Add/commit a file under `thoughts/…` (e.g. `thoughts/<id>/delivery/pr-title.md`) → digest is
   **unchanged** vs. step 2. ← the guard against self-triggering; without the `:(exclude)thoughts/`
   pathspec this assertion fails.

## E. Net change set for this run (everything else per §8)

- **§5.2 / step 2 only:** the `diffDigestAgainstBase` git command gains `-- . ":(exclude)thoughts/"`,
  with the doc-comment reason ("exclude the engine's own regenerated deliverables so the substance
  digest doesn't self-trigger; mirrors `exclude_thoughts_on_merge`").
- **§9 / step 2 test:** add the exclusion regression case (D above).
- **Decisions D1, D2:** status changes from *surfaced/pending* to *confirmed by owner* — no longer
  emitted as open `decisions` in `session-result.json`.
- All other steps (1, 3–6), the schema field (§5.4), the stress test (§6), the pre-mortem (§7), and
  the out-of-scope notes (§11) are unchanged and re-verified to still hold.

## F. Decision status (final)

**No open decisions remain for the owner.** D1 and D2 were the only surfaced calls; the owner
confirmed both. The remaining choices (D3 best-effort `updatePR`, D4 `.optional()` schema field, D5
workspace-manager method over raw git, three-dot diff range) are local/delegated mechanism calls
recorded in §10 for execution to inherit — none is a still-open choice the owner would gate on, so
none is surfaced. → **`ok`**.
