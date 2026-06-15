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

---

# Research — Pass 3: the three review-rework asks (against current shipped code)

_Run: 2026-06-15 (third pass — review-feedback rework on the open PR)_

The feature shipped (`c1f1b95` + `9ca225b fix: address review feedback`). The owner then left **three
concrete, scoped asks** on the PR (see requirements update dated 2026-06-15, "review rework pass").
This pass verifies each ask against the **current** code — not the pre-feature code the first research
pass read (that pass cited the notification at `:87`; in today's file it is `:100`, because the shipped
feature grew `create-pr.ts`). Everything below was re-read line-by-line in this worktree.

**All three asks are confirmed still-pending in the current tree.** None is partially done.

## A. Ask #3 — the rework notification is cause-inaccurate (Observations)

- **O1.** `reworkExistingPr` notifies unconditionally: `create-pr.ts:97-101` →
  `notify({ kind: NotificationKinds.ticket_comment, taskId, message: "Pushed rework addressing review feedback." })`.
  The string is **still the old text** in the current tree.
- **O2.** `reworkExistingPr` is entered whenever `ctx.task.review?.pr_number != null`
  (`create-pr.ts:63-65`) — it does **not** inspect the re-entry cause.
- **O3.** CI-failure and merge-conflict events re-enter the pipeline at `execution/implement`
  (`pr-events.ts:30-33`, `entryFor`), then flow forward through the phases (requirements → research →
  planning → execution → **review → delivery**) and hit delivery's sub-phases in order
  `[prDescription, push, createPr, awaitReview, autoMerge]` (`pipeline.ts:65`). At `create-pr` the task
  already has `review.pr_number`, so both causes route to `reworkExistingPr` and fire the
  "addressing review feedback" message. **→ The message mislabels CI-fix and conflict re-pushes.**
  (`pr_comments` re-enters at `requirements`, `pr-events.ts:28-29`, but reaches the same path.)
- **O4.** The string occurs **exactly once** in `src/` and **no test asserts on it**
  (`grep -rn "Pushed rework\|addressing review feedback" src/ tests/` → only `create-pr.ts:100`).
  The sibling signals are already cause-neutral: result `summary` (`:109` "Pushed rework to PR #N"),
  `observer.info("Rework pushed to existing PR", …)` (`:102`), and result `data` (`:110-115`).
