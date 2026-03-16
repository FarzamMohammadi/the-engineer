# Lens K: Documentation ↔ Code Sync

> "Does the documentation still match reality?"

---

## No Worktree — Run Directly on Main

This is the final verification pass. Run it directly on the main branch — no worktree needed. When done, use `/commit` to commit fixes.

---

## Context

We just completed Layer 7 (structural restructuring) of The Engineer — an autonomous software engineering agent, followed by a multi-round review process that may have changed code across all phases. The full layer 7 process:
- Assessment: @implementation-docs/7-restructure/assessment.md
- Phase plan: @implementation-docs/7-restructure/phase-plan.md
- Review findings: @implementation-docs/7-restructure/review-findings.md
- Final user flow review: @implementation-docs/7-restructure/final-user-flow-review.md

The runtime phase architecture: @implementation-docs/7-restructure/review/0-phase-architecture.md

---

## Your Role

You are verifying that documentation matches the actual codebase after all review rounds have been applied. Documentation that contradicts the code is worse than no documentation — it actively misleads. This project's persona is in @docs/persona.md — that engineer's docs are always in sync because they treat stale docs as bugs, not chores.

**You are my partner, not my tool.** We collaborate on everything:
- **Never assume** — if something is ambiguous, ask me
- **Use Q&A often** — propose ideas, check alignment, discuss tradeoffs
- **WE ARE A TEAM** — bring your own opinions, push back when you disagree, challenge my thinking

---

## Scope: ALL Documentation

This is a whole-project verification pass. You're checking every documentation artifact against the actual code.

### Documents to verify:

1. **Phase review docs** (`implementation-docs/7-restructure/review/*.md`)
   - Do the file lists match what actually exists?
   - Do the flow diagrams match the actual code paths?
   - Do the state transitions match the ValidTransitions table?
   - Are the function names and signatures still accurate?

2. **Architecture docs** (`implementation-docs/`)
   - `0-foundation/goals.md` — still accurate?
   - `1-system/overview.md` — component list still correct?
   - `1-system/task-states.md` — state machine still matches code?
   - `3-interactions/event-catalog.md` — events still match `EventTypes`?
   - `3-interactions/protocols.md` — protocols still implemented as described?

3. **OSS docs** (`docs/`, root files)
   - `CONTRIBUTING.md` — commands still work?
   - `docs/architecture.md` — diagrams still accurate?
   - `docs/plugin-development.md` — plugin API still matches?
   - `README.md` — setup steps still work?

4. **Code-level docs**
   - JSDoc on public APIs — still accurate?
   - Inline comments — still true?
   - Type descriptions — still matching?

### What you're checking for:

- **Renamed functions** referenced by old name in docs
- **Removed files** still listed in docs
- **New files** not mentioned in docs
- **Changed signatures** (parameters added/removed) not reflected
- **Changed behavior** (flow changed but doc describes old flow)
- **Changed config fields** not updated in config docs/templates
- **Stale numbers** (test counts, decision counts, file counts)

---

## How to Work

1. **Read each doc**, then **verify each claim against the code**
2. **Don't trust — verify**. If a doc says "function X does Y", read function X and confirm.
3. **Check file existence** for every file referenced in docs
4. **Run commands** mentioned in CONTRIBUTING.md to verify they work
5. **Compare diagrams** against actual code flow
6. **Check event names** against `EventTypes` enum
7. **Check state transitions** against `ValidTransitions` table

For each finding:
- Quote the stale documentation
- Show what the code actually says
- Propose the fix (update doc or update code)

---

## Output Format

```markdown
## Findings

### [Finding title]
**Document:** [file path]
**Stale claim:** "[quoted text from doc]"
**Reality:** [what the code actually shows]
**Fix:** [update doc text to: "..."]

...repeat for each finding...

## Summary
[Overall sync health — percentage of docs that are accurate, areas of greatest drift]
```

---

## Final Step

After all fixes are applied, use `/commit` to commit directly to main.
