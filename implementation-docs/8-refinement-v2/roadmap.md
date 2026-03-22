# Roadmap

Phases are fluid. New phases can be inserted anywhere as discoveries warrant. Completed phases get a `(DONE)` suffix. The order reflects our best thinking now — it will evolve as we learn.

**Resilience is not a phase — it's a lens.** Every phase we touch, we ask: what happens when this breaks? Can the engineer explain what happened? Can it recover? Can the user unstick it? Error handling, recovery, and clear communication are woven into every refinement, not bolted on at the end.

---

## Evaluation & Baseline (DONE)

Confirmed happy path works end-to-end after Layer 7 restructuring: trigger → intake → all phases → PR creation → feedback rework loop. Validated in Session 064 via manual live run.

---

## Dashboard — Simple Rebuild (DONE)

8-tab instrument panel with SSE real-time streaming. Audited Observer (13 types), EventBus (35 types), agent loop callbacks. Backend: `/api/observations` and `/api/stream` (SSE) endpoints. Frontend: complete rewrite with Overview, Tasks, Agent Loop, Observations, Events, Cost, Decisions, Errors tabs. Flicker-free 3-second auto-refresh.

Dashboard testing deferred entirely to the Dashboard Full Rebuild at the end of Layer 8 — no incremental testing on the simple dashboard.

---

## CLI-Only LLM Pivot

Remove API-based LLM integration entirely. The Engineer integrates exclusively with CLI-based tools. This is a permanent architectural simplification, not a temporary pivot.

### Remove API LLM Path

Strip out the API-oriented `LLMAdapter` contract (`complete/doComplete`). Remove any code paths, schemas, or config that assume direct API integration. Clean deletion, not deprecation.

### Redesign LLM Adapter for CLI

New adapter contract designed around CLI tool patterns: process spawning, stdin/stdout, streaming output, process lifecycle management. The contract should work naturally for Claude CLI, Codex, Gemini CLI, and OpenCode.

### Multi-CLI Plugin Support

Ensure the plugin architecture supports multiple CLI tools cleanly. Each CLI tool is a separate plugin implementing the new adapter. Users configure which one(s) to use. OpenCode serves as the "bring your own API key" option for OSS users.

---

## Multi-CLI Plugin Integration

With the CLI-only adapter contract in place, build and test plugins for the additional CLI tools. All three CLIs (Claude Code, OpenCode, Gemini CLI) are installed locally. Each CLI tool gets its own plugin implementing the same adapter contract — different flags and output parsing, same core pattern.

### OpenCode Plugin

Build plugin for OpenCode CLI. Test against a real repo.

### Gemini CLI Plugin

Build plugin for Gemini CLI. Test against a real repo.

### Cross-Plugin Validation

Verify all three plugins pass the contract compliance suite and produce equivalent results for the same prompts. Validate config switching between providers.

---

## RPI Integration (Research → Plan → Implement)

Adopt the RPI methodology: research and planning phases produce *real files* in the workspace, not just in-memory phase outputs. Inspired by [HumanLayer's RPI pattern](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/ace-fca.md).

### Research Phase → File Output

Research phase produces a structured markdown file in the worktree (e.g., `thoughts/research/YYYY-MM-DD-topic.md`). Documents what exists — files, patterns, flows, open questions. No opinions, no planning. This file becomes primary context for planning.

### Planning Phase → File Output

Planning phase reads the research file and produces a structured plan file (e.g., `thoughts/plans/YYYY-MM-DD-description.md`). Includes phases, file paths, success criteria, checkboxes for tracking. The plan file is the source of truth for execution.

### Execution Phase Reads Files

Execution phase reads the plan file as its primary guide. Updates checkboxes as phases complete. This makes the plan file a crash-safe progress tracker — if context fills or the process crashes, progress is tracked in the file itself.

### PR Integration & Cleanup Config

Research and plan files go into the PR by default — reviewers can see the reasoning. Configurable option to remove these files before merge for repos that want clean history. Small config: `rpi.include_in_pr: true/false` or similar.

---

## Runtime Phase Refinement

With the dashboard giving us visibility, CLI integration simplified, and RPI giving us better output structure — now we refine each runtime phase. Order is priority-driven based on what the dashboard reveals, not strictly sequential.

### Startup & Configuration

CLI entry, bootstrap, plugin loading, daemon startup. First impressions. Fast, informative, fail gracefully.

### Trigger & Intake

Trigger polling, dedup, task creation, prioritization. The bridge between external events and internal tasks.

### Scheduling & Dispatch

Priority, eligibility, slot management, concurrency. How tasks move from waiting to working.

### Workspace & Session

Worktree lifecycle, session setup, resume, rework detection. Task isolation and context.

### Intake & Research (RPI-aware)

Intake analysis, complexity detection, research file generation. Now produces real files per RPI methodology.

### Planning & Decomposition (RPI-aware)

Plan file generation, decomposition decisions, child task creation. Now produces real files per RPI methodology.

### Agent Loop & Execution

The iterative loop: CLI LLM call, action parse, tool execute, feed back. Plan file as primary guide. Test-fix iteration.

### Self-Review & Quality

Self-review assessment, loopback decisions (max 3), quality gates. What's "good enough to show."

### Demo & PR

Commit, push, draft PR creation. Demo artifacts, PR narrative. Research/plan files included per config.

### Review & Feedback

Review polling, feedback detection, rework loop. The cycle of human feedback → engineer improvement.

### Completion & Cleanup

Terminal states, notifications, workspace cleanup, parent integration for decomposed tasks.

### Communication

Notification wiring (Telegram + GitHub), message formatting, what notifications say and when.

### Background Services

Cost tracking, data lifecycle, health monitoring. The continuous machinery.

---

## Dashboard — Full Rebuild

Now that we know exactly what we want from refinement, rebuild the dashboard as a proper project.

### Frontend (React + Vite + shadcn/ui)

Production-grade UI. Real-time via SSE. Task status, phase progress, agent loop visibility, cost tracking, RPI file viewing, logs.

### Backend Instrumentation Polish

Any remaining data gaps identified during refinement. Richer traces, better event metadata.

---

## Hardening & OSS

Production readiness and community readiness.

### CI Pipeline

GitHub Actions, test matrix, lint/typecheck/test gates on PRs.

### Documentation & Contribution Flow

README, CONTRIBUTING, plugin development guide. The experience of a new contributor.

### Security Audit

Final pass on injection prevention, token handling, workspace confinement, trust boundaries.