- **O5 (docs).** `docs/user-flows/pr-management/overview.md:126` lists this exact string in the
  notifications table — that row must be updated to match the new neutral text. (AGENTS.md §"Tests,
  Docs… Are Not Afterthoughts" makes the doc part of the same unit of work.)

**Inference (I-A).** #3 is a one-literal change (e.g. `"Pushed rework to the PR."`) plus the doc row;
zero test reconciliation is forced. Adding a test that asserts the neutral message would lock it
(currently nothing pins it). Smallest, lowest-risk of the three.

## B. Ask #2 — a rework must not degrade a live body with the stub (Observations)

- **O6.** Inside the changed-substance branch, `refreshPrPresentation` builds the body as
  `composePrBody(sanitizeSecrets(readPrDescription(ctx) ?? \`PR for: ${ctx.task.title}\`), ctx.task.external_ref)`
  (`create-pr.ts:156-159`) and **always** passes it to `updatePR` (`:168-174`).
- **O7.** `readPrDescription` returns `null` when the deliverable is absent **or empty**
  (`create-pr.ts:282-291`: `existsSync`/`isFile` guard, then `.trim() || null`). So when
  `pr-description.md` is absent/empty on a rework, the live PR body (which may be the rich body written
  at creation) is **overwritten by the `PR for: <task title>` stub**. Real regression on an external
  surface.
- **O8 (the fix mechanism already exists).** `updatePR` treats `body: null` as "leave the host body
  unchanged": schema `PRUpdatesSchema.body = z.string().nullable()` (`adapters.ts:362-364`); the GitHub
  plugin applies `body` **only when non-null** (`github-hosting.ts:108-109`) and skips the
  `pulls.update` call entirely if title+body+draft are all null (`:115`). So "skip the body update" =
  pass `body: null`. No schema/adapter/plugin change is needed.
- **O9 (title has no symmetric problem; #2 is body-only).** At creation the title is
  `composePrTitle(readPrTitle(ctx) ?? ctx.task.title, …)` (`create-pr.ts:243`); on rework the fallback
  is the same `readPrTitle(ctx) ?? ctx.task.title` (`:155`). So when the **title** deliverable is
  absent, the rework fallback reproduces the live title value — no degradation. The owner scoped #2 to
  the **body**; the title path stays as-is. (`pr-title.md` is read only by `create-pr.ts` and written
  only by `pr-description.ts`; the one other reference, `workspace-manager/index.test.ts:351`, just
  writes it to prove the digest excludes `thoughts/`.)

**Inference (I-B).** Minimal change: read the description once (`const desc = readPrDescription(ctx)`),
and set `body = desc ? composePrBody(sanitizeSecrets(desc), ref) : null`; keep the title path. Two
downstream micro-choices (both satisfy the owner's "leave the existing body"):
  - whether to still call `updatePR` when only the title would change (with an absent title deliverable
    the title fallback == live title, so it is an effective no-op the plugin still issues as a
    `pulls.update`), or short-circuit; and
  - whether to advance `presented_diff_digest` on a body-skipped round (the title may have legitimately
    changed, so advancing is defensible).
  These are mechanical; the owner delegated them ("Do your own research and planning as usual").
- The skip lives **inside** the changed-substance branch; the digest gate (`:140-153`,
  `digest_unavailable` / `unchanged`) is untouched, so the no-op and cannot-verify paths are unaffected.

## C. Ask #1 — the tests prove the fallback, not the feature (Observations)

- **O10.** `mockCtx` sets `worktreePath: "/tmp/the-engineer-test-no-such-worktree"` (`create-pr.test.ts:90`),
  a path that does not exist. `readPrTitle`/`readPrDescription` `existsSync`-guard it
  (`create-pr.ts:287, 303`) → both return `null` in **every** test.
- **O11.** Therefore the rework test (`create-pr.test.ts:209-234`) asserts `title: "Add feature"` —
  which is `ctx.task.title`, the **fallback** at `create-pr.ts:155`, not a diff-derived `pr-title.md`;
  and its body assertion is only `expect.stringContaining("Crafted by The Engineer")` — the **branding
  footer of the `PR for:` stub** (`composePrBody`, `create-pr.ts:333`), not a composed narrative. The
  creation test (`:119-134`) likewise never asserts a diff-derived title/body. Deleting
  `readPrTitle`/`readPrDescription` and hard-coding the fallbacks would leave the suite green → these
  tests pin the fallback, not the feature. (This is exactly the owner's bar.)
- **O12 (the deliverables are real artifacts).** The `pr-description` sub-phase writes
  `pr-description.md` (body narrative) and `pr-title.md` (a single imperative line, `~50–70` chars, no
  prefixes/trailing period) — `pr-description.ts:10-11, 73-90`. `readPrTitle` takes the first non-empty
  line and strips a leading `# ` (`create-pr.ts:298-311`).
- **O13 (test mechanics already in the repo).** Real temp dirs via `mkdtempSync(join(tmpdir(), …))`
  are common (`tests/helpers/test-workspace-manager.ts:73`; `delivery.test.ts:114-134` stands up a real
  worktree and `writeFileSync`s into it; `workspace-manager/index.test.ts:351` writes
  `thoughts/delivery/pr-title.md`). For #1 the **light** path suffices: `mkdtempSync` a dir, write
  `<dir>/<thoughtsDir>/delivery/pr-title.md` + `pr-description.md`, point `worktreePath` + `thoughtsDir`
  at it, and mock `diffDigestAgainstBase` (already mocked). `readPrTitle`/`readPrDescription` only
  `existsSync`/`readFileSync` — **no git scaffolding needed**; add an `afterEach` `rmSync` cleanup.

**Inference (I-C).** New coverage must assert, with **real** deliverables present:
  - creation: `createPR` receives a title **distinct from `ctx.task.title`** (the `pr-title.md` line)
    and a body **containing the `pr-description.md` narrative**; and
  - rework (changed substance): `updatePR` receives that diff-derived title and the composed narrative
    body.
  Each new assertion would **fail** if `readPrTitle`/`readPrDescription` were deleted.
- **Reconciliation with #2 (mandatory).** Today's rework test (`:209-234`) runs with an **absent**
  deliverable; under #2 its body would no longer be pushed as a stub. So that test must split into
  (a) a **real-deliverable** rework asserting the composed body + diff-derived title, and
  (b) an **absent-deliverable** rework asserting the body is **not** overwritten (`updatePR` called with
  `body: null` / no stub). Both fallback and feature paths stay covered.

## Inventory / blast radius (this pass)

**Behavioral change — one file:** `src/core/orchestrator/pipeline/delivery/create-pr.ts`
  - #2: the body-compose + `updatePR` call in `refreshPrPresentation` (~`:155-174`).
  - #3: the notification string (`:100`).
**Tests — one file:** `tests/unit/core/orchestrator/pipeline/delivery/create-pr.test.ts`
  - #1: add a real-worktree fixture (mkdtemp + write deliverables + afterEach cleanup); reconcile the
    existing rework body assertion under #2; (optionally) assert the neutral #3 message.
**Docs — one file (in scope):** `docs/user-flows/pr-management/overview.md`
  - #3: notification row `:126`. Also note `:29` and `:98-105` ("The rework loop") still describe rework
    as only "dismiss approval + mark applied" and **omit the already-shipped title/body refresh** — a
    pre-existing doc gap on the surface being touched; planning can decide how much of it to bring
    current alongside #2/#3.
**Confirmed NOT in scope (verified, not assumed):**
  - No schema/adapter/plugin change — `updatePR`/`PRUpdates`/`github-hosting` already support
    `body: null` (O8).
  - `pr-description.ts` already emits title + body — unchanged.
  - The diff digest (`workspace-manager/index.ts:678`) and change-detection gate — unchanged.
  - `pr-events.ts` / `pipeline.ts` ordering — unchanged.
  - The integration test `tests/integration/pipeline-review-delivery.integration.test.ts` **skips**
    `create-pr` (`skip:create-pr`, `:71`), so it neither exercises nor asserts the rework body/message
    — **no reconciliation needed there.** `create-pr` behavior is covered only by the unit test above.

## Challenge / simplest-approach review (this pass)

- **Genuinely simplest path?** Yes, and it is small: #3 is a one-literal swap + one doc row; #2 is a
  single conditional on an already-read value using the existing `body: null` contract — **no new
  mechanism, no live host read.** Note `getPRStatus`/`PRStatus` (`adapters.ts:378-389`) returns
  `{number, state, draft, merge_state, checks_state, url}` — **no title/body** — so there is no
  off-the-shelf way to read the live body; #2 deliberately doesn't need one (`body: null` = leave it).
- **Are the patterns good, or legacy to avoid?** The best-effort/spanned shape of `refreshPrPresentation`
  (mirrors `dismissStaleApproval`) is sound and should be preserved (AC#4/#7). Don't widen #2 to gate
  the title — the owner scoped it to the body, and the title has no degradation (O9).
- **Unverified assumptions?** That CI-fix/conflict reworks reach `reworkExistingPr` — **verified**
  (O2-O3, not inferred). That nothing else asserts the notification string — **verified** (O4). That
  the integration test won't break — **verified** (it skips create-pr).
- **Existing mechanism already solving part of this?** Yes — `body: null` (O8) is the whole of #2's
  host contract; the temp-worktree test helpers (O13) are the whole of #1's mechanics. Build neither
  from scratch.

## Open questions for a human (this pass)

**None blocking.** All three asks are the owner's own explicit instructions on his own PR (highest
intent authority), each grounded in a verified code fact above; the only open choices are mechanical
(thread `body: null`; restructure the test fixtures; how far to refresh the user-flow doc) and were
explicitly delegated to The Engineer's judgment. → `ok`.
