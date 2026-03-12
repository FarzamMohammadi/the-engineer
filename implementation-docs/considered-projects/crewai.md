# CrewAI — Comparative Analysis

**Project:** [CrewAI](https://github.com/crewAIInc/crewAI) (open-source, MIT, 45.8k GitHub stars)
**Analyzed:** 2026-03-11
**Purpose:** Understand where The Engineer stands relative to CrewAI on architecture, technology, and design.

---

## 1. What CrewAI Is

CrewAI is a **general-purpose multi-agent orchestration framework** — a Python library for building teams of AI agents that collaborate on tasks. You define agents with roles, goals, and tools, group them into "crews," and CrewAI orchestrates their execution through sequential or hierarchical processes. It was created by Joao Moura in October 2023, initially built on LangChain (fully removed as of v0.86.0), and now claims independence from other agent frameworks.

CrewAI is NOT an autonomous software engineering agent. It is a framework you import into your Python application to orchestrate LLM-powered agents. It has no domain-specific knowledge of software engineering — no git integration, no PR lifecycle, no code review pipeline, no worktrees, no test execution. It competes with LangGraph and AutoGen, not with Devin, SWE-agent, or The Engineer.

### Architecture

**Dual paradigm: Crews + Flows.**

```
                    ┌──────────────────────────────────┐
                    │           Flows Layer             │
                    │   Event-driven DAGs (@start,      │
                    │   @listen, @router decorators)     │
                    │   Typed state, persistence,        │
                    │   conditional routing              │
                    └──────────┬───────────────────────┘
                               │ invokes
                    ┌──────────▼───────────────────────┐
                    │           Crews Layer             │
                    │   Agent teams with role-based      │
                    │   collaboration. Sequential or     │
                    │   hierarchical process.            │
                    └──────────┬───────────────────────┘
                               │ uses
                    ┌──────────▼───────────────────────┐
                    │    Agents + Tasks + Tools          │
                    │   ReAct loop or native function    │
                    │   calling per agent. LLM-driven.   │
                    └───────────────────────────────────┘
```

**Crews** = autonomous collaboration (agents delegate, share context, adapt dynamically). Each agent runs a ReAct loop (think-act-observe) or native function calling loop, with forced termination at `max_iter` (default 20).

**Flows** = production scaffolding added later for deterministic orchestration. Event-driven decorators (`@start`, `@listen`, `@router`), typed state management, conditional branching, SQLite persistence for pause/resume. Flows invoke Crews as scoped execution units.

### Core Components

| Component | What It Does |
|-----------|-------------|
| **Agent** | Pydantic model with role/goal/backstory persona. Configurable LLM, tools, memory, delegation, guardrails, max_iter/max_rpm/max_execution_time. |
| **Task** | Description + expected_output, assigned agent, tools, context (prior tasks), output types (Pydantic/JSON/file), conditional execution, async support. |
| **Crew** | Orchestrates agents + tasks. Process types: sequential or hierarchical. Memory, knowledge, planning, training, testing, replay, streaming, callbacks. |
| **Flow** | DAG orchestrator with typed state, thread-safe mutations, racing groups, human feedback pause/resume, SQLite persistence, visualization. |
| **Tools** | `BaseTool` abstract class + `@tool` decorator shortcut. 30+ pre-built via `crewai-tools` package. Native MCP server support. |
| **Memory** | Unified system: short-term (conversation context), long-term (vector DB), entity (knowledge graph-style). LLM-powered encoding and retrieval. |
| **Knowledge** | RAG system — ingest documents (PDF, text, CSV), chunk, embed, retrieve. Pluggable sources. |

### Tech Stack

| Component | Choice |
|-----------|--------|
| Language | Python >=3.10, <3.14 |
| Validation | Pydantic v2 |
| Build | Hatchling |
| Package Manager | UV |
| LLM | OpenAI SDK (native) + Anthropic, Gemini, Azure, Bedrock + LiteLLM fallback (100+ providers) |
| Vector DB | ChromaDB (default), LanceDB, Qdrant, Pinecone, Weaviate |
| Embeddings | 15+ providers (OpenAI, Gemini, Voyage, Mistral, Ollama, etc.) |
| Telemetry | OpenTelemetry |
| CLI | Click |
| Testing | pytest (767 test files) |
| Dashboard | Textual TUI |
| Protocols | MCP (Model Context Protocol), A2A (Agent-to-Agent) |

### State Model

CrewAI has **no formal task state machine**. Tasks are run-to-completion or Future-based:

- Sequential process: tasks execute linearly, output of task N becomes context for task N+1
- Hierarchical process: a "manager" agent (LLM-driven) decides which agent-task to execute next
- Flows add proper typed state with persistence/resume, but this is at the workflow level, not the task level

There are no states, no transitions, no permission tables. An agent can call any tool it has access to at any point during execution. The only constraint is `max_iter` (iteration cap) and `max_execution_time` (timeout).

**Critical known issue (GitHub #4783):** The hierarchical process does not function as documented. The manager agent fails to effectively delegate to workers, executes tasks sequentially instead, produces incorrect reasoning, and causes high latency. Multiple sources confirm the built-in manager prompt gives erroneous results. The fix requires replacing the generic manager with a custom agent — defeating the purpose of built-in hierarchical orchestration.

### Safety Model

**Minimal.** Safety is an afterthought, not architectural:

- **Output guardrails:** Function-based or LLM-as-judge validation applied *after* task completion, with configurable retries. This validates outputs, not actions.
- **Rate limiting:** `max_rpm` per agent
- **Iteration caps:** `max_iter` (default 20, recommended 3-5 for production)
- **Execution timeouts:** `max_execution_time`
- **Docker sandbox:** Optional for code execution tasks
- **Hooks:** `@before_llm_call`, `@before_tool_use` — event listeners, not authorization gates

**What's missing:** No action authorization pipeline. No state-machine-based permission table. No cost budgets or spending gates. No workspace confinement beyond optional Docker. No autonomy levels. No approval workflows. The security module in the source code is mostly TODO stubs (fingerprinting for identity tracking).

### Cost Model

**No built-in cost tracking or gating.** This is a significant production risk:

- Token usage is counted at the crew level but not aggregated, budgeted, or gated
- External tools (AgentOps, LangTrace) needed for cost observability via `step_callback`
- An agent stuck in a validation loop burns thousands of tokens in seconds — "effectively a `while(true)` loop for API spending"
- Community recommendation: set `max_iter=3` or `5` — "better to fail fast than spend $10 on a single failed query"
- No equivalent of The Engineer's Safety Layer cost snapshots, per-task budgets, or spending gates

### Memory System

CrewAI's memory system is its most sophisticated subsystem (post-1.0 rewrite):

**Architecture:** Unified memory with LLM-analyzed encoding. When memories are stored, an LLM infers scope, category, and importance metadata.

**Retrieval:** Deep recall with multi-stage LLM-powered sub-queries. Composite scoring: 50% semantic similarity + 30% recency (30-day half-life) + 20% importance.

**Consolidation:** Memories above 0.85 similarity are merged automatically.

**Storage:** LanceDB default backend, pluggable to ChromaDB, Qdrant, Pinecone, Weaviate.

**Scoping:** `MemoryScope` and `MemorySlice` for scoped views (per-agent, per-crew, per-task).

**Context management:** 85% context window limit with auto-summarization when exceeded.

This is genuinely advanced for retrieval-augmented memory. The LLM-powered encoding and multi-stage recall are more sophisticated than simple vector similarity. However, the memory is optimized for conversational recall across diverse topics — not for engineering audit trails or structured state reconstruction.

### Enterprise Offering

CrewAI has a commercial tier (AMP Suite / CrewAI+):

- **Studio:** Visual editor for building crews
- **Tracing:** Execution observability
- **Deployment:** Cloud and on-prem
- **Enterprise features:** RBAC, SSO, SOC2, FedRAMP, VPC deployment
- **Pricing:** Free (50 executions/month), Pro ($25/month), Enterprise (custom)
- **Customers:** PwC, IBM, Capgemini (partnerships), NVIDIA

---

## 2. Direct Comparison

### Fundamental Identity

| | CrewAI | The Engineer |
|-|--------|-------------|
| **What it is** | General-purpose multi-agent orchestration framework | Autonomous software engineering agent |
| **Type** | Python library you import | Standalone daemon with CLI |
| **Core metaphor** | Team of role-playing specialists | Engineer with judgment and safety constraints |
| **Interaction model** | Developer writes Python code defining agents/tasks/crews | Agent receives tasks from triggers, works autonomously, delivers PRs |
| **Intelligence location** | LLM (agents are LLM personas with tools) | Orchestrator (7-phase pipeline with structured reasoning, loopbacks, decomposition) |
| **Domain knowledge** | None (general-purpose) | Deep software engineering (git, PRs, code review, testing, worktrees) |
| **Deployment** | Imported into your app | Always-running daemon (`engineer start/stop/status/doctor`) |
| **Session model** | Crew kickoff → agents run → outputs collected | Task → intake → research → plan → execute → self-review → demo → integrate |

CrewAI is a **toolkit** — you build domain-specific agents on top of it. The Engineer IS the agent. This is the fundamental categorical difference. CrewAI provides orchestration primitives (agents, tasks, crews). The Engineer provides engineering behavior (understand requirements, research codebase, plan changes, execute safely, self-review, demo, ship).

### Architecture

| Dimension | CrewAI | The Engineer |
|-----------|--------|-------------|
| **Core pattern** | Crews (agent teams) + Flows (event-driven DAGs) | Hybrid OS kernel + Event Bus + task-as-truth |
| **Components** | ~7 (Agent, Task, Crew, Flow, Tools, Memory, Knowledge) | 9 Core + 5 Adapter types + Plugin ecosystem |
| **Execution model** | ReAct loop per agent (LLM → tool → loop) | Seven-phase pipeline with structured IR between phases |
| **State management** | No formal state machine. Run-to-completion tasks. | 7 states + sub-states, 23 transitions, permission table |
| **Event system** | Hooks (`@before_llm_call`, etc.) — listeners, not bus | Core Event Bus: 30 typed events, persistent, replayable |
| **Persistence** | Optional SQLite (Flows only, state snapshots) | SQLite: events, tasks, sessions, journal, checkpoints, knowledge |
| **Multi-agent** | Crews of role-playing agents, delegation between them | Task decomposition: parent-child hierarchy with dependency DAG |
| **Agent-to-agent comms** | Delegation converts other agents into tools via function calling | Event Bus pub/sub + task context flow between phases |
| **Process types** | Sequential, Hierarchical (broken), Parallel | Single structured pipeline with loopbacks and decomposition |

### Plugin & Extensibility

| Dimension | CrewAI | The Engineer |
|-----------|--------|-------------|
| **Plugin system** | No formal plugin system | Registry with manifests, five-phase lifecycle, health state machine |
| **Extension points** | Subclass `BaseTool`, `BaseAgent`, `BaseLLM`; use decorators | 5 typed adapter contracts with capability gates |
| **Tool ecosystem** | 30+ pre-built tools in `crewai-tools`, MCP servers | Built-in (Bash, Claude Code LLM, GitHub, Telegram) + plugin architecture |
| **LLM providers** | 100+ via LiteLLM + 5 native (OpenAI, Anthropic, Gemini, Azure, Bedrock) | LLMAdapter contract — any provider via plugin (Claude Code LLM built) |
| **Custom agents** | `BaseAgent` + adapters for LangGraph/OpenAI Agents SDK | Not applicable — The Engineer IS the agent |
| **Protocol support** | MCP (tool servers), A2A (agent-to-agent) | Adapter contracts (typed, compile-time enforced) |
| **Health management** | None | Health state machine per plugin (healthy/unhealthy/failed) |

### Safety & Authorization

| Dimension | CrewAI | The Engineer |
|-----------|--------|-------------|
| **Authorization model** | None. Agents call any assigned tool at any time. | Two-gate Action Pipeline: Gate 1 (state legality) → Gate 2 (policy) |
| **Structural safety** | None — no state machine, no phase restrictions | State machine as security boundary — actions structurally impossible in wrong phases |
| **Output validation** | Guardrails (function-based or LLM-as-judge) after task completion | Not primary mechanism — safety is pre-execution, not post-execution |
| **Cost gating** | None — no built-in tracking, no spending limits | Safety Layer blocks actions when budget exceeded |
| **Scope boundaries** | Optional Docker sandbox for code execution | Per-repo: allowed file patterns, forbidden paths, autonomy rules |
| **Iteration limits** | `max_iter`, `max_rpm`, `max_execution_time` | Cooperative preemption, timeout policies, stuck detection |

### Memory & Learning

| Dimension | CrewAI | The Engineer |
|-----------|--------|-------------|
| **Memory architecture** | Three-scope: short-term, long-term (vector), entity | Persistent: events (audit), journal (observability), checkpoints (resumption), knowledge (learning) |
| **Encoding** | LLM-analyzed (scope, category, importance inference) | Structured (typed schemas, Zod validation) |
| **Search** | Composite: 50% semantic + 30% recency + 20% importance | Event replay, query by task/time range (structured, not semantic) |
| **Storage** | Vector DBs (LanceDB, ChromaDB, Qdrant, etc.) | SQLite tables, queryable |
| **Consolidation** | Automatic merge at 0.85 similarity | Knowledge entries with content-hash upsert and supersession |
| **Cross-session** | Long-term memory persists across crew executions | Knowledge entries + journal persist across task sessions |
| **Context management** | 85% window limit, auto-summarize | Prompt template architecture with context assembly (Phase 6.2) |

### Technology

| Dimension | CrewAI | The Engineer |
|-----------|--------|-------------|
| **Language** | Python | TypeScript |
| **Runtime** | CPython >=3.10 | Node.js 22 LTS |
| **Validation** | Pydantic v2 | Zod |
| **Database** | Vector DBs (ChromaDB, LanceDB) + optional SQLite | SQLite (better-sqlite3), WAL mode |
| **Testing** | pytest (767 files) | Vitest three-tier (1,502 tests) |
| **Config** | Python code + YAML | Multi-file YAML (~/.engineer/config/) |
| **CLI** | Click | Commander |
| **Logging** | OpenTelemetry | pino + pino-roll |
| **Package manager** | UV | pnpm |
| **Type safety** | Pydantic runtime + Python type hints | Zod runtime + TypeScript compile-time (discriminated unions, generics) |

---

## 3. Architectural Analysis

### What CrewAI Does Well

**1. Dual paradigm (Crews + Flows).**
Separating autonomous agent collaboration (Crews) from deterministic workflow orchestration (Flows) is the right architectural instinct. Crews handle the messy, LLM-driven work. Flows handle the predictable, state-driven scaffolding. You prototype with Crews, then layer Flows for production.

The Engineer's architecture is monolithic in comparison — the Orchestrator pipeline is both the deterministic scaffold and the LLM-driven reasoning layer. This is appropriate for The Engineer's domain (every phase requires engineering judgment), but the separation of "deterministic routing" from "intelligent execution" is worth studying.

**2. Memory system sophistication.**
CrewAI's unified memory with LLM-analyzed encoding is genuinely advanced. The composite scoring (50% semantic + 30% recency + 20% importance) with automatic consolidation above 0.85 similarity is more sophisticated than simple vector search. The LLM-powered sub-query decomposition for deep recall goes beyond what most agent frameworks offer.

The Engineer's structured event/knowledge model is better for auditing and systematic learning, but lacks semantic search. CrewAI's approach — especially the LLM-powered encoding that infers scope and importance — is the reference for when The Engineer's knowledge system matures.

**3. LLM provider breadth.**
100+ providers via LiteLLM + 5 native integrations is comprehensive. The factory pattern with model-string routing (`"openai/gpt-4"`, `"anthropic/claude-3"`) is ergonomic. Token tracking is aggregated at the crew level. Context window management (85% limit, auto-summarize) is practical.

The Engineer's LLMAdapter contract is architecturally cleaner (typed contract, plugin lifecycle, health monitoring), but CrewAI has more providers working today. The Engineer's approach is correct for v1 — build the contract right, add providers as plugins.

**4. MCP and A2A protocol support.**
Native support for Model Context Protocol (tool servers) and Google's Agent-to-Agent protocol shows forward-thinking interoperability. CrewAI agents can consume MCP servers as tool sources and communicate with external agents via A2A.

The Engineer doesn't need A2A (it IS the agent, it doesn't talk to peer agents), but MCP support for tool extensibility is worth considering as a future plugin type.

**5. Developer experience for prototyping.**
CrewAI's decorator-based API (`@agent`, `@task`, `@crew`) with Pydantic models makes it fast to prototype multi-agent workflows. The visual Studio editor (enterprise) and Textual TUI add developer tooling. The `crewai create crew` CLI scaffolds projects.

This is irrelevant for The Engineer's use case (we're not building a framework for others), but the ergonomics are well-designed for CrewAI's purpose.

