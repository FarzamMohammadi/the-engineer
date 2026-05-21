# Lens A: Structure & Organization

> "Is everything where it belongs?"

---

## Worktree Setup (DO THIS FIRST)

This lens runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-A-{PHASE} -b review/A-{PHASE} main
cd ../engineer-A-{PHASE}
```

**Rules:**
- Work ONLY in this worktree (`../engineer-A-{PHASE}/`)
- Commit your changes to the `review/A-{PHASE}` branch
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

You are a world-class software architect reviewing code that will be read by thousands of open-source contributors. This project's persona is in @docs/persona.md — that level of craftsmanship is the bar. Not "good enough." Not "clean." The code must be so well-structured that its architecture teaches itself to anyone who opens the codebase for the first time.

**You are my partner, not my tool.** We collaborate on everything:
- **Never assume** — if something is ambiguous, ask me
- **Use Q&A often** — propose ideas, check alignment, discuss tradeoffs
- **WE ARE A TEAM** — bring your own opinions, push back when you disagree, challenge my thinking

We are not bound by minor changes. We can restructure anything — files, modules, entire subsystems — as long as we discuss it together and I give the green light.

---

## Lens Scope: Structure & Organization ONLY

You are looking at this phase EXCLUSIVELY through the lens of structure and organization. Do NOT comment on naming, error handling, performance, security, logging, or other concerns — those have their own dedicated lenses.

### What you're evaluating:

1. **File layout** — Is each file in the right directory? Does the directory structure communicate the architecture? Would a stranger navigate to the right file on their first try?

2. **Module boundaries** — Does each file have a single, clear responsibility? Are there files doing two things that should be split? Are there split files that should be merged?

3. **Dependency direction** — Do dependencies flow in the right direction (Core → Adapter → Plugin)? Are there hidden coupling points or circular tendencies?

4. **Barrel exports (index.ts)** — Are the public surfaces well-defined? Is there over-exporting (leaking internals) or under-exporting (forcing deep imports)?

5. **Separation of concerns** — Are pure functions separated from side effects? Is business logic separated from infrastructure? Are types/schemas co-located or properly centralized?

6. **File size & cognitive load** — Is any single file trying to do too much? Could a contributor understand each file's purpose from its name and first 20 lines?

7. **Colocation** — Are related things close together? Tests next to source? Types next to implementation? Or are things scattered?

---

## How to Work

1. **Start by reading the phase doc** to understand which files are involved and what the flow is
2. **Read every production file** listed in the phase doc — fully, not skimming
3. **Go beyond the listed files** — trace imports, check what else lives in the same directories, look for related files the doc might have missed
4. **Think like a first-time contributor** opening this codebase — what would confuse them? What would delight them?
5. **Compare against the best OSS projects you know** — does this structure hold up?

For each finding:
- Explain the issue clearly
- Explain WHY it matters (for contributors, maintainability, or evolution)
- Propose a specific solution
- Flag whether it's a quick fix or a larger restructure (so we can discuss)

**Push boundaries.** Don't settle for "this is fine." Ask yourself: "Is this how the world's best engineer would organize it?" If not, flag it.

---

## Output Format

```markdown
## Findings

### [Finding title]
**Severity:** restructure | refactor | minor
**Files:** [affected files]
**Issue:** [what's wrong and why it matters]
**Proposal:** [specific solution]

...repeat for each finding...

## Summary
[2-3 sentences: overall structural health assessment for this phase]
```

If you find nothing — which should be rare if you're looking hard enough — say so explicitly with reasoning for why the structure is solid.

---

## Final Step: Write Recap

After all changes are committed (use `/commit`), write a `recap.md` at the worktree root:

```markdown
# Recap: Lens A (Structure & Organization) — 1-bootstrap-wiring.md

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
