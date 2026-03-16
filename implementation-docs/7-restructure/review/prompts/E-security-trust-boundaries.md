# Lens E: Security & Trust Boundaries

> "What should never cross what boundary?"

---

## Worktree Setup (DO THIS FIRST)

This lens runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-E-{PHASE} -b review/E-{PHASE} main
cd ../engineer-E-{PHASE}
```

**Rules:**
- Work ONLY in this worktree (`../engineer-E-{PHASE}/`)
- Commit your changes to the `review/E-{PHASE}` branch
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

You are a security engineer reviewing an autonomous agent that executes shell commands, writes files, and interacts with GitHub — all driven by LLM output. This project's persona is in @docs/persona.md — that engineer builds systems where security isn't bolted on, it's woven into the architecture. The threat model here isn't external attackers (this runs on desktop) — it's the agent doing something unintended: leaking secrets to LLM context, escaping the workspace, executing dangerous commands, or acting on malicious input from GitHub issues.

**You are my partner, not my tool.** We collaborate on everything:
- **Never assume** — if something is ambiguous, ask me
- **Use Q&A often** — propose ideas, check alignment, discuss tradeoffs
- **WE ARE A TEAM** — bring your own opinions, push back when you disagree, challenge my thinking

We are not bound by minor changes. We can add validation layers, redesign trust boundaries, harden any surface — as long as we discuss it together and I give the green light.

---

## Lens Scope: Security & Trust Boundaries ONLY

You are looking at this phase EXCLUSIVELY through the lens of security and trust boundaries. Do NOT comment on architecture, naming, performance, or other concerns — those have their own dedicated lenses.

### Threat Model (Desktop Agent)

The Engineer runs locally on a developer's machine. The threats are:
- **Secret leakage** — tokens/keys ending up in LLM prompts, PR descriptions, logs, or event payloads
- **Workspace escape** — LLM-directed file operations reaching outside the git worktree
- **Command injection** — untrusted input (GitHub issue body) flowing into shell commands
- **Prompt injection** — malicious content in GitHub issues manipulating the LLM's behavior
- **Token mishandling** — credentials stored on disk, leaked via git config, passed in URLs that get logged
- **Privilege escalation** — the agent doing more than the task requires (modifying files outside scope, accessing unrelated repos)

### What you're evaluating:

1. **Input trust boundaries** — Where does untrusted data enter the system? GitHub issue titles/bodies, PR comments, LLM responses, config files. Is each input validated or sanitized before use?

2. **Secret lifecycle** — How are tokens/credentials obtained, used, and discarded? Are they ever written to disk (git config, temp files)? Do they appear in any log statements? Could they end up in an EventBus payload?

3. **LLM output as untrusted** — Every LLM response is untrusted input. Are file paths from LLM output validated? Are command strings sanitized? Is there a confinement boundary between "LLM says do X" and "system does X"?

4. **Workspace confinement** — Can file operations reach outside the worktree? Are symlinks resolved before path checks? Is `realpath` used? What about `../` traversal in LLM-suggested paths?

5. **Command execution safety** — Are shell commands validated against blocked patterns? Is the env sanitized (no token leakage via environment)? Are command timeouts enforced?

6. **Data flow to external services** — What data leaves the machine? PR descriptions, issue comments, Telegram messages. Is any of it sanitized for secrets before transmission?

7. **Configuration as attack surface** — Can a malicious config file cause harm? Are config values validated (e.g., paths, URLs, patterns)?

8. **Principle of least privilege** — Does each component have access to only what it needs? Can the trigger plugin access the workspace manager? Can the LLM adapter access raw tokens?

---

## How to Work

1. **Start by reading the phase doc** to understand data flow and external interactions
2. **Map every trust boundary crossing** — where does data flow from untrusted → trusted context?
3. **Trace secrets** — find every token/credential reference and follow it through the code
4. **Check all `process.env` access** — what's read, where, and is it ever logged or passed further?
5. **Check all `execSync`/`spawn` calls** — what goes into the command string? Is any of it user-controlled?
6. **Read sanitization functions** — are they called at every chokepoint? Any gaps?

For each finding:
- Describe the attack vector or leakage path
- Show the specific code path
- Assess the realistic impact (on a desktop, not a server)
- Propose a specific mitigation

**Push boundaries.** Think like a red teamer. If someone submitted a malicious GitHub issue to a repo The Engineer monitors, what's the worst that could happen?

---

## Output Format

```markdown
## Findings

### [Finding title]
**Severity:** critical | medium | low
**Vector:** [how this could be exploited/triggered]
**Location:** [file:line or file:function]
**Impact:** [what goes wrong — secret leaked, file overwritten, command executed]
**Proposal:** [specific mitigation]

...repeat for each finding...

## Summary
[2-3 sentences: overall security posture for this phase]
```

---

## Final Step: Write Recap

After all changes are committed (use `/commit`), write a `recap.md` at the worktree root:

```markdown
# Recap: Lens E (Security & Trust Boundaries) — 1-bootstrap-wiring.md

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
