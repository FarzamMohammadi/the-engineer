# Layer 6 Gap Analysis

Detailed analysis of gaps between "infrastructure works" and "actually works as an engineer." Ordered by priority.

---

## Gap 1: LLM Interaction Model (CRITICAL)

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

## Gap 2: Prompt Engineering (CRITICAL)

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

## Gap 3: Tool Use & Agent Loop (CRITICAL)

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

## Gap 4: Phase Output Flow (HIGH)

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

## Gap 5: Workspace Integration (HIGH)

**Current:** WorkspaceManager creates worktrees. Orchestrator calls `getWorktreePath()` once. Not meaningfully used.

**Target:** All phase work happens within the task's worktree. LLM reads from and writes to worktree. All tools confined to worktree path.

**What needs to change:**
1. Pass worktree path as `cwd` for all tool invocations
2. Research reads files from worktree (not just any path)
3. Execution writes code to worktree
4. Self-review reads diff within worktree
5. BashTool already enforces workspace confinement — leverage this

**Blocked by:** Gap 1 (tool invocations need worktree context)

**Phase:** 6.1 (infrastructure), 6.2-6.4 (per-phase usage)

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

## Gap 8: Demo Artifacts (LOWER)

**Current:** demo_prep asks for "artifacts" in output but nothing creates them.

**Target:** Backend: describe changes + test evidence. Frontend: screenshots. TUI for interactive demos.

**What needs to change:**
1. Demo-prep creates PR description from execution output
2. Opens Draft PR via GitHostingAdapter
3. Attaches relevant evidence (test results, screenshots if applicable)

**Blocked by:** Gap 4 (demo-prep needs execution output)

**Phase:** 6.4

---

## Additional Gaps (Not in Priority 8, but Noted)

### Query Handler Intelligence
- Current: 3 keyword types (status, progress, cost)
- Target: LLM-powered query understanding, rich responses
- Phase: 6.5 or later

### Cost Optimization
- Current: Token counts 0 from CLI (upstream #11917)
- Target: Real cost tracking, context budgeting
- Phase: 6.8

### Loopback Logic
- Current: Self-review can return "needs_work" but no loop back to execution
- Target: Quality gate triggers automatic rework
- Phase: 6.4

### PR Feedback Loop
- Current: `task.feedback_received` event re-queues task
- Target: PR comments feed back to Orchestrator, trigger targeted rework
- Phase: 6.5
