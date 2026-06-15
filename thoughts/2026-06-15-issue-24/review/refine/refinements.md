# Refine — Issue #24 (PR description isn't updated after rework)

## Pass 1 — 2026-06-15

### Scope reviewed

`git diff origin/main...HEAD`. The change makes the PR's title and body describe the **whole**
PR after every rework round, not just the original task:

- `pr-description.ts` — the delivery agent now writes a `pr-title.md` deliverable alongside
  `pr-description.md`; the prompt instructs both to describe the whole PR from the full diff
  against base, written as if every change landed at once (never round-by-round).
- `create-pr.ts` — new `refreshPrPresentation` on the rework path refreshes title + body, gated
  on a diff-against-base digest so an unchanged re-push is a clean no-op. Title is sourced from
  the `pr-title.md` deliverable at both creation and rework. The digest baseline is persisted on
  the review state at creation.
- `workspace-manager` (+ interface) — new `diffDigestAgainstBase(taskId)`: sha256 of
  `origin/<base>...HEAD` excluding `thoughts/`, best-effort (returns null, never throws).
- `task.ts` — `presented_diff_digest` added to `ReviewStateSchema` as `.optional()`.
- `knip.json` — `lefthook` added to `ignoreDependencies` (gate fix).
- `docs/user-flows/pr-management/overview.md` — narrative updated to match.
- Tests for all of the above (real temp git repo for the digest, real temp worktree for the
  deliverable reads).

### Consolidated findings from the lenses

Only the self-review lens ran. It reported **one** finding (everything else verified clean):

- **(Low) Title can be degraded on rework, contradicting its inline comment.** On the rework
  path the title was always sent, falling back to `ctx.task.title` when `pr-title.md` was absent.
  If creation wrote a diff-derived title but a later substance-changing round had the deliverable
  absent, the title would be overwritten with the *original task* title — the exact drift this
  feature exists to prevent — and would persist until a further substance change landed with the
  deliverable present. The body was already guarded against this identical failure mode
  (`body: null` = leave-unchanged); the title was not, and the inline comment falsely claimed the
  title "is never degraded."

I confirmed this holds against the actual code:
- `PRUpdatesSchema.title` is `z.string().nullable()` (`src/schemas/adapters.ts:363`).
- `doUpdatePR` skips the `title` param entirely when `updates.title === null`
  (`github-hosting.ts:105-117`), and skips the whole `pulls.update` call when title, body, and
  draft are all null — so `title: null` genuinely means "leave the host title unchanged."

### Fix applied (commit `a86a36e`)

Mirrored the body guard for the title on the rework path:

```ts
const titleDeliverable = readPrTitle(ctx);
const title = titleDeliverable ? composePrTitle(titleDeliverable, ctx.task.external_ref) : null;
```

- When `pr-title.md` is absent on rework, the host title is now left unchanged instead of being
  reset to the original task title. Strictly non-degrading.
- Rewrote the inline comment so it is truthful: both title and body are left unchanged when their
  deliverable is missing.
- **Creation (`openNewPr`) intentionally keeps the `ctx.task.title` fallback** — `PROptions.title`
  is non-nullable and there is nothing live to degrade when first opening the PR. Unchanged.
- Updated the `"...no deliverable..."` rework test to assert `title: null` alongside `body: null`,
  and renamed it to "leaves the live title and body in place."

### Independent review of the rest of the diff

I re-checked the lens's dismissals against the code and agree with them:
- **Merge-base drift moving the digest** (re-fetched base shifts the three-dot merge-base): the
  effective PR diff genuinely changed, so refreshing is arguably correct; documented best-effort.
  Not a defect.
- **`pr-description` LLM still runs on no-op rework rounds:** the digest gate suppresses the
  *host update*, not the separate LLM sub-phase, which always ran. No regression, out of scope.
- **Degenerate case — both deliverables absent on a substance-changing round:** after my fix,
  `updatePR` is still called with all-null fields, which the GitHub plugin turns into a host
  no-op; the digest still advances and `description_updated: true` is returned. Harmless
  observability inaccuracy in an agent-failure edge; not worth gold-plating.
- **`knip.json` lefthook ignore:** justified gate fix (`lefthook.yml` tracked, `lefthook` a real
  devDependency; knip's plugin only counts it used when `CI` is set, so `pnpm lint` fails locally
  without the ignore). One-line, reversible, matches the file convention. Not scope creep.

Confirmed: agent-authored title and body both pass through `sanitizeSecrets` /
`sanitizeErrorMessage`; no stray files, debug logging, or TODOs in the diff.

### Gates (after fix)

- `pnpm typecheck` — pass.
- `pnpm test:unit` — **2622 passed** across 139 files (create-pr suite: 19/19).
- `pnpm lint` (biome + tsc + tsc test + knip + madge) — pass (knip: 3 pre-existing warnings, no
  errors; no circular deps).

### Verdict: ship

The change correctly and completely solves the issue: the PR's title and body now describe the
whole PR after every rework, keyed on a substance digest that excludes the engine's own
regenerated deliverables. The one finding the review surfaced is fixed in place — it was the same
drift the issue describes, leaking through the title — and the fix mirrors already-vetted
behavior, is covered by an updated test, and passes every gate. Nothing material remains. A
re-review pass would not converge on anything new for a two-line guard that the lens itself
proposed.