### What The Engineer Does Better

**1. State machine as security boundary.**
CrewAI has no formal state machine. Any agent can call any tool at any time during execution. The only constraint is iteration caps. There is no concept of "this action is structurally impossible in this phase."

The Engineer's 7-state machine with sub-states and permission tables makes certain actions impossible in wrong phases — not policy-blocked, structurally prohibited. This is not a feature CrewAI chose to skip. It's a category of safety that doesn't exist in CrewAI's architecture. For a framework that orchestrates LLM-driven agents with tool access, this is a significant gap.

**2. Two-gate authorization pipeline.**
CrewAI: agents call tools → tools execute. One path, no gates.
The Engineer: Gate 1 (state machine legality) → Gate 2 (policy enforcement) → execute. Two gates, one structural and one configurable.

CrewAI's guardrails validate outputs *after* execution. The Engineer's Action Pipeline validates actions *before* execution. This is the difference between "we check if the result was good" and "we prevent the bad action from happening."

**3. Persistent replayable event log.**
CrewAI has no event system. Hooks (`@before_llm_call`) are listeners, not a persistent bus. There is no event replay, no state reconstruction from events, no audit trail. If a crew execution fails, debugging means reading logs — there's no structured replay of what happened and why.

The Engineer's Event Bus: 30 typed events, ULID + sequence ordering, SQLite persistence, replay for state reconstruction. Every system action is recorded before it happens. This answers "what did the system do and why?" — CrewAI cannot answer this question.

