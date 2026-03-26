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

## RRPIR Implementation (DONE)

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

### Session 070 — Planning + Implementation + Universal Fallback (DONE)

- Wired planning + execution to runPhaseWithCli (4/7 phases now CLI-native)
- Universal fallback: any phase → requirements_gathering → return to calling phase (returnToPhase on PipelineState)
- External blocking with persistent return_to_phase (DB migration 007, task schema, row mapper, task engine)
- Crash recovery: execution prompt detects resumed sessions via session-result.json state
- Separation of concerns: session-result.json = pure routing, .md files = rich context (documented in rrpir-design.md)
- Decomposition from plan.md deferred to future-considerations.md
- Triple review (simplify + persona + PR reviewer) → refinement pass (PhaseSchema validation, state mutation safety, test deduplication)
- 5 new tests, 2285 total

### Session 071 — Review Pipeline + Demo/PR (DONE)

- Configurable multi-phase review pipeline (`rrpir.review_phases` config)
- Review phase prompts (requirements check, security, code quality) with `overridePhaseDir`
- Refinement phase (reads `thoughts/review/*.md`, consolidates, applies fixes)
- Demo-prep is narrative-only (writes `pr-description.md`; pr-manager handles git/PR ops)
- All 7/7 phases now CLI-native via `runPhaseWithCli`
- `pnpm lint` runs all 4 checks (biome + typecheck + knip + circular)

### Session 076 — Agent Loop Removal (DONE)

- Deleted agent-loop.ts, action-executor.ts, phase-tools.ts, json-parser.ts, prompts/self-review.ts
- Removed dead schemas: AgentActionSchema, ActionResultSchema, PhaseToolConfigSchema
- Simplified llm-caller.ts (611 → 304 lines), removed `runPhaseWithAgentLoop` from interface
- ~2,600 lines removed, 80 tests dropped. 2,242 tests passing.

---

## Communication Flow (DONE)

Built the complete blocked/unblock communication lifecycle across Sessions 072-076. This work was not originally on the roadmap — it emerged from live testing as a critical gap.

### Sessions 072-073 — UnblockResolver + Response Poller Design (DONE)

- UnblockResolver: shared Core abstraction (by external_ref + by task_id)
- Response poller design: triggers = intake, communication = conversations
- Dashboard response API: POST writes `comm.message_received` event, daemon polls and unblocks
- `CommunicationAdapter.pollMessages()`: new optional method under `receive` capability

### Session 074 — Response Poller Implementation (DONE)

- Created `response-poller.ts` daemon subsystem with adaptive backoff
- Implemented `doPollMessages()` in GitHubCommPlugin (issue comment polling, self-filtering)
- Wired into tick loop, removed unblock check from trigger poller
- Triple review found and fixed 3 bugs (historical comment replay, event bus replay, spurious query responses)

### Session 075 — Live Testing + Telegram Receive (DONE)

- Moved `receive` capability from GitHub to Telegram (GitHub = intake, Telegram = communication)
- Fixed blocked task resume: no checkpoint on block, always set `return_to_phase`, persist `thoughts_dir`
- Updated requirements_gathering prompt to read `responses/` directory on resume
- Drained pending Telegram updates on startup to prevent false unblocks
- Live-tested end-to-end: block → Telegram outreach → reply → unblock → resume working

### Session 076 — Dashboard Blocked-Task UI (DONE)

- Blocked details card (reason, needed, waiting_for, efforts)
- Conversation panel with outreach messages and owner responses
- Text input with Send button (+ Ctrl+Enter) for dashboard responses
- Real-time SSE updates for new messages

---

## RRPIR Hardening (DONE)

Session 076 ran three parallel reviews (Engineer persona, Technical Architect, QA Engineer) of the full RRPIR pipeline. Found 17 issues across 4 categories. All 4 worktree branches merged.

### WS-1: Review Directory Consolidation + PHASE_DIRECTORIES Cleanup

- Merge `review/` and `refinements/` into single `review/` directory
- Remove `"refinements"` from PHASE_DIRECTORIES, add `"integration"`
- Eliminate magic index access (PHASE_DIRECTORIES[0], [4], [6]) — use PHASE_DIR_MAP exclusively
- Remove fragile PHASE_DELIVERABLE_MAP entirely (prompts are explicit, check adds no value)
- Update review.ts refinement output paths, phase-handlers.ts overridePhaseDir

### WS-2: Prompt Data Flow Fixes

- Fix demo-prep.ts hyphen/underscore filename mismatch (CRITICAL — LLM looks for wrong files)
- Fix review.ts bare `requirements.md` path (missing thoughtsDir prefix)
- Add `review/refinements.md` reference to demo-prep prompt
- Fix outreach/ cleanup timing (currently cleaned before LLM can read prior outreach on re-run)
- Add session-result.json reminder to process steps in requirements-gathering and research prompts
- Add decomposition mechanics sentence to planning prompt

### WS-3: Crash Recovery + State Persistence

- Persist `loopbackCount` and `requirementsLoopCount` on task record (lost on crash, defeats safety limits)
- Fix session-result.json invalid JSON fallback (currently defaults to "ready" — should default to "need_more_info")
- Wire or remove dead `rrpir.max_review_loopbacks` config (defined but never read)
- Add `"blocked"` to SessionEndReasonSchema (currently uses "crashed" — TODO still open)
- Fix response file write ordering in unblock-resolver (write content BEFORE transitioning task)

### WS-4: Observability + Preemption + Alert Delivery

- Fix preemption gate: shared singleton → task-scoped (wrong task preempted when max_concurrent > 1)
- Fix loopback alert delivery (currently publishes event that may never reach human)
- Add observation spans: top-level pipeline, per-phase handler, workspace ops, loopback/blocking decisions

---

## Runtime Phase Refinement

With RRPIR hardened, go through each runtime flow phase by phase. Two co-founders refining together — evaluate behavior, fix issues, tune until it's something we love. "Working" is not "good." This is where we make it good.

**Ideas & brainstorm:** Each subsection gets its own file in `roadmap-ideas/` — co-founder discussion documented before implementation. A separate plan finalizes scope for each.

- [roadmap-ideas/startup.md](roadmap-ideas/startup.md) — Startup & Configuration

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

## Backend Instrumentation Polish

After Runtime Phase Refinement reveals what data the dashboard actually needs. Fill remaining gaps: richer traces, better event metadata, observation types for every significant operation. This feeds the dashboard rebuild.

---

## Dashboard — Full Rebuild

Now that instrumentation is complete and we know exactly what we want, rebuild the dashboard as a proper project.

### Frontend (React + Vite + shadcn/ui)

Production-grade UI. Real-time via SSE. Task status, phase progress, cost tracking, thoughts/ file viewing, communication panel, logs.

---

## Hardening & OSS

Production readiness and community readiness.

### CI Pipeline

GitHub Actions, test matrix, lint/typecheck/test gates on PRs.

### Documentation & Contribution Flow

README, CONTRIBUTING, plugin development guide. The experience of a new contributor.

### Security Audit

Final pass on injection prevention, token handling, workspace confinement, trust boundaries.
