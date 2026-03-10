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
