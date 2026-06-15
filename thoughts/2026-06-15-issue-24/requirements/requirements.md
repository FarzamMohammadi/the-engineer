# Requirements — Issue #24: PR description isn't updated after rework

_Source: github_issue FarzamMohammadi/the-engineer#24_
_Run: 2026-06-15_

## Context Summary

**What the task asks (in my words).** When The Engineer reworks an already-open PR — most
notably to address review feedback — the PR's **description/body** on the host is never
refreshed. It still shows the narrative written from the *original* task, so a reviewer
reading it can't see what the feedback-driven rounds changed. The owner wants the PR
description brought up to date after rework so that, at any point, it gives a **complete,
accurate picture of everything the PR now does** — the original work plus every round of
feedback-driven changes.

**Stated vs. reconstructed.** The desired *end-state* is explicitly stated by the owner and
is unusually clear for a bug report: the issue has distinct "Expected", "Actual", and "Why
It Matters" sections that describe exactly what "done" means (description complete and
accurate after every change). What I reconstructed from the code is the **mechanism and root
cause** (below) — that part is researchable fact, verified against the source, not guessed.
The one thing the owner did *not* pin down is the **presentation format** of the refreshed
description (rewrite the whole narrative vs. preserve and append per-round), which is a
genuine fork — see Open Questions.

## How The System Behaves Today (researched fact, with file:line)

Traced end-to-end against `src/`:

1. **Reviewer feedback re-enters the pipeline at `requirements`.**
   `src/core/orchestrator/pipeline/pr-events.ts:26-43` — `entryFor(pr_comments)` returns
   `{ phase: Phases.requirements }`. The task then flows forward through research →
   planning → execution → review → **delivery** again. (CI failures and merge conflicts
   re-enter at `execution`/`implement` and likewise flow forward to delivery.)

2. **Delivery regenerates the description from the full current diff.**
   `src/core/orchestrator/pipeline/delivery/pr-description.ts:56-85` — the `pr-description`
   sub-phase prompt instructs the agent to run `git log`/`git diff` **against the base
   branch** (so the diff already includes the original work *plus* all rework commits),
   plus read `requirements/requirements.md` and `review/refine/refinements.md`, and write a
   complete narrative to `delivery/pr-description.md`. This sub-phase runs again on every
   non-push-only re-entry (`skip: skipWhenPushOnly`). → The regenerated content already
   reflects "everything the PR now does."

3. **The rework path discards that regenerated description.** This is the root cause.
   `src/core/orchestrator/pipeline/delivery/create-pr.ts:47-95` — `runCreatePr` sees
   `ctx.task.review?.pr_number != null` and routes to `reworkExistingPr` (lines 69-95),
   which: dismisses the stale approval, marks feedback rounds `applied`, and notifies — but
   **never reads `pr-description.md` and never calls `hosting.updatePR()`**. The newly
   generated body is written to disk and never pushed to the host. The new-PR path
   (`openNewPr`, lines 130-182) *does* read the description and set the body via
   `createPR(...)`; only the rework path omits it.

4. **The capability to update the body already exists.**
   - Adapter: `src/adapters/git-hosting.ts` — `updatePR(repo, prNumber, updates: PRUpdates)`.
   - Schema: `src/schemas/adapters.ts` (`PRUpdatesSchema`) — includes `body: string | null`.
   - Plugin: `src/plugins/git-hosting/github-hosting/github-hosting.ts:89-131` — applies
     `updates.body` when non-null.
   - `composePrBody(description, externalRef)` (`create-pr.ts:202-218`) deterministically
     wraps the narrative with decorations, trigger reference, and footer — reusable for an
     update.
   - Grep confirms **no caller** of `updatePR()` exists anywhere in
     `src/core/orchestrator/` today.

**Conclusion:** the content is already regenerated correctly; the only missing wiring is
that the rework path doesn't push it. The fix surface is small and the infrastructure
(updatePR + body field + composePrBody) is already present. (This map is for the downstream
research/planning phases; intake does not design the fix.)

## Edge cases surfaced while probing

- **Multiple rework rounds.** Because the description is regenerated from the full diff each
  round, a unified rewrite stays complete across N rounds without accumulation. A
  "preserve + append per round" format, by contrast, depends on whether prior body / round
  history is available to append to (the host body is the source of truth there).
- **Non-review re-entries.** CI-failure and merge-conflict re-pushes also reach
  `reworkExistingPr` after flowing through delivery, so any fix placed there refreshes the
  description for *all* rework causes, not only review feedback. Whether that breadth is
  desired is a scope edge (Open Question 2).
