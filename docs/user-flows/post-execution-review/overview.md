# Post-Execution Review Flow

The **Review** phase is The Engineer's quality gate between writing the code (execution) and shipping it (delivery). It catches bugs, requirement gaps, and quality problems — and fixes them — before a pull request is ever opened.

Review separates two jobs that are easy to do badly when combined:

- **Lenses find.** One or more focused agent passes each examine the change through a single concern and write findings. They never change code.
- **`refine` fixes.** A final pass consolidates every lens's findings, fixes what it can directly in the code, re-runs the project's gates, and decides whether the change is ready to ship, needs another look, or has a root cause that belongs to an earlier phase.

Keeping finding separate from fixing matters: an agent asked to both review and fix its own work tends to rationalize problems away. A lens that only reports, followed by a `refine` that only acts on reported findings, is harder to talk out of a real issue.

## Lenses

A lens is a single focused review pass. Each lens looks at the whole change (`git diff` against the base branch) through one concern, judged against what the task asked for, and writes its findings to its own file — it does not touch the code.

| Lens | Concern | Default |
|---|---|---|
| `self-review` | Correctness, requirement fit, simplicity, and clarity — a careful author re-reading the whole change (does every part earn its keep, would it surprise the next reader) | **On** |
| `security` | Dedicated security analysis | Opt-in |
| `code-quality` | Code quality and maintainability | Opt-in |
| `architecture` | Structural and architectural fit | Opt-in |

Which lenses run is controlled by [`orchestrator.review.lenses`](../../configuration/orchestrator.md#review) (default `["self-review"]`). A lens that is not enabled skips itself, with the skip recorded in the task's trail. `self-review` alone is usually enough; the others are opt-in for a change that warrants a dedicated pass.

Adding a new lens is a small change — a single file declaring the lens's name, its role, and what to look for, plus one config value — because every lens shares the same plumbing.

## refine

After the lenses run, `refine` is the last hands on the change before it ships. It:

1. **Consolidates** the lenses' findings — groups them, drops duplicates, and discards anything that does not hold up against the actual code.
2. **Fixes in place** what it can — correctness bugs, requirement gaps, simplicity problems, and security issues — committing its fixes.
3. **Re-runs the project's gates** after fixing. A fix that breaks a gate is not a fix.
4. **Decides** by reporting one verdict.

## Verdicts and routing

`refine` reports exactly one verdict, and the orchestrator routes on it:

| Verdict | Meaning | Where it goes |
|---|---|---|
| `ship` | Correct, complete, and clean — nothing material remains | Advances to delivery |
| `revise` | Fixed issues in place; wants the lenses to look again at the changed code | Repeats the review phase (capped) |
| `rework_execution` | Needs a substantial re-implementation better done fresh | Jumps back to execution |
| `rework_planning` | The approach itself is wrong | Jumps back to planning |
| `rework_requirements` | The requirements are unclear or wrong | Jumps back to requirements |

`refine` prefers fixing in place and shipping; a `rework_*` verdict is for when the root cause genuinely lives in an earlier phase, not to avoid the work. If a question blocks `refine` that is not its to answer, it reports `needs_human` and the task blocks for a person.

## The review loop and its cap

A `revise` verdict loops the whole Review phase from its first lens, so the lenses re-examine the now-fixed code. This loop is **capped at three iterations**. If review cannot converge in three passes, the runner stops and blocks the task with `iteration_cap_hit` — a loud signal that something deeper than the code is wrong and the owner should look, rather than letting the task spin.

The cap is enforced by the pipeline runner, not by `refine` — `refine` simply asks to `revise`, and the runner converts an over-cap repeat into a block. (For the full loop-and-cap model, see [the pipeline architecture](../../architecture/pipeline.md).)

## Default flow

With the default configuration (`self-review` only), the Review phase is:

```
execution ──▶ self-review ──▶ refine ──▶ ship ──▶ delivery
                  ▲                         │
                  └──────── revise ─────────┘  (capped at 3)
```

Enabling more lenses inserts them before `refine`; each writes its findings and advances, and `refine` consolidates them all.

## Key files and configuration

| Concern | Location |
|---|---|
| Lens factory (shared plumbing) | `src/core/orchestrator/pipeline/review/lens.ts` |
| Lenses | `src/core/orchestrator/pipeline/review/{self-review,security,code-quality,architecture}.ts` |
| Consolidate-and-fix | `src/core/orchestrator/pipeline/review/refine.ts` |
| Which lenses run | [`orchestrator.review.lenses`](../../configuration/orchestrator.md#review) |
