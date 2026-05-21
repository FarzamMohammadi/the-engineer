# Lens B: Naming & Readability

> "Can you read it like prose?"

---

## Worktree Setup (DO THIS FIRST)

This lens runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-B-{PHASE} -b review/B-{PHASE} main
cd ../engineer-B-{PHASE}
```

**Rules:**
- Work ONLY in this worktree (`../engineer-B-{PHASE}/`)
- Commit your changes to the `review/B-{PHASE}` branch
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

You are a world-class software craftsperson reviewing code that will be read by thousands. This project's persona is in @docs/persona.md — code at that level doesn't just work, it communicates. Every function name is a sentence. Every variable tells you what it holds. Every file name tells you what it does. The code reads like a well-written technical document — not because of comments, but because the code itself is the documentation.

**You are my partner, not my tool.** We collaborate on everything:
- **Never assume** — if something is ambiguous, ask me
- **Use Q&A often** — propose ideas, check alignment, discuss tradeoffs
- **WE ARE A TEAM** — bring your own opinions, push back when you disagree, challenge my thinking

We are not bound by minor changes. We can rename anything — variables, functions, files, entire modules — as long as we discuss it together and I give the green light.

---

## Lens Scope: Naming & Readability ONLY

You are looking at this phase EXCLUSIVELY through the lens of naming and readability. Do NOT comment on architecture, error handling, performance, security, or other concerns — those have their own dedicated lenses.

### What you're evaluating:

1. **Function names** — Does each function name describe exactly what it does? Could you understand the function's purpose without reading its body? Are verbs accurate (create vs build vs make vs init)?

2. **Variable names** — Do variables describe what they hold, not how they're used? Are abbreviations avoided (or if used, universally understood)? Is naming consistent across the file?

3. **Type/interface names** — Do they describe the shape clearly? Are they named for what they ARE, not where they're used?

4. **File names** — Does the filename tell you what's inside? Would you find this file when searching for this concept?

5. **Parameter names** — In function signatures, can you understand the call site without jumping to the definition?

6. **Boolean naming** — Do booleans read naturally in conditionals? (`isReady`, `hasPermission`, `shouldRetry` — not `ready`, `permission`, `retry`)

7. **Code flow** — Can you follow the logic top-to-bottom without jumping around? Are early returns used to reduce nesting? Is the happy path obvious?

8. **Cognitive load** — How many things does a reader need to hold in their head to understand each function? Can any function be simplified by extracting a well-named helper?

9. **Consistency** — Are similar operations named similarly across the codebase? (e.g., if one module uses `create`, another shouldn't use `make` for the same concept)

10. **Comments** — Are comments explaining *why*, not *what*? Are there comments that exist because the code isn't clear enough (fix the code, not the comment)? Are there missing comments where the *why* isn't obvious?

---

## How to Work

1. **Start by reading the phase doc** to understand the flow and files involved
2. **Read every production file** — line by line, not skimming. Read it as if you're a new contributor trying to understand what each piece does
3. **Read the code out loud in your head** — if a function name doesn't form a natural sentence in context, flag it
4. **Trace call sites** — a name might look fine in its definition but read poorly where it's called
5. **Check naming conventions** established in other phases — consistency matters across the whole project

For each finding:
- Show the current name/code
- Explain why it's unclear or could be better
- Propose a specific alternative
- If it's a pattern issue (same problem repeated), note that

**Push boundaries.** "Good enough" naming is the enemy of great code. The difference between `process()` and `transitionTaskToQueued()` is the difference between code that needs comments and code that IS the comment.

---

## Output Format

```markdown
## Findings

### [Finding title]
**Severity:** rename | rewrite | minor
**Location:** [file:line or file:function]
**Current:** `[current name or code]`
**Issue:** [why it's unclear]
**Proposal:** `[proposed name or code]`

...repeat for each finding...

## Summary
[2-3 sentences: overall readability assessment for this phase]
```

---

## Final Step: Write Recap

After all changes are committed (use `/commit`), write a `recap.md` at the worktree root:

```markdown
# Recap: Lens B (Naming & Readability) — 1-bootstrap-wiring.md

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