- **No-op rounds.** If a round changes nothing in the narrative, `composePrBody` is
  deterministic, so an update would be an effective no-op — harmless, but worth noting for
  acceptance (don't fail/duplicate on identical bodies).
- **Push-only mode.** `pr-description` and `create-pr` both `skipWhenPushOnly`; the fix is
  PR-mode only and must not introduce host calls in push-only mode.
- **updatePR failure.** Approval dismissal today is explicitly best-effort and non-blocking
  (`create-pr.ts:102-128`). Whether a failed description update should block delivery or be
  best-effort/observable like dismissal is an implementation detail for planning, but worth
  flagging now.

## Acceptance Criteria (proposed — pending Open Questions)

A reviewer would verify the task complete when:

1. After a rework round on an existing PR (at minimum: review-feedback rework), the PR's
   description/body on the host is updated — it no longer reflects only the original task.
2. The updated description completely and accurately reflects **everything the PR now does**
   (original work + the changes made across rework rounds), consistent with the full current
   diff against base.
3. The update reuses the existing description deliverable and `updatePR`/`composePrBody`
   path rather than introducing a parallel mechanism; the new-PR path is unchanged.
4. Behavior is unchanged in push-only mode (no host description calls there).
5. The change is covered by tests at the project's prevailing tier (unit tests around the
   rework path asserting `updatePR` is called with the refreshed body), and the existing
   delivery/rework tests still pass.
6. Observability/notifications around the update are consistent with the surrounding rework
   code (e.g., spanned/logged like the dismissal step).

> Criterion #1's exact breadth (which rework causes) and the **format** of the refreshed
> description (#2) depend on the Open Questions below. The remaining criteria are
> architecture-grounded and stable regardless of the answers.

## Source of each requirement (intake gate check)

- **"PR description must be updated after rework"** — *Owner expressed it.* The issue's
  Expected/Actual/Why-It-Matters sections state this directly. Trust it; proceed.
- **"Description must completely & accurately reflect the full PR (original + all feedback
  rounds)"** — *Owner expressed it* ("describes everything the PR now does", "a complete,
  accurate picture of the full PR").
- **Root cause = rework path never calls `updatePR`** — *Researchable fact*, verified at
  `create-pr.ts:69-95` and corroborated by the existing `openNewPr` path and the unused
  `updatePR` capability. No intent needed.
- **Verification commands** — *Researchable fact*, read from `package.json` (below).
- **Presentation format (unified rewrite vs. preserve-and-append vs. hybrid)** — *Not
  expressed.* I can name two equally-defensible readings of the same issue text (see Open
  Question 1), so the intent is underdetermined → must ask, not infer.
- **Breadth across rework causes (all re-pushes vs. review-feedback only)** — *Partially
  expressed but with a defensible alternative reading* → confirm with owner (Open Question 2).

## Open Questions (blocking) → see `outreach/farzam.txt`

1. **Presentation format.** Should the refreshed description be a single **unified rewrite**
   that completely describes the PR as it now stands (replacing the prior body — the
   architecture-natural option, since `pr-description` already regenerates from the full
   diff), OR should it **preserve the original description and append a labeled per-round
   section** summarizing what each rework round changed (so reviewers see exactly what moved
   in response to their feedback), OR a **hybrid** (up-to-date narrative + a short
   "changes since last review" section)? This materially changes the deliverable and the
   acceptance criteria.

2. **Breadth.** Should the description refresh on **every** rework re-push (review feedback,
   CI-failure fixes, merge-conflict resolutions — all of which reach the same rework path),
   or **only** on review-feedback rework? The issue says "When the work on a PR changes,"
   which reads as all; confirming avoids building the wrong breadth.

## Complexity

**moderate** — the desired end-state is clear and the fix surface is small and localized
(one rework path; the capability already exists), but it touches the delivery/rework flow,
needs tests, and hinges on the format decision above.

## Verification commands (from `package.json`)

- typecheck — `pnpm run typecheck` (`tsc --noEmit && tsc --noEmit -p tsconfig.test.json`)
- lint — `pnpm run lint` (biome + tsc + knip + madge)
- test (unit) — `pnpm test` (`vitest run`)

---

# Update — 2026-06-15 (owner answered; scope finalized → `ok`)

The owner answered both blocking Open Questions and, importantly, **widened the scope** to make
the PR **title** part of the deliverable alongside the body. Their answer is authoritative and
defines this task. The two prior forks are no longer open; I am not re-asking them.

