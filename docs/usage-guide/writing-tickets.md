# Writing Tickets

How to write GitHub issues that The Engineer can pick up and execute well.

## The Golden Rule

**Describe the problem and what you want — not how to build it.** The Engineer does its own research, reads the codebase, and figures out the implementation. Over-prescribing the solution limits its ability to find the right approach and makes tickets brittle when the codebase changes.

## What a Good Ticket Contains

### 1. Problem

What's wrong, or what's missing. Why does this matter? One or two sentences.

> Running the full 7-phase pipeline during development wastes tokens and time. Phases like `self_review` and `demo_prep` are valuable in production but unnecessary when iterating.

### 2. What We Want

The desired outcome in plain language. Focus on behavior, not code.

> Skip the `self_review` and `demo_prep` phases during pipeline execution — but PR creation must still happen.

### 3. Constraints

Non-negotiable boundaries. These prevent The Engineer from going off-track.

- What must not break
- What must not change (e.g., "no config schema changes")
- Safety rails (e.g., "never skip execution")
- Patterns to follow (e.g., "mark all changes with TODO-TEMP")

### 4. Acceptance Criteria

Checkboxes that define "done." Be specific enough that they're testable.

- [ ] `self_review` and `demo_prep` phases are skipped
- [ ] PR is still created after execution completes
- [ ] All existing tests pass

## What to Leave Out

### Don't prescribe the implementation

Bad:
> In `src/core/orchestrator/types.ts`, add a `skipSelfReview` parameter to `buildPhaseSequence()`. Then in `phase-runner.ts` at line 143, pass `true` for that parameter.

Good:
> Skip the `self_review` phase during pipeline execution.

The Engineer will find `buildPhaseSequence()`, understand the pattern, and implement it. Telling it which lines to edit makes the ticket fragile and prevents it from finding a better approach.

### Don't explain the codebase

Bad:
> The `PhaseNavigator` class in `phase-navigator.ts` has a `replaceSequence()` method that allows dynamic phase sequence modification. The existing `skipResearch` pattern filters phases in `buildPhaseSequence()`.

The Engineer reads the code. It will discover these patterns during its research phase. Explaining them in the ticket adds noise and can mislead if the code has changed since you wrote it.

### Don't over-constrain

Bad:
> Must use the exact same pattern as research skipping. Must add a boolean parameter. Must update exactly 3 files.

Good:
> Must not break existing tests. No config schema changes.

Constrain the boundaries, not the path.

## Calling Out Non-Obvious Gotchas

Sometimes you know something The Engineer might miss — a hidden dependency, a subtle invariant, an edge case you've hit before. **These belong in the ticket**, framed as constraints or context.

> **Important: PR Creation.** Currently, PR creation is triggered after `demo_prep` or after `self_review` when it's the last phase. With both skipped, `execution` becomes the last phase — so PR creation must still be triggered.

This isn't prescribing the solution — it's flagging a non-obvious consequence that could lead to a broken PR workflow. The Engineer still decides *how* to handle it.

## Sizing

The Engineer works best with focused, single-concern tickets. Signs a ticket is too big:

- It touches more than one system boundary
- The acceptance criteria cover unrelated behaviors
- You're writing paragraphs to explain the scope

Split it. The Engineer handles decomposition natively, but clean input produces cleaner output.

## Mechanical Refactors

For purely mechanical changes (rename, replace patterns, migrate syntax), be explicit about scope and consistency:

> Replace all raw string literals with exported Zod enum constants. Both `src/` and test files. Where constants already exist, don't duplicate — ensure raw strings referencing those values are replaced too.

Mechanical tickets can be more specific about scope because the "how" is inherent in the "what."

## Labels

The Engineer uses labels to track issue state:

- `engineer:queued` — picked up, waiting for execution
- `engineer:active` — currently being worked on
- `engineer:completed` — done, PR merged or closed

You don't need to add these manually — The Engineer manages them.
