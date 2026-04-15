# Architectural Decisions

Log of major decisions made. Do not re-litigate unless explicitly asked.

---

## 2026-03-06 — BOOT.md as single universal boot file

**Decision:** One file, `BOOT.md`. No agent-specific wrappers. "Read BOOT.md and begin." The repo dictates the protocol.

**Rationale:** Per-agent files (CLAUDE.md, GEMINI.md, etc.) fragment and create maintenance overhead that grows with every new agent. Our own protocol is simpler and truly agent-agnostic.

**Alternatives rejected:** AGENTS.md + per-agent wrappers, CLAUDE.md as primary, README.md as boot file.

---

## 2026-03-06 — Architecture first, code never (until approved)

**Decision:** All deliverables are documentation and architectural planning. No code until Farzam explicitly approves. Work lives in `implementation-docs/`.

**Rationale:** This is a massive project that demands every decision be made thoughtfully before implementation. Rushing to code creates rework and architectural debt.

**Alternatives rejected:** Prototype-first, iterative code-and-plan.

---

## 2026-03-06 — implementation-docs/ as development workspace

**Decision:** `implementation-docs/` holds all builder-facing documentation: active focus, session logs, philosophies, and architecture. Separate from agent-facing files.

**Rationale:** Clean separation between what the agent reads and what the builders reference.

---

## 2026-03-06 — No premature implementation artifacts

**Decision:** Removed BOOT.md and memory/ directory. These are outputs of architectural work, not inputs. They will be designed and created when the architecture is finalized.

**Rationale:** Writing agent files before architecting the agent creates assumptions that constrain design. Design first, build the artifacts from the design.

---

## 2026-03-07 — Hybrid architecture pattern

**Decision:** OS kernel authority + event bus communication + task-as-truth. Derived from three proven systems: OS kernels (central authority, scheduler), Kubernetes controllers (state-as-truth, reactive), and the Actor model (explicit message-passing, audit trails).

