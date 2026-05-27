# Post-Execution Review — End-to-End Flow

After execution completes, The Engineer reviews its own work through a multi-step self-review process. If the review finds issues, the system loops back to **execution** to fix them — up to a configurable limit. If any phase (including execution on a retry) determines it lacks sufficient information, a separate mechanism routes to **requirements_gathering** for clarification. This document covers the review pipeline, loopback mechanics, context preservation, and safety limits.

## Key Files

| Component | File | Role |
|---|---|---|
| Self-review prompts | `src/core/orchestrator/prompts/review.ts` | Review sub-phase and refinement prompts |
| Loopback detection | `src/core/orchestrator/phase-runner.ts` | `checkSelfReviewLoopback()` — verdict evaluation and routing |
| Post-phase routing | `src/core/orchestrator/phase-runner.ts` | `handlePostPhaseActions()` — orchestrates all routing decisions |
| Phase navigation | `src/core/orchestrator/phase-navigator.ts` | `jumpTo()`, `advance()`, cursor-based phase sequencing |
| Phase handlers | `src/core/orchestrator/phase-handlers.ts` | Self-review handler (multi-step: sub-phases + refinement) |
| Pipeline state | `src/core/orchestrator/types.ts` | `PipelineState` — loopback counter, return-to-phase tracking |
| Config schema | `src/schemas/config.ts` | `RrpirConfigSchema` — loopback limits, review phase selection |

---

## 1. Self-Review Pipeline

**Entry point:** Self-review phase handler in `phase-handlers.ts`, triggered after execution completes.

Self-review is not a single agent run — it's a **multi-step pipeline** with configurable review lenses followed by a consolidation step.

### Review Sub-Phases

Configured via `rrpir.review_phases` (default: `["requirements_check"]`). Available lenses:

| Sub-Phase | Purpose |
|---|---|
| `requirements_check` | Validates implementation against acceptance criteria |
| `security_review` | Finds security vulnerabilities |
| `code_quality` | Evaluates readability and maintainability |
| `architecture_review` | Checks system boundary compliance and design principles |

Each sub-phase:
1. Runs the CLI tool with a review-specific prompt
2. Writes findings to `thoughts/{thoughtsDir}/review/{phase-name}.md`
3. Does **not** produce a `session-result.json` — these are informational only

### Refinement Step

After all sub-phases complete, the refinement step consolidates findings:

```
Run all configured review sub-phases
  |
  +-- requirements_check → thoughts/.../review/requirements_check.md
  +-- security_review    → thoughts/.../review/security_review.md
  +-- (etc.)
  |
  v
Refinement step
  +-- Read ALL thoughts/.../review/*.md findings
  +-- Apply fixes directly in code
  +-- Write session-result.json:
        {
          "status": "ready" | "need_more_info" | "error",
          "next_phase": "demo_prep" | "execution" | "requirements_gathering",
          "summary": "<one-line refinement verdict>"
        }
```

The refinement handler maps `next_phase` to an internal `quality_assessment`:

| `next_phase` value | `quality_assessment` | Meaning |
|---|---|---|
| `"execution"` | `needs_work` | Code needs fixes, loop back |
| `"requirements_gathering"` | `fundamental_issues` | Deeper problems detected, loop back |
| `"demo_prep"` or anything else | `ship_it` | Work is acceptable, proceed |

---

## 2. Loopback Decision

**Entry point:** `checkSelfReviewLoopback()` in `phase-runner.ts`

Called by `handlePostPhaseActions()` after self-review completes. This is the single decision point for whether execution reruns.

### Decision Flow

```
Self-review refinement output
  |
  v
Read quality_assessment (primary)
  +-- Missing? Derive from next_phase:
  |     "execution"               → "needs_work"
  |     "requirements_gathering"  → "fundamental_issues"
  |     anything else             → "" (no loopback)
  |
  v
Assessment is "needs_work" or "fundamental_issues"?
  |
  +-- NO:  return null (proceed to demo_prep)
  |
  +-- YES:
        |
        v
      Increment loopbackCount
      loopbackCount > max_review_loopbacks?
        |
        +-- YES: emit alert, return null (proceed to demo_prep for human review)
        +-- NO:  return { targetPhase: execution, loopbackCount }
```

### Critical Design Decision

**Both `needs_work` and `fundamental_issues` loop back to execution.** The distinction between the two is logged in journal entries for observability, but the routing target is always the same. The rationale: execution is where code changes happen, and if the execution phase itself determines it lacks context, it can independently trigger the need-more-info fallback (see Section 4).

---

## 3. Loopback Execution

**Entry point:** Main pipeline loop in `phase-runner.ts`

When `checkSelfReviewLoopback()` returns a loopback result:

