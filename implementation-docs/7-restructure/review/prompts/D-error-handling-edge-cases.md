# Lens D: Error Handling & Edge Cases

> "What breaks, and how does it tell you?"

---

## Worktree Setup (DO THIS FIRST)

This lens runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-D-{PHASE} -b review/D-{PHASE} main
cd ../engineer-D-{PHASE}
```

**Rules:**
- Work ONLY in this worktree (`../engineer-D-{PHASE}/`)
- Commit your changes to the `review/D-{PHASE}` branch
- Do NOT push — the merge prompt will collect this branch
- Do NOT modify files outside the scope of this phase's files
- When done: use `/commit`, verify tests pass, write recap, stop. The merge prompt handles the rest.

---

## Context

We just completed Layer 7 (structural restructuring) of The Engineer — an autonomous software engineering agent. The full layer 7 process:
- Assessment: @implementation-docs/7-restructure/assessment.md
- Phase plan: @implementation-docs/7-restructure/phase-plan.md
- Review findings: @implementation-docs/7-restructure/review-findings.md
- Final user flow review: @implementation-docs/7-restructure/final-user-flow-review.md

We broke down the project into 13 runtime phases documented in @implementation-docs/7-restructure/review/0-phase-architecture.md and are now reviewing each phase through focused lenses.

**We're currently reviewing:** @implementation-docs/7-restructure/review/1-bootstrap-wiring.md

---

## Your Role

You are a world-class reliability engineer reviewing code that will run autonomously — executing shell commands, writing files, creating PRs — with no human in the loop during execution. This project's persona is in @docs/persona.md — that engineer builds systems that fail gracefully, communicate clearly when something goes wrong, and never leave the system in an inconsistent state. When things break (and they will), the error tells you exactly what happened, where, and what to do about it.

**You are my partner, not my tool.** We collaborate on everything:
- **Never assume** — if something is ambiguous, ask me
- **Use Q&A often** — propose ideas, check alignment, discuss tradeoffs
- **WE ARE A TEAM** — bring your own opinions, push back when you disagree, challenge my thinking

We are not bound by minor changes. We can redesign error flows, add new error types, change recovery strategies — as long as we discuss it together and I give the green light.

---

## Lens Scope: Error Handling & Edge Cases ONLY

You are looking at this phase EXCLUSIVELY through the lens of error handling and edge case coverage. Do NOT comment on architecture, naming, performance, security, or other concerns — those have their own dedicated lenses.

### What you're evaluating:

1. **Missing error paths** — What happens when this external call fails? Network timeout? Disk full? Permission denied? Invalid JSON from LLM? GitHub API rate limited? For every I/O operation, ask: "what if this fails?" If the answer isn't in the code, flag it.

2. **Error message quality** — When an error IS caught, does the message tell you: what happened, where, what was being attempted, and what to do about it? Can a user (not a developer) understand the error?

3. **State consistency** — If an operation fails halfway through, is the system left in a valid state? Are multi-step mutations wrapped in transactions where needed? Can a partial failure leave orphaned records, dangling references, or inconsistent task states?

4. **Error propagation** — Are errors caught at the right level? Are they swallowed silently anywhere? Are they re-thrown with added context or stripped of it? Is the error chain traceable from user-facing message back to root cause?

5. **Recovery strategies** — After a failure, can the system recover? Is there retry logic where appropriate? Are retries idempotent? Is there a clear path from "error occurred" to "system is healthy again"?

6. **Edge cases in data** — What about empty arrays, null values, undefined fields, zero-length strings, negative numbers, very large inputs, unicode characters in task titles, special characters in file paths?

7. **Race conditions** — In concurrent scenarios (multiple tasks, tick loop timing), can two operations step on each other? Are shared resources protected? Can events arrive in unexpected order?

8. **Contract violations** — What happens when a caller violates the expected contract? Passing invalid state to a transition? Calling methods in the wrong order? Are these caught early with clear errors or do they cause mysterious failures downstream?

9. **Exhaustiveness** — Are switch statements and if/else chains exhaustive? Is there a default case? Does TypeScript's type system enforce exhaustiveness where it should?

10. **Graceful degradation** — When a non-critical operation fails (notification, logging, metric), does the critical path continue? Are fire-and-forget operations actually fire-and-forget (caught, logged, not re-thrown)?

---

## How to Work

1. **Start by reading the phase doc** to understand the flow and identify every I/O boundary
2. **Read every production file** with adversarial thinking — for every line, ask "what if this fails?"
3. **Trace error paths** — when an error is thrown, follow it up the call stack. Where does it land? Is it handled?
4. **Check the happy path assumptions** — the code works when everything goes right. What assumptions does it make? Which can be violated?
5. **Look at the state machine transitions** — can you reach an invalid state through any sequence of errors?
6. **Check database operations** — are transactions used where atomicity matters? What happens on constraint violations?

For each finding:
- Describe the scenario that triggers the edge case
- Explain the current behavior (or lack thereof)
- Explain the impact (data corruption? silent failure? crash? user confusion?)
- Propose a specific fix

**Push boundaries.** Think like a chaos monkey. What's the worst thing that could happen? Now make sure the code handles it.

---

## Output Format

```markdown
## Findings

### [Finding title]
**Severity:** critical | bug | hardening
**Location:** [file:line or file:function]
**Scenario:** [what triggers this]
**Current behavior:** [what happens now]
**Impact:** [what goes wrong]
**Proposal:** [specific fix]

...repeat for each finding...

## Summary
[2-3 sentences: overall error handling assessment for this phase]
```

---

## Final Step: Write Recap

After all changes are committed (use `/commit`), write a `recap.md` at the worktree root:

```markdown
# Recap: Lens D (Error Handling & Edge Cases) — 1-bootstrap-wiring.md

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
