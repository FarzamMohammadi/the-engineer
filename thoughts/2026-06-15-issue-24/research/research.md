# Research — Issue #24: PR description (title + body) isn't updated after rework

_Source: github_issue FarzamMohammadi/the-engineer#24_
_Run: 2026-06-15 (first research pass)_

This builds on `requirements/requirements.md`. The requirements doc's end-to-end trace is
**accurate** — I re-read every cited file and confirm the root cause and the capability inventory
below. My job here was to verify those claims by reading the code (not inherit them), map the full
blast radius and test inventory, and challenge the assumptions. The one materially new thing this
pass adds is a **design tension the requirements/owner did not surface**: the body (and any
diff-derived title) are produced by an **LLM agent**, so "regenerate from the diff → identical
content → no-op" is *not* guaranteed. That breaks naïve string-equality change-detection. See
§"The change-detection trap" — it is the most important downstream consideration.

The owner has already settled all product decisions (unified rewrite; title+body as one unit;
refresh on every re-push, value-driven; push only when changed). Nothing here needs a human answer.
The remaining forks are **design decisions the owner explicitly delegated to planning**. → `ok`.

---

## 1. The execution path, verified end-to-end (Observations)

All line numbers re-read and confirmed against `src/` on this branch.

**O1 — Reviewer feedback re-enters at `requirements` and flows forward through delivery.**
`pipeline/pr-events.ts:26-43` (`entryFor`): `pr_comments → { phase: requirements }`;
`pr_ci_failure`/`pr_merge_conflict → { phase: execution, sub: implement }`;
`pr_ready_to_merge`/`pr_merged → { phase: delivery, sub: auto-merge }`. The pipeline order is
`pipeline.ts:53-68`: requirements → research → planning → execution → review → **delivery**, and
delivery's sub-phases are `[prDescription, push, createPr, awaitReview, autoMerge]`
(`pipeline.ts:65`). Because delivery is the last phase, **any** non-merge re-entry (comments, CI,
conflict) flows forward and re-runs `pr-description` then `create-pr`. (Inference I1 below qualifies
"re-runs".)

**O2 — `pr-description` regenerates the body narrative from the full diff against base, every run.**
`pipeline/delivery/pr-description.ts:56-68` instructs the agent to run `git log`/`git diff`
**against the base branch** (so the diff already covers original work + all rework commits), read
`requirements/requirements.md` and `review/refine/refinements.md`, and write the narrative to
`delivery/pr-description.md`. Its only skip gate is `skipWhenPushOnly` (`pr-description.ts:21`); there
is **no trivial-skip**, so in PR mode it runs on every re-entry. The deliverable is **body only**
(`DELIVERABLE = "pr-description.md"`, `pr-description.ts:10`) — no title is produced.

**O3 — Root cause: the rework path never pushes the regenerated content.**
`pipeline/delivery/create-pr.ts:47-62` (`runCreatePr`): if `ctx.task.review?.pr_number != null` →
`reworkExistingPr` (`:69-95`); else → `openNewPr` (`:131-182`).
- `reworkExistingPr` dismisses the stale approval (`:75`), marks every feedback round `applied:true`
  (`:77-82`), notifies + observes (`:84-89`), and returns. It **never reads `pr-description.md` and
  never calls `hosting.updatePR()`.** The freshly regenerated body sits on disk, unused.
- `openNewPr` *does* read the description (`readPrDescription`, `:185-194`) and set
  `title: composePrTitle(ctx.task.title, …)` + `body: composePrBody(description, …)` via
  `createPR` (`:145-154`).
→ Only the rework path omits the push. Confirmed root cause.

