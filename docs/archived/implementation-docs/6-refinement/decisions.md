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

---

## D144: Workspace-First Pipeline — Orchestrator Creates Worktree Before Phases

**Context (Phase 6.7 E2E):** First live run revealed the Orchestrator never calls `workspaceManager.createWorkspace()`. All 7 phases run with `getWorktreePath()` returning `null`. The LLM gets no repo context and generates fictional responses. The agent loop returns "done" on the first iteration because there's nothing to explore.

**Decision:** The Orchestrator must create a workspace as the first step of `executeTask()`, before any phase handler runs. Workspace creation requires: repo URL (from trigger event metadata), base branch (from config or repo default), and task ID (for branch naming).

**What this means:**
1. `Dispatch` must include `repoUrl` — resolved from trigger event's `repo` field
2. Orchestrator calls `workspaceManager.createWorkspace(taskId, repoUrl, baseBranch)` at top of `executeTask()`
3. All phase handlers already call `getWorktreePath(taskId)` — they'll get a real path instead of null
4. `gatherRepoContextSafe()` already handles null gracefully — with a real path, prompts get README, tree, git log
5. Action executor already uses `worktreePath ?? "."` — with a real path, file operations work in the repo
6. Workspace cleanup at pipeline completion (success or failure)

**Rationale:** The workspace is the #1 gap. Everything else (agent loop, prompts, action executor, tool restrictions) is already built and working. This is the connection that makes it all real.

**Phase:** 6.5

---

## D145: CLI Environment Isolation for LLM Plugin

**Context (Phase 6.7 E2E):** Claude CLI refuses to run inside another Claude Code session — it detects the `CLAUDECODE` environment variable and exits with error. The Engineer's daemon inherits this env var when started from a Claude Code terminal.

**Decision:** `ClaudeCodeLLMPlugin.cleanEnv()` strips `CLAUDECODE` from the child process environment. Applied to both `spawnAndParse()` (LLM calls) and `doHealthCheck()` (version check).

**Rationale:** The Engineer must be able to run from any environment, including being started from within a Claude Code session. Environment isolation prevents provider-specific env vars from leaking into child processes.

**Phase:** 6.7 (implemented)

---

## D146: Dual-Mode Cost Tracking (CLI vs API)

