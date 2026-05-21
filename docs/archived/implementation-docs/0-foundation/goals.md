# Goals & Intentions

What The Engineer achieves. The destination that all architecture must serve.

Driven by the principles in [`philosophy.md`](philosophy.md). Identity defined in [`../../persona.md`](../../persona.md). Architecture lives in [`../layers.md`](../layers.md).

---

## The Core Goal

Build the most capable autonomous software engineer that has ever existed. Not a code generator. Not a chatbot with tools. A real engineer — with the personality, judgment, diligence, and proactivity defined in `persona.md`.

The persona is not decoration. It is the operating system. Every characteristic listed there is a real behavioral requirement that the architecture must enable.

## What "Working" Looks Like

### The baseline (it does its job)
- Receives a task (GitHub issue, Jira ticket, whatever trigger is configured)
- Gathers requirements like a real engineer — reaching out to real people, asking precise questions, clarifying every ambiguity
- Researches the codebase deeply before touching anything
- Plans, executes, tests, self-reviews, refactors
- Ships a clean, tested PR with full context
- Handles review feedback and iterates until approved
- Does this for ANY software task across ALL software domains — frontend, backend, infrastructure, data, DevOps, testing, docs, architecture

### The holy shit moment (it's alive)
- Works proactively WITHOUT being asked
- Notices bugs in existing code while working on something else
- Identifies tech debt, poor patterns, missing tests — creates improvement tasks for itself
- Spots security vulnerabilities, outdated dependencies, exposed secrets — flags or fixes them
- Builds knowledge continuously — reads docs, explores the codebase, deepens understanding even when idle
- Always learning, always improving its understanding of the project

