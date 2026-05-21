# Phase 7: 7-Phase Pipeline

---

## Flow

```
runPhasePipeline(dispatch, state, deps)
    │
    ├─ Resolve start index (from checkpoint if resuming)
    ├─ Initialize priorOutputs map
    │
    ▼
For each phase [i = startIndex .. phases.length]:
    │
    ├─ Check preemption flag → if set: checkpoint + yield + return "preempted"
    ├─ Check andon cord → if pulled: return error
    │
    ├─ Execute phase handler → PhaseOutput
    │   └─ runPhaseWithAgentLoop(phase, taskId, systemPrompt, phasePrompt, state)
    │       ├─ Get phase tool config (which actions allowed)
    │       ├─ runAgentLoop(prompt, callLlm, executeAction)
    │       │   └─ LLM call → parse AgentAction → execute → feed result → repeat
    │       │      └─ Until action.type === "done"
    │       ├─ Validate output against phase schema (safeParse)
    │       └─ Emit cost.incurred event
    │
    ├─ processPhaseCompletion()
    │   ├─ After intake:    fast-path check (skip research/planning/demo_prep)
    │   ├─ After planning:  decomposition check → exit with "decomposed"
    │   ├─ After self_review: loopback check → jump back to execution
    │   ├─ After demo_prep: PR creation → exit with "review_pending"
    │   └─ Always: checkpoint + journal (SBAR handoff) + update task.phase
    │
    └─ Check preemption after transition
```

---

## Production Files

| # | File | Role |
|---|------|------|
| 1 | `src/core/orchestrator/phase-runner.ts` | Pipeline loop, phase transitions, completion logic |
| 2 | `src/core/orchestrator/llm-caller.ts` | LLM invocation with retry + validation |
| 3 | `src/core/orchestrator/action-executor.ts` | Agent action execution (file ops, commands) |
| 4 | `src/core/orchestrator/decomposition-handler.ts` | Child task creation from decomposition plan |
| 5 | `src/core/orchestrator/pr-manager.ts` | Commit, push, draft PR creation |
| 6 | `src/core/orchestrator/prompts/system.ts` | Shared system prompt (persona) |
| 7 | `src/core/orchestrator/prompts/context.ts` | Repo context assembly |
| 8 | `src/core/orchestrator/prompts/intake.ts` | Intake analysis prompt |
| 9 | `src/core/orchestrator/prompts/research.ts` | Research prompt (complexity-adaptive) |
| 10 | `src/core/orchestrator/prompts/planning.ts` | Planning prompt (approach + decomposition) |
| 11 | `src/core/orchestrator/prompts/execution.ts` | Execution prompt (implementation + test-fix) |
| 12 | `src/core/orchestrator/prompts/self-review.ts` | Self-review prompt (quality gate) |
| 13 | `src/core/orchestrator/prompts/demo-prep.ts` | Demo prep prompt (PR narrative) |
| 14 | `src/core/orchestrator/prompts/integration.ts` | Integration prompt (child summaries) |
| 15 | `src/core/orchestrator/prompts/format.ts` | Formatting utilities for prior phase injection |

---

## 7 Sub-Phases

### 1. intake_analysis
- **Input**: Task description, repo context, unapplied feedback (if rework)
- **Output**: `{ complexity, estimated_phases, ambiguities, fast_path, decomposition_likely }`
- **Decision**: If `fast_path: true` → skip research, planning, demo_prep, integration

### 2. research (skipped if fast_path)
- **Input**: Intake output, repo context, knowledge
- **Output**: `{ relevant_files, relevant_modules, conventions, existing_patterns, dependencies }`

### 3. planning
- **Input**: Intake + research outputs, repo context
- **Output**: `{ approach, file_changes, risks, decomposition_plan }`
- **Decision**: If `decomposition_plan` present → create children, exit pipeline

### 4. execution
- **Input**: Full plan + repo context + knowledge + review findings (if loopback)
- **Agent loop**: Multiple iterations with file ops + commands
- **Output**: `{ files_changed, tests_written, test_results, build_status }`

### 5. self_review
- **Input**: Plan + execution output + loopback count
- **Output**: `{ findings, refactoring_applied, quality_assessment }`
- **Decision**: If `quality_assessment === "needs_work"` AND loopbackCount < 3 → jump to execution

### 6. demo_prep (skipped if fast_path)
- **Input**: Execution + self-review outputs
- **Output**: `{ pr_description, demo_artifacts }`
- **Action**: `prManager.commitPushAndCreatePR()` → exit with "review_pending"

### 7. integration (only for decomposed parent tasks)
- **Input**: Execution + self-review + child_summaries
- **Output**: `{ integration_notes }`

---

## Special Exit Points

| Exit | Trigger | Outcome | When |
|------|---------|---------|------|
| Fast-path PR | self_review is last phase | `review_pending` | Fast-path tasks |
| Demo-prep PR | demo_prep completes | `review_pending` | Normal tasks |
| Decomposition | planning has decomposition_plan | `decomposed` | Complex tasks |
| Preemption | preemption flag set | `preempted` | Higher-priority task arrives |
| Error | phase handler throws | `error` | LLM failure, tool failure |

---

## Self-Review Loopback

```
self_review output → quality_assessment
    │
    ├─ "ship_it"          → proceed to demo_prep
    ├─ "needs_work"       → loopbackCount++ → jump to execution (max 3)
    ├─ "fundamental_issues" → loopbackCount++ → jump to execution (max 3)
    └─ loopbackCount >= 3 → emit alert, proceed to demo_prep anyway
```

Max 3 loopbacks. After that, the human is alerted and the task proceeds.

---

## Agent Loop

Each phase runs through the agent loop (`runAgentLoop`):

1. Build prompt (system + phase-specific + prior outputs)
2. Call LLM (with retry: 3 attempts, exponential backoff 1s/2s/4s)
3. Parse response → `AgentAction`
4. If `action.type !== "done"`: execute action → feed result back → repeat
5. If `action.type === "done"`: extract phase data, validate against schema

### 7 Agent Actions

| Action | Gate | Description |
|--------|------|-------------|
| `read_file` | read | Read file contents |
| `write_file` | write (Gate 1 + Gate 2) | Write file |
| `edit_file` | write (Gate 1 + Gate 2) | Edit file section |
| `search_files` | read | Glob pattern search |
| `search_content` | read | Content grep |
| `run_command` | write (Gate 1 + Gate 2) | Shell command via BashTool |
| `done` | — | Phase complete, return data |

All file paths validated to prevent workspace escape via `resolveWorktreePath()`.

---

## Phase Transition Recording

After each phase completes:

1. **Checkpoint**: `sessionMemory.createCheckpoint()` with phase, progress, key findings
2. **SBAR Journal**: `sessionMemory.addJournalEntry()` with Situation/Background/Assessment/Recommendation handoff
3. **Task update**: `taskEngine.updateTaskField(taskId, "phase", nextPhase)`

---

## Test Files

| File | Type |
|------|------|
| `src/core/orchestrator/phase-runner.test.ts` | Unit — pipeline loop, loopback, fast-path |
| `src/core/orchestrator/llm-caller.test.ts` | Unit — retry, validation |
| `src/core/orchestrator/action-executor.test.ts` | Unit — action execution |
| `src/core/orchestrator/prompts/*.test.ts` | Unit — prompt builders |
| `test/e2e/task-happy-path.e2e.test.ts` | E2E — full pipeline |
