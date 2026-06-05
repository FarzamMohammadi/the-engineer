# Writing Tickets

How to write GitHub issues that The Engineer can pick up and execute well.

## The Golden Rule

**Describe the problem and what you want — not how to build it.** The Engineer does its own research, reads the codebase, and figures out the implementation. Over-prescribing the solution limits its ability to find the right approach and makes tickets brittle when the codebase changes.

**But do say what "done" looks like.** "Don't prescribe the *how*" is not "be vague about the *what*." Length is not the measure — a one-line ticket can be complete, and a long, detailed one can still never say what done means. If a ticket names a target without saying what done looks like — "update the scenes", "improve the dashboard" — The Engineer stops and asks you before building, rather than guess an intent the rest of the pipeline cannot recover. A clear problem and a clear desired outcome are what let it run without interrupting you.

## What a Good Ticket Contains

### 1. Problem

What's wrong, or what's missing. Why does this matter? One or two sentences.

> `engineer status` only prints a human table. Scripts and dashboards that want to read task state have to scrape that text, which breaks whenever the formatting changes.

### 2. What We Want

The desired outcome in plain language. Focus on behavior, not code.

> Add a `--json` option to `engineer status` that prints the same task data as machine-readable JSON.

### 3. Constraints

Non-negotiable boundaries. These prevent The Engineer from going off-track.

- What must not break
- What must not change (e.g., "no config schema changes")
- Safety rails (e.g., "never skip execution")
- Patterns to follow (e.g., "mark all changes with TODO-TEMP")

### 4. Acceptance Criteria

Checkboxes that define "done." Be specific enough that they're testable.

- [ ] `engineer status --json` prints valid JSON with each task's id, state, title, and created_at timestamp
- [ ] `engineer status` with no flag prints the human table exactly as before
- [ ] All existing tests pass

## What to Leave Out

### Don't prescribe the implementation

Bad:
> In `src/cli/commands/status.ts`, add a `--json` option to the command definition, then branch at line 88 to call `JSON.stringify()` instead of the table renderer.

Good:
> Add a `--json` option to `engineer status` that prints the task data as JSON.

The Engineer will find the status command, understand how it renders output, and implement the flag. Telling it which lines to edit makes the ticket fragile and prevents it from finding a better approach.

### Don't explain the codebase

Bad:
> The status command builds its output through a table renderer in `output.ts`. There's a shared `TaskView` type the command maps each task onto before rendering — reuse that for the JSON shape.

The Engineer reads the code. It will discover these patterns during its research phase. Explaining them in the ticket adds noise and can mislead if the code has changed since you wrote it.

### Don't over-constrain

Bad:
> Must reuse the exact `TaskView` mapping. Must add one boolean option. Must update exactly 2 files.

Good:
> The default (no-flag) output must not change. No config schema changes.

Constrain the boundaries, not the path.

## Calling Out Non-Obvious Gotchas

Sometimes you know something The Engineer might miss — a hidden dependency, a subtle invariant, an edge case you've hit before. **These belong in the ticket**, framed as constraints or context.

> **Important: scripts depend on exit codes.** Some CI scripts already call `engineer status` and check its exit code. The `--json` flag must keep the same exit-code behavior, or those scripts break.

This isn't prescribing the solution — it's flagging a non-obvious consequence that could lead to a broken workflow. The Engineer still decides *how* to handle it.

## Sizing

The Engineer works best with focused, single-concern tickets. Signs a ticket is too big:

- It touches more than one system boundary
- The acceptance criteria cover unrelated behaviors
- You're writing paragraphs to explain the scope

Split it into focused tickets. Clean input produces cleaner output.

## Mechanical Refactors

For purely mechanical changes (rename, replace patterns, migrate syntax), be explicit about scope and consistency:

> Replace all raw string literals with exported Zod enum constants. Both `src/` and test files. Where constants already exist, don't duplicate — ensure raw strings referencing those values are replaced too.

Mechanical tickets can be more specific about scope because the "how" is inherent in the "what."

## Labels

The Engineer uses labels to track issue state. The label name is the task state with the configured prefix (default `engineer:`), so the full set mirrors the task state machine:

- `engineer:requirements_gathering` — clarifying the request before it's queued
- `engineer:queued` — picked up, waiting for execution
- `engineer:active` — currently being worked on
- `engineer:blocked` — paused, waiting on you (a question, a decision, or PR review)
- `engineer:completed` — done, PR merged or closed
- `engineer:failed` — could not be completed
- `engineer:cancelled` — you cancelled the task before it finished

You don't need to add these manually — The Engineer manages them, adding the new state label and removing the old one on each transition. A cancel can come from `engineer cancel` or the dashboard while the task sits queued or blocked; The Engineer reconciles the `engineer:cancelled` label and leaves a short comment on the issue when it cleans the task up.