**4. Engineering-specific intelligence.**
CrewAI agents are role-playing personas — you write a backstory and the LLM pretends to be that role. The "intelligence" is whatever the LLM produces given the persona prompt. There is no structured reasoning pipeline, no phase-specific tool restrictions, no loopbacks based on quality assessment.

The Engineer's seven-phase pipeline (intake → research → planning → execution → self-review → demo-prep → integration) encodes engineering judgment structurally. Each phase has specific allowed actions, specific output formats, specific inputs from prior phases. The system enforces engineering discipline even when the LLM might skip steps. This is the difference between "tell the LLM to be an engineer" and "build a system that engineers."

**5. Task decomposition with dependency DAG.**
CrewAI handles multiple tasks within a crew execution, but these are linear (sequential) or LLM-delegated (hierarchical, documented as broken). There's no concept of task hierarchy, dependency ordering, or parent-child supervision.

The Engineer: parent tasks decompose into children with dependency DAG. Parent supervises without consuming a working slot. Children have full lifecycle. This models how real engineering works.

**6. Cost gating (not just tracking).**
CrewAI counts tokens at the crew level but cannot stop spending. The community's best advice is "set max_iter=3 and hope for the best." There is no budget, no spending gate, no configurable response to cost overruns.

The Engineer's Safety Layer: per-task and cross-task cost accumulators, configurable limits (block/warn/self-unblock), UTC window management (daily/monthly). This is the difference between a gas gauge and a fuel cutoff valve.

