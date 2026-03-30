# Scheduling & Dispatch — Ideas & Brainstorm

Runtime Phase Refinement section 3 of 9. How tasks move from waiting to working: priority queues, task eligibility, slot management, concurrency, preemption, priority aging.

Brainstormed in Session 081. [Expert panel review pending]. [Co-founder review pending].

**Governing principle:** Plugin Blindness (see `docs/philosophy.md`). Core sees only adapter contracts. The scheduling system is entirely Core — no adapter or plugin references. Every decision below must maintain this invariant.

---

# Work in progress — brainstorming session active

