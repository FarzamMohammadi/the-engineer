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