**7. Two-stage PR review.**
CrewAI has no concept of code review, PRs, or shipping. It produces outputs — what happens with those outputs is your problem.

The Engineer: Draft PR (demo gate: "did we build the right thing?") → Ready PR (code review: "did we build it right?"). Feedback at either stage loops back to Active.Working. This separates functional validation from code quality validation.

**8. Crash recovery and resumption.**
CrewAI's Flows add SQLite persistence for state snapshots, enabling pause/resume at the Flow level. But at the Crew level, there's no checkpoint-based resumption. If a crew execution crashes mid-task, it restarts from scratch.

The Engineer: checkpoint-based resumption within phases, session persistence across crashes, event replay for state reconstruction. The system can crash at any point and resume from the last checkpoint, not from the beginning.

**9. Explicit adapter contracts.**
CrewAI has no formal plugin contracts. Extension is via subclassing (`BaseTool`, `BaseAgent`, `BaseLLM`) with implicit API surfaces. You discover what methods exist by reading source code.

The Engineer: 5 typed adapter contracts with abstract base classes, capability gates, and formal lifecycle. Plugin authors know exactly what to implement. Core knows exactly what to expect. Compile-time enforcement.

---

## 4. Patterns Worth Studying

These are ideas from CrewAI worth noting — not necessarily adopting, but understanding:

