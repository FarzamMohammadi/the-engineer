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

## CLI-Only LLM Pivot (DONE)

Remove API-based LLM integration entirely. The Engineer integrates exclusively with CLI-based tools. This is a permanent architectural simplification, not a temporary pivot.

### Remove API LLM Path

Strip out the API-oriented `LLMAdapter` contract (`complete/doComplete`). Remove any code paths, schemas, or config that assume direct API integration. Clean deletion, not deprecation.

### Redesign LLM Adapter for CLI

New adapter contract designed around CLI tool patterns: process spawning, stdin/stdout, streaming output, process lifecycle management. The contract should work naturally for Claude CLI, Codex, Gemini CLI, and OpenCode.

### Multi-CLI Plugin Support

Ensure the plugin architecture supports multiple CLI tools cleanly. Each CLI tool is a separate plugin implementing the new adapter. Users configure which one(s) to use. OpenCode serves as the "bring your own API key" option for OSS users.

---

## Multi-CLI Plugin Integration (DONE)

Three LLM plugins built, live-tested, and registered. Code quality review of S066 changes. Contribution guide dogfooded and refined. Dashboard: N/A for null cost, blocked reason visibility. `engineer init` single-select for LLM. Philosophy: "Agent-Assisted Everything".

Key learnings: always pipe via stdin (not CLI args), detect rate limits from both stdout (structured error) and stderr (retry messages), kill infinite-retry CLIs immediately.

---

## RRPIR Design (DONE)

The Engineer's own methodology: **R**equirements Gathering → **R**esearch → **P**lanning → **I**mplementation → **R**eview. Designed in Session 068. Full architecture in [rrpir-design.md](rrpir-design.md).

Key decisions made:
- CLI-native agent architecture (revises D143) — CLI tools are full agents, not inference providers
- Requirements Gathering as universal fallback — any phase can invoke it when stuck
- Intake analysis → Requirements Gathering (revises fast-path from D141) — every task gets full RRPIR
- Multi-phase configurable Review pipeline (revises self-review from Layer 2/6)
- `thoughts/` directory for file-based handoffs between phases
- Signal protocol (`ENGINEER_SIGNAL`) for phase transition parsing
- Plan checkboxes for crash-safe progress tracking

---

## RRPIR Implementation

Broken into focused sessions. Each session implements one or two RRPIR phases and tests them live.

### Session 069 — Requirements Gathering + Research (DONE)

- Renamed `intake_analysis` → `requirements_gathering` across entire codebase
- File-first architecture: session-result.json + .md deliverables (supersedes signal protocol)
- Task-scoped thoughts/ directory with trigger-provided thoughts_id
- CLI-native prompts for ALL 7 phases (shared helpers in format.ts)
- runPhaseWithCli() alongside agent loop (coexist until Session 072)
- Requirements ↔ research loop in phase runner
- Removed fast-path entirely, removed getContinueArgs (deferred)
- Post-commit triple review → refinement pass (3 critical bugs, ~300 lines deduplicated)

### Session 070 — Planning + Implementation + Universal Fallback

- Wire planning + execution handlers to use runPhaseWithCli (currently still agent-loop)
- Implement universal fallback routing (`return_to_phase` mechanism for any phase → requirements gathering → return)
- Implement need_more_info resolution flow (how blocked tasks unblock when responses arrive)
- Implement decomposition detection from plan.md
- Crash recovery via plan.md checkboxes
- Test with live CLI run

### Session 071 — Review Pipeline + Demo/PR

- Implement configurable multi-phase review pipeline (`rrpir.review_phases` config)
- Build review phase prompts (requirements check, security, code quality)
- Build refinement phase (reads `thoughts/review/*.md`, consolidates, fixes)
- Wire into demo_prep (PR creation with thoughts/ files, cleanup config)
- Cost management: default to minimal review phases, per-phase tracking
- Test full RRPIR pipeline end-to-end

### Session 072 — Agent Loop Removal

- Remove `agent-loop.ts`, `action-executor.ts`, `phase-tools.ts`, `json-parser.ts`
- Simplify `llm-caller.ts` — direct CLI call, read deliverable files
- Simplify phase output schemas (files are the output, not JSON)
- Update/remove ~200+ agent loop tests
- Clean up dead code and unused schemas

### Session 073+ — RRPIR Refinement

- Live testing each phase with all 3 CLI tools (Claude Code, OpenCode, Gemini CLI)
- Prompt tuning based on real results
- Cross-plugin validation (equivalent quality across CLIs)
- Dashboard updates for RRPIR visibility (thoughts/ file viewer, review findings)
- Crash recovery testing with file-based checkpoints

---

## Runtime Phase Refinement

With RRPIR implemented and the dashboard giving visibility, refine the supporting infrastructure. Order is priority-driven.

### Startup & Configuration

CLI entry, bootstrap, plugin loading, daemon startup. First impressions. Fast, informative, fail gracefully.

### Trigger & Requirements Flow

Trigger polling, dedup, task creation, prioritization. Requirements Gathering contacts via People Directory + Communication plugins. The bridge between external events and internal tasks.

### Scheduling & Dispatch

Priority, eligibility, slot management, concurrency. How tasks move from waiting to working.

### Workspace & Session

Worktree lifecycle, session setup, resume, rework detection. Task isolation. `thoughts/` directory lifecycle.

### Demo & PR

Commit, push, draft PR creation. PR narrative from thoughts/ files. Cleanup config for thoughts/ removal.

### Review & Feedback (External)

External review polling (after PR creation), feedback detection, rework loop. The cycle of human reviewer feedback → engineer rework. Distinct from the internal RRPIR Review pipeline.

### Completion & Cleanup

Terminal states, notifications, workspace cleanup, parent integration for decomposed tasks.

### Communication

Notification wiring (Telegram + GitHub), message formatting, requirements Q&A formatting, what notifications say and when.

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
