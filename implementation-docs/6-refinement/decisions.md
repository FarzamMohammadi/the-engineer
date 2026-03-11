# Layer 6 Decisions

Decisions made during Layer 6 (Refinement & Intelligence). Continues the decision log from `../decisions.md`.

---

## D137: LLM Interaction — Hybrid Adapter+Plugin Architecture

**Context:** The Orchestrator needs to interact with LLMs for tool-heavy phases (research, execution, self-review). The architecture must support multiple access methods.

**Decision:** Hybrid approach via the existing adapter+plugin pattern. Support both CLI-based (subscription) and API-based (direct billing) providers. **All providers are inference-only** — prompt in, structured JSON out. No provider-specific agentic features.

**Starting point:** Claude CLI via `claude --print --output-format json` (single-shot inference). Farzam has a Claude subscription.

**Architecture:**
- `LLMAdapter` base class provides inference contract (`complete()` with `system_prompt`)
- `ClaudeCodeLLMPlugin` handles CLI invocation with `--system-prompt` flag
- Future plugins: `AnthropicAPILLMPlugin`, `AgentSDKLLMPlugin`, `OpenRouterLLMPlugin`
- Orchestrator is provider-agnostic — works through adapter contract
- **All agentic behavior (tool use, iteration, context management) is owned by the Orchestrator, not the LLM plugin** (see D143)

**Rationale:** This is what great OSS is about. Any provider, any access method. Users with subscriptions use CLI. Users with API keys use API. The architecture doesn't care.

**Rejected alternatives:**
- API-only: Excludes subscription users
- CLI-only: Excludes API users, less control
- Hard-coded provider: Against three-tier philosophy

**Evolution note (D143):** Originally considered using Claude CLI's agentic mode (`-p` with `--allowedTools`). Replaced by D143 — The Engineer owns the loop, LLMs provide inference only.

---

## D138: Orchestrator Agent Loop with Phase-Specific Configurations

**Context:** Each Orchestrator phase needs specialized behavior. How should this be structured?

**Decision:** Orchestrator-owned agent loop with per-phase tool restrictions. The Orchestrator IS the agent — it runs the loop: build prompt → call LLM → parse action → execute tool → feed result back → repeat until done.

**Pattern:**
```
Orchestrator Agent Loop (per phase)
  1. Build phase-specific prompt (system + context + history)
  2. Call LLM (single-shot inference — ANY provider)
  3. Parse structured AgentAction from response JSON
  4. If action == "done" → validate against phase schema → return
  5. Validate action against phase's allowed_actions
  6. Execute action (file I/O, search, commands) within worktree
  7. Append action+result to conversation history
  8. Go to step 1 (until max_iterations)
```

Each phase run:
- Has its own system prompt (phase-specific)
- Uses only necessary actions (principle of least privilege, per D141)
- Returns structured JSON validated against PhaseOutput schemas
- Tool restrictions enforced by the agent loop, not the LLM provider

**Rationale:** The Engineer IS the agent. LLM providers are interchangeable inference tools. This is provider-agnostic by design — any LLM that can output JSON works (API, CLI, local models). No dependency on any provider's agentic features (Claude's `--allowedTools`, OpenAI's function calling, etc.). The Orchestrator controls everything: tool selection, context assembly, iteration limits, error recovery.

**Evolution note:** Originally D138 described "sub-agent architecture inspired by Claude Code pattern" where each phase would delegate to the LLM's built-in agentic mode. D143 fundamentally changed this — The Engineer doesn't delegate agency, it IS the agent. The concept of phase-specific configurations survived, but the mechanism changed from "tell the LLM what tools it can use" to "the Orchestrator decides which actions to allow and executes them itself."

**Rejected alternatives:**
- Delegate to LLM's agentic mode: Provider-specific, less control, breaks with non-agentic providers
- Single call per phase: Can't handle complex tasks requiring multi-step file operations
- External agent framework: Adds dependency, loses control over the core loop

---

## D139: Iterative Development with Manual Testing

**Context:** How should Layer 6 be built?

**Decision:** Phase by phase with manual testing between each phase. Build 6.1 → test → build 6.2 → test → etc.

**Rationale:** Matches "thoroughness over speed" philosophy. Each phase builds on tested foundation. Catches fundamental issues early. Farzam can provide feedback at each step.

---

## D140: Smoke Test Baseline

**Context:** Should we establish baseline behavior before making changes?

**Decision:** Yes. Run the system as-is against a real repo before any code changes. Document what happens at each pipeline stage.

**Rationale:** Gives concrete "before" to compare against "after". May reveal unexpected issues in the boot/polling/dispatch flow that code review didn't catch.

---

## D141: Per-Phase Tool Restrictions

**Context:** How should tool access be controlled per phase?

**Decision:** Map tool restrictions to the existing Permission Table (Gate 1 action classes → allowed Claude Code tools).

| Phase | Action Classes | Claude Code Tools | Max Turns |
|-------|---------------|-------------------|-----------|
| intake_analysis | read | Read, Glob | 5 |
| research | read, communicate | Read, Glob, Grep, Bash(read-only) | 15 |
| planning | read, communicate, task-manage | Read, Glob, Grep | 10 |
| execution | read, write, test, git-local | Read, Write, Edit, Bash, Glob, Grep | 25 |
| self_review | read, write, test | Read, Glob, Grep, Bash(tests) | 15 |
| demo_prep | read, git-remote, communicate | Read, Write, Bash | 10 |
| integration | read, write, test, git-local, git-remote, merge | Read, Write, Edit, Bash, Glob, Grep | 20 |

