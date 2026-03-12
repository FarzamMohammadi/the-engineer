# Layer 6 Phase Plan

8 phases to take The Engineer from "infrastructure complete" to "best OSS engineer the world has ever seen."

Each phase: build → manual test → refine → next phase.

---

## Phase Overview

| Phase | Name | Goal | Depends On | Status |
|-------|------|------|------------|--------|
| 6.0 | Assessment & Smoke Test | Baseline, docs, decisions | — | DONE |
| 6.1 | Agent Loop Engine | Orchestrator-owned agent loop | 6.0 | DONE |
| 6.2 | Intake & Research Prompts | First two phases intelligent | 6.1 | DONE |
| 6.3 | Planning & Execution Prompts | Core work phases functional | 6.2 | DONE |
| 6.4 | Review, Demo & Integration | Complete prompt pipeline | 6.3 | DONE |
| 6.7 | E2E Manual Testing (Round 1) | Validate pipeline infrastructure | 6.4 | DONE |
| 6.5 | Workspace Integration + Wiring | Real repo work, PR creation, notifications | 6.7 | DONE |
| 6.6 | Communication Wiring | GitHub issue comments, completion/error/cost notifications | 6.5 | DONE |
| 6.7b | Decomposition & Multi-Task | Task splitting for large tasks | 6.6 | Not started |
| 6.8 | Hardening, Observability & OSS Prep | Agent loop logs, cost tracking, polish | 6.6 | Not started |

**Order change note (Phase 6.7):** Originally 6.5 (Communication) and 6.6 (Decomposition) came before E2E testing. We pulled 6.7 forward to validate the infrastructure before adding more features. The E2E test revealed that the pipeline infrastructure is solid, but **workspace integration** is the critical missing piece — not communication or decomposition. Phase 6.5 is now redefined as "Workspace Integration + Wiring" to address the #1 gap before anything else.

**Order change note (Phase 6.6):** Originally "Decomposition & Multi-Task". Redefined as "Communication Wiring" — smaller scope, immediately testable in E2E, completes the notification story. Decomposition pushed to 6.7b.

---

## Dependency Graph

```
6.0 (Assessment) ✅
  └─ 6.1 (Agent Loop) ✅
       └─ 6.2 (Intake + Research Prompts) ✅
            └─ 6.3 (Planning + Execution Prompts) ✅
                 └─ 6.4 (Review + Demo + Integration Prompts) ✅
                      └─ 6.7 (E2E Round 1 — infrastructure validation) ✅
                           └─ 6.5 (Workspace Integration + Wiring) ✅
                                └─ 6.6 (Communication Wiring) ✅
                                     ├─ 6.7b (Decomposition)
                                     └─ 6.8 (Hardening & OSS Prep)
```

---

## Phase Details

### Phase 6.0: Assessment & Smoke Test — Session 051

**Status: DONE**

- [x] Full codebase assessment (3 parallel exploration agents)
- [x] Gap analysis (8 gaps identified and prioritized)
- [x] Design decisions (D137-D142)
- [x] Layer 6 directory structure created
- [x] Assessment, gaps, decisions, phase-plan docs written

### Phase 6.1: Agent Loop Engine — Session 052

**Status: DONE**

**Decision D143:** The Engineer owns the agent loop. LLMs are inference-only (prompt in, JSON out). Provider-agnostic by design.

**Delivered:**
- `agent-loop.ts` — Pure-function loop: prompt → LLM → parse JSON → validate → execute → repeat
- `action-executor.ts` — Maps AgentAction to real operations within worktree
- `phase-tools.ts` — Per-phase tool restrictions (D141 enforcement)
- `AgentAction` discriminated union schema (7 action types)
- All 7 Orchestrator phase handlers wired through `runPhaseWithAgentLoop()`
- Prior phase output injection

**Tests:** 1,442 total (was 1,437).

### Phase 6.2: Prompt Engineering — Intake & Research — Session 053

**Status: DONE**

**Delivered:**
- Prompt template architecture in `src/core/orchestrator/prompts/` (6 modules)
- `system.ts` — Shared system prompt (identity, JSON protocol, per-phase guidance)
- `context.ts` — Repo context assembly (README, tree, git log, branch, package.json; graceful degradation)
- `format.ts` — Formatting utilities (action reference, output schema, prior phase output, knowledge)
- `intake.ts` — Intake prompt builder
- `research.ts` — Research prompt builder with complexity-adaptive strategy

**Tests:** 1,502 total (was 1,442).

### Phase 6.3: Prompt Engineering — Planning & Execution — Session 054

