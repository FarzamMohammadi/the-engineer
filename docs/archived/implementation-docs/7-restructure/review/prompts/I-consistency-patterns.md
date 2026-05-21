# Lens I: Consistency, Patterns & Integration Seams

> "Is the same problem solved the same way everywhere — and do the phases actually fit together?"

---

## Worktree Setup (DO THIS FIRST)

This lens runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-I-{PHASE_GROUP} -b review/I-{PHASE_GROUP} main
cd ../engineer-I-{PHASE_GROUP}
```

**Rules:**
- Work ONLY in this worktree (`../engineer-I-{PHASE_GROUP}/`)
- Commit your changes to the `review/I-{PHASE_GROUP}` branch
- Do NOT push — the merge prompt will collect this branch
- When done: use `/commit`, verify tests pass, write recap, stop. The merge prompt handles the rest.

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

You are a codebase gardener AND a systems integration engineer. This lens has two jobs:

1. **Consistency** — find inconsistencies BETWEEN phases in this group (same problem solved differently)
2. **Integration seams** — verify the HANDOFFS between phases actually work (data shapes match, state transitions align, events are consumed)

This project's persona is in @docs/persona.md — that engineer's codebase has ONE way to do each thing, and components fit together like precision-machined parts. No gaps, no overlaps, no impedance mismatches.

**You are my partner, not my tool.** We collaborate on everything:
- **Never assume** — if something is ambiguous, ask me
- **Use Q&A often** — propose ideas, check alignment, discuss tradeoffs
- **WE ARE A TEAM** — bring your own opinions, push back when you disagree, challenge my thinking

---

## Part 1: Consistency Across Phases

You're looking for inconsistencies BETWEEN phases in this group.

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

## Part 2: Cross-Phase Integration Seams

Now look at the BOUNDARIES between phases. Individual phases may be perfect in isolation — this checks the seams.

### What you're evaluating:

1. **Data handoffs** — When Phase N produces data that Phase N+1 consumes, does the shape match exactly? Are there implicit contracts (one phase assumes a field exists that another might not set)? Could one phase mutate shared state unexpectedly?

2. **State transition boundaries** — When Phase N transitions a task to state X, does Phase N+1 correctly handle that state? Are there edge cases where a task could be in an unexpected state at a phase boundary? Is the transition reason string consistent between producer and consumer?

3. **Event contracts** — When Phase N publishes an event, does Phase N+1's subscriber handle all possible payload shapes? Are there dead-letter events (published but never consumed)? Are there subscribers waiting for events never published?

4. **Error propagation across phases** — When Phase N fails, does Phase N+1 handle the failure correctly? Are errors properly translated when crossing phase boundaries? Is the error chain traceable?

5. **Timing & ordering** — Are there assumptions about execution order the tick loop doesn't guarantee? Could a race condition occur between two phases in the same tick? Are there timing windows where data is inconsistent?

6. **Resource handoffs** — When Phase N creates a resource (workspace, session, checkpoint), does Phase N+1 use it correctly? Could a resource be used after cleanup?

### Seams per group:

| Group | Seams to Check |
|-------|---------------|
| Startup (0-3) | CLI→Bootstrap, Bootstrap→Plugins, Plugins→Daemon |
| Task Lifecycle (4-7) | Trigger→Scheduler, Scheduler→Workspace, Workspace→Pipeline |
| Review Lifecycle (8-10) | Pipeline→PR, PR→Feedback, Feedback→Completion |
| Resilience (11-12) | Error→Recovery, Health→Cost→Background |

---

## How to Work

1. **Read ALL phase docs** in this group to understand the landscape
2. **Read the production files** across all phases — side by side mentally
3. **For consistency**: look for the same problem solved two different ways, decide which is better
4. **For integration**: map every boundary between consecutive phases, trace 3 scenarios end-to-end (happy path, error path, edge case), look for assumptions one phase makes about another
5. **Check test files too** — test patterns should be consistent

**Push boundaries.** Consistency is the compound interest of code quality. Integration bugs are invisible when you look at either side alone — you have to look at BOTH sides simultaneously.

---

## Output Format

```markdown
## Consistency Findings

### [Finding title]
**Pattern:** [what's inconsistent]
**Approach A:** [how Phase X does it] — `[file]`
**Approach B:** [how Phase Y does it] — `[file]`
**Better:** [which and why]
**Scope:** [how many files need to change]

## Integration Seam Findings

### [Finding title]
**Seam:** Phase X → Phase Y
**Handoff:** [what crosses the boundary]
**Issue:** [mismatch, assumption, gap, or risk]
**Phase X side:** [code/behavior]
**Phase Y side:** [code/behavior]
**Proposal:** [which side changes and how]

## Summary
[2-3 sentences: overall consistency and integration health for this phase group]
```

---

## Final Step: Write Recap

After all changes are committed (use `/commit`), write a `recap.md` at the worktree root:

```markdown
# Recap: Lens I (Consistency, Patterns & Integration Seams) — {PHASE_GROUP}

## Findings Applied
- [1-sentence summary of each finding that resulted in code changes]

## Files Changed
- [list every file modified, created, or deleted]

## Commits
- [list commit hashes and messages]

## Findings Deferred
- [any findings flagged for discussion but not yet applied]
```

This recap is consumed by the merge prompt to efficiently integrate your changes with other parallel lenses.
