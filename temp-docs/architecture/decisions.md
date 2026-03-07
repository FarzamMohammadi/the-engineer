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