**Status: DONE**

**Delivered:**
- `planning.ts` — 10-section prompt with complexity-adaptive strategy
- `execution.ts` — 10-section prompt with test-fix loop guidance
- Planning formatter in `format.ts`
- Full context flow wired: intake→research→planning→execution

**Tests:** 1,540 total (was 1,502).

### Phase 6.4: Prompt Engineering — Review, Demo & Integration — Session 055

**Status: DONE**

**Delivered:**
- `self-review.ts` — 10-section, loopback-aware prompt
- `demo-prep.ts` — 9-section PR narrative prompt
- `integration.ts` — 9-section prompt with child summaries
- Self-review quality gate loopback (needs_work → execution, max 3)
- 3 phase formatters in `format.ts`
- **Full 7-phase prompt pipeline complete.**

**Tests:** 1,599 total (was 1,540).

### Phase 6.7: E2E Manual Testing (Round 1) — Session 056

**Status: DONE**

First live run against a real GitHub repo with real Claude CLI calls. Validated pipeline infrastructure end-to-end. Found and fixed critical bugs. Identified remaining gaps.

**Test setup:**
- Repo: `FarzamMohammadi/learnaholic-demo` (issue #1 with `engineer` label)
- Home: `/tmp/engineer-e2e-test/`
- LLM: Claude CLI (`claude-sonnet-4-20250514`)
- All 6 plugins initialized (github-trigger, github-comm, github-hosting, telegram-comm, claude-code-llm, bash-tool)

**Pipeline result:** All 7 phases completed successfully (intake→research→planning→execution→self_review→demo_prep→integration). Session ended with `completed` status. ~18 minutes total.

**Bugs found & fixed (3 code fixes):**
1. **Trigger ignores unassigned issues** — `assignee: "*"` in GitHub API means "only assigned issues". Removed filter from `pollIssues()`. (`github-trigger.ts`)
2. **Nested Claude session blocked** — `CLAUDECODE` env var inherited by child process. Added `cleanEnv()` method to strip it. (`claude-code-llm.ts`)
3. **`--max-tokens` not a CLI option** — Claude CLI doesn't support this flag. Removed from `doComplete()` args. (`claude-code-llm.ts`)

**Bugs found & fixed (1 daemon logic fix):**
4. **Task stays `active.working` after completion** — `handleTaskCompletion()` logged "completed" but never called `requestTransition()`. Fixed to transition to `completed`/`queued` on completion/preemption. (`daemon/index.ts`)

**Bugs found & fixed (from prior session, confirmed working):**
5. Bootstrap not loading plugins — `loadBuiltinPlugins()` added (Session 055)
6. E2E test format mismatch — `makeResponse()` wraps in `{"action":"done"}` (Session 055)

**Critical gaps confirmed (not yet fixed — Phase 6.5 scope):**
- **No workspace/worktree created** — LLM runs with zero repo context, can't read/write files
- **No PR created** — No branch exists, so integration phase can't create a PR
- **No Telegram notifications** — Orchestrator doesn't call comm plugins at milestones
- **Cost tracking non-functional** — CLI returns `cost_usd: null`, `tokens_in: 0`
- **Single-turn agent loop** — LLM returns "done" immediately with no repo context to explore
- **No state label sync** — GitHub issue labels not updated

**What passed (infrastructure):**
- GitHub trigger polling → finds issue → creates task ✅
- State machine: intake → queued → active.working ✅
- 7-phase pipeline runs sequentially ✅
- Agent loop: prompt → LLM → parse JSON → next phase ✅
- Checkpoints at each phase transition ✅
- Journal entries logged ✅
- Session lifecycle (start → complete) ✅
- Cost events emitted (7 total, values null) ✅
- Daemon tick loop (5s interval) ✅
- Plugin initialization (all 6) ✅
- Config loading with env var resolution ✅

**Additional documentation:**
- Agent loop observability gap documented
- Cost tracking gap updated with E2E findings
- Local dev dashboard idea documented in `future-considerations.md`

### Phase 6.5: Workspace Integration + Wiring — Sessions 057-058

**Status: DONE**

**Goal:** Make The Engineer do real work. This is where the system goes from "pipeline works" to "actually writes code."

**Critical changes (must-have for working system):**
1. **Workspace creation** — Orchestrator calls `workspaceManager.createWorkspace(taskId, repoUrl, baseBranch)` before first phase that needs repo access. Wire repo URL from trigger event → dispatch → Orchestrator.
2. **Real tool execution in worktree** — Agent loop passes worktree path to action executor. File reads/writes happen in the correct repo directory.
3. **Multi-turn agent loop** — With real repo context, LLM will use read_file/write_file/run_command actions before returning "done". The agent loop already supports this — it just needs a real workspace.
4. **PR creation** — Integration phase calls `GitHostingAdapter.createPR()` with the branch from the workspace.
5. **Task state completion** — Daemon transitions task to `completed` or `review_pending` after pipeline finishes. (Fixed in 6.7)

**Important changes (high value):**
6. **Telegram notifications** — Emit `comm.message_sent` events at task pickup, completion, errors. Wire through Orchestrator or Daemon.
7. **GitHub state sync** — Update issue labels at state transitions. Already wired in Daemon event handler.
8. **GitHub issue comments** — Post status updates on the issue being worked on.

**Files to modify:**
- `src/core/orchestrator/index.ts` — workspace creation, PR creation calls
- `src/core/daemon/index.ts` — repo URL in dispatch, notification wiring
- `src/core/workspace-manager/index.ts` — may need adjustments for real repos
- `src/plugins/git-hosting/github-hosting/` — PR creation integration test

**Manual test:** Same issue on learnaholic-demo. This time: real worktree, real file changes, real PR, Telegram notification. The full loop.

### Phase 6.6: Communication Wiring — Session 059

**Status: DONE**

Dual-channel notifications: personal (Telegram via PeopleDirectory) + public (GitHub issue comments via `commentOnIssue`). Key milestones only — pickup, PR created, completion/error.

**Delivered:**
- `commentOnSourceIssue()` in Orchestrator — extracts `task.external_ref`, routes to comm plugin with `issue_management` capability
- `commentOnTaskIssue()` in Daemon — same pattern using `taskEngine.getTask(taskId)`
- `sendCompletionNotification()` — milestone-type notification to owner on task completion
- `sendTaskErrorNotification()` — alert-type notification to owner on task error
- `sendCostLimitNotification()` — alert-type notification to owner on cost limit
- Wired at 5 trigger points: Orchestrator (pickup + PR creation), Daemon (completion + error + cost limit)
- All notifications fire-and-forget — errors silently caught, never block pipeline

**Tests:** 1,647 total (was 1,625). 22 new tests across 2 test files.

### Phase 6.7b: Decomposition & Multi-Task

**Status: Not started**

**Changes:**
1. Planning detects large tasks → decomposition plan
2. Orchestrator creates child tasks
3. Parent → Active.Supervising
4. Integration merges child results

**Manual test:** Large task → decomposes → children execute → parent integrates.

### Phase 6.8: Hardening, Observability & OSS Prep

**Status: Not started**

**Scope (informed by 6.7 findings):**
- **Agent loop observability** — `agent_iterations` table or structured journal entries for debugging LLM back-and-forth
- **Cost tracking** — Dual-mode: API adapters report real cost, CLI adapters report call count + error signals
- **Local dev dashboard** — Docker Compose with Datasette + Grafana (see `future-considerations.md`)
- **Context budgeting** — Token optimization, prompt size management
- **Error recovery** — Retry logic, graceful degradation
- **CI pipeline** — GitHub Actions workflow
- **Build script** — Auto-copy migrations after `pnpm build` (currently manual)
- **Enum constants refactor** — `TaskState.queued` instead of `"queued"`
- **Documentation** — README, setup guide, contributing guide

---

## Progress Tracking

| Phase | Status | Session | Tests After | Notes |
|-------|--------|---------|------------|-------|
| 6.0 | DONE | 051 | 1437 | Assessment, gaps, decisions (D137-D142) |
| 6.1 | DONE | 052 | 1442 | Agent loop engine, D143 (Engineer owns the loop) |
| 6.2 | DONE | 053 | 1502 | Prompt template architecture, system/intake/research prompts |
| 6.3 | DONE | 054 | 1540 | Planning + execution prompts, full context flow wired |
| 6.4 | DONE | 055 | 1599 | Self-review + demo-prep + integration prompts, quality gate loopback |
| 6.7 | DONE | 056 | 1599 | E2E round 1: pipeline infra validated, 4 bugs fixed, workspace gap confirmed |
| 6.5 | DONE | 057-058 | 1625 | Workspace integration, PR creation, token sanitization, D147-D154 |
| 6.6 | DONE | 059 | 1647 | Communication wiring: GitHub issue comments + completion/error/cost notifications |
| 6.7b | Not started | — | — | Decomposition & multi-task |
| 6.8 | Not started | — | — | Hardening, observability, OSS prep |
