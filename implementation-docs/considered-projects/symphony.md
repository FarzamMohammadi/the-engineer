# Symphony — Comparative Analysis

**Project:** [Symphony](https://github.com/openai/symphony) (OpenAI, open-source, Apache 2.0)
**Analyzed:** 2026-03-10
**Purpose:** Understand where The Engineer stands relative to Symphony. Inform continue/revise/pivot decision.

---

## 1. What Symphony Is

Symphony is a **long-running orchestration daemon** that polls an issue tracker (Linear), creates isolated per-issue workspaces, and dispatches a coding agent (Codex app-server) to autonomously complete work. It is a scheduler/runner framework — not a full autonomous engineer.

### Architecture

Three abstraction layers:

| Layer | Responsibility |
|-------|---------------|
| **Policy** | `WORKFLOW.md` (Markdown + YAML front matter) — prompt body, team rules, agent behavior guidance. Lives in-repo, versioned with code. |
| **Configuration** | Typed getters from YAML front matter. Env var resolution, defaults, path normalization, dynamic reload without restart. |
| **Coordination** | Orchestrator polling loop, issue eligibility, concurrency control, exponential backoff retries, reconciliation, state transitions. |

Additional layers: Execution (workspace lifecycle, agent protocol), Integration (Linear GraphQL adapter), Observability (structured logs, terminal UI, optional Phoenix LiveView).

### Core Components

| Component | What It Does |
|-----------|-------------|
| **Orchestrator** | Central state machine. Polls tracker, dispatches work, manages concurrency, retries with backoff, reconciles stale runs. ~1500 lines of scheduling logic. |
| **Workspace Manager** | Maps issue identifiers to filesystem paths. Sanitizes paths, guards against symlink escapes, runs lifecycle hooks (after_create, before_run, after_run, before_remove). |
| **Agent Runner** | Creates workspace, renders prompt via Solid template engine, launches Codex app-server subprocess, streams updates, manages multi-turn sessions (up to max_turns). |
| **Codex AppServer** | JSON-RPC 2.0 client over stdio. Session/turn management, dynamic tool execution (linear_graphql), approval policies, token tracking. |
| **Linear Client** | GraphQL API. Fetches candidate issues, refreshes states for reconciliation, handles pagination. |
| **Config/Workflow Loader** | Parses YAML front matter + Markdown body. Ecto schema validation. File watching with hot-reload. |
| **Status Dashboard** | Terminal ANSI UI + optional Phoenix LiveView web UI. Token throughput, running issue status, JSON API. |

### Tech Stack

- **Elixir 1.19 / OTP 28** — BEAM for supervision of long-running processes
- **Phoenix 1.8** — LiveView for web dashboard
- **Ecto** — Schema validation (not persistence — no database)
- **Solid** — Liquid-compatible template engine for prompts
- **Req** — HTTP client for Linear GraphQL
- **No persistent database** — in-memory orchestrator state, restart recovery is tracker-driven + filesystem-driven

### State Model

Orchestrator manages issue lifecycle in-memory:

```
Unclaimed → Claimed → Running → Released
                    → RetryQueued → (re-dispatch or release)
```

Run attempts track: PreparingWorkspace → BuildingPrompt → LaunchingAgentProcess → InitializingSession → StreamingTurn → Finishing → Succeeded/Failed/TimedOut/Stalled.

### What Symphony Is NOT

- Not a full autonomous engineer — no PR review pipeline, no demo stage, no self-review
- No persistent event log or audit trail
- No safety layer beyond workspace isolation and Codex sandbox policies
- No cost tracking beyond token counting
- No multi-channel communication (agent writes Linear comments directly)
- No task decomposition or hierarchy
- No knowledge/learning system
- Single tracker integration (Linear only)
- Trust posture delegated entirely to Codex sandbox policies

### Current State

**Fully implemented reference in Elixir.** Production-usable. Tests at 100% threshold (with pragmatic exclusions). Has e2e tests against real Linear + real Codex.

---

## 2. What The Engineer Is

The Engineer is an **autonomous software engineering agent** — a full system that receives tasks, gathers requirements, researches, plans, executes, self-reviews, demos, ships PRs, and iterates on feedback. It aims to replicate real engineer behavior, not just run an agent on an issue.

### Architecture

Five-layer documentation structure, three-tier runtime model:

| Runtime Tier | Responsibility |
|-------------|---------------|
| **Core** | 9 invariant components — the brain. Never changes regardless of integrations. |
| **Adapters** | 5 stable contract types — integration boundaries. Extensible. |
| **Plugins** | Swappable implementations — GitHub, Telegram, Claude, Bash, etc. |

Hybrid pattern: **OS kernel** (Daemon schedules, Task Engine authorizes) + **Event Bus** (all inter-component communication, persistent audit trail) + **Task-as-truth** (Kubernetes-style reactive state management).

### Core Components (9)

| Component | What It Does |
|-----------|-------------|
| **Daemon** | Always-running kernel. Scheduler loop: event processing → trigger polling → preemption eval → scheduling → health checks. |
| **Task Engine** | State authority. 7 states, 23 transitions, permission table per state+sub-state. Security boundary. |
| **Orchestrator** | The brain. Seven-phase pipeline (intake → research → planning → execution → self-review → demo-prep → integration). Compiler + flight director model. |
| **Event Bus** | Nervous system. 30 event types, glob-pattern subscriptions, SQLite persistence, replay for state reconstruction. Bus down = system halt. |
| **Session/Memory** | Checkpoints (resumption), journal (observability), knowledge (learning across tasks). |
| **Safety Layer** | Pipeline middleware (active gate) + passive consultation (judgment) + cost tracking via event subscription. |
| **Workspace Manager** | Git worktrees per task. Branch hierarchy, progressive merge policy. |
| **Registry** | Plugin lifecycle: discovery → registration → initialization → health monitoring → shutdown. |
| **People Directory** | Who to contact, how to reach them, domain expertise. Drives communication routing. |

### Adapter Types (5)

| Adapter | Contract |
|---------|----------|
| **TriggerAdapter** | Polls for new work (GitHub Issues, Linear, etc.) |
| **CommunicationAdapter** | Sends/receives messages (GitHub comments, Telegram) |
| **LLMAdapter** | Interfaces with language models (Claude, GPT, etc.) |
| **ToolAdapter** | Executes actions (bash, file operations, etc.) |
| **GitHostingAdapter** | PR creation, branch management, code review |

Capability gates: optional methods only called after checking declared capabilities. Contracts grow without breaking existing plugins.

### Authorization Model

Two-gate Action Pipeline:

```
Intent → Gate 1 (Task Engine: is action legal in current state?) → Gate 2 (Safety Layer: does policy allow it?) → Execute → Notify (Event Bus)
```

### Task Lifecycle

```
Intake → Queued → Active (Working/Supervising/Integrating) → Review-Pending (Demo/Code) → Completed/Failed
                                                            ↕ Blocked
```

Seven-phase Orchestrator pipeline within Active.Working:

```
intake-analysis → research → planning → execution → self-review → demo-prep → integration
```

Two-stage PR review: Draft PR (demo gate: "did we build the right thing?") → Ready PR (code review: "did we build it right?"). Feedback loops back to Active.Working.

### Tech Stack

- **TypeScript / Node.js 22 LTS** — ESM only, maximum strict tsconfig
- **SQLite (better-sqlite3)** — WAL mode, synchronous persistent storage
- **Zod** — Runtime schema validation, 30 typed event payloads, compile-time type inference
- **Biome** — Linter + formatter (all rules enabled)
- **Vitest** — Three-tier testing (unit/integration/e2e), pool: forks
- **pnpm** — Package manager, monorepo-ready
- **pino** — Structured JSON logging with rolling

### Current Implementation State

**Architecture: COMPLETE** (Layers 0-5, 128 decisions documented).
**Implementation: Phase 4 of 19 complete.** 469 tests, all passing.

| Phase | Status | What Was Built |
|-------|--------|---------------|
| 0 — Bootstrap | Done | 12 files: package.json, tsconfig, biome, lefthook, vitest configs |
| 1a — Core Schemas | Done | Task (7 enums, 25 transition rules, permission table), Events (30 payloads), Session/Memory |
| 1b — Integration Schemas | Done | Config (~25 schemas), Adapters (~37 schemas), Orchestrator (~22 schemas), Ephemeral (~18 schemas) |
| 2 — Database | Done | SQLite + migrations (7 tables, 25 indexes), WAL, test helpers |
| 3 — Config System | Done | YAML loader, env var resolution, duration parsing, hot-reload watcher |
| 4 — Event Bus | Done | Pub/sub, ULID + sequence, persistence, replay, glob patterns |
| 5-15 | Not started | Adapters, Registry, Task Engine, Safety, Action Pipeline, Session/Memory, Orchestrator, Daemon, CLI, Plugins, E2E |

Next: Phase 5 (Adapter Base Classes + SDK Boundary).

---

## 3. Direct Comparison

### Scope

| Dimension | Symphony | The Engineer |
|-----------|----------|-------------|
| **Identity** | Scheduler/runner framework | Full autonomous engineer |
| **Ambition** | Run agents on issues safely | Replace a small engineering team |
| **Agent model** | Dispatch external agent (Codex) | IS the agent (Orchestrator reasons through phases) |
| **Task lifecycle** | Poll → dispatch → run → done | Poll → intake → research → plan → execute → self-review → demo → integrate → feedback loop |
| **PR workflow** | Agent creates PR directly | Two-stage: Draft PR (demo gate) → Ready PR (code review) |
| **Task decomposition** | None — one agent per issue | Parent-child hierarchy, dependency DAG, supervised decomposition |
| **Learning** | None | Knowledge entries, journal, cross-task pattern recognition |
| **Communication** | Agent writes Linear comments | Orchestrator-driven multi-channel (GitHub + Telegram), question batching, notification digests |

### Architecture

| Dimension | Symphony | The Engineer |
|-----------|----------|-------------|
| **Runtime tiers** | 3 layers (Policy/Config/Coordination) | 3 tiers (Core/Adapter/Plugin) + OS kernel hybrid |
| **Components** | ~7 (orchestrator, workspace, tracker, agent runner, codex client, config, dashboard) | 9 Core + 5 Adapter types + Plugin ecosystem |
| **State machine** | 4 orchestration states (Unclaimed/Claimed/Running/Released) | 7 task states + sub-states + 23 transitions + permission table |
| **Event system** | Implicit (state transitions, no bus) | Core architectural component (30 events, persistent, replayable) |
| **Persistence** | None (in-memory, tracker-driven recovery) | SQLite (events, tasks, sessions, journal, checkpoints, knowledge) |
| **Authorization** | Codex sandbox policies (external) | Two-gate Action Pipeline (Task Engine state + Safety Layer policy) |
| **Plugin model** | Codex skills (.codex/skills/) | Formal plugin system: manifests, five-phase lifecycle, health state machine, capability gates |
| **Adapter pattern** | Single tracker interface (Linear) | 5 typed adapter contracts, extensible to new types |

### Technology

| Dimension | Symphony | The Engineer |
|-----------|----------|-------------|
| **Language** | Elixir / OTP 28 | TypeScript / Node.js 22 |
| **Concurrency** | BEAM processes, native supervision trees | Single-threaded event loop, worker_threads planned |
| **Database** | None | SQLite (better-sqlite3), WAL mode |
| **Config** | YAML front matter in WORKFLOW.md, Ecto schemas | Multi-file YAML in ~/.engineer/config/, Zod schemas |
| **Templates** | Solid (Liquid-compatible) | N/A (prompts constructed programmatically, Phase 11+) |
| **Testing** | ExUnit, 100% threshold | Vitest three-tier, 70/55 thresholds |
| **HTTP** | Phoenix + Bandit | None yet (CLI-first) |
| **Dashboard** | Terminal ANSI + Phoenix LiveView | Planned TUI for demos (not built) |

### Safety & Cost

| Dimension | Symphony | The Engineer |
|-----------|----------|-------------|
| **Workspace isolation** | Per-issue directories, symlink escape protection | Git worktrees per task, branch hierarchy |
| **Execution sandbox** | Codex approval_policy + thread_sandbox (delegated) | Two-gate Action Pipeline (structural + policy), state machine as security boundary |
| **Cost tracking** | Token counting per thread (absolute totals) | Per-task and cross-task cost accumulators, configurable limits (block/warn/self-unblock) |
| **Cost gating** | None — tracking only | Safety Layer gate: blocks actions when budget exceeded |
| **Scope boundaries** | Workspace root containment | Per-repo scope config: allowed file patterns, forbidden paths, autonomy rules |

### Operational Model

| Dimension | Symphony | The Engineer |
|-----------|----------|-------------|
| **Deployment** | Elixir release / escript binary | Daemon + CLI (engineer start/stop/status/doctor) |
| **Recovery** | Tracker-driven (re-fetch active issues on restart) | Event replay from SQLite (state reconstruction) |
| **Health checks** | Stall detection (time since last Codex event) | 10-category doctor (config, DB, plugins, triggers, LLM, comms, git, workspace, logging, resources) |
| **Hot reload** | WORKFLOW.md file watching | Config watcher (safety.yaml, people.yaml) |
| **Concurrency** | max_concurrent_agents (configurable, per-state limits) | max_concurrent = 1 for v1 (configurable for future scaling) |
| **Multi-turn** | Up to max_turns, continuation between turns | Checkpoint-based resumption, session persistence across crashes |

---

## 4. Architectural Analysis

### The Fundamental Difference

Symphony is a **dispatch loop with workspace isolation**. It polls a tracker, picks eligible issues, spins up an external agent (Codex) in a sandboxed directory, and waits. The "intelligence" lives entirely inside Codex. Symphony is plumbing.

The Engineer is the **intelligence itself**. The Orchestrator reasons through a seven-phase pipeline with loopbacks. The Task Engine enforces a state machine as a security boundary. The Event Bus provides a persistent, replayable nervous system. The Safety Layer gates actions before they execute. There is no external agent being dispatched — The Engineer IS the agent.

This is not a difference of scope. It's a difference of architectural category. Symphony is to The Engineer what a cron job is to an operating system.

### Architecture Depth

**Symphony's architecture is flat.** Three layers (Policy/Config/Coordination), but they're really just "config file → orchestrator loop → agent subprocess." The orchestrator is a single 1500-line module that owns scheduling, dispatch, reconciliation, retry, and state management. There's no separation of concerns within the coordination layer — it's one big state machine.

**The Engineer's architecture is deeply decomposed.** 9 Core components, each with a single responsibility:
- Daemon schedules, but doesn't authorize
- Task Engine authorizes, but doesn't reason
- Orchestrator reasons, but doesn't enforce policy
- Safety Layer enforces policy, but doesn't track state
- Event Bus provides communication, but doesn't make decisions

This separation means each component can evolve independently. Symphony's orchestrator cannot be decomposed without rewriting it.

**The three-tier model (Core/Adapter/Plugin) is architecturally superior to Symphony's hardcoded integrations.** Symphony's Linear client is wired directly into the orchestrator. Adding GitLab or Jira means forking core logic. The Engineer's adapter contracts mean Core never knows or cares what tracker, LLM, or communication channel is behind the interface.

### State Machine Design

**Symphony: 4 states, no permissions.**
```
Unclaimed → Claimed → Running/RetryQueued → Released
```
States track orchestration status (is something running?). No concept of what actions are legal in a given state. The agent can do anything at any time — trust is fully delegated to Codex sandbox policies.

**The Engineer: 7 states + sub-states, 23 transitions, permission table.**
```
Intake → Queued → Active (Working/Supervising/Integrating) → Review-Pending (Demo/Code) → Completed/Failed
                                                              ↕ Blocked
```
Each state+sub-state maps to a permission table defining which action classes are legal. The state machine IS the security boundary. If the task is in Review-Pending, write actions are structurally impossible — not policy-blocked, structurally prohibited.

This is a qualitative difference. Symphony has no equivalent concept. The Engineer's state machine derives from OS process states — proven to be the right abstraction for lifecycle management.

### Event System

**Symphony has no event system.** State transitions happen imperatively within the orchestrator. There is no broadcast mechanism, no subscriber model, no event persistence, no replay capability. If the process dies, all in-flight context is lost. Recovery means re-polling the tracker and hoping the agent's workspace is intact.

**The Engineer's Event Bus is a Core architectural component.** 30 typed events, glob-pattern subscriptions, SQLite persistence with ULID + auto-increment sequence, synchronous delivery, replay for state reconstruction. Every action the system takes is recorded as an immutable event before it happens.

This means:
- **Debugging:** replay any task's event stream to see exactly what happened
- **Recovery:** reconstruct state from events after crash, not from external tracker
- **Learning:** mine event history for patterns, measure phase durations, identify failure modes
- **Audit:** complete record of every decision, action, and transition

Symphony cannot do any of this. Its "recovery" is re-fetching issue lists from Linear.

### Safety Architecture

**Symphony delegates safety entirely to Codex.** The only safety mechanisms are:
- Workspace directory containment (symlink escape protection)
- Codex `approval_policy` and `thread_sandbox` settings (external to Symphony)

Symphony itself has no opinion on what the agent should or shouldn't do. If Codex's sandbox allows it, it happens.

**The Engineer has a three-layer safety model:**
1. **Task Engine (structural):** State machine determines which action classes are legal. Review-Pending cannot write code. Blocked cannot execute. This is not configurable — it's structural.
2. **Safety Layer (policy):** Per-repo scope boundaries, cost limits (block/warn/self-unblock), autonomy rules. Configurable per user/repo.
3. **Action Pipeline (enforcement):** Gate 1 (Task Engine) → Gate 2 (Safety Layer) → Execute → Notify. Both gates must pass. No bypass path exists.

The Engineer's safety is architectural — it cannot be disabled by a config change. Symphony's safety is delegated — it trusts whatever Codex does.

### Task Model

**Symphony: flat, one agent per issue.** No decomposition, no hierarchy, no dependencies between tasks. A complex feature that spans 5 files and 3 subsystems gets one agent session. If the agent can't handle it in max_turns, it retries the same flat approach.

**The Engineer: hierarchical with dependency DAG.** A parent task can decompose into children. Children are independent tasks with full lifecycle. The parent enters Active.Supervising (doesn't consume a working slot — this is architecturally significant for scheduling). Children can have dependency ordering (child B waits for child A). Sibling knowledge sharing lets children benefit from each other's discoveries.

This is how real engineering works. Complex tasks decompose. Symphony cannot model this.

### Persistence Model

**Symphony: stateless.** In-memory orchestrator state. No database. Restart = re-derive everything from the tracker + filesystem. Workspace directories persist (so partially completed work survives), but all scheduling context, retry state, and token accounting is lost.

This is adequate for a scheduler. It's inadequate for an autonomous engineer that needs to:
- Resume mid-phase after a crash
- Track cost across tasks over days/weeks
- Learn patterns from past work
- Provide audit trails

**The Engineer: SQLite with 7 domain tables.** Tasks, events, sessions, journal entries, checkpoints, knowledge. WAL mode for concurrent reads. Event replay for state reconstruction. Checkpoints for mid-phase resumption.

The persistence model is a direct consequence of the ambition gap. You can't build a learning system without memory.

### Plugin & Extensibility Architecture

**Symphony: hardcoded integrations.**
- Linear (only tracker, wired into orchestrator)
- Codex (only agent, wired into agent runner)
- `.codex/skills/` (agent-side, not system-side)

Adding a new tracker means writing a new adapter module and modifying the orchestrator to use it. Adding a new agent means replacing the Codex client entirely. There's no formal contract, no capability negotiation, no plugin lifecycle.

**The Engineer: formal three-tier plugin system.**
- 5 adapter types (Trigger, Communication, LLM, Tool, GitHosting) with abstract base classes
- Plugin manifests (`engineer.plugin.yaml`) declare capabilities, config schemas, health requirements
- Five-phase lifecycle: discovery → registration → initialization → health monitoring → shutdown
- Capability gates: optional methods only called after checking declared capabilities
- SDK boundary: curated re-exports so plugin authors get exactly what they need

Adding GitHub Issues as a trigger is a plugin. Adding GitLab as a hosting backend is a plugin. Swapping Claude for GPT is a plugin. Core never changes. This is fundamentally more extensible than Symphony's approach.

### Communication Architecture

**Symphony: agent-driven, single channel.** The Codex agent writes Linear comments directly via a dynamic tool (linear_graphql). Symphony itself has no communication model — the agent talks to the tracker as a side effect of execution.

**The Engineer: Orchestrator-driven, multi-channel.** The Orchestrator owns all communication intelligence. It decides when to ask questions, when to send status updates, when to batch notifications into digests. Messages route through CommunicationAdapter, which can be GitHub comments, Telegram messages, or any future channel. The Orchestrator controls cadence, batching, and escalation.

This separation means communication strategy can evolve independently of any specific channel. Symphony's approach couples communication to the agent's tool usage — no system-level control over what gets said, when, or where.

### Technology Trade-offs

**Elixir/OTP vs TypeScript/Node.js** is the one area where Symphony has a genuine architectural advantage through language choice:

| Concern | Elixir/OTP | Node.js |
|---------|-----------|---------|
| **Process supervision** | Built into OTP. Supervisor trees, restart strategies, fault isolation — all native. | Manual. Must design crash recovery, process management, graceful shutdown explicitly. |
| **Concurrency** | BEAM processes are lightweight, preemptive, isolated. 10+ concurrent agents is natural. | Single-threaded event loop. worker_threads possible but heavier. v1 = 1 concurrent agent. |
| **Hot code reload** | OTP supports hot code upgrades in running systems. | Requires process restart. Config hot-reload works, code doesn't. |
| **Fault tolerance** | "Let it crash" philosophy. Process crashes are expected and handled by supervisors. | Unhandled errors crash the process. Must catch everything or lose state. |

However, TypeScript/Node.js has its own strengths:

| Concern | TypeScript | Elixir |
|---------|-----------|--------|
| **Type system** | Discriminated unions, generic constraints, Zod inference — compile-time safety for 30 event types, 5 adapter contracts, state machine transitions. | Dialyzer provides gradual typing but lacks discriminated unions and generic constraints. |
| **Plugin ecosystem** | npm has the largest package ecosystem. Plugin authors likely know TypeScript. | Hex is smaller. Elixir developer pool is narrower. |
| **Schema validation** | Zod provides runtime validation with compile-time type inference in one tool. | Ecto schemas validate but don't generate TypeScript-style compile-time types from runtime schemas. |
| **Tooling maturity** | Biome (all rules), Vitest, tsconfig strict — battle-tested, well-understood. | Credo + Dialyxir are good but less comprehensive than Biome's "all rules" approach. |

**Verdict on language choice:** Elixir/OTP is the better language for the scheduler component (supervision, concurrency, fault tolerance). TypeScript is the better language for the system-wide architecture (type safety across 30 event types, 5 adapter contracts, plugin SDK). The Engineer's scope demands the latter. The concurrency limitation (v1 = 1 agent) is a real trade-off but acceptable — The Engineer's value is depth of engineering behavior per task, not parallelism.

### What The Engineer Should Adopt from Symphony

These are genuine architectural ideas worth incorporating — not because Symphony is ahead, but because they're good patterns:

**1. Per-repo workflow files.** `WORKFLOW.md` (Markdown + YAML front matter, versioned with the code) is an elegant config pattern. The Engineer should support a repo-level `.engineer/workflow.md` that overrides `~/.engineer/config/` defaults. This doesn't conflict with existing architecture — it's an additional config source scoped to the repo.

**2. Workspace lifecycle hooks.** `after_create`, `before_run`, `after_run`, `before_remove` — simple, pragmatic, proven. The Engineer's Workspace Manager design should incorporate these. They solve real problems (dependency bootstrapping, cleanup, artifact collection) without architectural overhead.

**3. Stall detection.** "No event from agent in N seconds → kill and retry" is simple and critical. The Engineer's Safety Layer or Daemon health checks should include this. Symphony's implementation (configurable stall_timeout_ms, per-tick check) is clean.

**4. Inter-phase state checks.** Symphony checks issue state between agent turns — if terminal, stop. The Engineer's Orchestrator should do equivalent checks between pipeline phases: re-verify task state, check for preemption, confirm external state hasn't changed.

---

## 5. Where We Stand

### What We Have That Symphony Doesn't

| Capability | Why It Matters |
|-----------|---------------|
| **State machine as security boundary** | Actions are structurally impossible in wrong states — not policy-blocked, impossible. No equivalent in any other open-source agent orchestrator. |
| **Two-gate authorization pipeline** | Separates structural legality (what phase allows) from policy enforcement (what user configured). Clean separation of concerns that scales. |
| **Persistent replayable event log** | Complete audit trail. State reconstruction after crash. Foundation for learning and debugging. Symphony loses everything on restart. |
| **Task decomposition with dependency DAG** | Complex work decomposes naturally. Parent supervises children without consuming working slots. Sibling knowledge sharing. No other agent system models this. |
| **Formal plugin system with capability gates** | 5 adapter types, manifests, five-phase lifecycle. Extensible without touching Core. Symphony's integrations are hardcoded. |
| **Two-stage PR review (demo + code)** | Separates "did we build the right thing?" from "did we build it right?" No other agent system has this pipeline. |
| **Cost gating (not just tracking)** | Safety Layer can block actions when budget exceeded. Symphony counts tokens but never stops spending. |
| **Cross-task learning** | Knowledge entries, journal, pattern recognition across tasks. Symphony is amnesiac. |
| **Seven-phase pipeline with structured loopbacks** | Compiler-inspired: each phase produces IR for the next. Loopbacks require reasoning. Not a flat "run agent and hope." |
| **Orchestrator-owned communication** | System controls when/what/where to communicate. Agent doesn't freestyle into channels. Batching, digests, escalation — all system-level. |

### What Symphony Has That We Should Absorb

| Pattern | Status in Our Architecture |
|---------|---------------------------|
| Per-repo workflow files | Not designed yet. Should add as config source. |
| Workspace lifecycle hooks | Not in Workspace Manager design. Should add. |
| Stall detection | Covered conceptually by Safety Layer / health checks, but not explicitly designed as a pattern. Should formalize. |
| Per-state concurrency limits | Our Daemon design supports max_concurrent but not per-state limits. Worth considering for future scaling. |

### Honest Assessment

**Architecturally, The Engineer is in a different league.** Symphony is competent infrastructure for dispatching agents. The Engineer is a comprehensive system for autonomous engineering with safety, learning, communication, and extensibility designed in from the ground up.

**The TypeScript/Node.js choice is correct for our scope.** Elixir/OTP wins on daemon supervision and concurrency. TypeScript wins on type safety across a complex system with 30 event types, 5 adapter contracts, and a plugin SDK. Our scope demands the latter. The supervision gap is solvable with explicit design; the type safety gap in Elixir is not.

**The architecture-first approach is validated.** 128 decisions, zero rework across 4 implementation phases, 469 tests. The schemas, database, config, and event bus all fit together because they were designed together. Symphony's spec was written alongside implementation — it shows in the monolithic orchestrator.

**Nothing in Symphony suggests we should change direction.** The patterns worth adopting (workflow files, workspace hooks, stall detection) are small additions that fit cleanly into existing architecture. No fundamental revision needed.