Proactive behavior is configurable. Some users want a soldier (only does what's assigned). Some want a partner (notices things and acts). The system supports both.

## Self-Decomposition

When work is too large for a single task, The Engineer doesn't flag it and wait. It acts like a tech lead:
- Breaks the work down into sub-tasks
- Creates new tickets/issues that trigger itself
- Sequences them (what depends on what) or parallelizes them (what can run simultaneously)
- Executes the full plan across multiple tasks
- Keeps the big picture in view while working on individual pieces

This is recursive. A sub-task can itself be decomposed further.

## Swiss Army Engineer

The Engineer is not limited to any domain. It handles:
- Architecture and system design
- Frontend and backend development
- Infrastructure and DevOps
- Data engineering and pipelines
- Testing and quality assurance
- Security auditing
- Documentation
- Code review
- Performance optimization
- Dependency management
- Any software task a senior engineer could be asked to do

If it doesn't know how to do something, it researches until it does (self-extension from PI philosophy).

## Configurable Guardrails

There are no hardcoded "never" rules. Everything is configurable based on the user's needs and environment:
- **Branch policy**: Some users want PR-only. Others allow direct pushes. Configured, not hardcoded.
- **Audit trail**: Full logging of every action and decision. Transparency is always on — but what's logged and where is configurable.
- **Scope limits**: The agent only operates within its configured scope (repos, branches, domains). But the scope can be as wide or narrow as the user wants.
- **Cost limits**: LLM API spend, compute time — hard limits configurable. The agent never runs up an unbounded bill.
- **Autonomy level**: How much the agent can do without checking in. Fully configurable.

The agent makes judgment calls within its configured boundaries — just like a real engineer follows company policy. Different companies, different rules. The Engineer adapts.

## First User

Farzam. Solo founder/engineer. The Engineer is his second pair of hands. He directs, it executes — but it also pushes back, suggests better approaches, and proactively improves the codebase. The relationship evolves from direction-taking to true partnership as trust builds.

Design for one person first. Then scale.

## Communication Quality

How The Engineer communicates is as important as what it builds. A real engineer's communication is half their value.

- PR descriptions that tell the full story — what changed, why, what was considered, how to test
- Questions to humans that are precise, specific, and easy to answer — not vague asks that waste people's time
- Status updates at the right cadence — not noisy, not silent
- Explains at the right altitude for the audience — technical depth for engineers, high-level for stakeholders
- Communicates at the speed of understanding (from `persona.md`) — any abstraction, any altitude, any audience

## Observability

Users can always see what The Engineer is doing. Full transparency, full auditability.

- Live status: what task it's on, what phase, what it's doing right now
- Full audit trail: every action, every decision, every LLM call, every tool execution
- Session logs that can be reviewed after the fact
- No black box behavior — if it made a decision, you can see why

## Real-Time Failure Ownership

When The Engineer screws up — and it will — it owns the failure immediately. Extreme ownership from `persona.md` made real.

- Detects its own mistakes (tests fail, build breaks, PR gets rejected)
- Doesn't hide or ignore failures — surfaces them immediately
- Rolls back if needed, fixes the issue, communicates what happened
- Treats every failure as a learning opportunity (feeds into Continuous Growth)

## Graceful Degradation

The Engineer never crashes and loses work. When external systems fail (LLM provider down, Slack unreachable, GitHub rate-limited, network issues):

- Saves current state immediately
- Degrades gracefully — continues what it can, parks what it can't
- Resumes automatically when the dependency recovers
- Never loses work in progress

## Testability

The system must be verifiable. You need to know it works correctly before trusting it with real repos.

- Dry-run mode: goes through all motions without actually committing, pushing, or sending messages
- Session replay: replay a recorded session against different LLMs or prompts, compare results
- Simulated triggers: feed it fake issues/tickets and observe behavior
- The architecture must enable testability — every component must be testable in isolation

## The Skeleton and Plugins

The Engineer's architecture is like a modular machine. The skeleton is the core — invariant, stable, always present. The plugins snap on and off based on use case.

**Skeleton (core):** daemon, task engine, state machine, orchestrator, session persistence. These never change. The skeleton itself can be non-LLM (scripts, polling, simple logic) to stay cost-efficient. The LLM is only invoked when real thinking is needed.

**Plugins (variable):** triggers, communication channels, LLM providers, tools, workflow phases, observability backends. Anyone can swap, add, remove, or build their own. As long as the skeleton's interfaces are respected, any combination works.

The vital pieces that vary by use case are always plugins. The pieces that are universal are always skeleton. This separation is what makes The Engineer usable by anyone.

> **Evolution note:** At Layer 1, this two-tier model was refined into three tiers: **Core** (the skeleton), **Adapters** (stable integration contracts at the boundary), and **Plugins** (interchangeable implementations). See [`../1-system/architecture-tiers.md`](../1-system/architecture-tiers.md).

## Continuous Growth

The field of software is ungodly vast and always moving. Even a god-tier engineer has room to grow. The Engineer must get better over time — not stay static.

### Learning from repos it works on
Every repo teaches something. Patterns, conventions, domain knowledge, team preferences, what works, what breaks. These learnings persist — but stay isolated and correlated to the repos and contexts they came from. Learnings from repo A don't pollute repo B. They live where they're relevant.

### Learning from its own mistakes
The Engineer analyzes its own work over time:
- What mistakes did it make? What patterns led to bugs, rejected PRs, bad assumptions?
- What approaches worked well? What should become habit?
- What took too long? Where was effort wasted?

It documents these findings, identifies patterns, and adjusts its behavior. Not just "don't do X again" — deep analysis of WHY something failed and HOW to prevent the class of failure, not just the instance.

### Self-improvement beyond repos
The Engineer also improves itself as a system — outside of any specific repo it works on:
- Refines its own processes, prompts, reference docs
- Identifies inefficiencies in its own workflow
- Proposes and implements improvements to its own codebase
- These improvements persist in its home repo (this repo, or wherever that ends up being)

This is compound learning from `persona.md` made real: every project, bug, and failure deposits directly into permanent, accessible knowledge. The Engineer of next month is measurably better than the one today.

## Ultimate Vision (Full Maturity)

At full maturity, The Engineer:
- **Replaces a team**: One instance handles the workload of a small engineering team. Multiple repos, multiple domains, 24/7.
- **Manages other agents**: Becomes a tech lead that orchestrates specialized agents (design agents, testing agents, security agents, etc.).
- **Self-improving**: Optimizes its own codebase, improves its own prompts, learns from every task, refines its own processes. Gets better every day without human intervention.

This is the north star. v1 doesn't need all of this. But every architectural decision must leave the door open for it.
