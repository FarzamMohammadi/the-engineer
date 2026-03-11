# Layer 6 Decisions

Decisions made during Layer 6 (Refinement & Intelligence). Continues the decision log from `../decisions.md`.

---

## D137: LLM Interaction — Hybrid Adapter+Plugin Architecture

**Context:** The Orchestrator needs to interact with LLMs for tool-heavy phases (research, execution, self-review). The architecture must support multiple access methods.

**Decision:** Hybrid approach via the existing adapter+plugin pattern. Support both CLI-based (subscription) and API-based (direct billing) providers.

**Starting point:** Claude CLI in agentic mode (`claude -p` with `--allowedTools`, `--system-prompt`, `--output-format json`). Farzam has a Claude subscription.

**Architecture:**
- `LLMAdapter` base class evolves to support agentic interactions
- `ClaudeCodeLLMPlugin` refactored for agentic mode
- Future plugins: `AnthropicAPILLMPlugin`, `AgentSDKLLMPlugin`, `OpenRouterLLMPlugin`
- Orchestrator is provider-agnostic — works through adapter contract

**Rationale:** This is what great OSS is about. Any provider, any access method. Users with subscriptions use CLI. Users with API keys use API. The architecture doesn't care.

**Rejected alternatives:**
- API-only: Excludes subscription users
- CLI-only: Excludes API users, less control
- Hard-coded provider: Against three-tier philosophy

---

## D138: Sub-Agent Architecture — Claude Code Pattern

**Context:** Each Orchestrator phase needs specialized behavior. How should this be structured?

**Decision:** Full sub-agent architecture inspired by Claude Code's internal pattern. One main Orchestrator + phase-specific sub-agents.

**Pattern:**
```
Orchestrator (main agent — lifecycle, checkpoints, state)
  ├─ Intake Analyzer (read-only, fast)
  ├─ Researcher (read + search, medium)
  ├─ Planner (read-only, capable model)
  ├─ Executor (read/write/bash, high turns)
  ├─ Self-Reviewer (read + diff, medium)
  ├─ Demo Prep (read/write for PR)
  └─ Integration Handler (read/bash/git)
```

Each sub-agent:
- Has its own system prompt (phase-specific)
- Uses only necessary tools (principle of least privilege)
- Returns structured JSON (matches PhaseOutput schemas)
- Tool restrictions map to the existing Permission Table

**Rationale:** Mirrors how Claude Code works internally — proven pattern. Separates concerns. Each phase gets focused context rather than bloated everything-context. Tool restrictions enforce the state machine's permission model at the LLM level.

**Rejected alternatives:**
- Single agent per phase (simpler but less capable)
- Sub-agents only for research+review (half measure)

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