**1. Flows as deterministic scaffolding.**
The separation of Flows (deterministic, event-driven, state-managed) from Crews (LLM-driven, autonomous) is architecturally clean. For The Engineer, the Orchestrator pipeline serves both roles. If operational tasks (deploy sequences, CI orchestration) ever need deterministic sub-workflows, a Flow-style decorator pattern is worth studying. This echoes OpenClaw's Lobster pattern — deterministic workflows alongside LLM-driven reasoning.

**2. LLM-powered memory encoding.**
Using an LLM to infer scope, category, and importance when storing memories is creative. It means retrieval quality isn't limited by embedding similarity alone — the LLM adds semantic metadata at write time that improves search at read time. Worth studying for The Engineer's knowledge system maturity.

**3. MCP as tool extensibility.**
Native MCP support means CrewAI agents can consume any MCP-compatible tool server. The Engineer's ToolAdapter contract is more rigorous (typed, capability-gated, health-monitored), but MCP compatibility as an additional tool source — perhaps a `McpToolPlugin` that bridges MCP servers into the ToolAdapter contract — would expand the tool ecosystem without architectural changes.

**4. Composite memory scoring.**
50% semantic + 30% recency + 20% importance is a well-calibrated scoring formula. The 30-day half-life for recency decay matches OpenClaw's approach. When The Engineer adds semantic search to its knowledge system, this scoring formula is a good starting point.

