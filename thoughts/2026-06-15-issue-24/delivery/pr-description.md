## What & why

A PR's title and body were written once from the initial task and then frozen. When a review round drove code changes, the rework was pushed but the description was never refreshed — so it kept describing only the original ask, drifting further from what the PR actually contained with every round. A reviewer reading the description couldn't see what changed in response to their own feedback without diffing the code themselves.

This change keeps the PR's title **and** body describing the *whole* PR as it currently stands, refreshing them on every rework re-entry — but only when the PR's substance actually changed.

## How

- **The `pr-description` sub-phase now produces the full presentation.** It writes a new single-line `pr-title.md` alongside `pr-description.md`, and the prompt instructs both to describe the whole PR from the full diff against base — the original work plus every later round — written as if every change landed at once, never round-by-round.
- **`create-pr` refreshes title + body on the rework path** (`refreshPrPresentation`). Like the stale-approval dismissal it sits next to, the refresh is best-effort and non-blocking: the code is already pushed, so a failed host update warns and proceeds rather than blocking delivery.
- **Change detection keys on a diff digest, not on the prose.** The agent regenerates the narrative every round even when nothing merge-relevant changed, so keying on the prose would push a spurious update every time. Instead, a new `WorkspaceManager.diffDigestAgainstBase` returns the sha256 of `origin/<base>...HEAD`, excluding the engine's own `thoughts/` deliverables. The three-dot range reads the diff since the merge-base, so resolving a conflict by merging base in (new HEAD, same diff) correctly reads as *no* substance change. An unchanged digest is a clean no-op — the host is left untouched.
- **The shown digest is persisted on review state** (`presented_diff_digest`, optional on `ReviewStateSchema`): set as a baseline at PR creation, and advanced only when a host update actually lands.
- **Refresh never degrades a good published presentation.** When a deliverable is absent or empty, the corresponding field is sent as `null` ("leave the host value unchanged") rather than overwritten with a fallback — for the body that fallback is the `PR for: <title>` stub, and for the title it is the *original task* title, the exact drift this feature exists to prevent. Creation keeps the task-title fallback because there is nothing live to degrade when first opening the PR.
- **The "rework pushed" notification is now cause-neutral** ("Pushed rework to the PR.") since that path is also reached by CI-fix and merge-conflict re-pushes, where "addressing review feedback" would be wrong.
- **Docs updated to match** (`docs/user-flows/pr-management/overview.md`): the `create-pr` and rework-loop sections now describe the title/body refresh and its best-effort, diff-gated semantics.

## Verification

- `pnpm typecheck` — pass.
- `pnpm test:unit` — 2622 passed across 139 files (create-pr suite 19/19).
- `pnpm test:integration` — 64 passed across 8 files, including `pipeline-review-delivery.integration.test.ts`, which exercises the modified delivery path.
- `pnpm lint` (biome + tsc + tsc-test + knip + madge) — pass; no circular deps; 3 pre-existing knip warnings, no errors.
- New tests cover the behavior end to end: creation with the diff-derived deliverables; rework with changed substance (pushes new title + body); changed substance but missing deliverable (leaves live title/body in place); unchanged substance (host untouched, digest preserved); digest unavailable (refresh skipped); and `updatePR` failure (delivery stays green, digest not advanced). The digest helper is tested against a real temp git repo, and `presented_diff_digest` against the schema.
- Reviewers may want to confirm the digest's `thoughts/` exclusion against the merge cleanup it mirrors (`removeThoughtsAndPush`), and that committing this PR's own `thoughts/` deliverables therefore does not trigger a spurious refresh.

## Risks & follow-ups

- **Two unrelated gate fixes ride along, both one-line and reversible.** They are not part of the feature but were needed to keep the project's own checks green:
  - `knip.json` adds `lefthook` to `ignoreDependencies` — a real devDependency with a tracked `lefthook.yml`, but knip's plugin only counts it used when `CI` is set, so `pnpm lint` fails locally without the ignore.
  - `biome.json` adds `"thoughts"` to `files.ignore` — `thoughts/` holds agent-authored process deliverables (markdown/JSON, no source), committed during the PR and stripped before merge; without the ignore `biome check .` lints those files and CI's `lint` job fails when one isn't in biome's house style. Mirrors the existing `.claude` ignore; narrows the formatter's scope to actual project files only.
- **The `pr-description` LLM pass still runs on no-op rework rounds.** The digest gate suppresses the *host update*, not the separate agent regeneration, which always ran. No regression, but the redundant pass is out of scope here.
- **Degenerate edge:** if both deliverables are absent on a substance-changing round, `updatePR` is still called with all-null fields (a host no-op), yet the digest advances and `description_updated: true` is returned — a harmless observability inaccuracy in an agent-failure edge, not gold-plated.
- A review pass surfaced one Low finding — the title could be reset to the original task title on a rework where the deliverable was absent, the same drift this feature prevents, leaking through the title. It was fixed in this PR by mirroring the body's leave-unchanged guard onto the title and correcting the inline comment.