**O4 — The title today is the static task title, not diff-derived.**
`create-pr.ts:149` → `composePrTitle(ctx.task.title, ctx.task.external_ref)`; `composePrTitle`
(`:221-226`) = decoration prefix/suffix + `sanitizeSecrets(ctx.task.title)`. Nothing anywhere
generates a title from the work/diff. (Note: `schemas/task.ts:106,108,112` *describe* the title and
description as "AI-generated" in their doc comments — aspirational; the body is agent-generated, the
**title is not**. The schema comment is stale relative to the title's actual implementation.)

**O5 — `updatePR` exists, supports title + body, and has no caller in core.**
- Adapter: `adapters/git-hosting.ts:56-58, 138` — `updatePR(repo, prNumber, updates: PRUpdates)`.
- Schema: `schemas/adapters.ts:362-369` — `PRUpdates = { title, body, draft, labels_add,
  labels_remove }`, all nullable; **`null` = "leave unchanged."**
- GitHub plugin: `plugins/git-hosting/github-hosting/github-hosting.ts:89-131` — applies `title`
  when non-null (`:105-107`), `body` when non-null (`:108-110`), only issues the `pulls.update` call
  if at least one of title/body/draft is non-null (`:115-117`).
- Grep across `src/` + `tests/`: the **only** references to `updatePR`/`doUpdatePR` are the adapter
  definition, the github plugin impl, the fake plugin, and plugin/adapter unit tests. **Zero callers
  in `src/core/orchestrator/`.** Confirmed unused capability.

**O6 — `composePrBody` / `composePrTitle` are pure, deterministic, exported, and unit-tested.**
`create-pr.ts:202-235`. `composePrBody` wraps the narrative with optional plugin decorations + a
trigger reference + the `*Crafted by The Engineer*` footer. `composePrTitle` wraps the title with
decorations. Already covered by `create-pr.test.ts:18-62`. Reusable as-is for an update.

**O7 — No host read of the current PR title/body exists.**
`getPRStatus` → `PRStatus` (`adapters/git-hosting.ts:70`; schema `adapters.ts:378-389`) returns
`{ number, state, draft, merge_state, checks_state, url }` — **no title, no body.** `getReviewStatus`
returns review aggregates; `getPRComments` returns conversation/inline comments — neither returns the
PR body. So there is **no off-the-shelf way to read what the PR currently shows** to compare against.

**O8 — `push` commits stragglers + pushes; the commit message already branches on rework.**
`pipeline/delivery/push.ts:34-67`. `commitStragglers` (`:73-84`) uses `isRework =
ctx.task.review?.pr_number != null` to pick `"fix: address review feedback"` vs
`"feat: <title>"`. `push` runs in both modes; it advances cleanly when nothing is ahead of base.
It sits **between** `pr-description` and `create-pr`, so on a rework re-entry the order is:
regenerate body → push code → `reworkExistingPr`.

**O9 — The rework path's observability/notification shape (the pattern a fix must match).**
`dismissStaleApproval` (`create-pr.ts:102-128`) wraps the host call in a `tool_execution` span
(`startSpan(ObservationTypes.tool_execution, "dismiss_approvals", …, traceScope(ctx))`), treats
failure as **best-effort and non-blocking** (logs `warn`, returns `false`, records it in result
`data`). `reworkExistingPr` notifies `ticket_comment: "Pushed rework addressing review feedback."`
(`:84-88`). The github plugin's `doUpdatePR` logging (`github-hosting.ts:91-98`) logs `hasTitle`,
`hasDraft`, labels — but **not `hasBody`** (minor pre-existing gap; in the plugin, out of scope).

---

## 2. Inferences (conclusions drawn from the above — not facts)

**I1 — `pr-description` re-runs on every non-push-only re-entry, so a fresh body is always available
at `create-pr` time.** From O1+O2: every re-entry path lands upstream of delivery and `pr-description`
has no trivial-skip. I did not trace the runner's mid-phase resume logic line-by-line; I infer
"re-runs" from the pipeline structure + the skip gates. (The requirements doc traced the runner and
agrees.) *Confidence: high.*

**I2 — The body half of the fix is genuinely small.** From O3+O5+O6: `reworkExistingPr` can reuse
`readPrDescription` + `composePrBody` + `hosting.updatePR(repo, prNumber, { body, title: null, … })`
inside a span, mirroring `dismissStaleApproval`. No new infrastructure. *Confidence: high.*

**I3 — The title half is the real work and has no existing mechanism.** From O4: honoring "title
regenerated from the full diff" requires *producing* a title from the work, which does not exist.
Something must generate it — most naturally the `pr-description` sub-phase emitting a title alongside
the body (e.g. a structured deliverable, or a first-line/front-matter convention). *Confidence: high.*

**I4 — Creation and update must generate the title the same way, or the first re-push spuriously
rewrites it.** From O4 + the owner's "push only when changed": if *update* derives the title from the
diff while *creation* still uses `ctx.task.title`, the first rework re-push will almost always change
the title (task phrasing → diff phrasing) even when PR substance is unchanged — violating the
owner's rule. So a diff-derived title must be wired into `openNewPr` too, not just the rework path.
The requirements doc flagged this as a derived consequence; I confirm it follows directly from O4.
*Confidence: high.*

---

## 3. The change-detection trap (the key new finding) ⚠

The owner's acceptance criterion is: *"regenerate from the full current diff every time… push
whatever actually changed; a CI-fix/merge-conflict re-push usually doesn't change what the PR
represents, so regenerating from the diff will naturally produce no update."* This assumes
**regeneration is deterministic** — same diff in, same content out, so `composed === current` and the
host call is skipped.

**That assumption does not hold for the body, and won't for an LLM-derived title** (Inference,
*confidence: high*):
- `composePrBody`/`composePrTitle` are deterministic (O6), **but the narrative they wrap is written
  by the `pr-description` *agent* (an LLM)** (O2). Re-running the agent on the *same* diff can yield
  reworded prose. A diff-derived title generated by an LLM has the same property.
