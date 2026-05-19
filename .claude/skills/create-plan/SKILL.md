---
name: create-plan
description: >-
  Synthesizes requirements and research into robust implementation plans through structured
  decision-making and expert panel stress-testing. Calibrates process depth to risk level — low
  stakes get a light plan, full stakes get hard decision gates and a pre-mortem. The plan is a
  decision record with actionable tasks, not an execution script. Use when you need to turn
  accumulated findings into a plan with clear choices, sequenced tasks, and verification. Also
  use when the user says "plan this", "create a plan", "how should we implement this", "design
  the approach", or "what's the strategy".
allowed-tools: Read, Bash, Edit, Write, Agent, AskUserQuestion
argument-hint: "[research-file or task description]"
---

# Create Plan

You own the plan. Requirements gathered intent. Research mapped the codebase. Now you synthesize
everything into a plan that produces the highest quality, most robust implementation possible.

Take full ownership. Previous phases did their best, but they may have missed things. You are
the last line of defense before code gets written. Be diligent. Be meticulous. Cover gaps that
earlier phases might have overlooked. The plan's value is the decisions it records and the
confidence it creates — not the prose it contains.

## Phase 1: Absorb

Read ALL upstream artifacts fully before designing anything:
- Requirements document (check `.claude/temp/requirements-gathering/`)
- Research document (check `.claude/temp/research/`)
- Any other referenced files, tickets, or context

Absorb everything. Cross-reference requirements against research findings. Look for:
- Requirements that research findings complicate or contradict
- Research findings that requirements didn't account for (especially cross-cutting concerns)
- Gaps that neither phase caught — things you can see now with both documents side by side
- Edge cases, error paths, and failure modes that need explicit handling in the plan

Surface anything you find. This is your diligence step.

## Phase 2: Design

Synthesize all accumulated context into a complete plan draft. Design for robustness, quality,
and correctness — not just the happy path. Consider error handling, edge cases, testing coverage,
maintainability, and the cross-cutting concerns from research.

Present the full draft to the user. Walk through the key decisions with your reasoning:

> **Decision: [Title]**
> **My recommendation**: [Choice] because [reasoning from research]
> **Alternative**: [Option B] — [trade-off]
> **What this locks in**: [Consequence of choosing]

Iterate with the user until aligned on all decisions. If genuine ambiguities remain that upstream
phases didn't resolve, surface them — but don't re-ask what's already been answered.

## Phase 3: Stress Test

Run the plan through `/expert-panel-review`. This is not optional — the panel is what catches
blind spots that a single perspective misses.

Incorporate panel findings. Present what changed and what was declined (with reasoning):

| Decision | Panel Verdict | Action |
|----------|--------------|--------|
| D1: [title] | [agreement/concern] | Keep / **Changed** — [what changed] |

For high-stakes work, run a **pre-mortem** after the panel:

> "Imagine this plan shipped and failed. What was the most likely cause?"

Write three failure scenarios and their mitigations. Add them to the plan.

### Write the Plan

Ensure the output directory exists, then write:

```bash
mkdir -p .claude/temp/create-plan
```

Write to: `.claude/temp/create-plan/<ticket-or-name>.md`

**Plan template:**

```markdown
# Plan: [Title]

**Date**: [date] | **Stakes**: Low / Standard / Full
**Upstream**: [research doc path] | [requirements doc path]
**Status**: Draft | Panel-Reviewed | Approved

## Intent

[2-3 sentences: what we are building and the single most important reason why.]

## Decisions

### D1: [Decision Title]
**Choice**: [What we chose]
**Context**: [Why this decision exists — what forced the choice]
**Rejected**:
- [Option B]: [Why not]
- [Option C]: [Why not]
**Consequence**: [What this locks in or prevents]

### D2: [Decision Title]
[Same structure]

## Scope Boundary

**Delivering**:
- [What ships]

**Deferring**:
- [What we're explicitly not doing] — [why]

## Task Breakdown

### Task 1: [Title] [estimated: Xm]
**Goal**: [What is true when this is done — one sentence]
**Where**: [File paths from research]
**Approach**: [How to do it — description, not code]
**Depends on**: [Nothing | Task N]
**Verify**: [Single concrete check — a command or behavior to observe]
**Commit**: [Use `/commit` after verification passes]

### Task 2: [Title] [estimated: Xm]
[Same structure]

Use `/commit` after each task or logical group of tasks passes verification. Each commit should
capture a coherent, working increment — not a big bang at the end.

## Verification Contract

| Check | Type | Command or Observation |
|-------|------|----------------------|
| [Types compile] | Auto | [command] |
| [Tests pass] | Auto | [command] |
| [Behavior works] | Manual | [what to observe] |

## Risks

| Risk | If It Happens | Mitigation |
|------|--------------|------------|
| [Risk] | [Impact] | [What to do] |

## Panel Review

**Panelists**: [Who ran]
**Incorporated**: [Changes made from panel feedback]
**Declined**: [Suggestions not taken, with reasoning]

## References
- Requirements: [path]
- Research: [path]
```

Present for final review. Iterate until the user confirms.

If a Jira ticket is involved, offer to attach via `/jira-ticket-manager`.

## Principles

- **Own it completely.** Previous phases did their best. You do yours. Cross-reference, challenge,
  and fill gaps as if you're the last person who will look before implementation starts.
- **Design for robustness.** The plan should produce the highest quality outcome. Consider error
  handling, edge cases, testing coverage, and maintainability — not just the happy path.
- **Decisions over descriptions.** The plan's value is the choices made, not the words written.
- **The panel is mandatory.** Expert review catches what a single perspective misses. Always run it.
- **No open questions ship.** Every ambiguity is resolved before the plan is finalized.
