# Lens G: Performance & Resource Management

> "Any waste, leaks, or blocking?"

---

## Worktree Setup (DO THIS FIRST)

This lens runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-G-{PHASE} -b review/G-{PHASE} main
cd ../engineer-G-{PHASE}
```

**Rules:**
- Work ONLY in this worktree (`../engineer-G-{PHASE}/`)
- Commit your changes to the `review/G-{PHASE}` branch
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

You are a performance engineer reviewing a long-running daemon that will run for days/weeks on a developer's desktop. This project's persona is in @docs/persona.md — that engineer builds systems that are lean, never waste resources, and stay healthy over time. Memory doesn't grow. Timers get cleaned up. Database queries are efficient. Nothing blocks the event loop unnecessarily.

**You are my partner, not my tool.** We collaborate on everything:
- **Never assume** — if something is ambiguous, ask me
- **Use Q&A often** — propose ideas, check alignment, discuss tradeoffs
- **WE ARE A TEAM** — bring your own opinions, push back when you disagree, challenge my thinking

---

## Lens Scope: Performance & Resource Management ONLY

You are looking at this phase EXCLUSIVELY through the lens of performance and resource management. Do NOT comment on architecture, naming, error handling, or other concerns — those have their own dedicated lenses.

### What you're evaluating:

1. **Memory leaks** — Maps, Sets, arrays, caches that grow without bounds. Event listeners that are never removed. Closures capturing references longer than needed. After a week of running with hundreds of tasks, will memory be stable?

2. **Resource cleanup** — Are timers (`setInterval`, `setTimeout`) cleared on shutdown? Are file handles closed? Are database statements finalized? Are child processes cleaned up?

3. **Hot path efficiency** — The tick loop runs every ~5 seconds. Anything in the tick path should be fast. Are there unnecessary allocations, redundant queries, or O(n²) operations in the hot path?

4. **Database performance** — Are queries using indexes? Are there N+1 query patterns? Are transactions held open longer than necessary? Is WAL mode being leveraged correctly?

5. **Blocking operations** — Are there synchronous I/O calls (`execSync`, `readFileSync`) on the critical path that should be async? (Note: some sync operations are intentional, e.g., SQLite via better-sqlite3)

6. **Unnecessary work** — Is work being done that could be skipped? Polling when nothing changed? Re-computing values that could be cached? Serializing/deserializing on every tick?

7. **Concurrency** — Is `Promise.allSettled` used where operations are independent? Are there sequential awaits that could be parallel? Is the event loop ever starved?

8. **Allocation patterns** — Objects created in loops that could be reused. String concatenation in hot paths. Temporary arrays that could be avoided.

9. **Graceful degradation under load** — With 50 queued tasks and 5 concurrent, does the system scale linearly? Are there quadratic patterns (checking every task against every other task)?

10. **Config-driven tuning** — Are performance-sensitive values (poll intervals, batch sizes, cache sizes, timeouts) configurable? Are defaults reasonable for a desktop machine?

---

## How to Work

1. **Start by reading the phase doc** to identify the hot paths and I/O boundaries
2. **Read the tick loop integration** — anything called every tick is a hot path
3. **Look for growing collections** — Maps, Sets, arrays. Do they have cleanup? TTLs? Max sizes?
4. **Check shutdown paths** — are all intervals, timeouts, and listeners cleaned up?
5. **Look at database queries** — especially in loops. Could they be batched?
6. **Profile mentally** — imagine 1000 tasks have passed through the system over a month. What's still in memory?

For each finding:
- Describe the waste, leak, or inefficiency
- Estimate the impact (memory growth rate, unnecessary CPU cycles, blocked time)
- Propose a specific optimization

**Push boundaries.** This daemon runs for weeks. A tiny leak becomes a big problem. A small inefficiency in the tick loop becomes millions of wasted cycles.

---

## Output Format

```markdown
## Findings

### [Finding title]
**Severity:** leak | optimization | minor
**Location:** [file:line or file:function]
**Issue:** [what's wasted/leaking/blocking]
**Impact:** [estimated cost over time]
**Proposal:** [specific fix]

...repeat for each finding...

## Summary
[2-3 sentences: overall performance health for this phase]
```

---

## Final Step: Write Recap

After all changes are committed (use `/commit`), write a `recap.md` at the worktree root:

```markdown
# Recap: Lens G (Performance & Resources) — 1-bootstrap-wiring.md

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
