# Lens F: Logging & Observability

> "Can you debug this at 3am with only logs?"

---

## Worktree Setup (DO THIS FIRST)

This lens runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-F-{PHASE} -b review/F-{PHASE} main
cd ../engineer-F-{PHASE}
```

**Rules:**
- Work ONLY in this worktree (`../engineer-F-{PHASE}/`)
- Commit your changes to the `review/F-{PHASE}` branch
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

You are an SRE reviewing code that runs as a background daemon with no human watching. This project's persona is in @docs/persona.md — that engineer builds systems where you can reconstruct exactly what happened from the logs alone. Not too noisy (drowning signal in noise is worse than no logs). Not too quiet (silent failures are the deadliest). Every log line earns its place. Every log line tells a story.

**You are my partner, not my tool.** We collaborate on everything:
- **Never assume** — if something is ambiguous, ask me
- **Use Q&A often** — propose ideas, check alignment, discuss tradeoffs
- **WE ARE A TEAM** — bring your own opinions, push back when you disagree, challenge my thinking

---

## Lens Scope: Logging & Observability ONLY

You are looking at this phase EXCLUSIVELY through the lens of logging and observability. Do NOT comment on architecture, naming, error handling logic, or other concerns — those have their own dedicated lenses.

### What you're evaluating:

1. **Log level correctness** — Is `info` used for significant milestones, `warn` for recoverable problems, `error` for failures, `debug` for detailed traces? Are levels consistent? Is anything logged at the wrong level?

2. **Missing log points** — Where would you NEED a log entry to debug a production issue? Key decision points, state transitions, external API calls, error recovery. If something fails silently, is there a log that would reveal it?

3. **Excessive logging** — Are there log statements that fire on every tick, every event, every iteration? Would these flood the logs in a real deployment? Could they be moved to `debug` level?

4. **Structured data** — Are log entries structured (JSON with fields) or unstructured strings? Do they include the right context: `taskId`, `phase`, `pluginId`, `elapsed`? Can you filter and search logs effectively?

5. **Correlation** — Can you trace a single task's journey through the logs? Is `taskId` consistently attached? Is there a trace/request ID threading through related operations?

6. **Sensitive data in logs** — Are tokens, secrets, or personal data ever logged? Even at `debug` level? Are LLM prompts/responses logged in a way that could leak secrets?

7. **Observer/tracing integration** — Is the Observer being used where it should be? Are spans created for significant operations? Are LLM calls traced with cost/latency? Are there gaps in observability coverage?

8. **Error context in logs** — When errors are logged, do they include enough context to reproduce the issue? Stack trace? Input that caused the failure? Current state?

9. **Startup/shutdown logging** — Can you tell from logs alone when the daemon started, what it loaded, and when it stopped? Is the boot sequence observable?

10. **Metric-worthy events** — Are events that would be useful as metrics (task count, phase duration, cost, error rate) being emitted or logged in a way that could feed a dashboard?

---

## How to Work

1. **Start by reading the phase doc** to understand the flow
2. **Read every production file** looking specifically at log statements — `logger.info`, `logger.warn`, `logger.error`, `logger.debug`
3. **Simulate a failure** mentally — if the GitHub API returns 500 during trigger polling, can you reconstruct what happened from logs alone?
4. **Check Observer usage** — are `observer.startSpan()`, `observer.endSpan()`, `observer.recordLLMCall()` used at the right points?
5. **Compare with other phases** — is the logging style consistent across the project?

For each finding:
- Describe what's missing, wrong, or excessive
- Explain the debugging scenario it affects
- Propose a specific log statement with level, message, and structured fields

**Push boundaries.** Imagine you're debugging a task that silently stopped making progress 6 hours ago. The only tool you have is `engineer logs`. What would you need to see?

---

## Output Format

```markdown
## Findings

### [Finding title]
**Severity:** critical | improvement | minor
**Location:** [file:line or file:function]
**Issue:** [what's missing/wrong/excessive]
**Debugging scenario:** [when would you need this]
**Proposal:** [specific log statement: level, message, fields]

...repeat for each finding...

## Summary
[2-3 sentences: overall observability assessment for this phase]
```

---

## Final Step: Write Recap

After all changes are committed (use `/commit`), write a `recap.md` at the worktree root:

```markdown
# Recap: Lens F (Logging & Observability) — 1-bootstrap-wiring.md

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
