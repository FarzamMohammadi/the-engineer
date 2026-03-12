# Layer 6 Phase Plan

8 phases to take The Engineer from "infrastructure complete" to "best OSS engineer the world has ever seen."

Each phase: build → manual test → refine → next phase.

---

## Phase Overview

| Phase | Name | Goal | Depends On |
|-------|------|------|------------|
| 6.0 | Assessment & Smoke Test | Baseline, docs, decisions | — |
| 6.1 | LLM Adapter Evolution | Agentic mode with tools | 6.0 |
| 6.2 | Intake & Research Prompts | First two phases intelligent | 6.1 |
| 6.3 | Planning & Execution Prompts | Core work phases functional | 6.2 |
| 6.4 | Review, Demo & Integration | Complete pipeline end-to-end | 6.3 |
| 6.5 | Communication & Feedback | Bidirectional human-agent | 6.4 |
| 6.6 | Decomposition & Multi-Task | Task splitting for large tasks | 6.3 |
| 6.7 | End-to-End Manual Testing | Validate all 5 user flows | 6.4 |
| 6.8 | Hardening & OSS Prep | Push to perfection | 6.7 |

---

## Dependency Graph

```
6.0 (Assessment)
  └─ 6.1 (LLM Adapter)
       └─ 6.2 (Intake + Research)
            └─ 6.3 (Planning + Execution)
                 ├─ 6.4 (Review + Demo + Integration)
                 │    ├─ 6.5 (Communication)
                 │    └─ 6.7 (E2E Testing)
                 │         └─ 6.8 (Hardening)
                 └─ 6.6 (Decomposition)
```

---

## Phase Details

### Phase 6.0: Assessment & Smoke Test — Session 051

**Status: IN PROGRESS**

- [x] Full codebase assessment (3 parallel exploration agents)
- [x] Gap analysis (8 gaps identified and prioritized)
- [x] Design decisions (D137-D142)
- [x] Layer 6 directory structure created
- [x] Assessment, gaps, decisions, phase-plan docs written
- [ ] Smoke test against real repo
- [ ] Update active.md, layers.md
- [ ] Session log
- [ ] Memory files

### Phase 6.1: Agent Loop Engine + LLM Adapter Evolution — Session 052

**Status: DONE**

**Decision D143:** The Engineer owns the agent loop. LLMs are inference-only (prompt in, JSON out). Provider-agnostic by design — any LLM that outputs JSON works. No dependency on any provider's agentic features.

**Changes (implemented):**
1. `CompletionRequest` → added `system_prompt` (nullable, backward-compatible)
2. `AgentAction` discriminated union schema (7 action types + `thinking` field)
3. `ActionResult` and `PhaseToolConfig` schemas
4. **`agent-loop.ts`** (NEW) — Pure-function agent loop: prompt → LLM → parse → validate → execute → repeat
5. **`action-executor.ts`** (NEW) — Maps AgentAction to real operations within worktree (security boundary)
6. **`phase-tools.ts`** (NEW) — Per-phase tool restrictions (D141 enforcement)
7. `ClaudeCodeLLMPlugin` → `--system-prompt` flag support
8. Orchestrator → all 7 phase handlers wired through `runPhaseWithAgentLoop()`
9. Prior phase output injection (intake→research, research→planning, planning→execution, execution→self_review)

**Files modified/created:**
- `src/schemas/adapters.ts` (system_prompt)
- `src/schemas/orchestrator.ts` (AgentAction, ActionResult, PhaseToolConfig)
- `src/core/orchestrator/agent-loop.ts` (NEW — the core)
- `src/core/orchestrator/action-executor.ts` (NEW)
- `src/core/orchestrator/phase-tools.ts` (NEW)
- `src/core/orchestrator/index.ts` (wiring)
- `src/plugins/llm/claude-code-llm/claude-code-llm.ts` (--system-prompt)
- `test/helpers/test-orchestrator.ts` (updated for agent loop format)
- 3 new test files + additions to 3 existing test files

**Tests:** 1,442 total (was 1,437). 0 lint errors. 0 new typecheck errors.

### Phase 6.2: Prompt Engineering — Intake & Research — Session 053

**Status: DONE**

**Changes (implemented):**
1. Prompt template architecture in `src/core/orchestrator/prompts/` (6 modules)
2. `system.ts` — Shared system prompt (identity from persona.md, JSON protocol, per-phase guidance)
3. `context.ts` — Repo context assembly (README, tree, git log, branch, package.json; sync I/O, graceful degradation)
4. `format.ts` — Formatting utilities (action reference, output schema, prior phase output, knowledge)
5. `intake.ts` — Intake prompt builder (task brief, repo overview, knowledge, instructions, iteration budget, output schema)
6. `research.ts` — Research prompt builder (intake results injection, complexity-adaptive strategy)
7. Orchestrator `handleIntakeAnalysis` + `handleResearch` wired to prompt builders

