# Roadmap

Phases are fluid. New phases can be inserted anywhere as discoveries warrant. Completed phases get a `(DONE)` suffix. The order reflects our best thinking now — it will evolve as we learn.

---

## Evaluation & Baseline

The starting point. Before we refine anything, we need to know exactly where we stand after Layer 7's massive restructuring.

### Code Audit

Walk through each runtime phase in code. Verify the structure matches our architecture decisions. Surface any issues from the Layer 7 restructuring that need attention. Produce a findings report.

### Live Run

Fire up the engineer against a real repo. Watch it work phase by phase. Document what works, what breaks, what feels wrong. This is the ground truth that shapes everything after.

---

## Startup & Configuration

The first thing any user experiences. Must be clean, informative, and fail gracefully.

### CLI Entry & Environment

`engineer start`, `engineer status`, `engineer stop`. Environment validation, directory setup, error messages. First impressions matter.

### Bootstrap & Wiring

Component initialization order, dependency injection, startup timing. Should be fast and transparent.

### Plugin Loading

Discovery, validation, initialization, health checks. Error messages when plugins fail. The experience of adding a new plugin.

### Daemon Startup

PID management, crash recovery, orphan detection. The transition from "starting" to "running."

---

## Trigger & Intake

How work enters the system. The bridge between external events and internal tasks.

### Trigger Polling & Dedup

Polling intervals, watermarks, idempotency, backoff on failures. GitHub-specific logic vs. adapter-generic logic.

### Task Creation & Prioritization

Intake state, initial priority assignment, metadata extraction from trigger events.

---

## Scheduling & Dispatch

How tasks move from waiting to working. The scheduler's judgment.

### Priority & Eligibility

Priority calculation, parent/child eligibility rules, cascade policies.

### Slot Management & Dispatch

Concurrency limits, dispatch packaging (session, knowledge, checkpoint), fire-and-forget execution.

---

## Workspace & Session

Task isolation and context. Where the engineer actually works.

### Worktree Lifecycle

Creation, branch naming, parent branch inheritance, cleanup. Git operations and token handling.

### Session Setup & Resume

New sessions, checkpoint resume, rework detection. Context handoff between sessions.

---

## Intake & Research

The engineer's first look at a task. Understanding before action.

### Intake Analysis & Complexity Detection

Complexity scoring, fast-path detection, decomposition signals. The prompt that shapes everything downstream.

### Research & Context Gathering

File discovery, pattern recognition, existing code analysis. Building the context that makes planning effective.

---

## Planning & Execution

The core of the work. Where code gets written.

### Plan Generation & Decomposition

Planning prompts, decomposition decisions, child task creation. The quality of the plan determines the quality of the output.

### Agent Loop & Tool Execution

The iterative loop: LLM call, action parse, tool execute, feed back. Tool restrictions per phase. Workspace confinement.

### Test-Fix Iteration

Running tests, interpreting failures, fixing code. The inner loop of execution quality.

---

## Self-Review & Quality

The engineer reviewing its own work before showing anyone.

### Self-Review & Loopback

Quality assessment, loopback decisions (max 3), the prompt that catches what execution missed.

### Quality Gates

What triggers loopback vs. proceeding. The bar for "good enough to show."

---

## Demo & PR

Presenting work for review. The handoff from engineer to human.

### Commit, Push & PR Creation

Commit messages, push mechanics, draft PR creation, token lifecycle during push.

### Demo Artifacts & Narrative

PR description quality, what the demo communicates, how reviewers experience the work.

---

## Review & Feedback

The human feedback loop. How the engineer responds to critique.

### Review Polling & Detection

Polling mechanics, feedback aggregation, self-comment filtering, circuit breakers.

### Feedback Rework Loop

Feedback injection into prompts, rework detection, PR updates, the cycle of improvement.

---

## Completion & Cleanup

Finishing cleanly. No loose ends.

### Terminal States & Notifications

Completion transitions, notification content, multi-channel delivery (Telegram + GitHub).

### Workspace Cleanup & Parent Integration

Worktree removal, branch preservation, child completion detection, parent integration phase.

---

## Resilience

When things go wrong. Grace under pressure.

### Error Handling & Escalation

Error classification, escalation stages, self-unblock attempts, human alerts.

### Preemption & Crash Recovery

Priority-based preemption, checkpoint integrity, crash recovery on restart, orphan detection.

### Stuck Detection

Staleness heuristics, blocked task detection, timeout escalation.

---

## Background Services

The continuous machinery. Runs alongside everything else.

### Cost Tracking & Limits

Per-task and global cost accumulation, limit enforcement, warning thresholds.

### Data Lifecycle & Retention

Event/trace cleanup, TTL enforcement, database maintenance.

### Health Monitoring

Plugin health checks, state machine transitions, failure alerting.

---

## Communication

How the engineer talks to humans. Every message should be useful.

### Notification Wiring (Telegram + GitHub)

Channel routing, message formatting, fire-and-forget delivery, error handling.

### Message Formatting & Templates

What notifications say, how they're structured, what information they carry.

---

## War Room Dashboard

Real-time visibility into what the engineer is doing and has done.

### Backend Instrumentation

New events, richer traces, agent loop visibility. The data that powers the dashboard.

### Frontend (React + Vite + shadcn/ui)

The dashboard UI. Real-time via SSE. Task status, phase progress, cost tracking, logs.

---

## Hardening & OSS

Production readiness and community readiness.

### CI Pipeline

GitHub Actions, test matrix, lint/typecheck/test gates on PRs.

### Documentation & Contribution Flow

README, CONTRIBUTING, plugin development guide. The experience of a new contributor.

### Security Audit

Final pass on injection prevention, token handling, workspace confinement, trust boundaries.
