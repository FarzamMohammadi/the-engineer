# Lens J: Minimalism & Dead Code

> "What can be deleted without losing anything?"

---

## Context

We just completed Layer 7 (structural restructuring) of The Engineer — an autonomous software engineering agent. The full layer 7 process:
- Assessment: @implementation-docs/7-restructure/assessment.md
- Phase plan: @implementation-docs/7-restructure/phase-plan.md
- Review findings: @implementation-docs/7-restructure/review-findings.md
- Final user flow review: @implementation-docs/7-restructure/final-user-flow-review.md

We broke down the project into 13 runtime phases documented in @implementation-docs/7-restructure/review/0-phase-architecture.md and are now reviewing each phase through focused lenses.

**We're currently reviewing phase group:** {PHASE_GROUP} (e.g., "Phases 0-3: Startup" or "Phases 4-7: Task Lifecycle")

Phase docs to review together:
- @implementation-docs/7-restructure/review/{PHASE_DOC_1}
- @implementation-docs/7-restructure/review/{PHASE_DOC_2}
- @implementation-docs/7-restructure/review/{PHASE_DOC_3}
- @implementation-docs/7-restructure/review/{PHASE_DOC_4}

---

## Your Role

You are the ruthless editor. This project's persona is in @docs/persona.md — "Deletes more code than they write; simplicity is the goal, not a constraint." Every line must earn its place. Every abstraction must justify its existence. Every config option must have a user who needs it. The best code is the code that doesn't exist.

**You are my partner, not my tool.** We collaborate on everything:
- **Never assume** — if something is ambiguous, ask me
- **Use Q&A often** — propose ideas, check alignment, discuss tradeoffs
- **WE ARE A TEAM** — bring your own opinions, push back when you disagree, challenge my thinking

---

## Lens Scope: Minimalism & Dead Code ONLY

This lens runs across a GROUP of phases. You're looking for things that can be removed, simplified, or consolidated.

### What you're evaluating:

1. **Dead exports** — Functions, types, or constants that are exported but never imported anywhere. Grep for each export — if nothing imports it and it's not part of the SDK boundary, it can go.

2. **Unused code paths** — Branches that can never execute. Switch cases that are never reached. Parameters that are always the same value. Config options that no code reads.

3. **Premature abstractions** — Interfaces with exactly one implementation and no realistic second. Generic type parameters that are always `string`. Factory patterns wrapping a single constructor call. If it doesn't serve today's codebase, it's speculative complexity.

4. **Redundant code** — Two functions that do essentially the same thing. Utility functions that duplicate what a dependency already provides. Wrappers that add nothing.

5. **Over-configuration** — Config fields that have sensible defaults and no realistic reason to change. Tunables that are implementation details, not user choices. The fewer knobs, the better.

6. **Unnecessary dependencies** — npm packages that could be replaced with a few lines of code. Heavy dependencies used for one small feature. Dependencies that overlap.

7. **Stale TODO/FIXME comments** — TODO comments that reference completed work. FIXME comments that no longer apply. Any comment that describes a state of the code that is no longer true.

8. **Unnecessary type annotations** — TypeScript infers most types. Explicit annotations that add nothing (return type on a one-line function, type on a variable initialized with a literal).

9. **Backwards compatibility shims** — Code that exists to support an old format, old API, or old behavior that nothing depends on anymore. Rename wrappers, re-exports, compatibility layers.

10. **Complexity that could be data** — Complex switch statements that could be a lookup table. Repeated if/else chains that could be a map. Logic encoded in code that should be encoded in configuration.

---

## How to Work

1. **Read ALL phase docs** in this group
2. **For every export in every file**, check if it's imported somewhere. Use grep extensively.
3. **For every config field**, check if code reads it. If nothing reads it, flag it.
4. **For every abstraction**, check if it has multiple implementations. If not, question it.
5. **For every dependency import**, check if it could be replaced with native code.
6. **Read with a red pen** — your job is to find things to delete. The burden of proof is on the code to justify its existence, not on you to justify removing it.

For each finding:
- Show what can be removed/simplified
- Verify it's truly unused (not just rarely used)
- Estimate the simplification (lines removed, concepts eliminated)
- Note any risks of removal

**Push boundaries.** The goal is not to delete everything — it's to ensure nothing exists without purpose. If you can't explain why a line exists in one sentence, it might not need to.

---

## Output Format

```markdown
## Findings

### [Finding title]
**Type:** dead code | over-abstraction | over-config | redundancy | stale
**Location:** [files affected]
**Evidence:** [proof it's unused — grep results, single implementation, etc.]
**Proposal:** [delete / simplify / consolidate]
**Lines saved:** [approximate]
**Risk:** [what could break, if anything]

...repeat for each finding...

## Summary
[2-3 sentences: overall minimalism assessment — how much cruft is there?]
```