## Context Summary (final)

**What the task asks (in my words).** After every re-push to an existing PR, regenerate the PR's
**presentation — title and body together, as one unit — from the full current diff against base**,
and push the result so the open PR always shows one clean, current narrative of *everything the PR
now proposes to merge* (original work + all feedback-driven rounds), written as if every change
landed at once. Push the regenerated title/body **only when the content actually changed**; when a
re-push (e.g. a CI-fix or merge-conflict resolution) doesn't change what the PR represents,
regenerating from the diff naturally yields the same content, so nothing is pushed — and that
no-op is the correct outcome, not a special case to gate on.

**Stated vs. reconstructed.** The *end-state* is now **fully owner-expressed**, and unusually
precisely: the owner picked the unified-rewrite format (explicitly rejecting per-round sections and
a bottom changelog), chose value-driven refresh on all re-pushes, declared title+body one unit that
each update only when the PR's substance changes, and even pre-wrote the acceptance criteria
("a unified rewrite of BOTH title and body, regenerated from the full diff on every re-push, pushed
when (and only when) the content actually changed"). What remains *reconstructed* is only the
**mechanism/root cause** (researchable fact, verified against source, below) and the **design
consequences** of bringing the title into scope — both of which are downstream concerns, not intent.

## What the owner settled (quoting their answer)

1. **Format = unified rewrite (A).** "We never present the work sequentially or round-by-round. The
   body is always one clean, current narrative of what the whole PR proposes to merge as it stands
   right now — written as if every change landed at once." Per-round "changes addressing round N"
   sections (B) and a bottom changelog (C) are **explicitly not wanted**.
2. **Breadth = all re-pushes, value-driven.** "Regenerate from the full current diff every time the
   code changes and push whatever actually changed." A CI-fix/merge-conflict re-push "usually doesn't
   change what the PR represents, so regenerating from the diff will naturally produce no update —
   which is correct, and falls out of the regeneration rather than a hard gate on the re-entry reason."
3. **"PR description" = title AND body, as one unit.** "The title is part of this update; it is not
   fixed to the original task. Both the title and the body must always represent the latest PR as a
   whole — all the proposed changes, not part of them. Update each only when the work changes what the
   PR represents… It's judgment, not mechanical — the only test is 'does this still accurately describe
   the whole PR as it stands?'"

## New researched fact surfaced by the title scope (file:line)

The body half of this was already mapped in the prior pass (delivery regenerates `pr-description.md`
from the full diff; the rework path never calls `updatePR` — root cause). The title widening adds:

- **The PR title today is the static original task title, not a diff-derived artifact.**
  `create-pr.ts:149` builds it as `composePrTitle(ctx.task.title, ctx.task.external_ref)`
  (`composePrTitle` at `:221-226` = decorations + `ctx.task.title`). The `pr-description` sub-phase
  (`pr-description.ts`) produces a **body narrative only** (`pr-description.md`); nothing regenerates a
  title from the diff anywhere. → Honoring "title regenerated from the full diff" requires a title
  that is *produced from the work/diff*, which **does not exist today**.
- **`updatePR` already supports both fields.** `PRUpdatesSchema` (`schemas/adapters.ts:362-369`):
  `{ title: string|null, body: string|null, draft, labels_add, labels_remove }` — `null` means "leave
  unchanged." GitHub plugin applies `title`/`body` when non-null (`github-hosting.ts:105-115`). Still
  **no caller** of `updatePR` in `src/core/orchestrator/`.
- **No existing read of the host's current title/body.** `getPRStatus`→`PRStatus`
  (`adapters/git-hosting.ts:70`, schema in `adapters.ts`) returns `{number, state, draft, merge_state,
  checks_state, url}` — *not* title/body. So "push only when changed" has no off-the-shelf comparison
  source; detecting change is a downstream design decision (compare against a stored/local prior
  version, or add a read of the live title/body), not an intake intent question.

## Edge cases / scenarios re-walked under the final scope

- **First re-push after creation (coherence trap).** Body-at-creation is diff-derived
  (`pr-description.md`), but title-at-creation is the task title. If the *update* path generates the
  title from the diff while *creation* still uses the task title, the **first** re-push will almost
  always rewrite the title (task phrasing → diff phrasing) even when the PR substance is unchanged —
  which would violate "push only when content changed." Cleanly satisfying the owner's stated behavior
  therefore implies title generation be **consistent across creation and update**. This is a design
  consequence that *derives from* the owner's stated requirements (not a new product choice), so it is
  recorded as a downstream design consideration — not re-asked.
- **No-op rounds (CI-fix / merge-conflict).** Owner wants these to naturally produce no push. The
  change-detection must compare regenerated content and skip the host call when identical — no
  failure, no duplicate update, no empty edit.
- **Multiple rounds.** Unified rewrite from the full diff stays complete across N rounds with no
  accumulation — matches the owner's "as if every change landed at once."
- **Push-only mode.** `pr-description` and `create-pr` both `skipWhenPushOnly`; the refresh must stay
  PR-mode only and make no host calls in push-only mode.
- **updatePR failure.** Surrounding rework code treats the approval dismissal as best-effort and
  non-blocking (`create-pr.ts:102-128`); whether a failed title/body update should block delivery or
  be best-effort/observable like dismissal is a downstream implementation call.

## Acceptance Criteria (FINAL — built to the owner's stated criteria)

A reviewer would call this task complete when:

1. **On every re-push to an existing PR**, the PR's **title and body** are regenerated from the
   **full current diff against base** (original work + all rework rounds) as a single unified
   narrative — never per-round sections, never a changelog.
2. The regenerated title/body is **pushed to the host only when it actually changed** versus what the
   PR currently shows; when a re-push doesn't change what the PR represents, **no update is pushed**
   (a clean no-op), and this falls out of regeneration rather than a gate on the re-entry reason.
3. At any point, the open PR's **title and body together** accurately describe the **whole** PR as it
   currently stands — all proposed changes, not only the original task. The title is no longer frozen
   to the original task title.
4. The fix reuses the existing description pipeline and the `updatePR`/compose path rather than a
   parallel mechanism; the new-PR (first-creation) path remains correct and consistent with how
   updates are generated (so the first re-push doesn't spuriously rewrite an unchanged title).
5. Behavior is unchanged in **push-only mode** (no host title/body calls there).
6. Covered by tests at the project's prevailing tier (rework path asserts `updatePR` is called with
   the refreshed title/body when content changed, and is **not** called when content is unchanged);
   existing delivery/create-pr/auto-merge tests still pass.
7. Observability/notifications around the update are consistent with the surrounding rework code
   (spanned/logged like the dismissal step).

## Source of each requirement (intake gate check — final)

- **Refresh title+body on every re-push as a unified rewrite** — *Owner expressed it* (answer ¶1, ¶3).
- **Push only when content actually changed; no-op otherwise** — *Owner expressed it* (answer ¶2).
- **Title in scope, not fixed to the original task; title+body always represent the whole PR** —
  *Owner expressed it* (answer ¶3), including the test "does this still accurately describe the whole
  PR as it stands?"
- **Root cause = rework path never calls `updatePR`; title is currently the static task title;
  `updatePR` supports title+body; no host read of current title/body** — *Researchable fact*, verified
  at the file:line above. No intent needed.
- **Title-generation must be consistent across creation and update (first-re-push coherence)** —
  *Derived design consequence* of the owner's "push only when changed" + "title always represents the
  whole PR." No equally-defensible alternative survives those words, so it is documented for the
  planner, not re-asked.
- **Change-detection mechanism, best-effort-vs-blocking on update failure** — *Downstream design
  decisions* the owner explicitly delegated ("It's judgment, not mechanical").
- **Verification commands** — *Researchable fact*, from `package.json`.

## Decision: report `ok`

Both prior blocking questions are answered and the scope is now fully owner-expressed down to the
acceptance criteria. The only remaining items are mechanism/design decisions the owner deliberately
delegated to The Engineer's judgment; re-asking them would re-litigate a settled, carefully-given
answer. No point remains where the owner's input would change *what* to build. → **`ok`**.

## Complexity (final): moderate

Direction is unambiguous and the work stays within one subsystem (delivery: `pr-description` +
`create-pr`, plus the unused `updatePR` capability). It is larger than the original "just wire
`updatePR` with the existing body": the **title must become a diff-derived, regenerated artifact**
(none exists today), creation/update title generation must be unified, and change-detection must be
added. Multiple coordinated pieces, but clear scope and no broad cross-system unknowns → **moderate**.

## Verification commands (unchanged — from `package.json`)

- typecheck — `pnpm run typecheck` (`tsc --noEmit && tsc --noEmit -p tsconfig.test.json`)
- lint — `pnpm run lint` (biome + tsc + knip + madge)
- test (unit) — `pnpm test` (`vitest run`)