---

## 5. Where We Stand

### Honest Assessment

**CrewAI and The Engineer operate at fundamentally different levels of abstraction.** CrewAI is a framework for building multi-agent applications. The Engineer is an autonomous software engineering agent. CrewAI provides orchestration primitives. The Engineer provides engineering behavior. You could theoretically use CrewAI as one component inside a system like The Engineer (e.g., to orchestrate sub-agents within a phase), but it doesn't solve the same problem.

**The Engineer's architecture is categorically more rigorous.** State machine as security boundary, two-gate authorization, persistent event log, task decomposition, cost gating, two-stage PR review, checkpoint-based resumption — these are architectural capabilities that don't exist in CrewAI and cannot be added by importing a library. They require system-level design.

**CrewAI's memory system is more sophisticated than ours for semantic retrieval.** LLM-powered encoding, composite scoring, automatic consolidation — this is state-of-the-art for agent memory. The Engineer's structured event/knowledge model is better for auditing and systematic learning, but lacks semantic search. This is an area to learn from, not a reason to change direction.

**CrewAI's known architectural failures validate our approach.** The hierarchical delegation bug (#4783) — where the "manager" agent fails to actually manage — demonstrates the risk of delegating orchestration decisions to LLMs. The Engineer's approach (D143: The Engineer IS the agent, LLMs are inference-only, the Orchestrator owns the loop) avoids this class of failure entirely. We don't ask the LLM to decide what to do next — the pipeline structure determines it.

