# Layer 7 Phase Plan

Full plan with parallel execution strategy lives in `.claude/plans/tingly-wondering-fairy.md`.

## How to Execute

1. Work through waves **in order** (Wave 0 → 1 → 2 → ...)
2. **Sequential waves** (0, 1, 5, 6): Open one Claude Code session, paste the prompt file content, let it run
3. **Parallel waves** (2, 3, 4): Open multiple sessions — one per phase. Each runs in its own git worktree
4. **After each parallel wave**: Run the merge prompt to combine branches back to main
5. Update the **Status** column below as you go (NOT STARTED → IN PROGRESS → DONE)

### For Parallel Waves (Worktree Setup)

Before pasting a prompt, create a worktree for that phase:
```bash
git worktree add ../engineer-R1 -b layer7/R1    # one per phase
```

Then open a new Claude Code session in that worktree directory and paste the prompt.

When all phases in the wave are done, run the merge prompt from the main repo.

---

## Wave Structure

```
WAVE 0 (Sequential):   R-0 — Centralized Observer
                         ↓ commit to main

WAVE 1 (Sequential):   R0 — Interfaces + Zod Enums + Shared Factory
                         ↓ commit to main

WAVE 2 (Parallel, 6):  R1 | R2a | R2b | R2c | R3 | R4
                         ↓ MERGE-WAVE2 → main

WAVE 3 (Parallel, 4):  R5 | R6 | R7 | R8
                         ↓ MERGE-WAVE3 → main

WAVE 4 (Parallel, 2):  R9 | R10
                         ↓ MERGE-WAVE4 → main

WAVE 5 (Sequential):   REVIEW — Deep audit + security verification
                         ↓ fixes applied to main

WAVE 6 (Sequential):   FINAL — End-to-end verification
```

---

## Phase Status

| Phase | Description | Wave | Prompt File | Status |
|-------|-------------|------|-------------|--------|
| R-0 | Centralized Observer (War Room's eyes) | 0 | `R-0-observer.md` | DONE |
| R0 | Interface Foundation + Zod Enums + Shared Factory | 1 | `R0-interfaces.md` | DONE |
| R1 | Safety Layer Split → CostTracker + PolicyEngine | 2 | `R1-safety-split.md` | MERGED |
| R2a | TaskEngine Decomposition | 2 | `R2a-task-engine.md` | MERGED |
| R2b | SessionMemory Decomposition | 2 | `R2b-session-memory.md` | MERGED |
| R2c | Registry Decomposition | 2 | `R2c-registry.md` | MERGED |
| R3 | Daemon Decomposition (6 subsystems) | 2 | `R3-daemon.md` | MERGED |
| R4 | Orchestrator Decomposition (5 subsystems) | 2 | `R4-orchestrator.md` | MERGED |
| — | *Merge Wave 2* | 2→3 | `MERGE-WAVE2.md` | DONE |
| R5 | Declarative Event Topology | 3 | `R5-event-topology.md` | NOT STARTED |
| R6 | Plugin Discovery + Scaffolding + Hooks | 3 | `R6-plugin-discovery.md` | NOT STARTED |
| R7 | CLI Polish | 3 | `R7-cli-polish.md` | NOT STARTED |
| R8 | Security Hardening | 3 | `R8-security.md` | NOT STARTED |
| — | *Merge Wave 3* | 3→4 | `MERGE-WAVE3.md` | NOT STARTED |
| R9 | OSS Foundation | 4 | `R9-oss-foundation.md` | NOT STARTED |
| R10 | Data Lifecycle + Performance | 4 | `R10-data-lifecycle.md` | NOT STARTED |
| — | *Merge Wave 4* | 4→5 | `MERGE-WAVE4.md` | NOT STARTED |
| REVIEW | Deep Audit + Security Verification | 5 | `REVIEW.md` | NOT STARTED |
| FINAL | End-to-End Verification | 6 | `FINAL.md` | NOT STARTED |

---

## Prompt Files

All at `implementation-docs/7-restructure/prompts/`. Each is fully self-contained — paste into a fresh Claude Code session with zero prior context.

| Wave | Prompt File | What It Does |
|------|-------------|--------------|
| 0 | `R-0-observer.md` | Build centralized Observer — Langfuse-inspired, single observations table, span nesting, real-time streaming |
| 1 | `R0-interfaces.md` | Extract interfaces for all core components, Zod enum constants, shared component factory |
| 2 | `R1-safety-split.md` | Split SafetyLayer → CostTracker + PolicyEngine |
| 2 | `R2a-task-engine.md` | Decompose TaskEngine → state-machine + queries + permissions |
| 2 | `R2b-session-memory.md` | Decompose SessionMemory → sessions + journal + checkpoints + knowledge |
| 2 | `R2c-registry.md` | Decompose Registry → discovery + lifecycle + health |
| 2 | `R3-daemon.md` | Decompose Daemon → 6 subsystems (trigger, scheduler, preemption, notifications, review, health) |
| 2 | `R4-orchestrator.md` | Decompose Orchestrator → 5 subsystems (phase runner, workspace, PR, decomposition, LLM caller) |
| 2→3 | `MERGE-WAVE2.md` | Merge 6 branches back to main |
| 3 | `R5-event-topology.md` | Declarative event wiring with startup validation |
| 3 | `R6-plugin-discovery.md` | Auto-discovery, scaffolding CLI, hook system, config versioning |
| 3 | `R7-cli-polish.md` | Colors, progress, output formatting, --dry-run, setup wizard, engineer why |
| 3 | `R8-security.md` | Command validation, secret sanitization, workspace escape prevention |
| 3→4 | `MERGE-WAVE3.md` | Merge 4 branches back to main |
| 4 | `R9-oss-foundation.md` | CONTRIBUTING.md, templates, CHANGELOG, architecture diagrams, plugin guide |
| 4 | `R10-data-lifecycle.md` | Event/trace retention, query optimization, DB tuning |
| 4→5 | `MERGE-WAVE4.md` | Merge 2 branches back to main |
| 5 | `REVIEW.md` | Deep audit: types, imports, tests, security, events, plugins, bootstrap, lint |
| 6 | `FINAL.md` | End-to-end verification, file size audit, manual E2E test |
