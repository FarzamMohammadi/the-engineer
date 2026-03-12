# Layer 6 Gap Analysis

Detailed analysis of gaps between "infrastructure works" and "actually works as an engineer." Ordered by priority.

*Updated after Phase 6.7 E2E testing (Session 056).*

---

## Gap 1: LLM Interaction Model (CRITICAL) — RESOLVED (Phase 6.1)

**Current:** `ClaudeCodeLLMPlugin` uses `claude --print --output-format json`. Single-shot, non-interactive. No tools available to the LLM.

**Target:** Agentic mode where LLM can use tools (Read, Write, Edit, Bash, Glob, Grep) iteratively within each phase.

**What needs to change:**
1. `LLMAdapter` interface — add `system_prompt`, `allowed_tools`, `output_schema`, `max_turns` to `CompletionRequest`
2. `ClaudeCodeLLMPlugin` — switch from `--print` to `-p` with `--allowedTools`, `--system-prompt`, `--output-format json`
3. `CompletionResult` — may need richer output (tool calls made, files modified, etc.)
4. Orchestrator — build context and restrictions per phase, pass to LLM

**Blocked by:** Nothing. Can start immediately.

**Phase:** 6.1

---

## Gap 2: Prompt Engineering (CRITICAL) — RESOLVED (Phases 6.2-6.4)

**Current:** Simple string templates. "Research the codebase for this task. Return JSON with these fields: ..."

**Target:** Sophisticated prompts with system role, context injection, reasoning guidance, output schemas, and examples.

**What needs to change:**
1. Create `src/core/orchestrator/prompts/` with phase-specific prompt builders
2. Each prompt: system role + task context + prior phase outputs + instructions + output schema
3. Context assembly: gather relevant information per phase (README, git log, prior outputs)
4. System prompt: "You are The Engineer, an autonomous software engineering agent. You approach every task like a senior engineer would..."

**Blocked by:** Gap 1 (need agentic mode to test prompts with tools)

**Phase:** 6.2, 6.3, 6.4

---

## Gap 3: Tool Use & Agent Loop (CRITICAL) — RESOLVED (Phase 6.1)

**Current:** Execution phase calls `tool.execute("run", {}, ...)` once with empty args. Result ignored.

**Target:** LLM uses tools iteratively: read files → understand → write code → run tests → fix → iterate.

**What needs to change:**
1. Tool descriptions exposed to LLM via CompletionRequest
2. Multi-turn interaction (LLM calls tool → gets result → decides next action)
3. Phase-specific tool restrictions (from D141)
4. Side effect tracking (what files were modified, what commands ran)

**Blocked by:** Gap 1 (same change — agentic mode enables tool use)

**Phase:** 6.1

---

## Gap 4: Phase Output Flow (HIGH) — RESOLVED (Phases 6.2-6.4)

**Current:** `_priorOutputs` parameter is unused in every handler. Each phase starts from scratch.

**Target:** Each phase receives relevant context from prior phases.

**What needs to change:**
1. Remove underscore prefix from `priorOutputs` in all handlers
2. Intake output → Research prompt (complexity, ambiguities)
3. Research output → Planning prompt (files, patterns, conventions)
4. Planning output → Execution prompt (approach, file changes, test plan)
5. Execution output → Self-Review prompt (changed files, test results)
6. Self-Review output → Demo-Prep prompt (quality assessment)

**Blocked by:** Gap 2 (need real prompts to inject context into)

**Phase:** 6.2, 6.3, 6.4

---

## Gap 5: Workspace Integration (HIGH) — OPEN (Phase 6.5, #1 priority)

**Current:** WorkspaceManager has full worktree management (`createWorkspace`, `verifyWorkspace`, `cleanupWorkspace`). Orchestrator calls `getWorktreePath()` in every phase handler. But **`createWorkspace()` is never called** — so `getWorktreePath()` always returns `null`, and all prompts run without repo context.

**E2E finding (Phase 6.7):** All 7 phases completed with `workspace_ref: null`. LLM generated plausible but fictional responses. Agent loop returned "done" on first turn (nothing to explore). No files read, no code written, no tests run.

**Target:** All phase work happens within the task's worktree. LLM reads from and writes to worktree. All tools confined to worktree path.

**What needs to change:**
1. **Orchestrator must call `createWorkspace()`** before first phase that needs repo context (research at latest)
2. **Dispatch must include repo URL** — currently `TriggerEvent.repo` is a string like `owner/repo`, needs to be resolved to a clone URL
3. Action executor already handles worktree path — just needs a non-null value
4. `gatherRepoContextSafe()` already handles null gracefully — just needs a real path
5. BashTool already enforces workspace confinement — leverage this