**Rationale:** Principle of least privilege at the LLM level. Research can't write files. Execution can't merge PRs. Tool restrictions enforce the same boundaries as the Permission Table but from the LLM's perspective.

---

## D142: Prompt Template Architecture

**Context:** Where should prompts live?

**Decision:** Separate TypeScript files in `src/core/orchestrator/prompts/`, one per phase. Each exports a function that takes context and returns the prompt string. System prompts are separate from user prompts.

**Rationale:** Prompts are the most frequently iterated artifact in Layer 6. Separate files make them easy to find, modify, and review. TypeScript (not markdown) so they can use type-safe context injection.

---

## D143: The Engineer Owns the Agent Loop — LLMs Are Inference-Only

**Context:** Phase 6.1 required deciding how The Engineer interacts with LLMs for multi-step work. The original plan (D137/D138) assumed delegating agentic behavior to the LLM provider — e.g., Claude CLI's `--allowedTools` mode, where the CLI runs its own tool-use loop. This approach has a fundamental flaw: it's provider-specific. Claude CLI has agentic mode, but most API providers don't. Local models definitely don't. Building on a provider-specific feature violates the core three-tier philosophy.

**The insight:** The Engineer IS the agent. LLM providers (API, CLI, local — any vendor) are inference tools. Prompt in, structured JSON response out. That's it. The Orchestrator owns the entire agentic loop: build context → call LLM → parse structured action → execute tool → feed result back → repeat.

**Decision:** The Orchestrator runs a pure-function agent loop (`runAgentLoop()`) for each phase. LLM calls are single-shot inference. All agentic behavior — tool selection, action execution, context assembly, iteration management, error recovery — lives in The Engineer's code, not in any provider's runtime.

**Architecture:**

```
┌─────────────────────────────────────────────────────┐
│ Orchestrator (owns the loop)                        │
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │
│  │ Agent Loop   │  │ Action      │  │ Phase Tool │  │
│  │ (agent-      │  │ Executor    │  │ Config     │  │
│  │  loop.ts)    │  │ (action-    │  │ (phase-    │  │
│  │              │  │  executor   │  │  tools.ts) │  │
│  │ Prompt build │  │  .ts)       │  │            │  │
│  │ → LLM call   │  │ File I/O   │  │ Allowed    │  │
│  │ → Parse JSON │  │ Search     │  │ actions    │  │
│  │ → Validate   │  │ Commands   │  │ per phase  │  │
│  │ → Execute    │  │ (worktree) │  │ Max iters  │  │
│  │ → Repeat     │  │            │  │            │  │
│  └──────┬───────┘  └────────────┘  └────────────┘  │
│         │                                           │
│         ▼ single-shot inference                     │
│  ┌─────────────────────────────────┐                │
│  │ LLM Adapter (any provider)     │                │
│  │ prompt + system_prompt → JSON   │                │
│  │                                 │                │
│  │ Claude CLI, Anthropic API,     │                │
│  │ OpenRouter, local models, etc. │                │
│  └─────────────────────────────────┘                │
└─────────────────────────────────────────────────────┘
```

**Key schemas:**

- `AgentAction` — discriminated union: `read_file | write_file | edit_file | search_files | search_content | run_command | done`. Universal JSON format any LLM can produce.
- `ActionResult` — `{ success, output, error? }` fed back as context.
- `PhaseToolConfig` — `{ allowed_actions, max_iterations, action_classes }` per phase.
- `CompletionRequest.system_prompt` — nullable field for provider-agnostic system prompts.

**Key modules:**

- `agent-loop.ts` — Pure function `runAgentLoop(config, callLlm, execAction)`. Dependency-injected for testability. Handles: prompt building with rolling history, robust JSON extraction (direct parse → code block → balanced brace), retry on parse failure, forced termination at iteration limit, cost accumulation.
- `action-executor.ts` — Maps `AgentAction` to real operations within worktree. File ops use Node `fs` directly; commands go through ToolAdapter via ActionPipeline (Gate 1 + Gate 2). Path traversal security boundary enforced.
- `phase-tools.ts` — Pure config mapping Phase → PhaseToolConfig (D141 enforcement).

**Why this wins:**
1. **Provider-agnostic**: Works with ANY LLM that can output JSON — Claude API, Claude CLI, OpenRouter, Ollama, anything.
2. **Full control**: The Engineer decides what tools are available, validates actions, manages context window, handles errors.
3. **Testable**: Agent loop is a pure function with injected dependencies. 45 new tests for loop + executor + config.
4. **Auditable**: Every action and result is recorded in the action history. Full trace of what the LLM decided and what happened.
5. **No vendor lock-in**: Switching LLM providers means swapping one plugin. The agent loop, tool configs, and action executor don't change.

**Rationale:** "We are the core, we are the engineer, we take care of it all from beginning to end. The LLM adapter is simply an inference tool." — Farzam. This is the most strategic decision for supporting all providers. Instead of building on Claude-specific features that other providers don't have, we build the universal agent loop once and use any LLM as a thinking engine.

**What this supersedes:**
- D137's reference to "agentic mode" and Claude CLI's `--allowedTools` — removed. CLI is now `--print --output-format json` (single-shot).
- D138's "sub-agent architecture inspired by Claude Code" — replaced. The Engineer doesn't mimic Claude Code's internal pattern; it IS its own agent with its own loop.

**Rejected alternatives:**
- Delegate to Claude CLI agentic mode (`-p --allowedTools`): Provider-specific, no control over iteration, can't use with API-only providers
- Use provider-specific function/tool calling: Each provider has different tool-call formats, creating adapter complexity
- No agent loop (single LLM call per phase): Can't handle tasks requiring file exploration, multi-step editing, test-fix cycles
