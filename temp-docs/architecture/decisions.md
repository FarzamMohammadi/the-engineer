# Architectural Decisions

Log of major decisions made. Do not re-litigate unless explicitly asked.

---

## 2026-03-06 — BOOT.md as single universal boot file

**Decision:** One file, `BOOT.md`. No agent-specific wrappers. "Read BOOT.md and begin." The repo dictates the protocol.

**Rationale:** Per-agent files (CLAUDE.md, GEMINI.md, etc.) fragment and create maintenance overhead that grows with every new agent. Our own protocol is simpler and truly agent-agnostic.

**Alternatives rejected:** AGENTS.md + per-agent wrappers, CLAUDE.md as primary, README.md as boot file.

---

## 2026-03-06 — Architecture first, code never (until approved)

**Decision:** All deliverables are documentation and architectural planning. No code until Farzam explicitly approves. Work lives in `temp-docs/`.

**Rationale:** This is a massive project that demands every decision be made thoughtfully before implementation. Rushing to code creates rework and architectural debt.

**Alternatives rejected:** Prototype-first, iterative code-and-plan.

---

## 2026-03-06 — temp-docs/ as development workspace

**Decision:** `temp-docs/` holds all builder-facing documentation: active focus, session logs, philosophies, and architecture. Separate from agent-facing files.

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