**Blocked by:** Nothing. Phase 6.5 scope.

**Phase:** 6.5

---

## Gap 6: Communication Receive (MEDIUM)

**Current:** Both GitHub and Telegram are send-only. The Engineer can't hear responses.

**Target:** Bidirectional communication. Human responds → message routed → task unblocks or query answered.

**What needs to change:**
1. Add `receive` capability to TelegramCommPlugin (grammy long-polling)
2. People Directory auth check for inbound messages
3. Daemon message routing: task response vs query
4. Orchestrator interrupt handling (basic: between phases, not mid-phase)
5. Blocked → question → response → unblock flow

**Blocked by:** Design decisions on interrupt handling (see `future-considerations.md`)

**Phase:** 6.5

---

## Gap 7: Decomposition Logic (MEDIUM)

**Current:** Planning can output `decomposition_plan`. Nothing uses it.

**Target:** Large tasks automatically decompose into child tasks. Parent supervises. Children execute sequentially (single-core). Integration merges.

**What needs to change:**
1. After planning phase: check `decomposition_plan` field
2. If present: create child tasks via Task Engine
3. Transition parent to Active.Supervising (slot freed)
4. Daemon already has: child scheduling, children_all_done handler, integration dispatch
5. Integration phase: verify children, merge results

**Blocked by:** Gap 2-4 (planning phase must produce real decomposition plans)

**Phase:** 6.6

---

## Gap 8: Demo Artifacts (LOWER) — PARTIALLY RESOLVED (Phase 6.4 + 6.5)

**Current:** demo_prep prompt tells LLM to write PR description and create demo artifacts. Prompt is built (Phase 6.4). But no workspace means no real artifacts can be created.

**Target:** Backend: describe changes + test evidence. Frontend: screenshots (Puppeteer/Playwright). TUI for interactive demos.

**Resolved in 6.4:**
- PR description prompt with narrative structure
- demo_prep formatter for prior phase context

**Remaining (Phase 6.5+):**
1. PR creation via GitHostingAdapter (needs workspace/branch first)
2. Screenshot automation for UI changes (future)
3. Test output capture for evidence

**Phase:** 6.5 (PR creation), 6.8+ (screenshots)

---

## Additional Gaps (Not in Priority 8, but Noted)

### Query Handler Intelligence
- Current: 3 keyword types (status, progress, cost)
- Target: LLM-powered query understanding, rich responses
- Phase: 6.5 or later

### Cost Optimization
- Current: Token counts 0 from CLI (upstream #11917). `cost_usd` also returns `null` from CLI JSON output — the `claude --print --output-format json` result event does not include a `cost_usd` field in practice, despite documentation suggesting it.
- **E2E finding (Phase 6.7):** All `cost.incurred` events have `spend_usd: null`, `tokens_in: 0`, `tokens_out: 0`. Cost tracking is effectively non-functional with the CLI path.
- **Farzam's guidance:** CLI providers often don't expose cost data. Disable per-call cost tracking for CLI-based LLMs. Instead, detect rate limits and errors via status codes/error messages from the CLI. Reserve real cost tracking for direct API-based LLM adapters (future). For CLI, track call count + error rate instead of spend.
- Target: Dual-mode cost tracking — API adapters report real cost, CLI adapters report call count + error signals. Context budgeting for both.
- Phase: 6.8

### Loopback Logic — RESOLVED (Phase 6.4)
- Implemented: Self-review `needs_work`/`fundamental_issues` → loop back to execution with findings injected, max 3 loopbacks before human alert via `comm.message_sent`
- Phase: 6.4

### Agent Loop Observability
- Current: Agent loop actions are tracked in the `AgentLoopResult.actions` array but only stored transiently in the Orchestrator's `priorOutputs` map. No persistent record of individual LLM calls, prompts sent, actions requested, or tool results returned.
- **E2E finding (Phase 6.7):** Debugging what the LLM is doing requires `ps aux | grep claude` to see the raw prompt. No way to see the back-and-forth conversation, what actions the LLM requested, or what results it got back. For a 10-iteration agent loop, this makes debugging nearly impossible.
- Target: Rolling log of agent loop iterations per task. Each iteration records: prompt summary (first 500 chars), LLM response, parsed action, tool result, latency. Queryable by task_id and phase. Flushed/compacted after task completion (keep summary, drop full prompts). Could be a new `agent_iterations` table or structured journal entries with `type: "agent_iteration"`.
- Phase: 6.8

### PR Feedback Loop
- Current: `task.feedback_received` event re-queues task
- Target: PR comments feed back to Orchestrator, trigger targeted rework
- Phase: 6.5