```
handlePostPhaseActions() returns { kind: "loopback", targetPhase: execution }
  |
  v
Pipeline main loop:
  1. Clear phase outputs from execution onward (prevents unbounded memory growth)
  2. Replace phase sequence (preserves any dynamic changes)
  3. Jump navigator cursor to execution
  4. Continue loop → execution runs again
  |
  v
Execution completes
  |
  v
Repo context refreshed (captures new code changes)
  |
  v
Self-review runs again with:
  - Updated loopbackCount (the agent knows this is attempt N)
  - Fresh repo context (sees actual code from latest execution)
  - Prior review findings still in thoughts/.../review/*.md
  |
  v
Loopback decision repeats (Section 2)
```

### Context Preservation

| What | How |
|---|---|
| Loopback count | Passed to review prompt builder so the agent knows which attempt this is |
| Prior findings | Review sub-phase `.md` files persist in `thoughts/` directory across loops |
| Repo context | Refreshed after every execution phase via `gatherRepoContextSafe()` |
| Phase outputs | Cleared from execution onward to prevent stale data accumulation |
| Counter persistence | `loopbackCount` saved to task record for crash recovery |

---

## 4. Need-More-Info Fallback (Separate System)

Independent of the self-review loopback, **any phase** can signal `status: "need_more_info"` to route to requirements gathering. This is how execution (during a loopback retry) can escalate to requirements clarification.

```
Any non-requirements phase outputs { status: "need_more_info" }
  |
  v
Save returnToPhase = current phase
Route to requirements_gathering
  |
  v
Requirements gathering completes
  |
  +-- status: "need_more_info" → block task, send outreach for human input
  +-- status: "ready"          → jump back to returnToPhase (e.g., execution)
```

**Own limit:** `rrpir.max_requirements_loops` (default: **5**).

This means the indirect path exists: self_review → execution (loopback) → execution signals need_more_info → requirements_gathering → back to execution. The two systems compose but operate independently.

---

## 5. Safety Limits

### Loopback Limit

| Config | Default | Effect |
|---|---|---|
| `rrpir.max_review_loopbacks` | **3** | Max times self-review can loop back to execution |

When exceeded:
1. Alert notification sent (routed through notification system)
2. Journal entry logged with attempt count and assessment
3. Loopback bypassed — pipeline proceeds to **demo_prep** for human review

The task is not abandoned — it advances to demo_prep where a PR is created. The human reviewer sees the work and can decide what to do.

### Requirements Loop Limit

| Config | Default | Effect |
|---|---|---|
| `rrpir.max_requirements_loops` | **5** | Max times any phase can route to requirements gathering |

When exceeded: warning logged, pipeline continues to next phase.

---

## 6. Notification Matrix

| Event | Kind | Message |
|---|---|---|
| Loopback triggered | (journal only) | "Quality assessment: {verdict}. Looping back to execution (attempt N)." |
| Loopback limit exceeded | `alert` | "Self-review loopback threshold exceeded (N attempts, assessment: {verdict}). Proceeding to demo_prep for human review." |

---

## 7. Configuration

### orchestrator.yaml — Review Settings

```yaml
rrpir:
  max_review_loopbacks: 3                              # Max execution retries after self-review
  max_requirements_loops: 5                             # Max requirements_gathering detours
  review_phases: ["requirements_check"]                 # Which review lenses to run
  # Available: requirements_check, security_review, code_quality, architecture_review
```

---

## 8. What Self-Review Cannot Do

For clarity, these are the routing limitations of the current design:

| Scenario | What happens |
|---|---|
| Code needs fixes | Loops to execution (direct) |
| Requirements unclear | Loops to execution; execution can escalate to requirements_gathering (indirect) |
| Plan/approach was wrong | Loops to execution — no direct path back to planning or research |
| Persistent failure after 3 loops | Proceeds to demo_prep, human alerted |

The system does not support looping back to **research** or **planning** from self-review. If the entire approach is flawed, the execution phase would need to independently course-correct or the human reviewer handles it after demo_prep.

---

## 9. End-to-End State Diagram

```
                  +-------------+
                  |  execution  |<--------+
                  |  (working)  |         |
                  +------+------+         |
                         |                |
                   completes              |
                   refresh repo ctx       |
                         |                |
                         v                |
              +-------------------+       |
              |    self_review    |       |
              | (sub-phases +    |       |
              |  refinement)     |       |
              +--------+---------+       |
                       |                 |
            +----------+----------+      |
            |          |          |      |
         ship_it  needs_work  fundamental   
            |          |      _issues    |
            |          |          |      |
            |          +----+-----+      |
            |               |            |
            |          under limit?       |
            |          YES  |  NO        |
            |           |   |            |
            |           |   +---> alert  |
            |           |         |      |
            v           |         v      |
       +----------+     |    +----------+|
       | demo_prep|     +--->| execution |+
       +----------+          +----------+
            |
            v
    (PR created, human review)
```
