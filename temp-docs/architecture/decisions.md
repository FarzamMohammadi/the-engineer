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
