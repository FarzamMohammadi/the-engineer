# The Engineer — Runtime Phase Architecture

13 distinct phases from `engineer start` to task completion. Cross-cutting services (EventBus, TaskEngine, SafetyLayer, ActionPipeline, SessionMemory, Observer, PeopleDirectory) are infrastructure used by phases, not phases themselves.

---

## Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ STARTUP (once)                                                   │
│                                                                   │
│  Phase 0: CLI Entry ──→ Phase 1: Bootstrap ──→ Phase 2: Plugins │
│                                    │                              │
│                              Phase 3: Daemon Start (P1)          │
│                                    │                              │
│                              ┌─────▼─────┐                      │
│                              │ TICK LOOP  │ (every 5s)           │
└──────────────────────────────┤            ├──────────────────────┘
                               └─────┬─────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
     Phase 4: Trigger       Phase 12: Background    Phase 11: Error
     Polling                Services (continuous)   & Recovery
              │
              ▼
     Phase 5: Scheduling
     & Dispatch
              │
              ▼
     Phase 6: Workspace
     & Session Setup
              │
              ▼
     Phase 7: 7-Phase Pipeline
     (intake → research → planning →
      execution → self_review →
      demo_prep → integration)
              │
       ┌──────┴──────┐
       ▼              ▼
  Phase 8: PR    Decomposition
  Creation       (children run
       │          Phases 5-8)
       ▼
  Phase 9: Feedback
  & Rework Loop
       │
       ▼
  Phase 10: Completion
  & Cleanup
```

---

## Phase Index

| # | Phase | Trigger | Produces | Key Files |
|---|-------|---------|----------|-----------|
| 0 | CLI Entry & Environment | `engineer start` | dirs, config, pre-flight pass | `src/cli/commands/start.ts` |
| 1 | Bootstrap & Component Wiring | Phase 0 complete | 16 components wired (7 core + 9 infrastructure) | `src/cli/bootstrap.ts`, `src/core/system.ts` |
| 2 | Plugin Loading & Initialization | Phase 1 complete | 6 plugins registered + initialized | `src/plugins/builtin.ts`, `src/core/registry/` |
| 3 | Daemon Startup (Protocol P1) | Phase 2 complete | PID file, crash recovery, subscriptions, tick loop | `src/core/daemon/index.ts` |
| 4 | Trigger Polling & Task Creation | Tick loop step 2 | New tasks (intake→queued) | `src/core/daemon/trigger-poller.ts`, `src/plugins/trigger/` |
| 5 | Task Scheduling & Dispatch | Tick loop step 4 | Tasks dispatched (queued→active.working) | `src/core/daemon/task-scheduler.ts` |
| 6 | Workspace & Session Setup | Orchestrator entry | Git worktree + session ready | `src/core/orchestrator/index.ts`, `src/core/workspace-manager/` |
| 7 | 7-Phase Pipeline | Phase 6 complete | Code changes, test results | `src/core/orchestrator/phase-runner.ts`, `src/core/orchestrator/prompts/` |
| 8 | PR Creation & Review Lifecycle | demo_prep complete | Draft PR, review polling | `src/core/orchestrator/pr-manager.ts`, `src/core/daemon/review-handler.ts` |
| 9 | Feedback & Rework Loop | changes_requested | Re-queued task with feedback | `src/core/daemon/review-handler.ts` |
| 10 | Completion & Cleanup | PR merged or approved | Workspace deleted, notifications sent | `src/core/daemon/task-scheduler.ts`, `src/core/daemon/review-handler.ts` |
| 11 | Error, Preemption & Recovery | Phase error / priority shift / crash | Task blocked, preempted, or recovered | `src/core/daemon/health-monitor.ts`, `src/core/daemon/preemption-manager.ts` |
| 12 | Background Services | Daemon running | Cleanup, health checks, cost monitoring | `src/core/data-lifecycle/`, `src/core/daemon/health-monitor.ts` |

---

## State Machine Through Phases

```
Phase 4:  intake ──→ queued
Phase 5:  queued ──→ active.working
Phase 7:  active.working (7 internal phase transitions)
          active.working ──→ active.supervising (decomposition)
          active.supervising ──→ active.integrating (children done)
Phase 8:  active.working ──→ review_pending.demo
Phase 9:  review_pending.demo ──→ review_pending.code (demo approved)
          review_pending.{demo,code} ──→ queued (rework)
Phase 10: review_pending.code ──→ completed (code approved)
Phase 11: active.working ──→ blocked ──→ failed (escalation)
          active.working ──→ queued (preemption / crash recovery)
          blocked ──→ active.working (self-unblock)
```

---

## Cross-Cutting Infrastructure

These are services, not phases. They activate on-demand throughout the lifecycle:

| Service | Role | Used By |
|---------|------|---------|
| EventBus | Audit trail + pub/sub | All phases |
| TaskEngine | State machine + Gate 1 | Phases 4-11 |
| SafetyLayer | Cost tracking + Gate 2 | Phases 5-8, 11 |
| ActionPipeline | Authorization middleware | Phase 7 (execution) |
| SessionMemory | Sessions, journal, checkpoints | Phases 6-7, 11 |
| Observer | Structured tracing (War Room) | All phases |
| PeopleDirectory | Contact resolution | Phases 8-11 |
| WorkspaceManager | Git worktree operations | Phases 6, 8, 10 |

---

## 5 Lifecycle Paths (from final-user-flow-review.md)

All 5 paths map to these phases:

1. **Happy Path**: 0→1→2→3→4→5→6→7→8→(review polling)→10
2. **Fast Path**: Same but Phase 7 runs only 3 of 7 sub-phases
3. **Decomposition**: Phase 7 exits early → children run Phases 5-8 → parent resumes Phase 7 (integration)
4. **Rework**: Phase 9 → back to Phase 5 → re-run Phases 6-8
5. **Error & Recovery**: Phase 11 intercepts at any point during Phases 5-8

---

## Documentation Status

| Phase | Doc File | Status |
|-------|----------|--------|
| 0-1 | `1-bootstrap-wiring.md` | DONE |
| 2 | `2-plugin-loading.md` | DONE |
| 3 | `3-daemon-startup.md` | DONE |
| 4 | `4-trigger-polling.md` | DONE |
| 5 | `5-scheduling-dispatch.md` | DONE |
| 6 | `6-workspace-session.md` | DONE |
| 7 | `7-phase-pipeline.md` | DONE |
| 8 | `8-pr-review.md` | DONE |
| 9 | `9-feedback-rework.md` | DONE |
| 10 | `10-completion-cleanup.md` | DONE |
| 11 | `11-error-recovery.md` | DONE |
| 12 | `12-background-services.md` | DONE |