**Files created:**
- `src/core/orchestrator/prompts/system.ts`
- `src/core/orchestrator/prompts/context.ts`
- `src/core/orchestrator/prompts/format.ts`
- `src/core/orchestrator/prompts/intake.ts`
- `src/core/orchestrator/prompts/research.ts`
- `src/core/orchestrator/prompts/index.ts`
- 5 test files (60 tests)

**Files modified:**
- `src/core/orchestrator/index.ts` (wiring)

**Tests:** 1,502 total (was 1,442). 0 lint errors. 0 type errors.

### Phase 6.3: Prompt Engineering — Planning & Execution

**Estimated scope:** Large

**Changes:**
1. `planning.ts` — Research findings as context, actionable plan output
2. `execution.ts` — Plan as context, test-fix iteration instructions
3. Wire research → planning → execution context flow
4. Workspace integration (all tool work in worktree)

**Files:**
- `src/core/orchestrator/prompts/planning.ts`
- `src/core/orchestrator/prompts/execution.ts`
- `src/core/orchestrator/index.ts`

**Manual test:** Simple task → plan → code → tests pass → commit. Real repo.

### Phase 6.4: Prompt Engineering — Review, Demo & Integration

**Estimated scope:** Medium

**Changes:**
1. `self-review.ts` — Read own diff, quality gates, loopback logic
2. `demo-prep.ts` — PR description, Draft PR creation
3. `integration.ts` — Child verification, integration tests
4. Quality gate: needs_work → loop back to execution

**Files:**
- `src/core/orchestrator/prompts/self-review.ts`
- `src/core/orchestrator/prompts/demo-prep.ts`
- `src/core/orchestrator/prompts/integration.ts`
- `src/core/orchestrator/index.ts`

**Manual test:** Full pipeline end-to-end. Inspect PR quality.

### Phase 6.5: Communication & Feedback Loop

**Estimated scope:** Medium-Large

**Changes:**
1. Telegram `receive` capability (grammy long-polling)
2. Message routing in Daemon
3. Blocked → question → response → unblock
4. PR feedback → rework loop
5. Enhanced query handler

**Files:**
- `src/plugins/communication/telegram-comm/telegram-comm.ts`
- `src/core/daemon/query-handler.ts`
- `src/core/daemon/index.ts`
- `src/core/orchestrator/index.ts`

**Manual test:** Block task, send question via Telegram, respond, task unblocks.

### Phase 6.6: Decomposition & Multi-Task

**Estimated scope:** Medium

**Changes:**
1. Planning detects large tasks → decomposition plan
2. Orchestrator creates child tasks
3. Parent → Active.Supervising
4. Integration merges child results

**Files:**
- `src/core/orchestrator/index.ts`

**Manual test:** Large task → decomposes → children execute → parent integrates.

### Phase 6.7: End-to-End Manual Testing

**Estimated scope:** Variable

**Test all 5 user flows:**
1. Happy path (Issue → PR)
2. Mid-task interaction (Block → question → response)
3. Feedback loop (PR review → rework)
4. Decomposition (Large task → children → integration)
5. Status query ("What's the status?")

**Deliverables:** Bug fixes, prompt refinements, cost analysis, edge case catalog.

### Phase 6.8: Hardening & OSS Prep

**Estimated scope:** Ongoing

- Context budgeting and token optimization
- Error recovery improvements
- CI pipeline setup
- Documentation updates
- Enum constants refactor
- Cost optimization
- README and docs polish

---

## Progress Tracking

Update this section as phases complete:

| Phase | Status | Session | Tests After | Notes |
|-------|--------|---------|------------|-------|
| 6.0 | DONE | 051 | 1437 | Assessment, gaps, decisions (D137-D142) |
| 6.1 | DONE | 052 | 1442 | Agent loop engine, D143 (Engineer owns the loop) |
| 6.2 | DONE | 053 | 1502 | Prompt template architecture, system/intake/research prompts, context assembly |
| 6.3 | DONE | 054 | 1540 | Planning + execution prompts, planning formatter, full context flow wired |
| 6.4 | Not started | — | — | — |
| 6.5 | Not started | — | — | — |
| 6.6 | Not started | — | — | — |
| 6.7 | Not started | — | — | — |
| 6.8 | Not started | — | — | — |