**CrewAI's cost management gap validates our Safety Layer.** The community's advice to "set max_iter=3 and hope" is exactly the problem our Safety Layer solves architecturally. Cost gating must be structural, not optional configuration.

**Nothing in CrewAI suggests we should change our architecture.** The patterns worth studying (Flows, LLM-powered memory encoding, MCP, composite scoring) are future enhancements that layer onto existing architecture. No fundamental revision needed.

### What We're Doing Better

| Dimension | Why Ours Is Stronger |
|-----------|---------------------|
| Safety architecture | Structural (state machine prohibits) vs. none (agents call any tool anytime) |
| Authorization | Two-gate (structural + policy) vs. none (tools execute directly) |
| State management | 7 states, 23 transitions, permission table vs. no formal state machine |
| Event system | 30 typed events, persistent, replayable vs. hooks (listeners, not persistent) |
| Adapter contracts | 5 typed adapters with capability gates vs. subclass-based with implicit API |
| Task model | Hierarchical with dependency DAG vs. linear or broken hierarchical |
| Engineering workflow | Seven-phase pipeline with structured IR vs. ReAct loop with role-playing |
| PR pipeline | Two-stage (demo + code review) vs. none |
| Cost control | Safety Layer gate that blocks execution vs. no built-in tracking |
| Crash recovery | Checkpoint-based resumption + event replay vs. restart from scratch |
| Orchestration control | System owns the loop (D143) vs. LLM decides what to do (fails in practice) |

### What CrewAI Does Better (That We Should Learn From)

| Dimension | What They Have | Our Status |
|-----------|---------------|------------|
| Memory retrieval | LLM-powered encoding, composite scoring (50/30/20), consolidation | Structured queries only. Semantic search is future work. |
| LLM providers | 100+ via LiteLLM + 5 native | 1 built (Claude Code). Architecture supports more via LLMAdapter plugins. |
| Protocol support | MCP + A2A native | No protocol support. MCP as ToolAdapter bridge is worth considering. |
| Developer ecosystem | 30+ pre-built tools, visual Studio, CLI scaffolding | Focused on engineering domain. Not building a framework for others. |
| Context management | 85% window limit, auto-summarize | Prompt template architecture (Phase 6.2). Context budgeting is designed but not battle-tested. |

### The Fundamental Difference

CrewAI tells LLMs to role-play as specialists and hopes the collaboration produces good results. The Engineer encodes engineering judgment into system architecture and uses LLMs as inference tools within a structured pipeline.

CrewAI's approach fails when the LLM makes bad orchestration decisions (see: broken hierarchical delegation). The Engineer's approach (D143) makes orchestration decisions structurally — the LLM doesn't choose what phase comes next, the pipeline does. The LLM doesn't decide if an action is allowed, the state machine does. The LLM doesn't manage cost, the Safety Layer does.

This is not a difference of scope or maturity. It's a difference of philosophy: trust the LLM to orchestrate vs. trust the system to orchestrate and use the LLM for reasoning. Our architecture validates the latter.