- Therefore a strict string comparison of the regenerated body against a prior body will frequently
  report "changed" on a round where the PR substance did **not** change (e.g. a CI-only fix that
  doesn't alter the diff-against-base meaningfully) → a **spurious update**, exactly what the owner
  asked to avoid.

There is also **no clean baseline to compare against** (O7): the host doesn't expose the current
body, and `pr-description.md` is overwritten in place each round (no retained prior copy; the thoughts
dir's git history is unreliable — it lives inside the target-repo worktree and whether it's committed
depends on that repo's `.gitignore`).

So "push only when content actually changed" forces two coupled **design decisions for planning**
(both explicitly delegated by the owner — *"It's judgment, not mechanical"*):
1. **What baseline to diff against.** Options that exist in the codebase today:
   - **Store last-pushed title/body on the task.** `ReviewState` (`schemas/task.ts:177-194`) has
     `pr_number`, `feedback_rounds`, etc. but **no field for the last pushed presentation** — a
     schema addition + persistence via `taskEngine.updateTaskField` (the pattern `openNewPr` already
     uses at `create-pr.ts:162-168`). Compare regenerated vs stored.
   - **Read the live PR title/body from the host.** Requires extending the adapter contract
     (`PRStatus` has no body, O7) — a broader blast radius across the adapter + every hosting plugin
     + contract suite. Higher cost.
2. **How to decide "meaningfully changed" given LLM nondeterminism.** Exact-match will over-trigger.
   Alternatives the planner must weigh (none implemented today): accept exact-match and tolerate
   occasional reword pushes; normalize before comparing; or make the comparison about the underlying
   diff/substance rather than the prose. This is the crux of satisfying the owner's "no-op on
   unchanged" intent and deserves an explicit, recorded decision.

I am **not** resolving these — they are the owner-delegated design space. I am flagging that the
naïve reading ("just compare the composed strings") will not deliver the owner's stated behavior.

---

## 4. Files in the blast radius (the inventory)

**Must change (core fix):**
- `src/core/orchestrator/pipeline/delivery/create-pr.ts` — `reworkExistingPr` must read the
  description, compose title+body, and call `updatePR` (spanned, best-effort like `dismissStaleApproval`).
  `openNewPr` likely must adopt the same diff-derived title source (I4). `composePrTitle` may need a
  new input (a generated title, not `ctx.task.title`).
- `src/core/orchestrator/pipeline/delivery/pr-description.ts` — to make the **title** diff-derived,
  this sub-phase (the only place that reads the full diff for presentation) is the natural producer
  of a title alongside the body. Touching it means touching its prompt + deliverable contract.

**Likely change (depends on the change-detection design, §3):**
- `src/schemas/task.ts` — add a field to `ReviewStateSchema` to store last-pushed title/body, **if**
  the "store-and-compare" baseline is chosen (option 1). Persisted DB schema → check migration impact.
- *(Only if "read live body" is chosen instead)* `src/schemas/adapters.ts` (`PRStatusSchema` or a new
  type), `src/adapters/git-hosting.ts`, `src/plugins/git-hosting/github-hosting/github-hosting.ts`,
  and the contract suite `tests/helpers/contract-suites/git-hosting-contract.ts`. Broader; flagged as
  the higher-cost path.

**Critical context (read, probably unchanged):**
- `src/core/orchestrator/pipeline/pipeline.ts` (delivery sub-phase order), `pr-events.ts` (re-entry
  breadth — confirms all re-push causes reach the rework path), `delivery/push.ts` (runs between
  describe and create-pr; `isRework` branch), `delivery/deliverable.ts` (`skipWhenPushOnly`).
- `src/schemas/adapters.ts` (`PRUpdatesSchema`, `PRStatusSchema`), `src/adapters/git-hosting.ts`
  (`updatePR` contract).

**Tests (must add/update — see §5).**

---

## 5. Test inventory (Observations)

- **Unit, primary:** `tests/unit/core/orchestrator/pipeline/delivery/create-pr.test.ts`. Pattern:
  `mockCtx` builds a fake `Ctx` with `vi.fn()` for `createPR`/`dismissApprovals`/`updateTaskField`/
  `notify` and a `createRecordingObserver`. Existing rework tests (`:116-138`, `:167-187`) assert
  dismissal + feedback-applied + "no new PR". A fix needs new cases here: rework calls `updatePR`
  with the refreshed title/body **when content changed**, and does **not** when unchanged. The mock
  has no `updatePR` today (`hosting = { createPR, dismissApprovals }`, `:77`) → add it.
- **Unit, plugin:** `tests/unit/plugins/git-hosting/github-hosting/github-hosting.test.ts:184-210`
  already covers `updatePR()` behavior. `tests/helpers/fake-plugins/fake-git-hosting/index.ts:112-124`
  implements `doUpdatePR` and **stores title/body on `pr.options`** — so fake-based tests can assert
  the persisted presentation.
- **Unit, delivery composition:** `tests/unit/core/orchestrator/pipeline/delivery/delivery.test.ts`
  asserts skip-gate behavior across sub-phases (`:55-70`) — must stay green; a fix must keep
  push-only skipping the new host calls.
- **Integration:** `tests/integration/pipeline-review-delivery.integration.test.ts` exercises the
  refine→delivery flow but its "rework" refers to the review loop's `rework_execution`/
  `rework_planning` verdicts — **not** the PR-event `reworkExistingPr` (pr_number set) path. So no
  existing integration test covers the new behavior; the harness pattern is available if one is wanted.
- **Verification gates (from `package.json`):** `pnpm run typecheck`, `pnpm run lint`
  (biome + tsc + knip + madge — note **knip** will flag the still-unused `updatePR` only until a
  caller is added; the fix incidentally resolves any such dead-code concern), `pnpm test` (vitest).

---

## 6. Challenge / simplest-approach review

- **Simplest *correct* approach.** The body-only wiring is trivial and reuses everything (I2). But the
  owner's scope is **title + body as one unit, pushed only when changed**, and the title is not
  diff-derived today (O4) and regeneration is nondeterministic (§3). So the genuinely-simplest *fix
  that satisfies the stated end-state* is **not** "wire `updatePR` with the existing body." It is:
  (a) make `pr-description` produce a diff-derived **title + body**, (b) use that same source at
  **both** creation and update (I4), (c) push via `updatePR` **only when changed against a chosen
  baseline**, with a deliberate answer to the LLM-nondeterminism problem (§3).
- **Is the existing pattern good to copy?** Yes for the host-call shape: model the update after
  `dismissStaleApproval` — spanned `tool_execution`, best-effort/non-blocking, recorded in result
  `data` (O9, AC#7). Whether a failed *description* update should be best-effort or blocking is an
  owner-delegated call; best-effort matches the neighbor and is the low-risk default.
- **Unverified assumption I did not chase to the metal.** The runner's mid-phase resume (I1) — I
  inferred "pr-description always re-runs on re-entry" from pipeline structure + skip gates, not from
  reading the runner's resume code. The requirements doc traced it and agrees; still an inference.
- **An existing mechanism that already solves part of this?** Yes — `updatePR` + `PRUpdates`(title+body)
  + `composePrBody`/`composePrTitle` are all present and idempotent (`null` = no-change at both the
  schema and plugin layers, O5). The *missing* pieces are narrow: a diff-derived title, a
  change-detection baseline, and the rework-path call. No parallel mechanism should be built (AC#4).
- **Out-of-scope observations (noted, not fixed — boy-scout boundary):** the
  `"Pushed rework addressing review feedback."` notification (`create-pr.ts:87`) is inaccurate for
  CI-fix/conflict re-pushes; `doUpdatePR` doesn't log `hasBody`; the `schemas/task.ts:106` "AI-generated
  title" comment is stale. All outside the issue's surface.

---

## 7. Open questions for a human

**None blocking.** The owner settled every product decision in the requirements update (unified
rewrite; title+body one unit; refresh on all re-pushes, value-driven; push only when changed) and
explicitly delegated the mechanism ("It's judgment, not mechanical"). The forks in §3 (change-detection
baseline; how to handle LLM-nondeterminism; best-effort-vs-blocking on update failure; how/where the
title gets generated) are **design decisions for the planning phase**, not intent questions — the
owner's words already bound them. Surfacing them here so planning grapples with them with eyes open.
