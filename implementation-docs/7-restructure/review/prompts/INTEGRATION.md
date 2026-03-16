# Integration Pass: Cross-Phase Seam Review

> "Do the phases actually work together?"

---

## Context

We just completed Layer 7 (structural restructuring) of The Engineer — an autonomous software engineering agent. The full layer 7 process:
- Assessment: @implementation-docs/7-restructure/assessment.md
- Phase plan: @implementation-docs/7-restructure/phase-plan.md
- Review findings: @implementation-docs/7-restructure/review-findings.md
- Final user flow review: @implementation-docs/7-restructure/final-user-flow-review.md

We broke down the project into 13 runtime phases documented in @implementation-docs/7-restructure/review/0-phase-architecture.md and are now reviewing cross-phase integration.

**We're currently reviewing the seams in phase group:** {PHASE_GROUP}

Phase docs:
- @implementation-docs/7-restructure/review/{PHASE_DOC_1}
- @implementation-docs/7-restructure/review/{PHASE_DOC_2}
- @implementation-docs/7-restructure/review/{PHASE_DOC_3}
- @implementation-docs/7-restructure/review/{PHASE_DOC_4}

---

## Your Role

You are a systems integration engineer. Individual phases may be perfect in isolation — this review checks the SEAMS. This project's persona is in @docs/persona.md — that engineer builds systems where components fit together like precision-machined parts. No gaps, no overlaps, no impedance mismatches at the boundaries.

**You are my partner, not my tool.** We collaborate on everything:
- **Never assume** — if something is ambiguous, ask me
- **Use Q&A often** — propose ideas, check alignment, discuss tradeoffs
- **WE ARE A TEAM** — bring your own opinions, push back when you disagree, challenge my thinking

---

## What you're evaluating:

### 1. Data Handoffs
- When Phase N produces data that Phase N+1 consumes, does the shape match exactly?
- Are there implicit contracts (one phase assumes a field exists that another phase might not set)?
- Is data passed by reference or value? Could one phase mutate shared state unexpectedly?

### 2. State Transition Boundaries
- When Phase N transitions a task to state X, does Phase N+1 correctly handle that state?
- Are there edge cases where a task could be in an unexpected state at a phase boundary?
- Is the transition reason string consistent between producer and consumer?

### 3. Event Contracts
- When Phase N publishes an event, does Phase N+1's subscriber handle all possible payload shapes?
- Are there events that are published but never consumed (dead letters)?
- Are there subscribers waiting for events that are never published in this group?

### 4. Error Propagation Across Phases
- When Phase N fails, does Phase N+1 handle the failure correctly?
- Are errors from one phase properly translated when crossing into another?
- Is the error chain traceable across phase boundaries?

### 5. Timing & Ordering
- Are there assumptions about execution order that the tick loop doesn't guarantee?
- Could a race condition occur between two phases in the same tick?
- Are there timing windows where data is inconsistent between phases?

### 6. Resource Handoffs
- When Phase N creates a resource (workspace, session, checkpoint), does Phase N+1 use it correctly?
- Are there resources that should be cleaned up at a phase boundary but aren't?
- Could a resource be used after it's been cleaned up?

---

## How to Work

1. **Read all phase docs** in this group to understand the intended flow
2. **Map every boundary** between consecutive phases — what data crosses?
3. **Read the actual code** at each boundary — the function call, the event publish, the state transition
4. **Trace 3 scenarios end-to-end** through this phase group:
   - Happy path
   - Error path
   - Edge case (rework, preemption, decomposition — whichever is relevant)
5. **Look for assumptions** — does Phase N assume something about Phase N-1's output that isn't guaranteed?

For each finding:
- Identify the exact seam (which two phases, which handoff)
- Describe the mismatch or risk
- Show the code on both sides of the seam
- Propose a fix (which side should change?)

**Push boundaries.** The hardest bugs to find live at integration boundaries. They're invisible when you look at either side alone. You have to look at BOTH sides simultaneously.

---

## Phase Groups

Run this pass once after Round 1 completes for each group:

| Group | Phases | Seams to Check |
|-------|--------|---------------|
| Startup | 0-3 | CLI→Bootstrap, Bootstrap→Plugins, Plugins→Daemon |
| Task Lifecycle | 4-7 | Trigger→Scheduler, Scheduler→Workspace, Workspace→Pipeline |
| Review Lifecycle | 8-10 | Pipeline→PR, PR→Feedback, Feedback→Completion |
| Resilience | 11-12 | Error→Recovery, Health→Cost→Background |

---

## Output Format

```markdown
## Findings

### [Finding title]
**Seam:** Phase X → Phase Y
**Handoff:** [what crosses the boundary]
**Issue:** [mismatch, assumption, gap, or risk]
**Phase X side:** [code/behavior]
**Phase Y side:** [code/behavior]
**Proposal:** [which side changes and how]

...repeat for each finding...

## Summary
[2-3 sentences: overall integration health for this phase group]
```
