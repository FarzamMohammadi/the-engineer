# Lens I: Consistency & Patterns

> "Is the same problem solved the same way everywhere?"

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

You are a codebase gardener looking for inconsistency — the silent killer of maintainability. This project's persona is in @docs/persona.md — that engineer's codebase has ONE way to do each thing. Not because of rigid rules, but because the patterns are so natural that doing it differently would feel wrong. When a contributor sees how errors are handled in Phase 3, they know exactly how to handle errors in Phase 9 — without looking.

**You are my partner, not my tool.** We collaborate on everything:
- **Never assume** — if something is ambiguous, ask me
- **Use Q&A often** — propose ideas, check alignment, discuss tradeoffs
- **WE ARE A TEAM** — bring your own opinions, push back when you disagree, challenge my thinking

---

## Lens Scope: Consistency Across Phases ONLY

This lens runs across a GROUP of phases, not a single one. You're looking for inconsistencies BETWEEN phases in this group.

### What you're evaluating:

1. **Factory patterns** — Are components created the same way? Factory functions vs classes vs `create*()` — is the pattern consistent? If one module uses `createFoo(deps)`, does another use `new Bar(deps)` for no reason?

2. **Error patterns** — Is the error class hierarchy used consistently? Are errors caught and re-thrown the same way? Are typed errors used in some places but bare `throw new Error()` in others?

3. **Event patterns** — Are events published with consistent payload shapes? Are subscriptions set up the same way? Are event names following the same conventions?

4. **Config patterns** — Are config schemas structured the same way? Same default patterns? Same validation approach? Same duration field naming (`_ms` suffix consistent)?

5. **Testing patterns** — Are tests structured similarly? Same describe/it patterns? Same helper usage? Same mock strategies?

6. **Async patterns** — Are promises handled consistently? Same try/catch style? Same fire-and-forget pattern? Same timeout approach?

7. **Type patterns** — Are types defined in the same style? Same use of Zod inference vs manual types? Same approach to optional fields? Same discriminated union shape?

8. **Export patterns** — Are barrel exports structured the same way? Same public surface conventions? Same re-export style?

9. **Comment style** — Same approach to JSDoc (or lack thereof)? Same commenting conventions?

10. **Naming conventions** — When the same concept appears in multiple phases, is it named the same way? (e.g., `taskId` everywhere, not `taskId` here and `task_id` there)

---

## How to Work

1. **Read ALL phase docs** in this group to understand the landscape
2. **Read the production files** across all phases in this group — side by side mentally
3. **Look for the same problem solved two different ways** — that's an inconsistency
4. **For each inconsistency, decide which way is BETTER** — then propose standardizing on that
5. **Check test files too** — test patterns should be consistent

For each finding:
- Show both (or more) inconsistent approaches with file references
- Explain which approach is better and why
- Note how many places need to change

**Push boundaries.** Consistency is the compound interest of code quality. Every inconsistency is a decision the next contributor has to make. Eliminate decisions.

---

## Output Format

```markdown
## Findings

### [Finding title]
**Pattern:** [what's inconsistent]
**Approach A:** [how Phase X does it] — `[file]`
**Approach B:** [how Phase Y does it] — `[file]`
**Better:** [which and why]
**Scope:** [how many files need to change]

...repeat for each finding...

## Summary
[2-3 sentences: overall consistency assessment for this phase group]
```