**Context (Phase 6.7 E2E):** All `cost.incurred` events have `spend_usd: null`, `tokens_in: 0`, `tokens_out: 0`. The Claude CLI's `--output-format json` result event doesn't include `cost_usd` in practice. Token counts are also unavailable (upstream GitHub #11917).

**Decision:** Accept that CLI-based LLM providers can't report cost data. Design dual-mode tracking:
- **API adapters:** Report real cost per call (`spend_usd`, `tokens_in`, `tokens_out`)
- **CLI adapters:** Report call count + error signals (rate limit detection, error rate)

For CLI adapters, Safety Layer cost limits should be based on call count thresholds rather than dollar amounts. Rate limits and errors detected via CLI exit codes and error messages.

**Rationale:** CLI providers (subscription-based) don't expose per-call billing. Trying to estimate cost from token counts that are 0 is futile. Better to track what we can measure (calls, errors) and defer real cost tracking to API adapters.

**Phase:** 6.8 (implementation)

---

## D147: Clone-on-Demand for Workspaces

**Context (Phase 6.5):** WorkspaceManager creates worktrees via `git worktree add`, but needs a local clone of the target repo first. The clone may or may not already exist from a previous task.

**Decision:** `WorkspaceManager.createWorkspace()` clones the target repo on first use if the clone directory doesn't exist. Accepts `cloneUrl` parameter. Idempotent — skips if already cloned. After clone, resets the remote URL to the unauthenticated form (token only used transiently during clone, per D151).

**Rationale:** On-demand cloning means no manual setup step. Idempotent design means multiple tasks targeting the same repo don't conflict. Token is never persisted in git config.

**Phase:** 6.5

---

## D148: Task clone_url Field + Transient Auth Injection

**Context (Phase 6.5):** Tasks need to reference the target repo for workspace creation. The clone URL must include authentication for private repos, but storing tokens in the database is a security risk.

**Decision:** Tasks store a `clone_url TEXT` field in SQLite (the HTTPS URL without credentials). Authentication is injected transiently into HTTPS URLs (`https://git:{token}@`) by the `injectAuth()` function at operation time. Token is read from an env var specified in workspace config (`git_token_env`), never persisted to disk or git config.

**Rationale:** Separates "where is the repo" (persisted) from "how to authenticate" (ephemeral). The env var indirection means different deployments can use different token sources.

**Phase:** 6.5

---

## D149: Deterministic Commit + Draft PR After Demo Prep

**Context (Phase 6.5):** After the LLM completes the demo_prep phase, any code changes need to be committed, pushed, and presented as a draft PR. The LLM (Claude CLI in `--print --dangerously-skip-permissions` mode) may have already committed changes internally during the execution phase.

**Decision:** After demo_prep phase completion, the Orchestrator runs a deterministic commit pipeline: `git add -A` → check for staged changes → `git commit` if changes exist → check `git rev-list --count origin/{base}..HEAD` for ahead-of-base commits (covers Claude CLI internal commits) → push → create draft PR via GitHostingAdapter. The ahead-of-base check was a critical Session 057 bug fix — without it, Claude CLI's internal commits were silently dropped.

**Rationale:** Deterministic commits ensure nothing is lost. The rev-list check handles the case where the LLM already committed internally, making the Orchestrator's commit a no-op but still requiring push/PR.

**Phase:** 6.5

---

## D150: Push via Explicit Authenticated URL

**Context (Phase 6.5):** `git push` needs authentication for private repos. The standard approach of storing credentials in `.git/config` or git credential helpers persists sensitive data.

**Decision:** `WorkspaceManager.pushBranch()` pushes to an explicit `https://git:{token}@` URL rather than a git remote name. The token is injected at call time and discarded after the command completes.

**Rationale:** The token never appears in `.git/config`, credential storage, or any persisted state. Each push is self-contained — the URL is constructed, used, and forgotten.

**Phase:** 6.5

---

## D151: Token Injection Lifecycle (Never Persisted)

**Context (Phase 6.5):** Multiple git operations (clone, push) need authentication. The token lifecycle must be carefully managed to prevent leaks.

**Decision:** Tokens follow a strict lifecycle: read from environment variable → inject into URL → execute single git command → discard. After clone, the remote URL is immediately reset to the unauthenticated form. The token never appears in: git config, remote URLs on disk, environment passed to the LLM, or database records.

**Rationale:** Defense in depth for credential security. Even if the process crashes mid-operation, the token only exists in the process memory of the git command. Combined with D154 (sanitization at chokepoints), token exposure risk is minimized.

**Phase:** 6.5

---

## D152: Milestone Notifications via PeopleDirectory

**Context (Phase 6.5):** The Orchestrator should notify the task owner at key milestones (task pickup, PR creation) but shouldn't have hard-coded notification logic.

**Decision:** `notifyMilestone()` resolves the task owner via PeopleDirectory, then dispatches fire-and-forget messages to matching comm plugins. Plugin matching uses channel name convention: contact's `plugin_id` maps to `{channel}-comm` in the Registry. Failures are logged and swallowed — notifications are best-effort.

**Rationale:** PeopleDirectory owns "who to notify", Registry owns "how to send". Orchestrator just says "send this message to the owner". Fire-and-forget because notification failures shouldn't block task execution.

**Phase:** 6.5

---

## D153: Workspace Cleanup Policy

**Context (Phase 6.5):** After task completion, the worktree consumes disk space but the branch may be needed for the open PR. After task error, the workspace may be needed for debugging or resume.

**Decision:** On task completion: remove the worktree, preserve the branch (PR may still be open). On task error: preserve both worktree and branch (for potential resume via checkpoint). Cleanup is idempotent and failure-tolerant — if the worktree is already gone, no error.

**Rationale:** Disk space is a real concern for long-running daemons handling many tasks. Branches are cheap (just refs). Preserving failed workspaces enables the resume-from-checkpoint pattern (Protocol P9).

**Phase:** 6.5

---

## D154: Token Sanitization at Chokepoints

**Context (Phase 6.5):** Session 057 discovered that a `git push` failure writes the full authenticated URL (including GITHUB_TOKEN) into journal entries via `logPrStepFailure()`. Multiple other leak paths exist: BashToolPlugin stdout/stderr, agent loop history fed back to LLM, console log output.

**Decision:** Rather than sanitizing at every potential leak source, apply `sanitizeSecrets()` at three chokepoints:
1. **SessionMemory.addJournalEntry()** — sanitize `summary`, `detail`, `errorDetail` before DB insert
2. **Agent loop `appendHistoryEntry()`** — sanitize `output` and `error` before appending to LLM context
3. **Agent loop `executeAndLog()`** — sanitize error strings in console log calls

The `sanitizeSecrets()` function (in `src/utils/sanitize.ts`) redacts URL-embedded tokens (`https://git:{token}@`) via regex and replaces known env var values (GITHUB_TOKEN, TELEGRAM_BOT_TOKEN) when they appear in text (≥8 chars to avoid false positives).

**Rationale:** Defense-in-depth at chokepoints is more maintainable than point-of-origin sanitization. If a new leak path emerges (new tool, new error handler), the chokepoints catch it before the data reaches persistence or external systems. The three chokepoints cover: database persistence, LLM context (privacy), and console output (developer visibility).

**Phase:** 6.5

---

## D160: React + Vite for War Room v2

**Context (Phase 6.10 planning):** The dashboard is a 2,209-line single HTML file with vanilla JS and 5 global variables. It works, but can't scale to the "see everything in real-time" vision. Need a component-based foundation. Evaluated: React, Preact, Svelte, Vue, vanilla web components.

**Decision:** React + Vite. React for the largest ecosystem and contributor pool (critical for an open source project). Bundle size (40KB) is irrelevant for a localhost dashboard. Vite for industry-standard build tooling with fast HMR.

**Rejected alternatives:**
- Preact: 3KB smaller but smaller ecosystem, `preact/compat` has edge cases
- Svelte: Elegant but smaller contributor pool, custom syntax
- Vue: Good but React has more UI library support (shadcn, Recharts)
- Vanilla web components: Solves encapsulation but not reactivity

**Phase:** 6.10

---

## D161: Dashboard Stays in Same Package

**Context (Phase 6.10 planning):** Should the dashboard become a separate npm package or stay in `the-engineer`?

**Decision:** Stay in the same package, add `src/dashboard/ui/` as a Vite sub-project. Shared types (task states, phases, events) import directly from `src/schemas/`. Distribution stays simple — one `npm install`, one binary, `engineer start` launches dashboard automatically.

**Rationale:** Splitting would require a third shared-types package just for internal consumption. The dashboard is a build artifact served by the Hono backend, not a standalone deployable. Keeps the project monorepo-ready per existing Layer 4 decisions.

**Phase:** 6.10

---

## D162: shadcn/ui + Tailwind CSS + Lucide + Recharts

**Context (Phase 6.10 planning):** UI library choices for the dashboard rebuild.

**Decision:**
- **shadcn/ui** — Copy-paste components (Radix primitives). Not a dependency — source lives in our code, fully customizable. Gives us polished, accessible components without reinventing them.
- **Tailwind CSS** — shadcn/ui's foundation. War Room color palette maps to custom Tailwind v4 theme tokens.
- **Lucide React** — Icon library. Clean, consistent, extensive.
- **Recharts** — Charts and data visualization. Cost breakdowns, phase timelines, token usage.
- **@tanstack/react-table** — If sortable/filterable data tables are needed (traces, events).

**Rationale:** See D164. Ecosystem leverage over custom components.

**Phase:** 6.10

---

## D163: SSE for Real-Time Dashboard Updates

**Context (Phase 6.10 planning):** Current dashboard uses polling (2-10s intervals). The War Room vision needs real-time streaming.

**Decision:** Add Server-Sent Events (SSE) via a new `GET /api/stream` endpoint (Hono's `streamSSE`). Keep polling as fallback for aggregate data and when SSE disconnects. No WebSocket.

**Rationale:** SSE is unidirectional (dashboard only reads), HTTP-native (works through proxies, no upgrade handshake), and auto-reconnects (browser `EventSource` API). WebSocket is bidirectional — unnecessary complexity for a read-only dashboard.

**Phase:** 6.10

---

## D164: Ecosystem-First — Premade Components Over Custom

**Context (Phase 6.10 planning):** Farzam's strong preference: focus energy on data/functionality, not component creation.

**Decision:** Before building ANY component, search for an existing library solution first. Only build custom when the component is truly unique to our domain (e.g., agent loop visualization, phase pipeline, decomposition tree). Use shadcn/ui for all generic UI (cards, tables, badges, dialogs, tabs). Use Recharts for all charts. Use Lucide for all icons.

**Rationale:** Our value is in *what data we show* and *how we wire it*, not in crafting custom buttons, modals, and bar charts. Every premade component is time freed for the real differentiator — the War Room's intelligence and data richness.

**Phase:** 6.10

---

## D165: War Room Is a Two-Sided Effort — Backend Instrumentation + Frontend

**Context (Phase 6.10 planning):** The current dashboard shows what the system already records. The War Room vision requires far deeper observability — agent loop internals, LLM prompt/response pairs, decision points, decomposition trees.

**Decision:** Phase 6.10 is explicitly a two-sided effort: deep backend instrumentation AND modern frontend. The implementing agent must assess what data is already available in the ObservabilityStore and what new instrumentation is needed in the core (new events, richer traces, new tables/schemas). The frontend can only show what the backend emits.

**Target instrumentation areas:**
- Agent loop: every iteration's context → LLM call → parsed action → execution result
- LLM: full prompts (system + user), responses, token counts, latency, retries
- Decisions: complexity classification, strategy selection, loopback triggers, decomposition decisions
- Phases: detailed transition triggers, gate check results, phase outputs
- Cost: per-iteration, per-phase, cumulative with budget tracking
- Git: branch creation, commits, pushes, PR creation, review feedback
- Decomposition: parent-child trees, child progress, sibling coordination

**Rationale:** A beautiful frontend showing shallow data is a worse War Room than a basic frontend showing deep data. The observability depth is the differentiator.

**Phase:** 6.10