**Rationale:** Each proven system solves part of the problem. OS kernel gives clear authority (never ambiguous who's in charge). Event bus gives auditable communication and decoupling. Task-as-truth gives a single source of truth for work state. The hybrid takes the best of each without the full complexity of any one.

**Alternatives rejected:** Pure OS kernel (Daemon becomes bottleneck and single coupling point). Pure K8s controllers (coordination is implicit, harder to reason about full flow). Pure Actor model (full actor runtime is heavy infrastructure for a system that's fundamentally sequential within a task).

---

## 2026-03-07 — Event Bus as structural element

**Decision:** The Event Bus is a first-class skeleton component, not just a design pattern. All inter-component communication flows through it. Every event is logged — the event stream IS the audit trail.

**Rationale:** Making the Event Bus structural (not optional) ensures auditability and observability are built into the architecture, not bolted on. It also enables the Safety Layer interceptor pattern and makes the full story of any task reconstructable from its event stream.

---

## 2026-03-07 — Safety Layer dual mode

**Decision:** Safety operates in two modes simultaneously. Active interceptor on the Event Bus for hard limits (cost caps, scope boundaries, forbidden actions). Passive consultation by the Orchestrator for judgment calls (branch policy, autonomy level, who to contact).

**Rationale:** Defense in depth. Hard limits must be structural — nothing unsafe passes even if a component forgets to check. Judgment calls are contextual and need the Orchestrator's reasoning. Two modes, two purposes.

---

## 2026-03-07 — Simulation-driven architecture validation

**Decision:** Validate architectural decisions by running realistic scenarios (simple, difficult, extreme) through the proposed design and identifying gaps. This is a permanent practice, not a one-time exercise.

**Rationale:** Abstract architecture looks clean until real scenarios expose missing pieces. Running a 30-minute typo fix, a 2-day OAuth implementation, and a multi-week microservice migration through the architecture revealed 12 gaps that pure design thinking missed.

---

## 2026-03-07 — Layer 1.5: User flows before component design

**Decision:** Before Layer 2 (Component Architecture), validate Layer 1 by designing concrete user flows from Farzam's perspective. An intermediary phase that stress-tests the architecture from the user's experience, not just the architect's.

**Rationale:** Layer 1 simulations traced data through components. User flows trace the experience through the human's eyes — what they do, what they see, when they're notified. This catches experiential gaps (notification cadence, review semantics, status queries) that component-level simulation misses. Found 12 new gaps (24 total).

---

## 2026-03-07 — Two-stage PR review (Demo Gate)

**Decision:** Every PR goes through two stages. Draft PR = demo gate ("did you build the right thing?"). Ready PR = code review ("did you build it right?"). Feedback at either stage must be applied. Everything is demo-able — frontend gets screenshots/recordings, backend gets a temporary TUI built specifically for demo purposes.

**Rationale:** Separates two fundamentally different review questions. The demo gate is the fastest possible way to validate direction before investing in code review. Most teams conflate "right thing" and "built right" — separating them catches direction problems early.

---

## 2026-03-07 — Communication channels: GitHub + Telegram

**Decision:** GitHub for code workflow (issues as triggers, PRs for delivery, comments for code-level discussion). Telegram bot for real-time communication (questions, status updates, alerts). Grounded in Farzam's setup as first user.

**Rationale:** Both free, both accessible. Telegram has an excellent bot API purpose-built for this. Email is the universal fallback. All channels are plugins — the architecture doesn't depend on any specific one.

---

## 2026-03-07 — Real engineer behavior over prescribed policies

**Decision:** The Engineer doesn't have hardcoded policies for situations like demo rejection, conflicting reviews, or feedback severity. It uses judgment — the same judgment a real engineer would use. The architecture enables looping back to any phase and engaging people through available channels; it doesn't prescribe the response.

**Rationale:** Over-systematizing judgment creates brittle policy trees. A real engineer reads feedback, understands it, asks clarifying questions if needed, and acts. If the feedback means tweaking one thing, tweak it. If it means the requirements were wrong, loop back to requirements. The architecture's job is to make every response *possible*, not to decide which one to use.

---

## 2026-03-07 — Auto-merge configurable per repo

**Decision:** PR merge after approval is configurable per repo. Default: wait for owner to merge manually. Can be configured to auto-merge.

**Rationale:** Different repos have different cultures. Some want maximum control (manual merge), others want speed (auto-merge). The default is conservative.

---

## 2026-03-07 — State machine as security boundary (failsafe)

**Decision:** The task state machine is not just a workflow tracker — it's a permission gate. Each state defines what actions are LEGAL. Actions outside that set are hard-blocked. This is defense in depth layered on top of the Safety Layer: Safety checks *what* against rules, state machine checks *when* against phase. Both must agree.

**Rationale:** If the LLM hallucinates, if the Orchestrator has a bug, the state machine prevents structurally impossible actions (pushing code during research, merging during demo review). Looping back to an earlier phase resets permissions — no code pushes until execution is reached again. This makes the state machine a failsafe independent of LLM behavior.

---

## 2026-03-07 — Phase loopback as formal state transition

**Decision:** When the Engineer needs to loop back to an earlier phase (e.g., from code review to requirements gathering), this is a formal state machine transition — recorded in the audit trail, changes the permission set. The Orchestrator *decides* to loop back; the Task Engine *enforces* the transition.

**Rationale:** If loopback were just Orchestrator judgment with no state change, the permission gate would be wrong — the system would still think it's in code review while the Orchestrator is actually redoing requirements. Formal transitions keep the state machine accurate and the security boundary intact.

---

## 2026-03-07 — DevEx for the Engineer (demo TUI base + tooling pattern)

**Decision:** Hybrid approach for backend demos: a maintained base TUI project (wired into foundational things — API calls, auth, data display) that the Engineer extends in an isolated worktree per task. The worktree is throwaway; the base persists and improves. This is the first instance of a broader pattern: invest in the Engineer's DevEx — pre-built infrastructure that makes it more effective.

**Rationale:** Rebuilding a demo TUI from scratch every time is wasteful. A shared base with task-specific extensions gives consistency + isolation. The broader principle: the Engineer is our developer, and we should invest in its tooling just like we would for a human engineer. Only outcomes matter — the better the tooling, the higher the quality of output.

---

## 2026-03-07 — Review-Pending as top-level state

**Decision:** Review-Pending is a top-level state alongside Active and Blocked, not a sub-state of Active. It has two sub-states: Demo (Draft PR) and Code (Ready PR). When feedback arrives, the task transitions back to Active.Working; when approved, it advances (Demo → Code, or Code → Completed).

**Rationale:** Review-Pending is semantically distinct from both Active (the agent isn't working) and Blocked (the task isn't stuck). It's "done for now, pending judgment." Making it top-level gives it its own permission set (minimal — can only read and communicate), enables the scheduler to assign the agent to other work while waiting, and follows the CPU analogy (process waiting for I/O leaves Running state and frees the CPU).

**Alternatives rejected:** Sub-state of Active (muddies permissions — Active would have sub-states with wildly different permission sets, from full write access to read-only).

---

## 2026-03-07 — Action classes as permission unit

**Decision:** The state machine permission gate uses action classes (read, write, test, git-local, git-remote, communicate, merge, deploy, task-manage, ask-human), not individual tools. Each state+sub-state maps to a set of allowed action classes.

**Rationale:** Tools are plugins — new tools are added constantly. Action classes are stable categories that new tools map into. This keeps the permission table maintainable and semantically clear. Two gates: Task Engine (is this action class legal in this phase?) → Safety Layer (is this specific action within policy?).

**Alternatives rejected:** Per-tool permissions (doesn't scale as tools are added/removed, requires updating permission table for every new tool).

---

## 2026-03-07 — Gap prioritization by component

**Decision:** 24 gaps grouped by target component. Components designed in dependency order: Task Engine → Session/Memory → Daemon/Scheduler → Safety Layer → Orchestrator → Workspace Manager → Comm Plugins. Gaps are resolved as their component is designed.

**Rationale:** Components have dependencies — Task Engine's state model must be defined before the Daemon can design scheduling, before the Safety Layer can define permission enforcement. Grouping gaps by component and ordering components by dependency ensures each design builds on solid foundations.

---

## 2026-03-07 — Context reconstruction over conversation replay

**Decision:** When resuming a task after preemption, crash, or new session, the system reconstructs context from a compressed checkpoint summary (key findings, open questions, next action), not by replaying the original LLM conversation.

**Rationale:** LLM conversations are expensive, non-deterministic, and full of abandoned exploration paths. A checkpoint summary captures the distilled result — equivalent context without noise. Resume quality depends on summary quality, which is an Orchestrator concern (generating good summaries at checkpoint time). This is fast, cheap, and deterministic.

**Alternatives rejected:** Full conversation replay (expensive, non-deterministic, replays abandoned paths). Hybrid replay (adds complexity as a safety net for a problem better solved by improving summary quality).

---

## 2026-03-07 — Two knowledge scopes: repo + user

**Decision:** Cross-task knowledge has two scopes. Repo-scope: conventions, patterns, and domain knowledge isolated per repository. User-scope: personal preferences and workflow patterns that apply across all repositories. Precedence hierarchy: Repo conventions > User preferences > Agent defaults.

**Rationale:** Repo knowledge comes from the repo itself — its docs, code patterns, and conventions. The Engineer reads and acclimate itself, just like joining any repo. But users also have personal preferences (component style, PR verbosity, testing expectations) that apply everywhere. User-scope captures these as learned observations, not declared config. When repo and user knowledge conflict, repo wins — like CSS specificity.

**Key distinction:** Knowledge (Session/Memory) is dynamic — observed and accumulated over time. Configuration (Safety Layer / system config) is static — explicitly declared by the user. User-scope knowledge is what the Engineer discovers about the user's patterns, not what the user configures.

---

## 2026-03-07 — Session Journal as curated narrative (separate from Event Bus)

**Decision:** The session journal is a curated, human-readable narrative of the Orchestrator's reasoning process, separate from the Event Bus. The Event Bus stores exhaustive system-level events (audit trail). The journal stores meaningful steps from the agent's perspective (working notes).

**Rationale:** Different audiences, different granularity. Event Bus serves debugging, audit, and compliance. Journal serves human queries ("what have you tried?"), context reconstruction, and analytics. Both are needed; neither replaces the other. Together they form the data foundation for a comprehensive Engineer Dashboard.

---

## 2026-03-07 — Engineer Dashboard as analytics vision

**Decision:** The Event Bus audit trail, Session Journal, and Task history together form the data foundation for a comprehensive Engineer Dashboard. Goal: runners of The Engineer can see everything — past work, live status, thorough analytics — in one place, with utmost accuracy and comprehensiveness.

**Rationale:** All the data is already being captured for operational reasons (audit, recovery, queryability). Aggregating it into analytics is a downstream concern that the architecture naturally enables. This vision informs how we capture and structure data at every layer — we keep it rich, structured, and queryable so the dashboard can surface deep insights.

---

## 2026-03-07 — Single-core CPU architecture (concurrency-ready)

**Decision:** The Engineer runs as a single-core CPU: one Active.Working task at a time. When a task is Blocked or Review-Pending, the agent is freed and picks up the next Queued task. All interfaces use abstract capacity (`max_concurrent` config value, default 1) so the architecture can evolve to multi-core without redesign.

**Rationale:** Like Intel's evolution from single-core to multi-core — start simple, prove correctness, then scale. Concurrency adds enormous complexity (race conditions, resource contention, context management). Single-core lets us build and thoroughly test the scheduling, preemption, and checkpoint/resume flows before introducing parallelism. The key insight: design interfaces that don't hardcode "1" so multi-core is a config change, not a rewrite.

**Alternatives rejected:** Configurable concurrency from day one (too much complexity before the basics are proven). Strict sequential with no task-switching (misses the opportunity to work on other tasks while blocked/in-review).

---

## 2026-03-07 — Graceful preemption only

**Decision:** When a higher-priority task arrives, the current task is preempted gracefully: the Orchestrator finishes its current atomic operation (file write, test run, LLM call), creates a checkpoint, then yields. The agent is never interrupted mid-operation.

**Rationale:** Cooperative multitasking is simpler and safer than preemptive. Interrupting mid-operation risks partial writes, broken git state, or incomplete test runs. The trade-off (slight delay before the higher-priority task starts) is acceptable — the maximum delay is one atomic operation, typically seconds. A configurable preemption threshold (default: priority delta >= 20) prevents thrashing on small priority differences.

**Alternatives rejected:** Immediate preemption with rollback (complex, risky — partial state recovery is error-prone). Checkpoint-boundary-only preemption (too coarse — could wait for an entire phase transition, potentially hours).

---

## 2026-03-07 — User-assigned priority with defaults

**Decision:** Task priority is a number (1-100, higher = more important). Users can set it explicitly (labels, commands). When not set, the system assigns sensible defaults based on task signals (bug → 70, feature → 50, critical → 90). Simple aging prevents starvation of low-priority tasks.

**Rationale:** The user should always understand why task X ran before task Y. User-assigned priority is maximally transparent and predictable. Derived/computed priority systems are smarter but opaque — users lose trust when they can't predict scheduling. Defaults handle the common case (most tasks won't have explicit priority), and aging ensures nothing starves.

**Alternatives rejected:** Fully derived priority (computed from signals, opaque to user). Hybrid user + derived (added complexity without clear benefit given single-core simplicity).

---

## 2026-03-07 — Active.Supervising does not consume working slot

**Decision:** When a parent task enters Active.Supervising (monitoring children), it does NOT consume the agent's working slot. Only Active.Working and Active.Integrating consume a slot. This means a child can execute while the parent watches, on a single core.

**Rationale:** Supervising is inherently lightweight — its permission table only allows read, communicate, task-manage, and ask-human. No LLM-heavy work, no code writing, no testing. Holding the working slot while supervising would mean children could never execute (deadlock on a single core). The parent parks itself and wakes up to Active.Integrating only when all children complete.

---

## 2026-03-08 — Safety Layer derives from SELinux/IAM policy engines

**Decision:** The Safety Layer is a stateless policy evaluator, derived from mandatory access control systems (SELinux/AppArmor) and cloud IAM policy engines. It evaluates policies per-action without querying other components for state. Deny-by-default for dangerous operations, allow-by-default for safe operations.

**Rationale:** Proven security systems are stateless evaluators with externally-provided state. SELinux doesn't query the filesystem — the kernel provides context. Similarly, our Safety Layer doesn't query the Task Engine. State flows to it via Event Bus events. This preserves the architectural constraint that Safety Layer depends on nothing.

---

## 2026-03-08 — Cost accumulators internal to Safety Layer (ephemeral)

**Decision:** The Safety Layer maintains its own cost accumulators by subscribing to `cost.incurred` events on the Event Bus. These accumulators are ephemeral — reconstructable from Event Bus history on restart. This gives two independent cost views: per-task on the Task object (Task Engine), cross-task aggregates in Safety Layer.

**Rationale:** Safety Layer must track cumulative cost (Gap #5) without depending on other components. Building accumulators from the event stream preserves independence. Like a billing system that accumulates charges from the event stream independently of the services that generated them. Follows the same ephemerality pattern as the Daemon.

---

## 2026-03-08 — Two LLM provider types with different cost semantics

**Decision:** The cost tracking system accommodates two fundamentally different LLM provider models. CLI-based (Claude Code, Gemini CLI, Codex): subscription limits, rate limits, daily caps — the system tracks usage and stops when limits are hit, reports when limits reset. API-based (OpenRouter, direct API keys): per-token dollar spend against user-defined budgets — the system tracks dollars and enforces budget limits. Both share the same Safety Layer interface.

**Rationale:** Many users will power The Engineer with CLI tools they already have subscriptions for. These have provider-imposed limits, not user-defined budgets. API providers are the opposite — no subscription cap, but every token costs money. The architecture must accommodate both because The Engineer must work with any LLM source.

---

## 2026-03-08 — Cost limit reached = stop (no graduated wind-down)

**Decision:** When a cost limit is reached, the agent simply stops. Checkpoint current state, transition task to Blocked (reason: cost limit), notify the human, wait for limit reset or budget increase. No warning thresholds, no soft/hard limit distinction, no buffer percentages.

**Rationale:** Follows the natural model of CLI subscription tools — when you run out, you stop, and you're told when it resets. For API budgets, the user sets the budget and the agent stops at that number. Simple, predictable, transparent. If the user wants more budget, they increase it.

---

## 2026-03-08 — Response timeout: Safety Layer owns policy, Daemon executes

**Decision:** Response timeout policy (stage definitions, thresholds, actions) is owned by the Safety Layer configuration. The Daemon reads these thresholds from Safety config and handles execution (timer tracking, event emission). Single source of truth — no duplication between Daemon config and Safety config.

**Rationale:** Clean separation of concerns. The Safety Layer defines WHAT happens and WHEN. The Daemon handles the HOW (running timers, checking thresholds, emitting events). This prevents the Daemon from maintaining independent timeout values that could drift from the policy.

---

## 2026-03-08 — Autonomy boundaries by decision category

**Decision:** The autonomy boundary config uses named decision categories (architectural, refactoring, dependencies, breaking changes, etc.) each mapped to one of three autonomy levels: `always_decide` (agent has full authority), `threshold` (agent decides unless a condition is met), `always_ask` (must get human approval). Categories are configurable — users add/remove freely. Per-repo overrides supported.

**Rationale:** Mirrors how real organizations define authority. A tech lead can decide code style but must escalate architectural changes. The three-level model is simple enough to configure but granular enough to express real policies. The category list is not hardcoded — different teams care about different things.

---

## 2026-03-08 — Self-unblock respects autonomy boundaries

**Decision:** When the response timeout's self-unblock stage triggers (default: 24 hours blocked), the Orchestrator checks the autonomy category of the pending decision. If the category is `always_ask`, no self-unblock occurs — only reminders continue. Self-unblock only works for `threshold` or `always_decide` categories where a reasonable default exists.

**Rationale:** `always_ask` means "always ask" — including when the human hasn't responded. The agent should respect this boundary regardless of wait time. Otherwise `always_ask` doesn't truly mean "always." For lower-stakes decisions, self-unblock prevents indefinite stalling while still notifying the human of the default chosen.

---

## 2026-03-08 — Active interceptor: veto-only, vetoed events still logged

**Decision:** The Safety Layer's active interceptor on the Event Bus can only veto events, never modify them. Vetoed events are still recorded in the audit trail with veto reason attached.

**Rationale:** Veto-only keeps the interceptor simple and auditable — no event mutation means the system is easier to reason about. Logging vetoed events is critical: the audit trail must show what was attempted AND what was blocked. If a component tries something out of scope, that attempt itself is valuable audit information.

---

## 2026-03-08 — Orchestrator derives from compiler front-end + flight director

**Decision:** The Orchestrator derives from two proven systems. Compiler front-end (multi-pass): phases as passes, each producing structured output (intermediate representation) that feeds the next. Trivial inputs skip passes (fast-path). Flight Director (NASA Mission Control): single coordinator managing specialists, communication cadence, escalation judgments, and delegation while maintaining situational awareness.

**Rationale:** The compiler gives the phase pipeline structure — passes, structured IR between phases, fast-path for trivial inputs. The flight director gives the coordination and communication model — notification cadence, autonomy judgments, tech lead supervision, specialist delegation. Neither alone covers the Orchestrator's full responsibility. The compiler doesn't explain human communication; the flight director doesn't explain how phases produce structured output.

---

## 2026-03-08 — Seven-phase pipeline with structured phase outputs

**Decision:** The Orchestrator runs a seven-phase pipeline: intake-analysis, research, planning, execution, self-review, demo-prep, integration. Each phase produces structured `PhaseOutput` that feeds the next. Phases are Orchestrator-internal — the Task Engine only sees the `phase` string field for observability. Phases have no permission implications beyond the current state+sub-state.

**Rationale:** Compiler-inspired passes with intermediate representation. Intake-analysis is separated from research because it determines complexity and decides which subsequent phases to run — like the lexing pass that classifies input before deeper analysis. Structured output prevents coupling between phases and enables clean loopbacks.

---

## 2026-03-08 — Fast-path for trivial tasks

**Decision:** The Orchestrator detects trivial tasks during intake-analysis and abbreviates the pipeline. Trivial = all of: <=2 files affected, no ambiguity, no new dependencies, no architectural changes, <30 min estimated. Fast-path skips planning, abbreviates self-review, skips demo (PR goes straight to Ready), collapses three notifications into one. All thresholds configurable. Can be disabled entirely.

**Rationale:** Compiler insight: trivial inputs skip passes. A typo fix in README doesn't need a planning phase, demo artifacts, or three separate notifications. The full pipeline is correct for complex tasks but creates unnecessary ceremony for trivial ones. Execution, safety checks, and permission gates are never skipped.

---

## 2026-03-08 — Milestone-based notification as default cadence

**Decision:** The Orchestrator sends notifications at natural milestones (task pickup, draft ready, PR ready, done, blocked, child completion, cascade failure), not on timers. Optional daily digest on top. Noise prevention: deduplication window (5 min), quiet hours, batching window (2 min). Fast-path tasks collapse to one combined message.

**Rationale:** Flight director insight: communicate when meaningful things happen, not on a schedule. Phase transitions are too granular (the human doesn't care that the agent entered "planning" phase). Milestones are the events the human actually wants to know about. Time-based updates are noisy for short tasks and insufficient for long ones. Milestone-based is self-adapting to task duration.

---

## 2026-03-08 — Question batching by default

**Decision:** When the Orchestrator encounters multiple questions during a phase, it batches them into one numbered message with a 30-second accumulation window (max 5 questions). Format: numbered list with options. Human replies with "1:A 2:B" or natural language. Batch flushes on window expiry, blocking need, or max size.

**Rationale:** Fewer interruptions for the human. Questions encountered close together are usually related (same decision space). A single message with three questions is easier to answer than three separate messages. The LLM enables flexible response parsing — humans don't need to follow strict format.

---

## 2026-03-08 — Decomposition approval via Safety Layer autonomy system

**Decision:** Decomposition approval integrates into the Safety Layer's existing autonomy boundary system as a new decision category: `task_decomposition`. Default level: `always_ask`. Three configurable levels: always_ask (always approve before decomposing), threshold (ask only above N children), always_decide (full autonomy). The Orchestrator calls `SafetyLayer.evaluate()` and follows the verdict.

**Rationale:** Decomposition is an autonomy decision — "should I restructure the work?" Using the existing autonomy system avoids a parallel config mechanism. The default (always_ask) matches Farzam's preference from Flow 5 and is the conservative choice. Users wanting maximum autonomy can change it. Single source of truth for all autonomy decisions.

---

## 2026-03-08 — task_decomposition as autonomy decision category

**Decision:** Added `task_decomposition` as a new decision category in the Safety Layer's autonomy boundary config, alongside the existing 10 categories (code_style, testing_strategy, etc.). Default level: `always_ask`. This is the 11th default autonomy category.

**Rationale:** Decomposition is a distinct decision type with its own risk profile — it creates new tasks, changes the work structure, and affects project scope. It doesn't fit neatly into existing categories like `architectural` or `refactoring`. A dedicated category gives users fine-grained control over this specific capability.

---

## 2026-03-08 — Git worktrees for task isolation

**Decision:** Use git worktrees (not full clones) for per-task workspace isolation. Each task gets its own worktree sharing the repo's `.git` directory. Worktrees are ephemeral (tied to task lifecycle); branches are the persistent artifacts.

**Rationale:** Worktrees are lightweight, fast to create/destroy, and share the `.git` directory (like OS processes sharing a kernel). In single-core mode, only one task is actively working at a time, but multiple worktrees can coexist on disk (preempted tasks keep their worktrees). Full clones would duplicate the entire `.git` directory for no benefit in our architecture.

---

## 2026-03-08 — Children branch from parent (namespaced)

**Decision:** Child tasks branch from the parent's branch, with namespaced names: `engineer/{parent-id}/{child-id}-{slug}`. Example: `engineer/50-jwt-migration/51-jwt-utils`.

**Rationale:** Namespacing makes the hierarchy visible in branch names. Branching from parent (rather than from main) means children start with the parent's context. Combined with progressive merge, this ensures dependent siblings get prior siblings' actual code.

---

## 2026-03-08 — Progressive merge for child task branches

**Decision:** When a child task completes, its branch is merged into the parent branch immediately — not deferred to Active.Integrating. This means dependent siblings get prior siblings' actual code when they start, because they branch from the (now-updated) parent.

**Rationale:** In the JWT migration example, child #52 (middleware) depends on #51 (JWT utils). If #52 can't access #51's actual code — only a knowledge summary — it can't import the JWT utility functions. Progressive merge solves this naturally: completed work flows into the integration branch (parent), and subsequent children start from there. Active.Integrating becomes lighter — just final verification.

**Alternatives rejected:** All-at-once integration (children can't use each other's code, only knowledge summaries). Direct sibling branching (breaks isolation — children should relate to each other through the parent, not directly).

---

## 2026-03-08 — Multi-repo: interface now, details later

**Decision:** The Workspace Manager defines the multi-repo interface at Layer 2: primary/secondary repo model, same branch name across repos for traceability, Task.workspace extended with `multi_repo` array. Detailed mechanics (cross-repo commit ordering, coordinated PR merge strategy, rollback) are deferred to Layer 3.

**Rationale:** Multi-repo is the extreme case (microservice extraction). The interface must be defined now so the Workspace object schema is complete, but the detailed coordination mechanics involve complex trade-offs (atomic cross-repo operations don't exist in git) that are better resolved with the full interaction protocol context of Layer 3.

---

## 2026-03-08 — Comm plugins are transport, Orchestrator is intelligence

**Decision:** Comm plugins are dumb transport — they send/receive messages and sync state to platforms. All intelligence (query parsing, response composition, notification cadence, disambiguation) lives in the Orchestrator.

**Rationale:** If query parsing lived in each comm plugin, swapping Telegram for Slack would require reimplementing all the intelligence. By keeping comm plugins as pure platform adapters, the Orchestrator's logic works identically regardless of which comm channels are configured. This follows the adapter pattern: consumers interact with the interface, never with the platform directly.

---

## 2026-03-08 — Daemon owns query handling (not Orchestrator)

**Decision:** The Daemon handles all incoming `comm.message_received` events for queries (status, history, etc.) at all times. It reads structured data from Task Engine and Session/Memory, formats responses, and sends them via comm plugins. The Orchestrator is never interrupted for queries.

**Rationale:** The Orchestrator is dispatch-only and stateless — it only exists when the Daemon dispatches it for a task. When no task is Active.Working, there's no Orchestrator to handle queries. Even when the Orchestrator IS running, interrupting it for an unrelated status query would break its phase pipeline. The Daemon is always running and can read the same structured data the Orchestrator would. Query handling is reading + formatting, not intelligence.

**Alternatives rejected:** Orchestrator handles queries (breaks stateless/dispatch-only design). Orchestrator interrupted mid-phase for queries (breaks phase pipeline, adds complexity for no benefit).

---

## 2026-03-08 — Merge conflict resolution via temporary state transition

**Decision:** When a merge conflict occurs during progressive merge (child completing into parent branch), the parent task transitions Active.Supervising → Active.Working temporarily (consuming a working slot), resolves the conflict, then transitions Active.Working → Active.Supervising after resolution.

**Rationale:** Active.Supervising forbids write and git permissions — but resolving a merge conflict IS active work (writing files, committing). The temporary transition is semantically honest and uses the existing permission model. No special-case permissions needed.

**Alternatives rejected:** Special merge-conflict permissions for Supervising (creates permission model exception). Defer all merges to Integrating (breaks progressive merge — dependent siblings don't get prior code).

---

## 2026-03-08 — Event Bus gets Layer 2 design doc

**Decision:** The Event Bus gets a lightweight Layer 2 design doc covering: event model (canonical events + subscription filters), delivery guarantees (at-least-once, per-task ordering), Safety Layer pre-processing hook, and persistence (append-only, replayable). Registry and People Directory are simple enough to define at Layer 3.

**Rationale:** All 7 component designs reference the Event Bus — its delivery semantics, pre-processing hook, and subscription model. Without a formal design, these references point to thin air. The Event Bus is infrastructure that every component depends on; it needs its own specification. Registry and People Directory are simpler (key-value stores) and can be defined inline during Layer 3 interaction protocols.

---

## 2026-03-08 — GitHub state sync via Event Bus subscription

**Decision:** The GitHub comm plugin subscribes to `task.state_changed` events on the Event Bus and syncs internal state to GitHub: labels (`engineer:{state}`), milestone comments on issues, child task checklists on parent issues, and optionally project board columns. All sync behaviors are configurable.

**Rationale:** State sync is a natural comm plugin responsibility — it's the GitHub "channel" keeping its representation current. Using Event Bus subscription (rather than having the Task Engine or Orchestrator push to GitHub directly) preserves decoupling — no component needs to know about GitHub labels. The sync is the GitHub plugin's business.

---

## 2026-03-08 — Action Pipeline replaces Event Bus pre-processing

**Decision:** Replace the Safety Layer's Event Bus pre-processing hook with an Action Pipeline (middleware chain). Derived from auth middleware systems (HTTP middleware chains, Kubernetes admission controllers, Linux DAC + LSM hooks, API gateways). Every side-effecting action flows through: Gate 1 (Task Engine: state+action class legality) → Gate 2 (Safety Layer: scope, cost, autonomy policy) → Execute → Notify (post-action event on Event Bus). The Event Bus becomes pure pub/sub with no synchronous interception. All events are post-action notifications.

**Rationale:** The Layer 2 design had the Safety Layer intercepting events (`git.pushed`, `git.merge`, `deploy.requested`) on the Event Bus synchronously before delivery. This created a timing ambiguity: events named in past tense were intercepted before the action happened. The middleware pattern — proven in HTTP stacks, Kubernetes, Linux security, and API gateways — cleanly separates pre-action checking (pipeline) from post-action notification (events). Defense-in-depth is maintained through two pipeline gates that both must pass. The Event Bus is simplified: no pre-processing, no synchronous delivery, no vetoed event status.

**Alternatives rejected:** (1) Intent events — separate pre-action request events (`git.push_requested`) + completion events (`git.pushed`). Clean but doubles event count. (2) Dual-purpose events — same event serves as both request and notification. Simpler event count but confusing semantics. (3) Pipeline + Event Bus safety net — keep Event Bus pre-processing as belt-and-suspenders. Adds complexity for marginal safety benefit (post-action veto can't undo the action).

## 2026-03-08 — One plugin per adapter, not per platform

**Decision:** Each plugin is an independent adapter implementing exactly one contract. A platform like GitHub provides three separate plugins (GitHubTriggerPlugin, GitHubCommPlugin, GitHubHostingPlugin), each registered independently, each replaceable independently. No multi-contract plugins. Mix and match freely: GitHub triggers + GitLab hosting + Slack comms is a valid configuration.

**Rationale:** The entire point of the plugin architecture is modularity and OSS accessibility. Users must be able to plug in and swap out any individual functionality without affecting others. Separation of concerns at the integration boundary means each adapter does one thing, each contract is focused and testable, and the barrier to building new plugins is low. Consolidating multiple contracts into one plugin would create coupling that defeats the purpose.

**Alternatives rejected:** Multi-contract plugins (one GitHubPlugin implementing Trigger + Comm + Hosting). Simpler to manage as one unit, but creates coupling — can't swap just the comm layer without removing the trigger layer too. Violates separation of concerns.

## 2026-03-08 — Health events formalized as `health.*` group

**Decision:** Add formal `health.stuck_detected` and `health.trigger_failure` events to the Event Catalog. Daemon's health monitoring alerts are first-class events (not just internal operational logging). Subscribers: Comm Plugin (alert owner). Total catalog: 28 events, 10 groups.

**Rationale:** Observability is a core goal. Health anomalies (stuck tasks, failing triggers) should be as observable as any other system event. Making them first-class events ensures they appear in the event stream audit trail and can be routed through any comm plugin.

## 2026-03-08 — Minimal tool contract (safety integration, not behavior prescription)

**Decision:** Tool Plugin contract is minimal: `execute(action, params) -> ToolResult` + action class declaration + side effects reporting. The contract focuses on safety integration (Action Pipeline gating, side effects audit) rather than prescribing tool behavior or capability categories. The agent can self-extend by creating new tools at runtime.

**Rationale:** PI-Inspired Minimalism says "few broad tools, not many narrow ones." Bash is the meta-tool. Over-specifying tool categories (filesystem, network, shell, search) would constrain how the agent composes operations and what tools it can create. The contract needs to integrate with the safety system (action classes → Gate 1, side effects → audit) without dictating tool internals.

## 2026-03-08 — LLM cost reporting is contractual

**Decision:** Every `CompletionResult` from an LLM provider plugin MUST include usage data (tokens_in, tokens_out, and provider-specific cost/remaining data). This is non-negotiable — it is the bridge between LLM providers and the Safety Layer's cost tracking system.

**Rationale:** The cost tracking architecture depends on `cost.incurred` events flowing from every LLM call. The Orchestrator constructs these events from `CompletionResult.usage`. If a provider can't report usage, the safety system can't enforce cost limits. Making this contractual (not optional) ensures every provider — CLI or API — contributes to cost visibility.

## 2026-03-08 — People Directory is skeleton, not plugin

**Decision:** People Directory is a skeleton component (always present, config-driven). It does not register in the Registry. It provides a query interface for looking up people by ID or role, resolving contact info per channel.

**Rationale:** The People Directory is infrastructure that every component depends on (Orchestrator, Task Engine, Comm Plugins, Daemon). It's not swappable or optional — every installation needs to know who to contact. Making it a plugin would add registration overhead for something that's always present. It's analogous to the Event Bus: structural, not variable.

## 2026-03-08 — Cost limit auto-resume is configurable per limit

**Decision:** Each cost limit can have an `auto_resume_on_reset: boolean` (default: false). When true, tasks blocked by that limit automatically re-enter Queued when the time window resets. When false (default), the task stays Blocked and the human is notified that the limit has reset.

**Rationale:** Balances overnight autonomy (opt-in) with surprise spend prevention (default). Different limits warrant different behavior — a per-task limit reset is low risk, a monthly global reset warrants human awareness. Making it configurable per limit gives users fine-grained control without a one-size-fits-all policy.

## 2026-03-08 — Read operations go through Gate 1 only, skip Gate 2

**Decision:** Read operations (`read` action class) go through Gate 1 (Task Engine permission check) but skip Gate 2 (Safety Layer). This is defense-in-depth: terminal states deny reads via the permission table even though the Orchestrator architecturally shouldn't be running in those states.

**Rationale:** Reads have no side effects — they don't need scope, cost, or autonomy checks from the Safety Layer. But the permission table exists and reads ARE denied in Completed/Failed states, so we enforce it via Gate 1 as a safety net. Skipping Gate 2 for reads avoids unnecessary overhead on the most frequent operation the agent performs.

## 2026-03-08 — LLM fallback for natural language response parsing

**Decision:** When a human responds to a batched question in natural language instead of numbered format (e.g., "Go with JWT and shorter expiry" instead of "1:A 2:B"), the Orchestrator tries structured parsing first, then falls back to LLM to map natural language responses to original questions. This is the only LLM usage in the communication path — the Daemon's query handler (P14) remains LLM-free.

**Rationale:** Real engineers don't force rigid formats on their teammates. Structured parsing is tried first (cheap, fast, deterministic). LLM is used only when structured parsing fails. The cost is minimal (one small LLM call for parsing) and the UX improvement is significant — humans can reply naturally without learning a syntax. The Daemon's query handler stays LLM-free because queries are simpler (keyword matching) and must work even when the Orchestrator/LLM is unavailable.

## 2026-03-08 — Shutdown timeout owned by Daemon config

**Decision:** The `shutdown_timeout` (default: 30 seconds) — how long the Daemon waits for the Orchestrator to checkpoint during graceful shutdown before force-terminating — is a Daemon config parameter, not a Safety Layer config parameter.

**Rationale:** Process lifecycle management is the Daemon's domain. This config lives alongside `tick_interval`, `preemption_timeout`, `stuck_threshold`, and other process-management parameters. The Safety Layer owns timeout policy for human response wait times (reminder, self-unblock, alert thresholds), which are about autonomy and communication cadence — a fundamentally different concern. Shutdown timeout is about operational process management.

---

## 2026-03-08 — Event Bus down = system halt (#53)

**Decision:** If Event Bus storage becomes inaccessible mid-operation, the system halts: checkpoint active tasks, stop accepting new work, alert human. No degraded-continue mode.

**Rationale:** The audit trail is a safety requirement (from `philosophy.md`: full transparency, full auditability). Without Event Bus persistence: cost tracking drifts (Safety Layer accumulators stale), notifications stop, scheduling breaks. The Action Pipeline technically still works (synchronous calls), but cost checks use stale data, risking silent over-spend. Operating without audit guarantees violates the system's integrity contract.

**Alternatives rejected:** Continue degraded (saves progress but risks unaudited actions and unbounded cost). The safety-over-progress principle applies.

---

## 2026-03-08 — LLM provider auto-failover (#54)

**Decision:** When the active LLM provider fails, the Daemon automatically switches to the next provider in a configured priority list. Task continues with the new provider. Cost tracking updates to the new `provider_id`. Human notified of the switch via milestone notification but work doesn't stop.

**Rationale:** LLM provider outages are transient and common. Blocking work and waiting for human intervention every time a provider hiccups creates unnecessary downtime. Auto-failover is what a real engineer would do — switch tools and keep working. The priority list lets users express provider preference (cost, quality, speed) while maintaining continuity. If no fallback is configured, the system degrades gracefully (stuck detection → health alert → human intervention).

---

## 2026-03-08 — Comm plugin fallback chains via People Directory (#55)

**Decision:** People Directory `contacts[]` is an ordered list of channel preferences per person. When sending a message, the system tries channels in order. If the primary channel's comm plugin fails, it tries the next channel. This resolves the open question from `plugin-contracts.md`.

**Rationale:** Reliable communication is critical for blocking questions, alerts, and notifications. Fallback ordering is per-person (not system-wide) because different people have different channel preferences. The ordered list is explicit configuration — no automatic discovery or guessing. Comm plugins remain dumb transport; the fallback logic lives in the Daemon/Orchestrator.

---

## 2026-03-08 — Config reload failure triggers health alert (#56)

**Decision:** When Safety Layer or People Directory config hot-reload fails validation, the component keeps the previous valid config and emits a `health.config_reload_failed` event. Comm Plugin subscribes and alerts the human.

**Rationale:** Stale config is a degraded state — the system operates safely (previous config is valid) but may not reflect intended policy changes. Silent failure would leave the human unaware that their config change didn't take effect. A health event makes the failure visible through the standard alerting path.

---

## 2026-03-08 — Checkpoint without LLM (minimal checkpoint) (#57)

**Decision:** When the LLM provider is unavailable, the Orchestrator creates a minimal checkpoint: phase, workspace state (branch, HEAD SHA), raw phase data, open questions — but without the narrative `context_summary` field (which requires LLM generation). Resume from a minimal checkpoint has degraded quality but is possible — the Orchestrator works from `next_action` and workspace state instead of full narrative context.

**Rationale:** Checkpointing should never be blocked by LLM unavailability. The checkpoint's purpose is resume safety — even a degraded checkpoint is better than no checkpoint. The `context_summary` is the highest-quality resume path, but the other checkpoint fields (phase, key_findings, next_action, workspace state) provide enough signal for the Orchestrator to reconstruct working context. This is the Degrade-and-continue pattern applied to checkpointing.

---

## 2026-03-08 — GitHub state reconciliation on plugin recovery (#58)

**Decision:** When the GitHub comm plugin recovers from an outage, it automatically reconciles state: compares Task Engine state vs GitHub labels for all active tasks, updates mismatched labels, and posts catch-up comments for missed milestones. Reconciliation runs once on recovery, not continuously.

**Rationale:** GitHub state (labels, comments) drifts during comm plugin outages because internal state (Task Engine) is authoritative and continues to change. Without reconciliation, GitHub would show stale labels indefinitely until the next state change for each task. Automatic reconciliation on recovery keeps GitHub in sync without manual intervention. Running once (not continuously) avoids unnecessary API calls during normal operation.

---

## 2026-03-08 — Three-tier architecture: Core / Adapter / Plugin (#59)

**Decision:** Formalize the implicit three-tier model: Core (invariant brain and infrastructure — 9 components), Adapter (stable integration contracts at the boundary — 5 types today, open-ended), Plugin (interchangeable implementations that satisfy adapter contracts). This refines the original "skeleton vs plugin" two-tier model by recognizing that adapter contracts are a distinct architectural tier. The adapter tier is open by design — new adapter types can be added as needs evolve without changing Core or existing adapters.

**Rationale:** The three-tier model was already present implicitly — `plugin-contracts.md` used "adapter" 14+ times, Decision #43 is "one plugin per adapter." Formalizing it makes the boundary explicit for contributors: you code against the adapter contract, not against Core internals. This is critical for OSS accessibility — a contributor building a Jira trigger plugin or a Slack communication plugin needs only the adapter contract, not knowledge of the Orchestrator, Task Engine, or Event Bus.

**Alternatives rejected:** (1) Keep two-tier with better docs — misses the conceptual distinction between contract and implementation. (2) Four-tier with separate "infrastructure" tier for Event Bus/Registry — over-segmentation; these are Core.

---

## 2026-03-08 — Explicit adapter naming with full names (#60)

**Decision:** Adapters use full, proper names: TriggerAdapter, CommunicationAdapter, LLMAdapter, ToolAdapter, GitHostingAdapter. Base contract: Adapter. Error contract: AdapterError. Plugins implement adapters: `GitHubTriggerPlugin implements TriggerAdapter`. No abbreviations — clarity from bottom to top.

**Rationale:** Naming must be precise and self-documenting. `CommunicationAdapter`, not `CommAdapter`. When you read the name, you know exactly what it is. This is an architecture designed for long-term maintainability and large OSS contribution — every name should communicate clearly to someone encountering it for the first time.

---

## 2026-03-08 — "Skeleton" terminology evolves to "Core" (#61)

**Decision:** The formal tier name is "Core." Historical docs (Layer 0 foundation) retain "skeleton" with an evolution note pointing to `architecture-tiers.md`. All other docs updated to use "Core."

**Rationale:** "Core" communicates the concept more directly to new contributors. "Skeleton" was effective during early design (skeleton + flesh metaphor) but "Core" is the more standard architectural term (core/periphery, core/adapter/plugin). The evolution is additive — "skeleton" is documented as the original term.

---

## 2026-03-08 — Optional adapter methods via capability gates (#62)

**Decision:** Platform-specific methods that Core calls (reconcileState, commentOnIssue, createIssue, etc.) are optional methods on the adapter contract, gated by the adapter's `capabilities` field. Core checks capability before calling. For CommunicationAdapter: `"sync"` capability requires `syncTaskState()` and `reconcileState()`; `"issue_management"` capability requires `commentOnIssue()`, `createIssue()`, `updateIssue()`.

**Rationale:** Different platforms support different features. A Telegram plugin doesn't have issues or labels — it shouldn't be forced to implement issue management methods. Capability gates let adapters declare what they support and let Core discover it at runtime. This is more maintainable than separate extension interfaces (which would proliferate) and more explicit than duck-typing. Existing plugins that don't declare a new capability are never asked to implement it — making contract evolution non-breaking.

---

## 2026-03-08 — Adapter contracts and plugin implementations co-located (#63)

**Decision:** `adapter-contracts.md` (renamed from `plugin-contracts.md`) contains both adapter contracts (stable interfaces) and plugin implementation documentation. Clear framing distinguishes the two. Not split into separate files.

**Rationale:** "Say it once." A contributor building a new plugin needs both the adapter contract (what to implement) and existing implementation examples (how others did it) in one reading flow. Splitting into `adapter-contracts.md` + `plugin-guide.md` would create duplication and cross-referencing overhead. Clear section headers achieve the separation without file proliferation.

---

## 2026-03-08 — Future adapter types deferred to Layer 4, adapter tier open-ended (#64)

**Decision:** Workflow Phases and Observability Backends (listed in overview.md) do not yet have adapter contracts. Flagged in `architecture-tiers.md` as future adapter types to be defined during Layer 4 (Implementation Design). The adapter tier is explicitly designed as open-ended — new adapter types beyond these two can be added as The Engineer's capabilities evolve.

**Rationale:** Workflow phase contracts depend on Orchestrator implementation details not yet specified. Observability contracts depend on the monitoring stack not yet chosen. Defining placeholder contracts now would be speculative. More importantly, the architecture must not assume these are the only future adapter types — The Engineer's needs will evolve in ways we cannot fully predict. The pattern for adding new adapter types (define contract extending Universal Adapter Contract, register type in Registry) is well-established and low-impact.

---

## Layer 4 — Implementation Design

> Decisions #65–#74. All choices serve two masters: works for v1 (single user, single process) AND doesn't block future evolution (multi-threaded, multi-user, scaled). Reference project: [OpenClaw](https://github.com/openclaw/openclaw).

---

## 2026-03-09 — TypeScript as primary language (#65)

**Decision:** TypeScript is the primary implementation language for The Engineer.

**Rationale:** Strong type system enforces our 30 event types, 5 adapter contracts, and state machine transitions at compile time. Native event loop matches event-driven architecture. Scales via `worker_threads` for future multi-threading.

**Alternatives rejected:** Python (weaker typing, GIL), Go (weaker plugin/dynamic loading, verbose for nested schemas), Rust (overkill for I/O orchestration system).

---

## 2026-03-09 — Node.js 22 LTS (#66)

**Decision:** Node.js 22 LTS as the runtime. Active LTS through October 2027.

**Rationale:** Native ESM support (stable), `worker_threads` for future parallelism, `node:sqlite` maturing as future built-in option.

---

## 2026-03-09 — pnpm as package manager (#67)

**Decision:** pnpm for package management.

**Rationale:** Fast, disk-efficient, strict dependency resolution catches phantom dependencies. Built-in workspace support for future monorepo. Validated by OpenClaw.

**Alternatives rejected:** npm (slower, less strict), bun (less mature lockfile ecosystem).

---

## 2026-03-09 — ESM only (#68)

**Decision:** ES Modules exclusively. No CommonJS. `"type": "module"` in package.json.

**Rationale:** Modern Node.js standard. Clean dynamic `import()` for plugin loading — critical for our adapter/plugin system. Tree-shaking support for production builds.

---

## 2026-03-09 — SQLite via better-sqlite3 (#69)

**Decision:** SQLite (via `better-sqlite3`) as the storage backend for Task Engine, Event Bus, and Session/Memory.

**Rationale:** Zero-config, embedded, single file. WAL mode for concurrent reads + single writer (matches single-daemon design). Handles millions of rows. Portable — DB file moves with the project. "Design for one person first" (goals.md). Behind interfaces — swappable to PostgreSQL or `node:sqlite` when concurrency demands it. The bottleneck is LLM calls (95%+ of task time), never storage throughput.

**Alternatives rejected:** PostgreSQL (requires server, overkill for single-user), file-based JSON/JSONL (no indexing/transactions), `node:sqlite` built-in (still experimental).

---

## 2026-03-09 — tsx (dev) + tsdown (production builds) (#70)

**Decision:** `tsx` for development (fast TS execution, watch mode), `tsdown` for production builds (optimized bundles via esbuild).

**Rationale:** Development needs speed (tsx runs TS directly). Production needs optimization (tsdown tree-shakes, bundles). Both TypeScript-first, well-maintained. tsdown validated by OpenClaw.

---

## 2026-03-09 — Biome for linting & formatting (#71)

**Decision:** Biome as the single linting and formatting tool.

**Rationale:** Replaces ESLint + Prettier with one tool, one config. Rust-based — 10-100x faster. Prettier-compatible formatter. Growing adoption.

**Alternatives rejected:** oxlint + oxfmt (two separate tools), ESLint + Prettier (slower, more configuration).

---

## 2026-03-09 — Zod for runtime validation (#72)

**Decision:** Zod for runtime validation of event payloads, adapter responses, and config schemas.

**Rationale:** TypeScript types only exist at compile time. At runtime — when events flow through Event Bus, adapters return data, config files load — we need validation. Zod schemas infer TypeScript types automatically (`z.infer<typeof schema>`). Composable, zero dependencies, excellent error messages. De facto standard.

---

## 2026-03-09 — Vitest for testing (#73)

**Decision:** Vitest as the test framework.

**Rationale:** Fast, TypeScript-native (no compilation step for tests). Parallel test execution, built-in coverage via v8. Supports multiple configs (unit, e2e, integration) via workspaces. Jest-compatible API. Validated by OpenClaw.

---

## 2026-03-09 — Polling-only triggers for v1 (#74)

**Decision:** GitHub API polling at configurable intervals for v1. No HTTP server, no webhooks, no exposed ports.

**Rationale:** Zero cost (GitHub free tier: 5,000 req/hr, polling uses ~120 req/hr). Zero infrastructure (runs locally). Simple to develop and debug. 30-second latency is negligible for tasks taking minutes to hours. TriggerAdapter contract already supports adding webhook plugins later without changing Core.

**Alternatives rejected:** Webhooks (requires exposed endpoint, tunnel setup, infrastructure cost). Deferred to future optimization.

---

## 2026-03-09 — ULID for all entity IDs (#75)

**Decision:** ULID (Universally Unique Lexicographically Sortable Identifier) for all entity IDs. Exception: KnowledgeEntry uses content hash (SHA-256, 32-char hex).

**Rationale:** Time-sortable (`ORDER BY id` = chronological), globally unique, 26-char Crockford Base32. One ID format everywhere reduces cognitive overhead. Knowledge uses content hash because immutability and version tracking are more important than time-ordering — updating a knowledge entry creates a new entry with a new hash.

---

## 2026-03-09 — ISO 8601 strings for all timestamps (#76)

**Decision:** All timestamps stored as ISO 8601 strings (TEXT in SQLite, `z.string().datetime()` in Zod).

**Rationale:** Human-readable in database inspection. SQLite's built-in `datetime()`, `julianday()`, and comparison operators work natively with ISO 8601. Standard across every language and system.

---

## 2026-03-09 — String literal enums, lowercase_snake_case (#77)

**Decision:** All enums are TypeScript string literal unions, stored as TEXT in SQLite. Values use lowercase_snake_case.

**Rationale:** L2 docs used mixed case (`Review_Pending`, `Working`) and hyphens (`pause-siblings`, `git-local`). Normalized to `review_pending`, `working`, `pause_siblings`, `git_local` for TypeScript identifier compatibility and consistency. String literals are readable in database queries — no integer-to-meaning lookup.

---

## 2026-03-09 — Zod-first with mandatory named type aliases (#78)

**Decision:** Zod schemas are the single source of truth. TypeScript types always derived via `z.infer<typeof Schema>`. Named type aliases are mandatory — no anonymous `z.infer` in function signatures.

**Rationale:** Single source of truth prevents type drift. Named aliases provide IDE hover information, error messages, and documentation.

---

## 2026-03-09 — 7 SQLite tables + _meta (#79)

**Decision:** 7 entity tables (tasks, state_transitions, events, sessions, journal_entries, checkpoints, knowledge) plus a `_meta` table for schema versioning and system-level key-value storage.

**Rationale:** Each table corresponds to a domain entity with its own query patterns. _meta provides schema migration tracking and safety accumulator snapshots.

---

## 2026-03-09 — Task cost as real columns (#80)

**Decision:** `llm_tokens` (INTEGER), `llm_cost_usd` (REAL), and `compute_time_ms` (INTEGER) as real columns on the tasks table, not embedded in a JSON cost object.

**Rationale:** Hot-path optimization. These counters are updated on every LLM call. JSON columns require deserializing the entire task row, modifying, and writing back. Real columns allow `UPDATE tasks SET llm_tokens = llm_tokens + ? WHERE id = ?`.

---

## 2026-03-09 — State transitions in separate table (#81)

**Decision:** State transitions stored in a separate `state_transitions` table, not as an embedded `history` array on the Task object (as L2 defined).

**Rationale:** Enables cross-task audit queries (`SELECT * FROM state_transitions WHERE to_state = 'blocked'`). Append-only table is natural for audit trails. Per-task history: `SELECT * FROM state_transitions WHERE task_id = ? ORDER BY timestamp`.

---

## 2026-03-09 — Event payloads as JSON blob + mapped type (#82)

**Decision:** Single `events` table for all 30 event types. Payload stored as JSON TEXT column. Per-type Zod schemas with a mapped type (`EventPayloads["cost.incurred"]`) for type-safe access.

**Rationale:** One table is simpler than 30 tables. JSON payloads are flexible for new event types. The mapped type provides compile-time type safety without a 30-variant discriminated union.

---

## 2026-03-09 — Knowledge: natural key + content hash (#83)

**Decision:** Knowledge entries identified by content hash (`hash(scope + key + body)`, 32-char hex). Stable logical key is `(scope, repo_scope, key)`. Updating a knowledge entry creates a new entry; old entry gets `superseded_by` pointing to the new one.

**Rationale:** Immutable entries with clean audit trail. You can always see what the system used to know. Content hash ensures identical knowledge is never stored twice.

---

## 2026-03-09 — Safety accumulator snapshots in _meta (#84)

**Decision:** Safety Layer cost accumulators are ephemeral (rebuilt from events on startup), but with periodic snapshots stored in `_meta` for fast recovery.

**Rationale:** Pure event replay is an anti-pattern at scale — startup time grows linearly with event volume. Snapshots provide O(1) startup with incremental replay. Full replay is the safe fallback if snapshot is missing or corrupt.

---

## 2026-03-09 — Phase outputs use .safeParse() (#85)

**Decision:** Orchestrator phase outputs validated with Zod `.safeParse()` + fallback handling, not hard `.parse()` gates.

**Rationale:** Phase outputs are LLM-generated. LLM output is unreliable — wrong field names, missing fields, unexpected types. Schemas document the expected shape; the code handles deviations gracefully. Hard parse would crash the pipeline on minor LLM mistakes.

---

## 2026-03-09 — Durations as milliseconds (#86)

**Decision:** All duration values stored as milliseconds (INTEGER in SQLite, `z.number().int()` in TypeScript). Human-readable config values (e.g., `"4h"`, `"30s"`) parsed at config load time only.

**Rationale:** Consistent arithmetic, no runtime parsing. Config files are the only place humans see durations — everywhere else is integers.

---

## 2026-03-09 — Event envelope simplified per L3 (#87)

**Decision:** Event envelope does not include `status` or `veto_reason` fields. L3's Action Pipeline replaced L2's Event Bus pre-processing model. Pipeline rejections are logged as `action.rejected` events.

**Rationale:** L3 superseded L2's design. The Event Bus is pure pub/sub — no pre-processing, no vetoing on the bus itself. Safety checks happen in the Action Pipeline (Gate 2), not on the Event Bus.

---

## 2026-03-09 — Enum values normalized to lowercase_snake_case (#88)

**Decision:** All enum values from L2/L3 normalized to lowercase_snake_case in concrete schemas.

**Rationale:** L2 used mixed conventions (`Review_Pending`, `Working`, `pause-siblings`). Concrete schemas use a single convention: `review_pending`, `working`, `pause_siblings`. Consistency reduces cognitive load and prevents string matching bugs.

---

## 2026-03-09 — Strictest enforcement through tooling (#89)

**Decision:** Every code quality rule enforced by automated tooling that cannot be bypassed. Agents (and humans) MUST fix issues because they literally cannot continue.

**Rationale:** AI-driven development insight — agents inadvertently skip formatting, leave unused imports, miss dead code. Leveraging pre-commit hooks (Biome format + type check), pre-push hooks (tests must pass), and Zod runtime validation at boundaries creates non-bypassable enforcement. Detailed tooling design deferred to Sessions 25 (hooks, Biome, tsconfig) and 28 (tests, coverage).

---

## Layer 4 — Project Layout & Config Format

> Decisions #90–#101. Config file system, source directory layout, and enforcement tooling. Every choice supports a single principle: strictest enforcement that doesn't block future evolution.

---

## 2026-03-09 — YAML for all config files (#90)

**Decision:** All config files use YAML (`.yaml` extension). Parser: `yaml` npm package.

**Rationale:** Configs are deeply nested (SafetyConfig has 5 sections with sub-objects) — YAML handles this cleanly. Comments are essential for config files (JSON disqualified). Duration strings like `"4h"` read naturally. Norway problem (`NO` → `false`) is irrelevant — Zod validates every field at load time.

**Alternatives rejected:** JSON5 (OpenClaw uses it, but less readable for deep nesting), TOML (verbose for nested structures), JSON (no comments).

---

## 2026-03-09 — Multi-file config organization (#91)

**Decision:** Separate config files per concern in `~/.engineer/config/`: `daemon.yaml`, `orchestrator.yaml`, `safety.yaml`, `workspace.yaml`, `people.yaml`, plus `plugins/` directory for per-plugin configs.

**Rationale:** Hot-reload precision — the watcher knows exactly which config changed, no need to re-parse everything. Safety and People configs change independently. Plugin configs are naturally per-plugin. 6 files + a plugins directory is manageable.

**Alternatives rejected:** Single `engineer.yaml` with sections (hot-reload must re-parse entire file).

---

## 2026-03-09 — Config location and discovery (#92)

**Decision:** Default config directory: `~/.engineer/config/`. Override via `ENGINEER_CONFIG_DIR` environment variable. Fixed paths — no merging, no layering, no per-project overrides for v1.

**Rationale:** Simplicity for v1 (single user, single machine). Per-project overrides add layering complexity without v1 value. The env var override supports different setups (CI, testing, multiple instances).

---

## 2026-03-09 — Defaults in Zod schemas (#93)

**Decision:** Config defaults live in Zod schemas via `.default()`. Config files only need to specify overrides. Missing config file = system runs with all defaults.

**Rationale:** Single source of truth for defaults (in the schema, not duplicated in template files). Out-of-the-box behavior without requiring config file creation. Zod `.default()` integrates naturally with the validation pipeline.

---

## 2026-03-09 — Hot-reload for safety and people configs (#94)

**Decision:** `safety.yaml` and `people.yaml` are hot-reloadable via `node:fs.watch()` with 500ms debounce. All other configs are startup-only. Plugin configs are not hot-reloadable in v1. Invalid reload → keep previous config, emit alert event.

**Rationale:** Safety and People configs are explicitly designed for hot-reload in L2/L3 (cost limits need adjustment without restart, people contacts change). Daemon/Orchestrator/Workspace configs control system behavior that shouldn't change mid-operation (tick intervals, phase behavior, branch naming). The 500ms debounce handles editor autosave and atomic write patterns.

---

## 2026-03-09 — Config error handling: startup vs hot-reload (#95)

**Decision:** Invalid config on startup = refuse to start with clear Zod error. Missing config on startup = use all Zod defaults. Invalid config on hot-reload = keep previous valid config, emit alert event.

**Rationale:** Startup is the safe place to fail — the system isn't running yet, clear errors help the user fix the issue. Hot-reload must be resilient — a typo in a config edit shouldn't crash a running system with active tasks.

---

## 2026-03-09 — Secrets via environment variables (#96)

**Decision:** Config files reference secrets using `${ENV_VAR_NAME}` syntax. Resolved at load time before Zod validation. Config files never contain actual secrets.

**Rationale:** Config files are safe to version control. Env vars are the standard secret injection mechanism. Missing env var = clear error at load time. No need for encrypted config files or secret management services for v1.

---

## 2026-03-09 — Duration parsing via ms package (#97)

**Decision:** Human-readable duration strings (`"4h"`, `"30s"`, `"2m"`) in config files parsed to milliseconds at load time using the `ms` npm package.

**Rationale:** `ms` is tiny (zero deps, ~50 lines), widely used (~100M weekly downloads), handles all common duration formats. Integrates with Decision #86 (durations as milliseconds internally) — config files are the only place humans write durations in readable format.

---

## 2026-03-09 — tsconfig: maximum strictness (#98)

**Decision:** TypeScript strict mode with additional aggressive flags: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`. Unused locals/parameters delegated to Biome.

**Rationale:** Decision #89 (strictest enforcement). `noUncheckedIndexedAccess` catches unguarded array/record access — critical for a system with 30 event types and dynamic lookups. `exactOptionalPropertyTypes` distinguishes "key absent" from "key is undefined" — important for our config merging and partial updates. Biome handles unused code checks faster (runs on staged files only in pre-commit).

---

## 2026-03-09 — Biome all preset (#99)

**Decision:** Start with Biome's `all` lint preset (every rule enabled). Carve specific exceptions as needed during implementation. Format: 2-space indent, 100-char lines, trailing commas, semicolons always.

**Rationale:** Decision #89 — start strictest, relax intentionally. `noExplicitAny` is non-negotiable for our contract-heavy architecture. Starting with `all` ensures we don't miss rules; exceptions are documented with rationale.

**Alternatives rejected:** `recommended` + extras (might miss rules we should have).

---

## 2026-03-09 — lefthook for git hooks (#100)

**Decision:** lefthook manages git hooks. Go binary — fast startup, YAML config, parallel command execution.

**Rationale:** No Node.js boot overhead for hook execution (Go binary starts instantly). YAML config aligns with our config format. Parallel execution means Biome and tsc run simultaneously in pre-commit.

**Alternatives rejected:** husky (JS-based, slower startup), simple-git-hooks (no parallel execution).

---

## 2026-03-09 — Enforcement pipeline: pre-commit and pre-push (#101)

**Decision:** Pre-commit (parallel): Biome check on staged files + tsc --noEmit (full type check, incremental). Pre-push: Vitest full test suite. The Engineer (the agent) MUST NOT bypass hooks.

**Rationale:** Detailed design for Decision #89. Type check in pre-commit prevents accumulating type errors across commits (2-5 second cost is worth it). Biome catches formatting and lint instantly. Tests run at push time (slower, but catches logic errors before code leaves the machine). The agent cannot use `--no-verify` — this is the core enforcement mechanism.

---

## 2026-03-09 — Plugin manifest as standalone file: engineer.plugin.yaml (#102)

**Decision:** Each plugin directory contains an `engineer.plugin.yaml` file — metadata separate from code. Universal fields (id, type, version, name, description, critical, enabled, entry) plus nested `adapter_meta` for type-specific static metadata. `enabled` field lives in manifest only. Config schema in manifest is JSON Schema derived from Zod via `zod-to-json-schema`.

**Rationale:** Adopted from OpenClaw pattern. Enables discovery without loading code, enable/disable toggle without code changes, config schema pre-validation, and machine-readable metadata for future tooling. Nested `adapter_meta` keeps universal namespace clean. Zod in code is source of truth for runtime validation; JSON Schema in manifest is the derived representation.

---

## 2026-03-09 — Five-phase plugin loading sequence (#103)

**Decision:** Registry loads plugins in five phases: Discover (scan for engineer.plugin.yaml, skip disabled), Validate (unique IDs, valid type, semver, entry exists), Order (type-based: Communication → LLM → Tool → GitHosting → Trigger), Load (dynamic import, factory function), Initialize (load user config, validate, resolve secrets, call initialize). Discovery path configurable via `plugins.dirs` in daemon.yaml. Plugins grouped by adapter type in directory structure.

**Rationale:** Aligns with P1 startup protocol. Type-based ordering ensures dependencies are ready before dependents (triggers last — they produce work immediately). Factory function export allows async setup and implementation flexibility. YAML manifest is source of truth; Registry injects manifest into plugin instance.

---

## 2026-03-09 — Abstract classes for adapter contracts (#104)

**Decision:** Adapter contracts implemented as abstract class hierarchy: BaseAdapter → {TriggerAdapter, CommunicationAdapter, LLMAdapter, ToolAdapter, GitHostingAdapter}. BaseAdapter provides manifest storage, `hasCapability()`, and template methods (initialize wraps doInitialize, shutdown wraps doShutdown). Plugins export factory function `createPlugin(): Adapter`.

**Rationale:** Abstract classes carry shared implementation (no duplication across plugins), enable `instanceof` checks at runtime (Registry type-safe lookup), and enforce method implementation at compile time. Template method pattern guarantees timing/logging/error handling. Single inheritance constraint is acceptable given Decision #43 (one plugin per adapter).

---

## 2026-03-09 — Plugin SDK boundary: src/adapters/index.ts (#105)

**Decision:** `src/adapters/index.ts` is the curated re-export surface for plugin authors. Exports: BaseAdapter, all 5 adapter abstract classes, all shared types/Zod schemas from schemas/adapters.ts, error helper `createAdapterError()`, and needed event payload types (TaskStateChangedPayload). Does NOT export Core internals, Event Bus APIs, database access, or config system. New files: `base.ts`, `errors.ts`.

**Rationale:** Concrete implementation of the accessibility promise. Plugin authors import everything from one file. This is the future `packages/plugin-sdk/` extraction point. Event payload types are included only where plugins actually need them (comm plugins with sync capability).

---

## 2026-03-09 — Plugin health state machine (#106)

**Decision:** Three health states: healthy → unhealthy (1 failed check) → failed (N consecutive failures, default 3). No automatic re-initialization for v1 — alert human and wait. Per-type failure response: triggers stop polling, LLM triggers failover, comm falls back to next channel. Shutdown in reverse initialization order (triggers first, comm last).

**Rationale:** Simple three-state model covers all cases. Manual recovery for v1 avoids masking underlying issues (expired credentials, service permanently down). Reverse shutdown order keeps communication available for error alerts during shutdown. Staggered health checks prevent burst load.

---

## 2026-03-09 — Plugin lifecycle config in daemon.yaml (#107)

**Decision:** Plugin lifecycle settings in `daemon.yaml` under `plugins` section: `dirs` (discovery paths, default ["src/plugins"]), `health_check_interval_ms` (60s), `health_check_timeout_ms` (5s), `consecutive_failures_threshold` (3). All fields have `.default()` values.

**Rationale:** Lifecycle settings are Daemon concerns (Daemon owns plugin lifecycle via Registry). Configurable discovery path prepares for future third-party plugins without premature complexity. Default thresholds are conservative — 3 consecutive failures before marking failed gives transient issues time to resolve.

---

## 2026-03-09 — Process safety rules for child process spawning (#108)

**Decision:** Five rules: (1) Explicit shell via `spawn("bash", ["-c", cmd])`, never `shell: true`. (2) Signal forwarding — SIGTERM/SIGINT to children, SIGKILL on timeout. (3) Workspace confinement — BashToolPlugin sets `cwd` to task workspace. (4) Environment allowlist — PATH, HOME, NODE_ENV, LANG, TERM, git vars, plus configurable `env_passthrough`. (5) Output size limits — default 10MB max stdout/stderr, process terminated on exceed.

**Rationale:** Explicit bash prevents platform-dependent shell behavior (LLM generates bash syntax). Allowlist over denylist prevents accidental secret leakage. Workspace confinement at plugin level, verified by Safety Layer scope rules. Output limits prevent runaway commands from exhausting memory. New dependency: `zod-to-json-schema` for generating manifest JSON Schema from Zod.

---

## Layer 4 — Deployment & Operations

> Decisions #109–#118. How The Engineer runs operationally: data directory, logging, process management, CLI, health checks, and first-run experience. Adopts `doctor` command and rolling file logging from the [OpenClaw review](4-implementation/openclaw-review.md).

---

## 2026-03-09 — Data directory layout: ~/.engineer/ unified root (#109)

**Decision:** All runtime data under `~/.engineer/` with subdirectories: `config/` (existing), `data/` (SQLite), `logs/` (rolling files), `workspaces/` (git worktrees), `run/` (PID file). `ENGINEER_HOME` env var overrides the root. `ENGINEER_CONFIG_DIR` (Decision #92) still works as a specific config override.

**Rationale:** Unified root is one directory to inspect, back up, and remove. Matches Cargo (`~/.cargo/`), Rustup (`~/.rustup/`) patterns. XDG scatters files across 4+ directories — harder to manage, and macOS doesn't follow XDG anyway. Config already lives at `~/.engineer/config/` — extending the pattern.

**Alternatives rejected:** XDG Base Directory spec (scattered, not macOS-friendly), per-component directories outside `~/.engineer/`.

---

## 2026-03-09 — Logging strategy: pino + pino-roll (#110)

**Decision:** Operational logging via pino (structured JSON) with pino-roll (daily rotation, 500MB cap, 7-day retention). Single log file with component tags for subsystem filtering. pino-pretty for `engineer logs` human-readable output. Complementary to Event Bus audit trail — logging is for debugging, Event Bus is for audit.

**Rationale:** pino is 5-10x faster than winston, JSON-native, uses worker-thread transport (never blocks main loop). Single file with structured tags is easier to correlate cross-component than per-component files — filter with `jq`. Logging failure = degraded debugging; Event Bus failure = system halt (Decision #53).

**Alternatives rejected:** winston (heavier, slower), custom rolling (reinventing solved problems), per-component log files (harder to correlate).

---

## 2026-03-09 — Logging configuration in DaemonConfig (#111)

**Decision:** New `logging` section in DaemonConfig: `level` (default "info"), `dir` (default "logs", relative to ENGINEER_HOME), `max_size_bytes` (500MB), `max_files` (7), `console` (false). `dir` supports relative (to ENGINEER_HOME) and absolute paths.

**Rationale:** Logging is a Daemon concern — Daemon owns the logger instance and passes child loggers to components. Defaults produce sensible behavior without any config. `console: true` is useful for development (foreground mode) or when running under OS service managers that capture stdout.

---

## 2026-03-09 — Process management: foreground default, PID file, single instance (#112)

**Decision:** `engineer start` runs foreground by default, `--daemon` flag for background. PID file at `{ENGINEER_HOME}/run/engineer.pid` for daemon tracking. Single instance enforced via PID file with stale detection (check process alive AND is The Engineer). Signal handling: SIGTERM/SIGINT → graceful shutdown (P15), SIGHUP → ignored for v1. Exit codes: 0 (clean), 1 (startup failure), 2 (runtime crash).

**Rationale:** Foreground default is best for development and OS service managers (they handle backgrounding). PID file is simple, well-understood, and the stale detection covers race condition edge cases. Single instance prevents conflicting daemon processes.

**Alternatives rejected:** Advisory file lock (less portable macOS vs Linux), always-background (poor for development).

---

## 2026-03-09 — OS service integration via engineer install (#113)

**Decision:** `engineer install` generates OS-specific service config files and prints registration instructions. macOS: launchd plist at `~/Library/LaunchAgents/com.the-engineer.daemon.plist` (KeepAlive, RunAtLoad false). Linux: systemd user unit at `~/.config/systemd/user/engineer.service` (Restart=on-failure, RestartSec=5). Does NOT auto-register — user runs the commands. Windows out of scope for v1.

**Rationale:** Generate + instructions respects user agency (service registration has implications like start-on-login). No sudo needed (user-level services). OS service managers handle restart-on-crash better than self-healing daemon code. The generated files use paths resolved at generation time.

---

## 2026-03-09 — CLI framework: commander (#114)

**Decision:** commander is the CLI framework. Binary name: `engineer`.

**Rationale:** Most established Node.js CLI framework (26k stars), TypeScript support, auto-generated help, stable API. Used by OpenClaw (validated). Single dependency.

**Alternatives rejected:** citty (newer, less mature), yargs (heavier API), custom (reinventing solved problems).

---

## 2026-03-09 — CLI command inventory: 8 commands for v1 (#115)

**Decision:** Flat command structure. Daemon lifecycle: `start` (foreground default, --daemon), `stop` (--timeout override), `status`, `logs` (pretty default, --json). Setup: `init`, `doctor`, `install`. Config: `config validate`. Global options: `--home`, `--verbose`, `--version`, `--help`.

**Rationale:** Flat structure covers all v1 needs without nesting complexity. Future commands (`task list`, `plugin list`) fit naturally without restructuring. Each command maps to a single clear action.

---

## 2026-03-09 — doctor command: 10 check categories, pre-flight subset (#116)

**Decision:** `engineer doctor` runs 10 check categories: Node.js runtime, data directory, config files, required secrets, database, plugin manifests, GitHub connectivity, Telegram connectivity, workspace, risky config warnings. `engineer start` runs fast pre-flight subset (categories 1-6, no network). Exit codes: 0 (pass), 1 (failure), 2 (warnings only). Actionable failure messages.

**Rationale:** Adopted from OpenClaw's `doctor` pattern. Pre-flight on startup catches config errors before the daemon loop. Full doctor adds network checks for manual validation. Every failure includes remediation steps — the system tells you exactly what to fix.

---

## 2026-03-09 — First-run experience: auto-create, fail-with-instructions (#117)

**Decision:** First-run detection: no `{ENGINEER_HOME}/data/engineer.db`. On first `engineer start`: auto-create directory structure, initialize SQLite database (run migrations), run pre-flight checks, fail with clear instructions if secrets missing. Missing config files = Zod defaults (system works out of the box). No interactive wizard for v1.

**Rationale:** Auto-create directories removes friction. Fail-with-instructions is more debuggable than a wizard. Zod defaults mean the system runs without config files — the user only configures what they want to change. The recommended workflow is: `engineer init` → edit configs → `engineer doctor` → `engineer start`.

---

## 2026-03-09 — engineer init: template generation and directory scaffolding (#118)

**Decision:** `engineer init` creates `~/.engineer/` directory structure and generates template config files with inline comments for all fields. Generates core configs (all fields commented out) and all built-in plugin configs (required fields uncommented with placeholders). Safe to run multiple times — existing files are not overwritten. `--force` flag to regenerate.

**Rationale:** Template files are the best documentation — the user sees every field with its default and purpose. Generating plugin config templates removes the guesswork of "what do I need to configure?" Safe re-run prevents accidental overwrites of user-edited configs.

---

## 2026-03-09 — Three-tier Vitest configs: unit, integration, e2e (#119)

**Decision:** Three Vitest config files organized by test type. Unit (`vitest.config.ts`), integration (`vitest.integration.config.ts`), e2e (`vitest.e2e.config.ts`). All use `pool: "forks"` globally — `better-sqlite3` native bindings aren't thread-safe, and VM contexts leak mocks (validated by OpenClaw). Shared base `vitest.shared.ts`. Worker scaling: aggressive local, conservative CI. Pre-push hook runs unit tests only (amends Decision #101).

**Rationale:** Test-type tiers match our three architectural boundaries: within a component (unit), across components (integration), full system (e2e). `forks` globally prevents subtle native binding failures. Pre-push stays fast (< 15s).

**Alternatives rejected:** Domain-scoped configs (OpenClaw style — our system is simpler), Vitest workspaces (monorepo concern), two tiers only (missing integration means unit tests grow too complex).

---

## 2026-03-09 — Hybrid test directory: co-located units, separate cross-cutting (#120)

**Decision:** Unit tests co-located with source (`*.test.ts` next to the file they test). Integration, e2e, boundary tests, fixtures, and helpers in a top-level `test/` directory. File naming conventions: `*.test.ts` (unit), `*.integration.test.ts` (integration), `*.e2e.test.ts` (e2e).

**Rationale:** Co-located unit tests are immediately findable. Integration/e2e tests span multiple components and can't belong to any single source file. Shared helpers serve all tiers from one location.

**Alternatives rejected:** Pure co-location (integration tests don't belong next to one component), pure separation (duplicates source tree), `__tests__/` directories (Jest convention, extra nesting).

---

## 2026-03-09 — Coverage: pragmatic exclusion with 70/55 thresholds (#121)

**Decision:** `coverage.all: false` — only files exercised by tests count toward thresholds. 70% lines, 55% branches, 70% functions/statements. Exclude CLI, daemon, plugins, wiring, migrations from coverage (validated by integration/e2e/manual). Focus coverage on schemas, state machines, adapters, safety layer. v8 provider. Manual ratcheting. Adopted from OpenClaw.

**Rationale:** Tests should verify logic, not wiring. `all: false` prevents gaming coverage numbers on hard-to-test process management code. 70/55 is validated by OpenClaw's production codebase. Manual ratcheting avoids the one-way trap of automated tools during legitimate refactoring.

**Alternatives rejected:** `all: true` (forces pointless tests on CLI wiring), per-directory thresholds (too granular), no thresholds (coverage drifts with AI-generated code).

---

## 2026-03-09 — Plugin contract compliance test suites (#122)

**Decision:** Abstract contract test suites — one per adapter type — that verify behavioral expectations TypeScript can't express. Plugin authors import `runTriggerContractSuite()` (etc.) and pass their implementation. Suites test: lifecycle compliance (initialize/healthCheck/shutdown behavior), method contracts (schema-compliant returns, AdapterError wrapping), type-specific rules (idempotency keys, usage reporting, side effects). Mock factories generate schema-compliant defaults via Zod.

**Rationale:** TypeScript ensures type signatures match. But `poll()` returning stable idempotency keys, `initialize()` returning `{ success: false }` instead of throwing, and `complete()` always reporting usage data are behavioral contracts the type system can't enforce. Contract suites catch these at test time.

**Alternatives rejected:** Runtime-only validation (catches types, not behavior), no suites + rely on integration tests (forces plugin authors to stand up Core), interface-only testing (TypeScript already does this).

---

## 2026-03-09 — Integration tests: real Core + fake plugins via Registry (#123)

**Decision:** Integration tests wire real Core components together, with plugins replaced by lightweight fakes registered through the Registry. Shared immutable registry (adopted from OpenClaw) created once in test setup, restored in `afterEach` if overridden. Fakes are minimal complete adapter implementations (not mocks) that pass contract suites. In-memory SQLite per test. Seven integration test categories: plugin loading, trigger polling, task lifecycle, orchestrator flow, config hot-reload, event delivery, health monitoring.

**Rationale:** The Registry is the natural integration seam — production loads real plugins, tests load fakes. Fakes over mocks because fakes exercise real downstream paths; mocks silently pass when misconfigured. Unit tests use `vi.fn()`, integration tests use fakes.

**Alternatives rejected:** Mock everything (verifies mock configuration, not behavior), test against real services (violates local-first/cost-conscious), single God integration test (too slow, hard to diagnose).

---

## 2026-03-09 — E2E: in-process daemon with injectable clock (#124)

**Decision:** E2E tests use an in-process daemon (`createDaemon(config)` returns a controllable `Daemon` object). Injectable clock replaces real timers for deterministic time control. Seven key scenarios mapped to Layer 3 lifecycle traces: happy path, task decomposition, crash recovery, preemption, cost limit breach, plugin failure, graceful shutdown. External dependencies faked (no HTTP). Real git in temp directories.

**Rationale:** In-process daemon gives direct state access, fake plugin injection, synchronous tick control — impossible with a forked process. Injectable clock eliminates timer flakiness. Real git is simpler than reimplementing git semantics.

**Alternatives rejected:** Forked process (no observability, can't inject fakes — useful as future smoke test), Docker-based (overkill, violates cost constraint), record/replay (stale recordings, no failure testing).

---

## 2026-03-09 — Architectural boundary enforcement tests (#125)

**Decision:** A test in `test/boundary/tier-import-rules.test.ts` verifies three-tier import rules: plugins only import from SDK boundary (`src/adapters/index.ts`) and schemas, adapters never import plugins, core never imports plugins directly. Globs `.ts` files per tier, parses import statements, asserts no forbidden cross-tier imports. Adopted from OpenClaw's `check-channel-agnostic-boundaries.test.ts` pattern.

**Rationale:** The SDK boundary is the contract surface for plugins. If a plugin imports Core internals, it creates hidden coupling that breaks on refactoring. This test catches it at unit-test time. Critical for future third-party plugin support.

**Alternatives rejected:** Biome `noRestrictedImports` (per-file, not directory-contextual — can't express "any file in src/plugins/ must not import from src/core/").

---

## Holistic Review — Session 29

> Decisions #126–#127. Pre-implementation holistic review found 3 MEDIUM issues across all 5 layers. Architecture validated: 30/30 events consistent, 15/15 protocols implementable, 23/23 transitions correct, 16/16 reconciliation items resolved.

---

## 2026-03-09 — Remove `per_repo` from cost limit type enum, normalize naming (#126)

**Decision:** Remove `per_repo` from `cost.limit_reached` event's `limit_type` enum. Rename `daily_global` → `daily` and `monthly_global` → `monthly` to match SafetyConfig naming. Final enum: `["per_task", "daily", "monthly"]`. Update protocols.md P10 accordingly.

**Rationale:** Holistic review found that `per_repo` was a limit type in the event payload but no per-repo cost limit existed in `SafetyConfigSchema`. The event advertised a value that could never be produced. The `_global` suffix was descriptive but redundant — config already scopes these under `api`, making the scope unambiguous. Per-repo cost limits can be added later as a coordinated change across config, event, and protocol.

---

## 2026-03-09 — Action Pipeline as dedicated Core module (#127)

**Decision:** Add `src/core/action-pipeline/index.ts` to the project layout. The Action Pipeline is a thin module (~50-100 lines) that orchestrates Gate 1 (Task Engine permission check) and Gate 2 (Safety Layer policy check) before action execution. Owns the `action.rejected` event. Used by Orchestrator and Workspace Manager.

**Rationale:** Holistic review found the Action Pipeline — a central L3 concept with its own event ownership — had no designated module in the L4 project layout. It can't live in the Orchestrator (Workspace Manager also uses it, creating a circular dependency risk) or in a utility file (it owns an event type and has architectural significance). A dedicated thin Core module gives it a proper home without over-engineering.

---

## Layer 5 — Build Order

> Decision #128. Implementation sequence: 19 phases, bottom-up. Schemas and infrastructure first, then components in dependency order, then the daemon that wires everything together. Context-window-aware phase scoping.

---

## 2026-03-10 — 19-phase bottom-up build order (#128)

**Decision:** 19 implementation phases in strict dependency order: 0 (Bootstrap) → 1a (Core Schemas) → 1b (Integration Schemas) → 2 (DB) → 3 (Config) → 4 (Event Bus) → 5 (Adapters) → 6 (Registry + test infra) → 7 (Task Engine) → 8 (Safety + People) → 9 (Action Pipeline) → 10 (Session/Memory + Workspace Manager) → 11 (Orchestrator skeleton) → 12 (Daemon + logging = hello world) → 13 (CLI) → 14a (Contract suites + process plugins) → 14b (GitHub plugins) → 14c (Telegram plugin) → 15 (Integration + E2E tests). Each phase produces independently testable output, scoped to fit in a single agent context window. Unit tests co-located with each phase. Each phase has a comprehensive self-contained briefing with architecture connections, exact reference docs, and implementation notes.

**Rationale:** Bottom-up mirrors compiler bootstrap — build the type system first (schemas), then infrastructure (DB, config, Event Bus), then components in dependency order, then the wiring layer (daemon). Breaks the chicken-and-egg: Action Pipeline (Phase 9) needs Task Engine (7) and Safety Layer (8), both already built. Orchestrator (11) needs everything, but by then everything exists. Hello world at Phase 12 is the natural point where the full stack is wired. Phase 1 split into 1a/1b because 2,619 lines of reference + 14 output files risks context overflow — core data model (task, events, session) in 1a, integration types (adapters, orchestrator, config) in 1b. Phase 14 split into 14a/14b/14c because 29 files across 6 different APIs (GitHub, Telegram, Claude CLI, bash) is too much — process-based plugins (14a), GitHub-Octokit plugins (14b), Telegram-grammy (14c). Parallelization: Phases 2+3 independent, Phases 14a/14b/14c independent of Phases 6-13.

**Alternatives considered:** Top-down skeleton-first (daemon shell → fill in), but produces a non-functional stub that doesn't test anything. Interleaved plugins (build real plugins alongside core), but adds external API distractions during core development. Keeping original 16 phases (no splits), but context window analysis showed Phase 1 and Phase 14 genuinely risk overflow.

---

## Phase 8 — Safety Layer + People Directory

## 2026-03-11 — Two-method Safety Layer API (#129)

**Decision:** Split the L2/L3-spec single `evaluate(SafetyQuery)` into two methods: `evaluateAction(taskId, actionClass, details)` for Gate 2 (hard limits checked by Action Pipeline) and `consultJudgment(query: SafetyQuery)` for passive consultation (autonomy decisions queried by Orchestrator). Both return `SafetyVerdict { allowed, action: "proceed"|"ask_human"|"deny", reason, warnings? }`.

**Rationale:** Different callers (Action Pipeline vs Orchestrator), different intent (binary gate check vs nuanced three-way verdict). Splitting makes each method's contract clearer. `consultJudgment` handles three query types internally (`can_i`, `should_i_ask`, `cost_check`).

**Alternatives considered:** Single `evaluate()` as in specs — but overloaded method signature and mixed caller expectations add complexity without benefit.

## 2026-03-11 — Custom matchesPathPattern over glob dependency (#130)

**Decision:** Implement a focused `matchesPathPattern()` (~30 lines) for file/branch glob matching — supports `*` (single segment), `**` (recursive), and literal matching. Separate from EventBus's dot-separated `matchesPattern()`.

**Rationale:** Adding a full glob dependency for a focused use case is overkill. The pattern set is well-defined (`.env*`, `secrets/**`, `engineer/*`).

## 2026-03-11 — Snapshot after every cost event (#131)

**Decision:** Save cost accumulator snapshot to `_meta` after every `cost.incurred` event. No timer, no counter, no configurability.

**Rationale:** Cost events are infrequent (one per LLM call, ~dozens per task). A `_meta` upsert is microseconds. Simple wins.

## 2026-03-11 — UTC midnight/first-of-month for time windows (#132)

**Decision:** Daily cost windows reset at midnight UTC. Monthly windows reset at first-of-month midnight UTC. Deterministic, no configuration.

**Rationale:** UTC eliminates timezone ambiguity. Window rollover detected on every cost event by comparing timestamp against current boundary.

## 2026-03-11 — Simple threshold parser for autonomy (#133)

**Decision:** Parse `"<metric> <op> <value>"` patterns for autonomy thresholds (e.g., `"scope > 5 files"` → metric=scope, op=>, value=5). Unknown thresholds → `ask_human` (fail-safe). Exported as pure functions.

**Rationale:** Sufficient for v1 autonomy rules. Fail-safe default for unparseable thresholds ensures safety. Pure functions enable isolated testing.

## 2026-03-11 — ContactInfo.plugin_id = channel name (#134)

**Decision:** `PeopleDirectory.resolveContact()` sets `ContactInfo.plugin_id` to the contact's channel name (e.g., `"github"`, `"telegram"`). The Orchestrator maps channel names to actual Registry plugin IDs.

**Rationale:** People Directory has no knowledge of the Registry. Clean separation of concerns.

## 2026-03-11 — Include getTimeoutPolicy accessor now (#135)

**Decision:** Add `getTimeoutPolicy(): ResponseTimeout` to Safety Layer now, even though the Daemon (Phase 12) is the consumer.

**Rationale:** Trivial accessor returning `config.response_timeout`. Keeps the Safety Layer interface complete. Protocol P11 references it.

## 2026-03-11 — evaluateAction checks merge policy (#136)

**Decision:** `evaluateAction()` checks `config.merge.auto_merge` when `actionClass === "merge"`. Returns `ask_human` if auto-merge is not enabled for the repo.

**Rationale:** Connects to Task Engine's conditional permission for merge (Decision #3, Session 039). Safety Layer evaluates the condition that Task Engine flags.

---

## 2026-03-12 — Layer 6 Phase 6.5 decisions (D147-D154)

See `6-refinement/decisions.md` for full entries. Summary:

- **D147:** Clone-on-demand for workspaces — WorkspaceManager clones target repo on first use, idempotent, resets remote URL after clone.
- **D148:** Task `clone_url` field + `injectAuth()` transient auth injection — URL stored without credentials, token injected ephemerally from env var.
- **D149:** Deterministic commit + draft PR after demo_prep — `git add -A` → commit → rev-list ahead-of-base check → push → create draft PR. Rev-list handles Claude CLI internal commits.
- **D150:** Push via explicit authenticated URL — `git push` uses transient `https://git:{token}@` URL, never stored in `.git/config`.
- **D151:** Token injection lifecycle — read from env → inject → single git command → discard. Never persisted anywhere.
- **D152:** Milestone notifications via PeopleDirectory — owner resolution + fire-and-forget comm dispatch, channel→plugin name convention.
- **D153:** Workspace cleanup policy — remove worktree on completion (preserve branch for PR), preserve everything on error (for resume).
- **D154:** Token sanitization at chokepoints — `sanitizeSecrets()` applied at SessionMemory.addJournalEntry, agent loop history, and agent loop logs. Redacts URL-embedded tokens and known env var values.

---

## 2026-03-12 — Layer 6 Phase 6.9 decisions (D155-D159)

See `6-refinement/decisions.md` for full entries. Summary:

- **D155:** Content-addressable blob store for LLM traces — full prompts/responses stored as SHA-256 hashed files at `~/.engineer/traces/blobs/{hash[0:2]}/{hash}.txt`. DB holds only hash references. Zero bloat, automatic dedup, lazy loading.
- **D156:** Trace ID correlation — ULID generated per `executeTask()` call, flows through action_traces, phase_metrics, llm_traces. Enables end-to-end request tracing.
- **D157:** Agent loop callbacks pattern — optional `AgentLoopCallbacks` interface (onActionComplete, onLlmComplete) injected into runAgentLoop. Loop stays pure, no DB dependency.
- **D158:** Dashboard as separate process — reads SQLite in WAL mode (read-only), works independently of daemon, can view historical data when daemon stopped.
- **D159:** Hono + single HTML file — zero frontend build, 14KB HTTP framework, dark war room theme. Polling over WebSocket for simplicity.

---

## 2026-03-12 — Layer 6 Phase 6.10 decisions (D160-D165)

See `6-refinement/decisions.md` for full entries. Summary:

- **D160:** React + Vite for War Room v2 — largest ecosystem + OSS contributor pool. Bundle size irrelevant for localhost. Replaces D159's single HTML file approach.
- **D161:** Dashboard stays in same package — `src/dashboard/ui/` Vite sub-project. Shared types import directly from `src/schemas/`.
- **D162:** shadcn/ui + Tailwind CSS + Lucide + Recharts — premade component ecosystem for UI, charts, and icons.
- **D163:** SSE for real-time dashboard updates — `GET /api/stream` endpoint. Polling as fallback. No WebSocket (unidirectional data).
- **D164:** Ecosystem-first — premade components over custom. Only build custom for domain-unique visualizations (agent loop, phase pipeline, decomposition tree).
- **D165:** War Room is two-sided — deep backend instrumentation (agent loop visibility, LLM detail, decision points, decomposition) + modern frontend. Observability depth is the differentiator.

---

## 2026-04-03 — PR-to-ticket linking via `pr_prefix` on ExternalRef (D176)

**Decision:** Add optional `pr_prefix: string` field to `ExternalRefSchema`. Trigger plugins set it to the platform-formatted ticket reference (GitHub: `"#42"`, Jira: `"JIRA-123"`). Core prefixes the PR title with `pr_prefix` as an opaque string — never inspects its format.

**Rationale:** Git platforms (GitHub, GitLab, Azure DevOps) use keyword/prefix parsing as their primary PR-to-issue linking mechanism — no universal "link PR to issue" API exists. By having trigger plugins provide the platform-native prefix, Core can enable automatic linking while maintaining plugin blindness. The prefix in the title creates a platform-recognized reference without auto-closing behavior (closing keywords like `Resolves` would need to be in the PR body).

**Alternatives rejected:** (1) `linkPRToSource()` adapter method — over-engineered for what amounts to a string prefix. (2) Closing keywords in Core (`Resolves #42`) — plugin blindness violation, Core encoding platform semantics. (3) Deferral — immediate value for same-platform scenarios with minimal scope.

**Superseded by D177** — `pr_prefix` replaced by `pr_decorations` nested object.

---

## 2026-04-05 — PR decorations: 4-slot title/description decoration via `pr_decorations` (D177)

**Decision:** Replace `pr_prefix: string` on `ExternalRefSchema` with `pr_decorations: PrDecorationsSchema` — a nested optional object with four independently optional fields: `title_prefix`, `title_suffix`, `description_prefix`, `description_suffix`. All values are opaque strings set by trigger plugins and applied by Core's PR Manager. Plugin owns all delimiter formatting (Core space-joins title parts, no hardcoded `: `).

**Rationale:** D176 covered only PR title prefixing. Platforms like GitHub also support auto-close linking via description keywords (`Closes #42`). Expanding to 4 decoration slots enables full title + description customization while maintaining plugin blindness — Core never inspects what the strings contain. A nested object groups related concerns and signals "this is a coherent decoration set" to future developers.

**Expert panel review:** 5-panelist review (Torvalds, Hipp, Pike, Engineer, Architect) recommended 2 flat fields (YAGNI). Decision: keep 4-field nested design for completeness — adding fields later has zero migration cost (JSON TEXT storage), but the symmetrical design better communicates the intent. Key panel refinements adopted: (1) plugin owns delimiter formatting, (2) single separator before branding footer, (3) edge case tests for empty strings and empty objects.

**Alternatives rejected:** (1) Two flat fields (`pr_prefix` + `pr_body_suffix`) — simpler but less expressive, loses grouping signal. (2) Template strings with placeholders — parser complexity, injection surface, breaks plugin blindness. (3) Keeping `pr_prefix` and adding `pr_body_suffix` — avoids rename churn but inconsistent naming between old flat field and new flat field.

---

## 2026-04-13 — AI-as-Judge evaluation system (D178)

**Decision:** Add a config-gated (`evaluation.enabled: false` by default) quality assessment system that runs two independent CLI sessions after every task completes. Session 1 (blind plan): judge receives only the raw trigger details and explores the codebase read-only — plans how it would approach the task without knowing work has been done. Session 2 (comparison): judge sees its blind plan + The Engineer's full output (git diff, commit log, all thoughts/ files) and produces a structured verdict (1-5 rating, approach comparison, improvement recommendations). Results stored locally at `~/.engineer/evaluations/{task-id}/` — never pushed to remote.

**Rationale:** The Engineer produces ~3.5/5 quality output with no automated way to measure it. Farzam's manual evaluation workflow (feed ticket to separate Claude session, let it plan, compare against Engineer output) works but doesn't scale. Automating this creates a continuous quality feedback loop. The blind-then-reveal design prevents the judge from adapting its "plan" to match the existing work — honest baseline comparison. Fire-and-forget execution ensures evaluation never blocks task completion.

**Key design choices:** (1) Bypasses ActionPipeline — evaluation costs are not subject to safety limits (opt-in via flag). (2) Snapshot captured synchronously before worktree cleanup — survives cleanup. (3) Session 1 CWD is the bare clone dir (always exists), Session 2 CWD is the evaluation dir. (4) Tracked as promises with 15s shutdown drain — LLM plugin shutdown kills any surviving CLI processes. (5) New `evaluation.completed` event for future dashboard integration.

**Alternatives rejected:** (1) Single-session evaluation (judge sees everything from start) — loses the honest baseline; judge would adapt its assessment to look smarter. (2) Storing results in git branch/worktree — evaluation is local-only diagnostic data, pushing it pollutes the repo. (3) Separate config for judge LLM — over-engineering; same CLI that does the work judges the work.
