# Review Prompt Templates

## Quick Start

1. Pick a phase and round
2. Open N terminal tabs (one per lens in that round)
3. In each tab: create worktree → open Claude Code → paste template → replace `{PHASE_DOC}` and `{PHASE}`
4. When all lenses finish: run the merge prompt from main repo
5. Move to next phase (or next round if all phases done)

---

## Placeholders

| Placeholder | What to replace with | Example |
|-------------|---------------------|---------|
| `{PHASE_DOC}` | Phase review doc filename | `1-bootstrap-wiring.md` |
| `{PHASE}` | Short phase identifier for branch naming | `phase1`, `phase4` |
| `{PHASE_GROUP}` | Group identifier for Round 3 | `startup`, `lifecycle`, `review`, `resilience` |

---

## Execution Strategy

### Round 1 — Craft (5 lenses in parallel per phase)

```
For each phase:
  ┌─ Terminal 1: Lens A (Structure)      → worktree ../engineer-A-{PHASE}
  ├─ Terminal 2: Lens B (Naming)         → worktree ../engineer-B-{PHASE}
  ├─ Terminal 3: Lens C (Abstractions)   → worktree ../engineer-C-{PHASE}
  ├─ Terminal 4: Lens D (Errors)         → worktree ../engineer-D-{PHASE}
  └─ Terminal 5: Lens E (Security)       → worktree ../engineer-E-{PHASE}

  All 5 finish → run MERGE-ROUND1.md from main repo
  → move to next phase

After all phases in a group complete:
  Run INTEGRATION.md on main (no worktree needed)
```

### Round 2 — Polish (3 lenses in parallel per phase)

```
For each phase:
  ┌─ Terminal 1: Lens F (Logging)        → worktree ../engineer-F-{PHASE}
  ├─ Terminal 2: Lens G (Performance)    → worktree ../engineer-G-{PHASE}
  └─ Terminal 3: Lens H (Config/DX)      → worktree ../engineer-H-{PHASE}

  All 3 finish → run MERGE-ROUND2.md from main repo
```

### Round 3 — Coherence (2 lenses in parallel per group)

```
For each phase group:
  ┌─ Terminal 1: Lens I (Consistency)    → worktree ../engineer-I-{GROUP}
  └─ Terminal 2: Lens J (Minimalism)     → worktree ../engineer-J-{GROUP}

  Both finish → run MERGE-ROUND3.md from main repo
```

### Round 4 — Verification (1 session, no worktree)

```
Run Lens K (Docs Sync) directly on main
```

---

## Phase Groups

| Group ID | Name | Phases | Phase Docs |
|----------|------|--------|------------|
| `startup` | Startup | 0-3 | `1-bootstrap-wiring.md`, `2-plugin-loading.md`, `3-daemon-startup.md` |
| `lifecycle` | Task Lifecycle | 4-7 | `4-trigger-polling.md`, `5-scheduling-dispatch.md`, `6-workspace-session.md`, `7-phase-pipeline.md` |
| `review` | Review Lifecycle | 8-10 | `8-pr-review.md`, `9-feedback-rework.md`, `10-completion-cleanup.md` |
| `resilience` | Resilience | 11-12 | `11-error-recovery.md`, `12-background-services.md` |

---

## Template Index

### Round 1 — Craft (per phase, parallel)

| ID | Lens | File |
|----|------|------|
| A | Structure & Organization | `A-structure-organization.md` |
| B | Naming & Readability | `B-naming-readability.md` |
| C | Abstractions & API Design | `C-abstractions-api-design.md` |
| D | Error Handling & Edge Cases | `D-error-handling-edge-cases.md` |
| E | Security & Trust Boundaries | `E-security-trust-boundaries.md` |
| — | **Merge** | `MERGE-ROUND1.md` |

### Integration (per group, sequential on main)

| ID | Lens | File |
|----|------|------|
| — | Cross-Phase Seam Review | `INTEGRATION.md` |

### Round 2 — Polish (per phase, parallel)

| ID | Lens | File |
|----|------|------|
| F | Logging & Observability | `F-logging-observability.md` |
| G | Performance & Resources | `G-performance-resources.md` |
| H | Config & DX | `H-config-dx.md` |
| — | **Merge** | `MERGE-ROUND2.md` |

### Round 3 — Coherence (per group, parallel)

| ID | Lens | File |
|----|------|------|
| I | Consistency & Patterns | `I-consistency-patterns.md` |
| J | Minimalism & Dead Code | `J-minimalism-dead-code.md` |
| — | **Merge** | `MERGE-ROUND3.md` |

### Round 4 — Verification (once, on main)

| ID | Lens | File |
|----|------|------|
| K | Docs ↔ Code Sync | `K-docs-code-sync.md` |

---

## Session Counts

| Round | Lenses | Per-phase | Phases/Groups | Lens sessions | Merge sessions | Total |
|-------|--------|-----------|---------------|---------------|----------------|-------|
| Round 1 | A-E | 5 parallel | 12 phases | 60 | 12 | 72 |
| Integration | — | 1 sequential | 4 groups | 4 | — | 4 |
| Round 2 | F-H | 3 parallel | 12 phases | 36 | 12 | 48 |
| Round 3 | I-J | 2 parallel | 4 groups | 8 | 4 | 12 |
| Round 4 | K | 1 | 1 | 1 | — | 1 |
| **Total** | | | | **109** | **28** | **137** |

### Wall-Clock Batches

| Round | Batches (parallel execution) |
|-------|------------------------------|
| Round 1 | 12 lens batches + 12 merges + 4 integration = **28** |
| Round 2 | 12 lens batches + 12 merges = **24** |
| Round 3 | 4 lens batches + 4 merges = **8** |
| Round 4 | **1** |
| **Total wall-clock batches** | **61** |

---

## Branch Naming Convention

```
review/{LENS}-{PHASE}

Examples:
  review/A-phase1      # Lens A on Phase 0-1 (bootstrap)
  review/E-phase7      # Lens E on Phase 7 (pipeline)
  review/I-startup     # Lens I on startup group (Phases 0-3)
  review/J-resilience  # Lens J on resilience group (Phases 11-12)
```

---

## Worktree Naming Convention

```
../engineer-{LENS}-{PHASE}

Examples:
  ../engineer-A-phase1
  ../engineer-E-phase7
  ../engineer-I-startup
```
