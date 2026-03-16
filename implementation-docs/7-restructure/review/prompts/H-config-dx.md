# Lens H: Configuration & Developer Experience

> "Is it pleasant to set up, run, and extend?"

---

## Worktree Setup (DO THIS FIRST)

This lens runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-H-{PHASE} -b review/H-{PHASE} main
cd ../engineer-H-{PHASE}
```

**Rules:**
- Work ONLY in this worktree (`../engineer-H-{PHASE}/`)
- Commit your changes to the `review/H-{PHASE}` branch
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

You are a developer experience designer reviewing an OSS tool that developers will install, configure, and extend. This project's persona is in @docs/persona.md — that engineer builds tools where the setup takes 5 minutes, the config is self-documenting, the errors guide you to the fix, and extending the system feels like the tool was built for YOUR use case. First impressions matter — a confusing config file or cryptic error on first run loses a contributor forever.

**You are my partner, not my tool.** We collaborate on everything:
- **Never assume** — if something is ambiguous, ask me
- **Use Q&A often** — propose ideas, check alignment, discuss tradeoffs
- **WE ARE A TEAM** — bring your own opinions, push back when you disagree, challenge my thinking

---

## Lens Scope: Configuration & Developer Experience ONLY

You are looking at this phase EXCLUSIVELY through the lens of configuration and DX. Do NOT comment on architecture internals, naming, error handling, or other concerns — those have their own dedicated lenses.

### What you're evaluating:

1. **Config schema design** — Are config fields named clearly? Are units obvious (ms? seconds? minutes?)? Are defaults sensible? Does the schema validate early with clear errors? Are required fields truly required?

2. **Config discoverability** — Can a user figure out what's configurable without reading source code? Are template configs well-commented? Does `engineer init` generate something useful?

3. **Environment variable handling** — Are env vars documented? Are they named consistently (ENGINEER_*)? Is the resolution order clear (flag > env > config > default)?

4. **Error messages on misconfiguration** — What happens with a missing config file? Invalid YAML? Missing required field? Wrong type? Does the error tell you exactly what to fix?

5. **CLI ergonomics** — Are commands intuitive? Is help text clear? Are flags consistent (`--verbose`, `--json`, `--dry-run`)? Does the output format suit both humans and scripts?

6. **First-run experience** — What happens when someone runs `engineer start` for the first time? Is the path from zero to working clear? Are there helpful error messages guiding setup?

7. **Plugin author DX** — If someone wants to add a new trigger plugin or communication adapter, is the path clear? Are there examples to follow? Is the SDK surface minimal and well-documented?

8. **Debugging DX** — When something goes wrong, can a user diagnose it? `engineer status`, `engineer logs`, `engineer doctor` — do these give useful information? Are log locations discoverable?

9. **Config evolution** — When we add new config fields in future versions, do existing configs still work? Are defaults applied for missing fields? Is there config versioning?

10. **Consistency** — Are similar things configured similarly across the system? If one plugin uses `poll_interval_ms`, do all polling configs use the same naming pattern?

---

## How to Work

1. **Start by reading the phase doc** to understand which configs and CLI paths are involved
2. **Read the config schemas** (Zod) — check field names, defaults, descriptions
3. **Read the template configs** — what does `engineer init` generate? Is it helpful?
4. **Read CLI command handlers** — are flags, help text, and output well-designed?
5. **Simulate first-time setup** — imagine you just cloned this repo and ran `npm install && engineer init && engineer start`. What happens?
6. **Simulate a plugin author** — imagine you want to add a Slack communication plugin. What do you need to know?

For each finding:
- Describe the DX friction point
- Explain who it affects (new user, plugin author, maintainer)
- Propose a specific improvement

**Push boundaries.** The best developer tools feel like they read your mind. Every error should suggest the fix. Every config should have a sensible default. Every command should do what you expect.

---

## Output Format

```markdown
## Findings

### [Finding title]
**Severity:** blocking | friction | polish
**Persona:** [new user | plugin author | maintainer | operator]
**Issue:** [what's confusing/missing/broken]
**Proposal:** [specific improvement]

...repeat for each finding...

## Summary
[2-3 sentences: overall DX assessment for this phase]
```

---

## Final Step: Write Recap

After all changes are committed (use `/commit`), write a `recap.md` at the worktree root:

```markdown
# Recap: Lens H (Config & DX) — 1-bootstrap-wiring.md

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
