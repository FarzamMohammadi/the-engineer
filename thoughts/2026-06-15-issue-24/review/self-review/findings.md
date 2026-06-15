# Self-Review — Issue #24 (PR description isn't updated after rework)

## Scope reviewed

Diff scope: `git diff origin/main...HEAD` (the branch merged `origin/main` in `526804f`, so
the merge-base is `origin/main`'s tip and this range is exactly the issue #24 work). Source
changes:

- `src/core/orchestrator/pipeline/delivery/pr-description.ts` — agent now writes a `pr-title.md`
  deliverable alongside `pr-description.md`; prompt instructs both to describe the *whole* PR
  from the full diff against base, not round-by-round.
- `src/core/orchestrator/pipeline/delivery/create-pr.ts` — new `refreshPrPresentation` on the
  rework path; `readPrTitle` deliverable reader; title sourced from the deliverable at both
  creation and rework; digest baseline persisted on the review state.
- `src/core/workspace-manager/index.ts` + interface — new `diffDigestAgainstBase(taskId)`:
  sha256 of `origin/<base>...HEAD` excluding `thoughts/`.
- `src/schemas/task.ts` — `presented_diff_digest` added to `ReviewStateSchema` (`.optional()`).
- `knip.json` — `lefthook` added to `ignoreDependencies`.
- `docs/user-flows/pr-management/overview.md` — narrative updated to match.
- Tests for all of the above.

## Verdict

The change does what the issue asked and is cleanly built. The central design problem —
"the pr-description agent regenerates prose every round, so prose can't be the change signal" —
is solved correctly by keying the host update on a *diff-against-base digest* rather than the
prose, and by excluding `thoughts/` from that digest so the engine's own regenerated
deliverables don't falsely trip it. Best-effort/non-blocking semantics mirror the existing
`dismissStaleApproval`, the digest-unavailable and update-failed paths preserve the prior
digest so a later round retries, and the body is protected from degradation (`body: null` =
leave-unchanged when the deliverable is absent). Tests are real-substance (real temp git repo
for the digest, real temp worktree for deliverable reads), not just mock-shaped.

## Verification performed

- `pnpm typecheck` — passes.
- `pnpm test:unit` — **2622 passed** across 139 files.
- Confirmed the GitHub plugin's `doUpdatePR` treats `title: null` / `body: null` as
  "leave unchanged" (`src/plugins/git-hosting/github-hosting/github-hosting.ts:105-117`), so
  the `body: null` protection works as the comment claims.
- Confirmed `composePrTitle`/`composePrBody` both run `sanitizeSecrets` on agent-authored text.
- Confirmed `knip.json`'s `lefthook` addition is a justified gate-fix, not scope creep:
  `lefthook.yml` is tracked and `lefthook` is a real devDependency on `main`; knip's lefthook
  plugin only counts it as used when `CI` is set, so `pnpm lint` fails locally without the
  ignore. One-line, reversible, matches the file's existing convention.
- No stray files, debug logging, TODO/FIXME, or leftover scaffolding in the diff. The only
  untracked path is this review deliverable directory (expected).

## Findings

### 1. (Low) Title can be degraded on rework, contradicting its inline comment

**Where:** `src/core/orchestrator/pipeline/delivery/create-pr.ts:157-164` (the title line in
`refreshPrPresentation`).

**What:** The body is protected against degradation — when the description deliverable is
absent, the code sends `body: null` so the rich body written at creation survives. The title
is deliberately *not* given the same protection: it is always sent, falling back to
`ctx.task.title` when `readPrTitle` returns null. The inline comment justifies this with:

> "The title still refreshes — its fallback reproduces the live title when the deliverable is
> absent, so it is never degraded."

That claim only holds when the PR title at *creation* also came from the task-title fallback.
If creation wrote a diff-derived title (`pr-title.md` present then) but a later
substance-changing rework round has `pr-title.md` absent, `readPrTitle` returns null, the title
falls back to `ctx.task.title`, and `updatePR` overwrites the good diff-derived title with the
task title — a real degradation. Because that round advances `presented_diff_digest`, the
degraded title then persists until a *further* substance change lands with the deliverable
present.

**Why it matters:** It's the exact failure mode the body guard exists to prevent, left open for
the title, and the comment asserts the opposite of the actual behavior. The next reader trusts
the comment.

**Likelihood:** Low. `pr-description` runs every rework round and is explicitly told to write
`pr-title.md`, so the absent-at-rework-but-present-at-creation case requires the agent to skip
the file on a later round only. Recoverable, but not automatically.

**Concrete fix (small, mirrors the body):** On the rework path, leave the host title unchanged
when the deliverable is absent:

```ts
const titleDeliverable = readPrTitle(ctx);
const title = titleDeliverable ? composePrTitle(titleDeliverable, ctx.task.external_ref) : null;
```

`PRUpdates.title` is nullable and the plugin treats null as leave-unchanged, so this fully
mirrors the body guard and makes the comment true. Creation (`openNewPr`) must keep the
task-title fallback — `PROptions.title` is non-nullable, and there is nothing live to degrade
when first opening. Alternatively, if the always-send behavior is intentional, soften the
comment so it no longer claims "never degraded."

## Not findings (considered and dismissed)

- **Merge-base drift moving the digest:** if `origin/<base>` is re-fetched between creation and
  a rework, the three-dot merge-base shifts and the digest can change without branch commits.
  This is documented as best-effort and is arguably correct (the PR's effective diff did
  change). Not a defect.
- **`pr-description` LLM still runs on no-op rounds:** the digest gate suppresses the *host
  update*, not the LLM regeneration in the separate `pr-description` sub-phase. That sub-phase
  always ran before this change too — no regression, and out of scope.
- **`LEADING_HEADING` (`/^#\s+/`) only strips `# ` not `##`/`#x`:** the prompt asks for a plain
  single-line title, so deeper-heading input is not expected; harmless fallthrough. Not worth a
  change.

---

## Pass 2 — 2026-06-15 (re-review after refine fixed pass-1 finding)

### What I checked

Re-ran the holistic last look against the current tree (`git diff 2d799fd...HEAD`, the issue #24
work). The pass-1 finding ("title can be degraded on rework") was fixed by refine in commit
`a86a36e`; I confirmed the fix is present in the current code:
`refreshPrPresentation` now sources the title as
`const title = titleDeliverable ? composePrTitle(...) : null` (create-pr.ts ~144), mirroring the
body guard, and the inline comment is truthful. The "no deliverable on rework" test asserts both
`title: null` and `body: null`.

Independently verified, all clean:

- **Requirements met.** The rework path (`reworkExistingPr`, reached by review-feedback *and*
  CI-fix *and* merge-conflict re-pushes) now refreshes both title and body so they describe the
  whole PR. The `pr-description` prompt is rewritten to draw both from the full diff against base,
  "as if every change landed at once — never round-by-round." Regenerating from the full diff is a
  stronger design than accumulating per-round notes and exactly satisfies the issue's "complete,
  accurate picture of the full PR."
- **Change-detection is correct.** Host update is gated on `diffDigestAgainstBase`
  (`origin/<base>...HEAD`, excluding `thoughts/`), not on the LLM prose — so a no-op re-push that
  only regenerated prose does not push a spurious update. Three-dot range makes a base-merge
  conflict-resolution (new HEAD sha, same net diff) read as no change. Digest tested with a real
  temp git repo (code change moves it; a `thoughts/` commit does not).
- **Best-effort, never blocks.** digest-unavailable and update-failed paths both preserve the
  prior digest (so a later round retries) and return `description_updated: false`; mirrors
  `dismissStaleApproval`. The code is already pushed before either runs.
- **Backward compatible.** `presented_diff_digest` is `.optional()` (old persisted review literals
  parse unchanged, tested); an in-flight PR with no stored digest reads `last = null`, so its first
  rework correctly refreshes.
- **Secret hygiene.** Title and body pass through `sanitizeSecrets` at both creation and refresh;
  error text through `sanitizeErrorMessage`.
- **Dispatch is sound.** `reworkExistingPr` only runs when `review.pr_number != null`, so the
  `if (ctx.task.review)` digest-persist guard is TypeScript narrowing (the type stays nullable
  through `?.`), not dead defensive code — the digest is always persisted on this path.
- **Notification correctness/completeness.** Message made cause-neutral ("Pushed rework to the
  PR."); the docs table is updated to match; the only remaining "addressing review feedback"
  strings are the explanatory code/test comments and frozen `docs/archived/` history — no stale
  live reference.
- **What ships.** `knip.json` `lefthook` ignore and `biome.json` `thoughts` ignore are justified
  one-line gate fixes (confirmed by prior passes and consistent with the file conventions). No
  stray files, debug logging, TODOs, or leftover scaffolding in the source diff.

### Gates (current tree)

- `pnpm typecheck` — pass.
- `pnpm vitest run` on the three affected suites — **124 passed** (create-pr 19, workspace-manager
  47, task schema 58).

### New findings

None. The pass-1 finding is fixed and verified in place. The two edges I re-examined were already
considered and correctly dismissed by the prior passes, and I agree:

- **`description_updated: true` when *both* deliverables are absent on a substance-changing round**
  — `updatePR` is still called with all-null fields (a host no-op for a compliant plugin) and the
  digest advances, so the data flag slightly overstates. This is an agent-failure edge only
  (`pr-description` writes both files every normal round); harmless observability inaccuracy, not
  worth gold-plating.
- **Merge-base drift moving the digest** if `origin/<base>` is re-fetched between rounds — the
  effective PR diff genuinely changed, so a refresh is arguably correct; documented best-effort.

### Verdict: ship

The change correctly and completely solves the issue, the single prior finding is fixed and the
fix mirrors already-vetted behavior, tests are real-substance and comprehensive, and every gate is
green. Nothing material remains.