## Pass 2 — 2026-06-15 (re-review after CI-fix rework round)

### Why this pass ran

Since Pass 1 the branch took further rework rounds (visible in the log): a merge-conflict
resolution (`526804f` merge of `origin/main`, `d2d104c`), the Pass-1 title guard
(`a86a36e`), another review-feedback round (`3ccac13`), and a **CI-fix round** that excluded
`thoughts/` from Biome so the committed engine deliverables stop failing CI lint
(`2aa4d88`, recorded in `f434692`). The self-review lens re-ran (its "Pass 2") against the
current tree and returned **ship with no new findings**. This refine pass independently
re-verifies the whole current change rather than trusting that verdict.

### Consolidated findings from the lenses (this pass)

Only the self-review lens ran. Its Pass 2 reports **zero** new findings: the Pass-1 title
degradation is fixed and verified present, and the two edges it re-examined (both-deliverables-
absent observability inaccuracy; merge-base drift) were already considered and correctly
dismissed in Pass 1. I agree with all of it.

### Independent verification (not taken on the lens's word)

I re-read the full source diff (`git diff origin/main...HEAD -- src/ docs/ knip.json biome.json`)
and confirmed against the actual code:

- **Pass-1 fix is present and correct.** `refreshPrPresentation` sources the title as
  `const title = titleDeliverable ? composePrTitle(titleDeliverable, ctx.task.external_ref) : null`
  and the body symmetrically (`description ? composePrBody(sanitizeSecrets(description), …) : null`).
  A missing deliverable on rework now leaves the host value unchanged (`null` = leave-unchanged,
  honoured by the GitHub plugin) instead of resetting to the original task title — the exact drift
  the issue is about. The inline comment matches the behavior.
- **Secret hygiene on both paths, verified at the source.** I did not take the lens's word that
  "both run sanitizeSecrets." Checked the definitions: `composePrTitle` calls `sanitizeSecrets(title)`
  internally (covers title on both creation and rework); `composePrBody` does *not* sanitize
  internally, and its callers pass already-sanitized text — creation:
  `sanitizeSecrets(readPrDescription(ctx) ?? …)`; rework: `composePrBody(sanitizeSecrets(description), …)`.
  No double-sanitization, no unsanitized agent text reaching the host. Error text goes through
  `sanitizeErrorMessage`.
- **Digest design is sound.** `diffDigestAgainstBase` runs `git diff origin/<base>...HEAD -- . :(exclude)thoughts/`
  via `execFileSync` (args array — no shell injection), sha256 of the trimmed output. Three-dot
  range = diff since merge-base, so a base-merge conflict resolution (new HEAD sha, same net diff)
  reads as no change. `thoughts/` excluded so the engine's own per-round deliverable regeneration
  does not move the digest. Best-effort: returns null (never throws) on missing record or git
  failure; the caller treats null as "cannot verify" and skips the refresh, preserving the prior
  stored digest so a later round retries. The rework persist sits inside `if (ctx.task.review)`,
  which is always true on this path (`reworkExistingPr` only runs when `review.pr_number != null`).
- **Gate fixes are justified, not scope creep.** `biome.json` adds `"thoughts"` to `files.ignore`
  — the `thoughts/` tree is committed engine deliverables (markdown/json), no `.ts` source, so
  excluding it from Biome costs zero real-code coverage and stops CI lint failing on agent-authored
  files; consistent with the existing ignores (`.claude`, `~`, `coverage`). `knip.json` adds
  `lefthook` to `ignoreDependencies` (real devDependency, `lefthook.yml` tracked; knip's plugin only
  counts it used when `CI` is set, so local `pnpm lint` fails without the ignore). Both one-line,
  reversible, file-convention-consistent.
- **Docs match behavior.** `docs/user-flows/pr-management/overview.md` describes the refresh
  (whole-PR, regenerated from full diff, pushed only when the diff changed, best-effort) and the
  cause-neutral "Pushed rework to the PR." notification — no stale "addressing review feedback"
  string remains in live text.
- **No stray artifacts.** Grep of the source diff for `console.log/debug`, `TODO/FIXME/XXX`,
  `debugger` — none. Working tree has no uncommitted source changes (only this phase's deliverables
  and harness `.bak` files).

### Gates (current tree, this pass)

- `pnpm typecheck` (`tsc --noEmit` + test project) — **pass**.
- `pnpm lint` (biome check + tsc + tsc test + knip + madge) — **pass** (knip: 3 pre-existing
  warnings, no errors; no circular deps).
- `pnpm test:unit` — **2622 passed** across 139 files. Affected suites: create-pr 19,
  workspace-manager 47, task schema 58 — all green.

### Fixes applied this pass

None. The single Pass-1 finding was already fixed and verified; this pass found nothing new to
fix. No commit was needed — the source is correct, complete, and already committed.

### Verdict: ship

The change correctly and completely solves the issue and survives independent re-verification
after the later rework rounds. Secret hygiene, the digest change-detection, backward
compatibility (`presented_diff_digest` is `.optional()`), best-effort non-blocking semantics,
and the two config gate-fixes all hold up against the actual code. Every gate is green. Nothing
material remains.
