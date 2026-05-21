# OpenClaw — Comparative Analysis

**Project:** [OpenClaw](https://github.com/openclaw/openclaw) (open-source, 250k+ GitHub stars)
**Analyzed:** 2026-03-10
**Purpose:** Understand where The Engineer stands relative to OpenClaw on architecture, technology, and design.

---

## 1. What OpenClaw Is

OpenClaw is a **personal AI assistant platform** — a long-running Gateway daemon (Node.js) that connects through 15+ messaging channels (WhatsApp, Telegram, Discord, Slack, Signal, iMessage, etc.) and executes tasks autonomously with full system access. It originated as a personal assistant project (formerly Moltbot/Clawdbot) and grew into the fastest-growing open-source AI project (250k+ stars).

OpenClaw is NOT a software engineering agent. It's a general-purpose assistant that can do coding as one of many capabilities. Its architecture reflects this: it's built around messaging, sessions, and user interaction — not around task lifecycle, PR pipelines, or engineering judgment.

### Architecture

**Hub-and-spoke Gateway pattern:**

```
Messaging Channels ──→ Gateway (HTTP/WS, localhost:18789) ──→ Agent Runtime ──→ LLM
   WhatsApp                  │                                      │
   Telegram              Session routing                      Tool execution
   Discord               Lane Queue                          Memory search
   Slack                  Multi-agent binding                 Skill loading
   Signal                 Plugin loading
   iMessage               ...
```

**Four-layer runtime stack:**

| Layer | What It Does |
|-------|-------------|
| **Model** | LLM invocation with provider fallback chains (Claude, GPT, Gemini, local) |
| **Memory** | Working (context window) + short-term (session transcripts, JSONL) + long-term (Markdown + vector search) + episodic (audit logs) |
| **Tools** | Discoverable, type-safe tools under least-privilege policies (exec, file I/O, browser, messaging, nodes) |
| **Orchestrator** | State management, context budget allocation, execution flow, lane queue |

### Core Components

| Component | What It Does |
|-----------|-------------|
| **Gateway** | Central daemon. WebSocket API, session routing, multi-agent binding, plugin loading. Single Node.js process. |
| **Lane Queue** | Serial-first execution. Routes messages by session key → global lanes. Default 1 concurrent per lane. Modes: steer, followup, collect, interrupt. |
| **Agent Runtime** | Per-session: assembles context (history + memory + workspace + tool schemas + skill instructions), invokes LLM, executes tool calls, persists transcripts. |
| **Memory System** | Hybrid vector (70%) + BM25 keyword (30%) search. Markdown files as source of truth. SQLite index. Daily append-only logs. Temporal decay with 30-day half-life. MMR for diversity. |
| **Workspace** | File-based identity: SOUL.md (persona), AGENTS.md (guidelines), TOOLS.md (tool conventions), USER.md (user profile). Config-as-code, versionable, portable. |
| **Skills** | Extensibility layer. SKILL.md (YAML frontmatter + instructions). ClawHub registry (2,857+ skills). Workspace → managed → bundled → plugin precedence. |
| **Lobster** | Deterministic workflow engine (YAML/JSON pipelines). Multi-step tool sequences as single operation. Approval gates, resume tokens, retry + error handling. Separate from LLM-driven execution. |

### Tech Stack

| Component | Choice |
|-----------|--------|
| Language | TypeScript (strict, ESM-only) |
| Runtime | Node.js 22 LTS |
| Package Manager | pnpm (monorepo workspaces) |
| Bundler | tsdown |
| Linting | oxlint + oxfmt |
| Validation | TypeBox schemas |
| Testing | Vitest (unit/e2e/live, 6+ configs) |
| Database | SQLite (memory index, `node:sqlite` experimental) |
| HTTP | Express 5 + WebSocket |
| Messaging | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js |
| Vector Search | Local GGUF, OpenAI, Gemini, Voyage, Mistral, Ollama embeddings |
| Workflow Engine | Lobster (YAML/JSON pipelines) |

### State Model

OpenClaw's state model is **session-based**, not task-based:

- Messages arrive → routed to session by peer/channel binding
- Lane Queue guarantees one active agent turn per session
- ReAct loop: context assembly → LLM → tool execution → loop → persist transcript
- No formal state machine. Sessions start, run turns, and end.
- Multi-turn via continuation within session, not lifecycle transitions.

### Safety Model

**Personal assistant deployment** — single trusted operator per Gateway. Not designed for hostile multi-user isolation.

Three permission gates:
1. **Agent-level tools** — allow/deny lists per agent
2. **Sandbox-level filter** — tools.sandbox.tools.allow
3. **Network sandbox** — Docker isolation (non-root, read-only root FS, all caps removed, resource limits)

**Profiles:** minimal, coding, messaging, full — preset tool access levels.

**No structural safety.** There is no state machine that prohibits actions based on lifecycle phase. If a tool is in the allow list, it can be called at any time. Safety is configuration-based, not architectural.

### Cost Model

**No native hard cap.** OpenClaw lacks built-in spend limits. Requires:
- Provider-level monthly spend caps (external)
- LiteLLM proxy with budget limits (external)
- Custom skill that disables gateway if spend exceeded (workaround)

Token optimization is sophisticated: prompt caching (80-90% cost reduction), file truncation (20k char/file, 150k total), on-demand skill loading, compaction. But there's no system-level gate that blocks execution when budget is exceeded.

---

## 2. Direct Comparison

### Fundamental Identity

| | OpenClaw | The Engineer |
|-|----------|-------------|
| **What it is** | General-purpose personal AI assistant | Autonomous software engineering agent |
| **Core metaphor** | Butler with full house access | Engineer with judgment and safety constraints |
| **Interaction model** | User sends messages, agent responds | Agent receives tasks, works autonomously, delivers PRs |
| **Intelligence location** | LLM + skills (agent follows instructions) | Orchestrator (7-phase pipeline with structured reasoning, loopbacks, decomposition) |
| **Session model** | Message → turn → response | Task → intake → research → plan → execute → self-review → demo → integrate |

OpenClaw is a **reactive assistant** — it waits for messages and responds. The Engineer is a **proactive agent** — it receives a task and drives it to completion through a structured pipeline, making judgment calls about when to ask questions, when to research more, when to loop back.

### Architecture

| Dimension | OpenClaw | The Engineer |
|-----------|----------|-------------|
| **Core pattern** | Hub-and-spoke Gateway (HTTP/WS server) | Hybrid OS kernel + Event Bus + task-as-truth |
| **Components** | ~7 (Gateway, Lane Queue, Agent Runtime, Memory, Workspace, Skills, Lobster) | 9 Core + 5 Adapter types + Plugin ecosystem |
| **Execution model** | ReAct loop (LLM → tool → loop) | Seven-phase pipeline with structured IR between phases |
| **State management** | Session-based, no formal state machine | 7 states + sub-states, 23 transitions, permission table |
| **Event system** | In-process promises, hooks for plugins | Core Event Bus: 30 typed events, persistent, replayable |
| **Persistence** | JSONL transcripts + Markdown memory files | SQLite: events, tasks, sessions, journal, checkpoints, knowledge |
| **Multi-agent** | Multiple isolated agents per Gateway (binding system) | Task decomposition: parent-child hierarchy with dependency DAG |

### Plugin & Extensibility

| Dimension | OpenClaw | The Engineer |
|-----------|----------|-------------|
| **Plugin discovery** | Scan workspace packages for `openclaw.extensions` in package.json | Registry reads `engineer.plugin.yaml` manifests |
| **Plugin contracts** | Implicit in API surface | Explicit: 5 typed adapter contracts with capability gates |
| **Skills** | SKILL.md files (YAML frontmatter + instructions), ClawHub registry (2,857+) | Not applicable — The Engineer's intelligence is in the Orchestrator, not in skill files |
| **SDK boundary** | `openclaw/plugin-sdk` re-export | `src/adapters/index.ts` curated re-export (adopted from OpenClaw) |
| **Plugin lifecycle** | Hot-loading via jiti, config watchers | Five-phase: discovery → registration → initialization → health monitoring → shutdown |
| **Health management** | No formal plugin health model | Health state machine per plugin |

**Key difference:** OpenClaw's extensibility is through **skills** (instruction files that guide the LLM) and **plugins** (code modules with implicit contracts). The Engineer's extensibility is through **adapters** (typed contracts with capability negotiation) and **plugins** (implementations of those contracts with formal lifecycle).

OpenClaw's skill system is more accessible — drop a Markdown file and the agent learns new behavior. But it's also less rigorous — there's no contract enforcement, no capability gates, no health monitoring. The Engineer's approach trades accessibility for safety and reliability.

### Safety & Authorization

| Dimension | OpenClaw | The Engineer |
|-----------|----------|-------------|
| **Authorization model** | Tool allow/deny lists per agent + sandbox profiles | Two-gate Action Pipeline: Gate 1 (state machine legality) → Gate 2 (Safety Layer policy) |
| **Structural safety** | None — any allowed tool callable at any time | State machine as security boundary — actions structurally impossible in wrong phases |
| **Cost gating** | None built-in — external caps only | Safety Layer blocks actions when budget exceeded |
| **Scope boundaries** | Workspace path confinement | Per-repo: allowed file patterns, forbidden paths, autonomy rules |
| **Sandboxing** | Docker (non-root, read-only FS, no caps, resource limits) | Process safety rules (explicit bash, signal forwarding, workspace confinement, env allowlist, output limits) — adopted from OpenClaw |
| **Prompt injection** | Acknowledged as unsolved; mitigate via access control + sandboxing + strong models | Not primary concern (no untrusted user input — tasks come from authenticated triggers) |

**The fundamental safety difference:** OpenClaw's safety is **configuration-based** — you set allow/deny lists and hope the LLM respects boundaries. The Engineer's safety is **architectural** — the state machine makes certain actions structurally impossible regardless of what the LLM wants to do. Gate 1 doesn't ask the LLM to not write code during review — it makes write actions return an error before they reach execution.

### Memory & Learning

| Dimension | OpenClaw | The Engineer |
|-----------|----------|-------------|
| **Memory architecture** | Four-tier: working (context), short-term (session JSONL), long-term (Markdown + vector), episodic (audit) | Persistent: events (audit), journal (observability), checkpoints (resumption), knowledge (learning) |
| **Search** | Hybrid vector 70% + BM25 30%, MMR diversity, temporal decay (30-day half-life) | Event replay, query by task/time range (structured, not semantic) |
| **Memory format** | Markdown files on disk, human-readable, diff-friendly | SQLite tables, structured, queryable |
| **Cross-session learning** | MEMORY.md (curated durable memory, private sessions only) + daily logs | Knowledge entries: patterns, conventions, domain knowledge — persisted in DB, queryable |
| **Memory maintenance** | Automatic flush before compaction (silent agentic turn) | Journal entries track what happened; knowledge entries capture learnings |

**OpenClaw's memory system is more sophisticated for retrieval.** Hybrid vector + BM25 search with temporal decay and MMR diversity is genuinely advanced. The Engineer's structured event/knowledge model is better for auditing and systematic learning, but lacks semantic search.

**Worth noting:** These solve different problems. OpenClaw needs to recall past conversations across diverse topics. The Engineer needs to track task state, audit decisions, and learn engineering patterns. Semantic search matters more for the former; structured queries matter more for the latter.

### Technology

| Dimension | OpenClaw | The Engineer |
|-----------|----------|-------------|
| **Language** | TypeScript (strict, ESM) | TypeScript (strict, ESM) |
| **Runtime** | Node.js 22 LTS | Node.js 22 LTS |
| **Package manager** | pnpm (monorepo workspaces) | pnpm (monorepo-ready) |
| **SQLite** | `node:sqlite` (experimental) | `better-sqlite3` (stable) |
| **Linting** | oxlint + oxfmt (two tools) | Biome (single tool, all rules) |
| **Validation** | TypeBox schemas | Zod schemas |
| **Config format** | JSON5 | YAML |
| **Bundler** | tsdown | tsdown (planned) |
| **Logging** | pino + pino-roll | pino + pino-roll (adopted from OpenClaw) |
| **CLI** | commander | commander (validated by OpenClaw) |
| **Testing** | Vitest (6+ configs, 70/55 thresholds) | Vitest (3-tier, 70/55 thresholds — adopted from OpenClaw) |

**Nearly identical tech stacks.** This is not coincidence — OpenClaw was explicitly reviewed during The Engineer's Layer 4 design (Session 23), and every foundation decision was validated against OpenClaw's production codebase. Where they differ:

**`node:sqlite` vs `better-sqlite3`:** OpenClaw uses the experimental `node:sqlite` API. We chose `better-sqlite3` for stability — it's battle-tested, synchronous (matches our architecture), and doesn't depend on Node.js experimental flags. OpenClaw's choice is forward-looking; ours is conservative. Both are valid.

**oxlint+oxfmt vs Biome:** OpenClaw uses two separate Rust-based tools. We chose Biome as a single tool that replaces both linter and formatter. Fewer moving parts, single config file. Our choice is simpler to maintain.

**TypeBox vs Zod:** OpenClaw uses TypeBox (JSON Schema compatible). We use Zod (TypeScript-first with runtime inference). Zod gives us `z.infer<typeof Schema>` — compile-time types from runtime schemas. This is critical for our 30 event types and 5 adapter contracts. TypeBox is lighter but doesn't provide the same TypeScript inference depth.

**JSON5 vs YAML:** OpenClaw uses JSON5 (JSON with comments and trailing commas). We chose YAML for deep nesting readability and multi-line strings (important for config files with descriptions and complex structures).

---

## 3. Architectural Analysis

### What OpenClaw Does Exceptionally Well

**1. Memory system.**
Hybrid vector + BM25 search is state-of-the-art for personal assistant recall. Temporal decay (30-day half-life) ensures recent context wins without losing old knowledge. MMR diversity prevents repetitive retrievals. Markdown as source of truth is elegant — human-readable, version-controllable, diff-friendly. The embedding cache prevents re-indexing unchanged content.

The Engineer's structured event/knowledge model is appropriate for its domain (engineering audit trails), but if we ever need semantic recall (e.g., "what approach did we use for similar problems?"), OpenClaw's hybrid search architecture is the reference implementation.

**2. Lane Queue system.**
Serial-first execution is a disciplined choice. One active turn per session guarantees isolation — every failure is contained, every log is linear, every transcript is replayable. The mode system (steer, followup, collect, interrupt) handles the real-world complexity of concurrent user messages without abandoning serial safety.

The Engineer's Event Bus + single-worker model achieves similar serial guarantees, but the Lane Queue's explicit mode handling for concurrent inbound messages is more developed.

**3. Workspace-as-identity pattern.**
SOUL.md, AGENTS.md, USER.md, TOOLS.md as file-based agent identity is powerful. The workspace IS the agent — portable, versionable, reproducible. Drop a workspace directory and you have a fully configured agent. No database migration, no config import, no setup wizard.

The Engineer's config system (`~/.engineer/config/`) is more structured and type-safe, but the workspace-as-identity pattern has an elegance that's worth studying for plugin configuration or per-repo agent personality.

**4. Lobster workflow engine.**
Separating deterministic work (sequencing, counting, routing) from LLM-driven work (reasoning, creating, analyzing) is the right architectural instinct. Lobster's YAML pipelines with approval gates, resume tokens, and retry handling give the system a deterministic backbone that doesn't depend on LLM reliability.

The Engineer's seven-phase Orchestrator pipeline is analogous but LLM-driven throughout. For the engineering domain this is appropriate (every phase requires judgment). But for operational tasks (deploy sequences, CI/CD orchestration), a Lobster-style deterministic engine would be valuable.

**5. Context budget management.**
OpenClaw's token budgeting is battle-tested: prompt caching (80-90% cost reduction), file truncation caps, on-demand skill loading, compaction with memory flush. The philosophy — "better context management routinely outperforms larger models with dumb prompting" — is validated by production usage.

The Engineer hasn't reached context management yet (Phase 11, Orchestrator), but OpenClaw's approach should inform how we manage LLM context windows.

**6. Multi-channel messaging at scale.**
15+ messaging channels, each with platform-specific retry logic, rate limiting, and formatting. This is genuine production infrastructure. The Engineer supports 2 channels (GitHub + Telegram) via adapter contracts — architecturally cleaner but orders of magnitude less battle-tested.

### What The Engineer Does Better

**1. State machine as security boundary.**
OpenClaw has no formal state machine. Any allowed tool can be called at any time during any session. The Engineer's 7-state machine with sub-states and permission tables makes certain actions structurally impossible in wrong phases. This is not a feature OpenClaw chose to skip — it's a category of safety that doesn't exist in OpenClaw's architecture.

In a personal assistant, this matters less — the user is present and can intervene. In an autonomous agent operating without supervision, structural safety is non-negotiable.

**2. Two-gate authorization pipeline.**
OpenClaw: tool allow/deny lists → if allowed, execute. One gate, configuration-only.
The Engineer: Gate 1 (state machine legality) → Gate 2 (policy enforcement) → execute. Two gates, one structural and one configurable.

The structural gate cannot be misconfigured. There is no config file that makes write actions possible during Review-Pending. This guarantee doesn't exist anywhere in OpenClaw.

**3. Persistent replayable event log.**
OpenClaw persists session transcripts as JSONL — good for replaying conversations. The Engineer persists every system event with ULID + sequence ordering — good for replaying the entire system's behavior, reconstructing state after crash, auditing decisions, and mining patterns.

OpenClaw's transcripts answer "what did the agent say?" The Engineer's event log answers "what did the system do and why?"

**4. Task decomposition with dependency DAG.**
OpenClaw handles one task per session. Multi-agent is multiple isolated agents on one Gateway — they don't coordinate, don't share knowledge, don't have dependency ordering.

The Engineer: parent tasks decompose into children with dependency DAG. Parent supervises (without consuming working slot). Children can share knowledge. This models how real engineering works — complex features decompose into subtasks.

**5. Explicit adapter contracts with capability gates.**
OpenClaw's plugin contracts are implicit in the API surface. You discover what methods exist by reading the source code.

The Engineer: 5 typed adapter contracts (TriggerAdapter, CommunicationAdapter, LLMAdapter, ToolAdapter, GitHostingAdapter) with abstract base classes, capability gates, and formal lifecycle. Plugin authors know exactly what to implement. Core knows exactly what to expect. Compile-time enforcement.

**6. Engineering-specific intelligence.**
OpenClaw is a general-purpose assistant that can do coding. The Engineer is an engineer that can only do engineering. The seven-phase pipeline (intake → research → planning → execution → self-review → demo-prep → integration) encodes engineering judgment: understand before coding, plan before executing, review before shipping, demo before merging.

OpenClaw's ReAct loop (LLM → tool → loop) is general-purpose. The Engineer's pipeline is domain-specific and opinionated about what good engineering looks like. This domain specificity is a strength — it means the system enforces engineering discipline even when the LLM might skip steps.

**7. Two-stage PR review.**
OpenClaw has no concept of code review pipeline. It writes code and (if configured) creates PRs.

The Engineer: Draft PR (demo gate: "did we build the right thing?") → Ready PR (code review: "did we build it right?"). Feedback at either stage loops back to Active.Working. This separates functional validation from code quality validation — a distinction every real engineering team makes.

**8. Cost gating (not just tracking).**
OpenClaw counts tokens but cannot stop spending. The Safety Layer blocks actions when budget is exceeded — per-task or cross-task, configurable response (block/warn/self-unblock). This is the difference between a gas gauge and a fuel cutoff valve.

---

## 4. Patterns Already Adopted

We already studied OpenClaw during Layer 4 design (Session 23) and adopted 6 high-priority patterns:

| Pattern | Decision | What We Took |
|---------|----------|-------------|
| Plugin manifest file | #102 | `engineer.plugin.yaml` — discovery without code loading |
| Multi-tier Vitest + forks | #119 | Three tiers, 70/55 thresholds, `pool: "forks"` globally |
| Plugin SDK re-export | #105 | `src/adapters/index.ts` as curated boundary |
| `doctor` health checks | #116 | 10 check categories + pre-flight subset |
| Process safety rules | #108 | Explicit bash, signal forwarding, workspace confinement, env allowlist, output limits |
| Rolling file logging | #110 | pino + pino-roll, daily rotation, 500MB cap, 7-day retention |

Also validated: pnpm, tsdown, commander, Vitest config patterns, coverage pragmatism.

---

## 5. Patterns Worth Adopting (New)

These were not identified in the original Session 23 review but emerge from deeper analysis:

**1. Hybrid vector + keyword memory search.**
Not for v1, but when The Engineer's knowledge system matures, hybrid search (vector 70% + BM25 30%) with temporal decay and MMR diversity is the right approach for "what approach did we use for similar problems?" queries. OpenClaw's implementation is the reference.

**2. Context budget management.**
Prompt caching, file truncation caps, on-demand loading, compaction. The Engineer's Orchestrator (Phase 11) should design context management from the start, not bolt it on. OpenClaw's philosophy — "smarter prompting outperforms larger models" — is empirically validated.

**3. Deterministic workflow engine for operational tasks.**
Lobster separates deterministic sequencing from LLM reasoning. The Engineer's pipeline is all LLM-driven, which is right for engineering phases. But for operational side-tasks (deploy sequences, CI steps, test suites), a deterministic sub-engine would reduce cost and increase reliability.

**4. Interrupt/steer modes for inbound communication.**
OpenClaw's Lane Queue modes (steer into current turn, queue as followup, collect and coalesce, interrupt and restart) handle the real-world complexity of concurrent messages. The Engineer should define similar semantics for when a user sends feedback while the agent is mid-phase.

---

## 6. Where We Stand

### Honest Assessment

**The Engineer's architecture is more rigorous than OpenClaw's across every dimension that matters for autonomous engineering:** safety (structural vs. configuration), authorization (two-gate vs. one-gate), state management (formal machine vs. session-based), persistence (event log vs. transcripts), extensibility (typed contracts vs. implicit API), and engineering workflow (seven-phase pipeline vs. ReAct loop).

**OpenClaw is more mature in areas we haven't reached yet:** memory/retrieval, context management, multi-channel messaging at scale, and plugin ecosystem (2,857 skills). These are areas to learn from as implementation progresses, not reasons to change direction.

**The tech stacks are nearly identical** — same language, runtime, package manager, testing framework, bundler, logger, CLI framework. OpenClaw validated our foundation decisions. Where we differ (better-sqlite3, Biome, Zod, YAML), our choices are defensible and in some cases stronger.

**OpenClaw and The Engineer are architecturally complementary, not competing.** OpenClaw is a general-purpose assistant platform that happens to do coding. The Engineer is a purpose-built engineering system. OpenClaw's breadth (15+ channels, 2,857 skills, diverse tool categories) serves its general-purpose mission. The Engineer's depth (state machine security, two-gate authorization, seven-phase pipeline, task decomposition, PR review stages) serves engineering quality.

**Nothing in OpenClaw suggests we should change our architecture.** The patterns worth adopting are operational improvements (memory search, context management, interrupt modes) that layer onto existing architecture, not structural changes.

### What We're Doing Better

| Dimension | Why Ours Is Stronger |
|-----------|---------------------|
| Safety architecture | Structural (state machine prohibits) vs. configurable (allow/deny lists permit) |
| Authorization | Two-gate (structural + policy) vs. one-gate (tool permissions) |
| State management | 7 states, 23 transitions, permission table vs. no formal state machine |
| Event system | 30 typed events, persistent, replayable vs. in-process promises |
| Adapter contracts | 5 typed adapters with capability gates vs. implicit API surface |
| Task model | Hierarchical with dependency DAG vs. flat one-task-per-session |
| Engineering workflow | Seven-phase pipeline with structured IR vs. generic ReAct loop |
| PR pipeline | Two-stage (demo + code review) vs. none |
| Cost control | Safety Layer gate that blocks execution vs. no built-in cap |
| Type safety | Zod discriminated unions across 30 events + 5 adapters vs. TypeBox |

### What OpenClaw Does Better (That We Should Learn From)

| Dimension | What They Have | Our Status |
|-----------|---------------|------------|
| Memory retrieval | Hybrid vector + BM25, temporal decay, MMR | Structured queries only (event replay, knowledge table). Semantic search is future work. |
| Context management | Prompt caching, truncation, compaction, on-demand loading | Not yet designed (Phase 11). Should adopt their philosophy and techniques. |
| Messaging scale | 15+ channels, platform-specific retry/formatting | 2 channels via adapters. Architecture supports more; implementation is minimal. |
| Plugin ecosystem | 2,857+ skills, ClawHub registry, hot-loading | No plugins built yet (Phase 14). Architecture is more rigorous; ecosystem will take time. |
| Deterministic workflows | Lobster (YAML pipelines, approval gates, resume tokens) | No deterministic sub-engine. All phases are LLM-driven. Consider for operational tasks. |
| Interrupt handling | Lane Queue modes (steer, followup, collect, interrupt) | Not yet designed. Should define semantics for mid-phase user communication. |
