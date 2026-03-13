# Phase R4: Orchestrator Decomposition

**Wave 2 (Parallel) -- Can run alongside R1, R2a, R2b, R2c, R3.**

---

## Worktree Setup (DO THIS FIRST)

This phase runs in an **isolated git worktree**. Before doing anything else:

```bash
# From the main repo directory:
cd /Users/farzammohammadi/Documents/Repos/the-engineer
git worktree add ../engineer-R4 -b layer7/R4 main
cd ../engineer-R4
```

**Rules:**
- Work ONLY in this worktree (`../engineer-R4/`)
- Commit your changes to the `layer7/R4` branch
- Do NOT push — the merge prompt will collect this branch
- Do NOT modify files outside the scope listed in this prompt
- When done: commit, verify tests pass, stop. The merge wave handles the rest.

---

You are an autonomous software engineering agent working on The Engineer project. This prompt is fully self-contained -- you have zero prior context. Follow every step precisely.

---

## 1. Identity Preamble

Before making any changes, read these files to understand who The Engineer is:

- `docs/persona.md` -- The Engineer's identity and characteristics
- `docs/philosophy.md` -- Core beliefs: agent-agnostic protocol, minimalism, real engineer behavior, modular everything
- `implementation-docs/0-foundation/philosophy.md` -- Builder-specific principles (say it once, collaboration, no premature artifacts)

Internalize: The Engineer is the 100,000x engineer. Every line earns its place. Simplicity is the goal. Full names, no abbreviations.

---

## 2. Architecture Catchup

Read these docs to understand the system architecture relevant to this phase:

- `implementation-docs/1-system/overview.md` -- System overview, three-tier model
- `implementation-docs/1-system/task-states.md` -- CPU-derived state machine
- `implementation-docs/2-components/orchestrator.md` (if it exists) -- Orchestrator component design
- `implementation-docs/3-interactions/protocols.md` -- Protocols P4 (phase transition), P8 (preemption), P9 (task resume)
- `implementation-docs/3-interactions/event-catalog.md` -- Event catalog (especially cost.incurred, preemption.*)
- `implementation-docs/3-interactions/lifecycle.md` -- Lifecycle traces (full pipeline scenario)
- `implementation-docs/4-implementation/plugins.md` -- Plugin system (adapter contracts)
- `implementation-docs/4-implementation/testing.md` -- Testing strategy
- `implementation-docs/7-restructure/assessment.md` -- Layer 7 assessment (Orchestrator: 1,724 LOC, 35 methods, 8 concerns)
- `implementation-docs/7-restructure/decisions.md` -- Layer 7 decisions (D166+)

---

## 3. Decision Log Review

Read `implementation-docs/decisions.md` and understand these specific decisions:

- **D85**: SafeParse fallback outputs
- **D124**: Factory function pattern
- **D128**: Build order (Phase 11 = Orchestrator Skeleton)
- **D143**: The Engineer IS the agent -- LLMs are inference-only
- **D144**: Workspace-first pipeline
- **D145**: CLI env isolation
- **D146**: Dual-mode cost tracking
- **D147**: Workspace creation in Orchestrator
- **D149**: Draft PR creation after demo_prep
- **D150**: PR creation workflow
- **D151**: Token injection for push
- **D152**: Milestone notifications
- **D153**: Workspace cleanup policy
- **D154**: Secret sanitization

Also check `implementation-docs/7-restructure/decisions.md` for any D166+ decisions that affect Orchestrator decomposition.

---

## 4. Current Code Deep-Read

Read ALL of these files completely before making any changes:

### Source files (the files being decomposed)
- `src/core/orchestrator/index.ts` -- **The main file** (1,724 LOC, `Orchestrator` class)
- `src/core/orchestrator/agent-loop.ts` -- Agent loop engine (already extracted)
- `src/core/orchestrator/action-executor.ts` -- Action executor (already extracted)
- `src/core/orchestrator/phase-tools.ts` -- Phase tool restrictions (already extracted)

### Prompt modules (already extracted, do NOT modify)
- `src/core/orchestrator/prompts/system.ts`
- `src/core/orchestrator/prompts/context.ts`
- `src/core/orchestrator/prompts/format.ts`
- `src/core/orchestrator/prompts/intake.ts`
- `src/core/orchestrator/prompts/research.ts`
- `src/core/orchestrator/prompts/planning.ts`
- `src/core/orchestrator/prompts/execution.ts`
- `src/core/orchestrator/prompts/self-review.ts`
- `src/core/orchestrator/prompts/demo-prep.ts`
- `src/core/orchestrator/prompts/integration.ts`
- `src/core/orchestrator/prompts/index.ts`

### Schema files
- `src/schemas/orchestrator.ts` -- `Phase`, `PhaseOutput`, phase output schemas, `AgentAction`, `LLMDecompositionPlanSchema`
- `src/schemas/adapters.ts` -- `CompletionResult`, adapter types
- `src/schemas/ephemeral.ts` -- `Dispatch` type
- `src/schemas/events.ts` -- Event types and payloads
- `src/schemas/task.ts` -- Task type, `ChildEntry`
- `src/schemas/observability.ts` -- `ActionTraceRecord`, `LlmTraceRecord`

### Dependencies
- `src/core/event-bus/index.ts` -- `EventBus`, `PublishInput`
- `src/core/task-engine/index.ts` -- `TaskEngine` interface
- `src/core/safety-layer/index.ts` -- `SafetyLayer` interface
- `src/core/session-memory/index.ts` -- `SessionMemory` interface
- `src/core/workspace-manager/index.ts` -- `WorkspaceManager` interface
- `src/core/people-directory/index.ts` -- `PeopleDirectory` interface
- `src/core/registry/index.ts` -- `Registry` class
- `src/core/action-pipeline/index.ts` -- `ActionPipeline` interface
- `src/core/observability/index.ts` -- `ObservabilityStore` interface
- `src/utils/sanitize.ts` -- `sanitizeSecrets()`

### Test files
- `src/core/orchestrator/index.test.ts` -- Main Orchestrator tests (35 tests)
- `src/core/orchestrator/agent-loop.test.ts` -- Agent loop tests
- `src/core/orchestrator/action-executor.test.ts` -- Action executor tests
- `src/core/orchestrator/phase-tools.test.ts` -- Phase tools tests
- `src/core/orchestrator/comment-on-issue.test.ts` -- Issue comment tests
- `src/core/orchestrator/commit-push-pr.test.ts` -- PR workflow tests (10 tests)
- `src/core/orchestrator/decomposition.test.ts` -- Decomposition tests

### Test helpers
- `test/helpers/test-orchestrator.ts` -- `createTestOrchestrator()` helper
- `test/helpers/mock-factories.ts` -- Mock factories

---

## 5. Exact Specifications

### Goal
Decompose the monolithic `Orchestrator` class (1,724 LOC, 35 methods) into 5 focused subsystems. The `Orchestrator` class remains as the public API but delegates to subsystems. Each subsystem is either a factory function returning an object or a set of pure functions.

### New file structure

```
src/core/orchestrator/
  index.ts                  -- Orchestrator class (slim facade) + barrel exports
  phase-runner.ts           -- Phase execution pipeline with handler registry
  workspace-lifecycle.ts    -- Workspace setup, session management, preemption
  pr-manager.ts             -- Commit, push, PR creation, rework handling
  decomposition-handler.ts  -- Task decomposition logic
  llm-caller.ts             -- LLM invocation with retry, cost emission, schema validation
  agent-loop.ts             -- (already extracted, keep as-is)
  action-executor.ts        -- (already extracted, keep as-is)
  phase-tools.ts            -- (already extracted, keep as-is)
  prompts/                  -- (already extracted, keep as-is)
  index.test.ts             -- Existing tests (update imports if needed)
```

### Shared Dependencies Interface

Define a shared context for subsystems:

```typescript
/** Shared dependencies available to all Orchestrator subsystems. */
export interface OrchestratorContext {
  eventBus: EventBus;
  registry: Registry;
  taskEngine: TaskEngine;
  safetyLayer: SafetyLayer;
  actionPipeline: ActionPipeline;
  sessionMemory: SessionMemory;
  workspaceManager: WorkspaceManager;
  peopleDirectory: PeopleDirectory;
  observability: ObservabilityStore | null;
}
```

### Module: `phase-runner.ts`

Extract the phase execution pipeline -- the core control flow:

```typescript
/** A phase handler function. */
export type PhaseHandler = (
  taskId: string,
  dispatch: Dispatch,
  priorOutputs: Map<Phase, PhaseOutput>,
) => Promise<PhaseOutput>;

/** Registry of phase handlers (avoid hardcoded switch/map in Orchestrator). */
export interface PhaseHandlerRegistry {
  get(phase: Phase): PhaseHandler;
}

export interface PhaseRunnerDeps {
  ctx: OrchestratorContext;
  handlers: PhaseHandlerRegistry;
  llmCaller: LlmCaller;
  workspaceLifecycle: WorkspaceLifecycle;
  prManager: PrManager;
  decompositionHandler: DecompositionHandler;
}

export interface PhaseRunnerResult {
  outcome: ExecuteTaskResult;
}

/**
 * Execute a task through the phase pipeline.
 *
 * This is the main loop extracted from Orchestrator.executeTask().
 * Handles: phase sequence, fast-path, loopback, preemption, decomposition,
 * PR creation, and phase transitions.
 */
export async function runPhasePipeline(
  dispatch: Dispatch,
  sessionId: string,
  traceId: string,
  deps: PhaseRunnerDeps,
): Promise<ExecuteTaskResult>
```

Functions to move here:
- `resolveStartState()` -- determine start phase and sequence
- `processPhaseCompletion()` -- post-phase logic (fast-path, loopback, decomposition, PR)
- `applyFastPathIfNeeded()` -- fast-path decision
- `checkSelfReviewLoopback()` -- self-review quality gate
- `emitLoopbackAlert()` -- human alert on excessive loopbacks
- `recordPhaseTransition()` -- Protocol P4 phase transition recording
- `createPhaseCheckpoint()` -- checkpoint creation
- `handlePreemption()` -- Protocol P8 preemption handling
- `handlePhaseError()` -- error result building
- `tryCreatePRAndExitForReview()` -- PR creation exit point
- Constants: `PHASE_SEQUENCE`, `FAST_PATH_PHASES`, `MAX_LOOPBACKS_BEFORE_ALERT`, `PHASE_SCHEMAS`

**Improvement -- Phase handlers as registry**: Instead of a hardcoded `Record<Phase, handler>` map bound in the constructor, use a `PhaseHandlerRegistry` interface. This makes it trivial to add, remove, or reorder phases without touching the runner. The Orchestrator constructor builds the registry:
```typescript
function createPhaseHandlerRegistry(handlers: Record<Phase, PhaseHandler>): PhaseHandlerRegistry {
  return {
    get(phase: Phase): PhaseHandler {
      const handler = handlers[phase];
      if (!handler) throw new Error(`No handler registered for phase: ${phase}`);
      return handler;
    },
  };
}
```

**Improvement -- Sterile cockpit (aviation)**: During critical phases (execution, self_review), suppress non-critical notifications and reduce logging noise. Add a `isCriticalPhase(phase: Phase): boolean` check:
```typescript
const CRITICAL_PHASES: Set<Phase> = new Set(["execution", "self_review"]);
export function isCriticalPhase(phase: Phase): boolean {
  return CRITICAL_PHASES.has(phase);
}
```
This is informational for now -- the actual suppression can be wired in later phases.

**Improvement -- SBAR handoffs (medicine)**: When transitioning between phases, structure the handoff context using SBAR (Situation, Background, Assessment, Recommendation). Add a pure function:
```typescript
export function buildPhaseHandoff(
  completedPhase: Phase,
  nextPhase: Phase,
  output: PhaseOutput,
  dispatch: Dispatch,
): string {
  return [
    `SITUATION: Completed ${completedPhase} phase for task "${dispatch.task.title}"`,
    `BACKGROUND: ${output.confidence} confidence, ${output.open_questions.length} open questions`,
    `ASSESSMENT: ${output.open_questions.length > 0 ? "Open questions need attention" : "Clean handoff"}`,
    `RECOMMENDATION: Proceed with ${nextPhase}`,
  ].join("\n");
}
```
Log this at each phase transition for operational visibility.

### Module: `workspace-lifecycle.ts`

Extract workspace setup, session creation, and milestone notifications:

```typescript
export interface WorkspaceLifecycle {
  /** Set up workspace and session for a task dispatch. */
  setupWorkspace(dispatch: Dispatch, traceId: string): { sessionId: string };
  /** Send a milestone notification via PeopleDirectory + comm plugins. */
  notifyMilestone(dispatch: Dispatch, message: string): void;
  /** Post a comment on the source GitHub issue. */
  commentOnSourceIssue(dispatch: Dispatch, message: string): void;
  /** Create a session for a dispatch. */
  createSession(dispatch: Dispatch): { id: string };
}

export function createWorkspaceLifecycle(ctx: OrchestratorContext): WorkspaceLifecycle
```

Functions to move here:
- `createSession()` (the session creation logic from executeTask)
- Workspace setup logic (worktree creation, existing workspace registration, parent branch lookup)
- `notifyMilestone()` -- milestone notification routing
- `commentOnSourceIssue()` -- GitHub issue commenting
- `getTaskRepo()` -- repository identifier extraction

**Improvement -- Andon cord / stop signals (Toyota Production System)**: Add a mechanism for any subsystem to signal "stop the line" -- an emergency halt that prevents the pipeline from proceeding. Implement as a simple flag:
```typescript
export interface AndonCord {
  pull(reason: string): void;
  isPulled(): boolean;
  getReason(): string | null;
  reset(): void;
}

export function createAndonCord(): AndonCord {
  let pulled = false;
  let reason: string | null = null;
  return {
    pull(r) { pulled = true; reason = r; },
    isPulled() { return pulled; },
    getReason() { return reason; },
    reset() { pulled = false; reason = null; },
  };
}
```
The phase runner checks `andonCord.isPulled()` between phases (alongside preemption check). Wire this into `PhaseRunnerDeps`. Triggers for pulling the cord: secret detection in LLM output, workspace corruption detected, critical safety violation.

### Module: `pr-manager.ts`

Extract all PR-related logic:

```typescript
export interface PrManager {
  /** Commit, push, and create draft PR. Returns true if PR was created/pushed. */
  commitPushAndCreatePR(
    sessionId: string,
    taskId: string,
    demoPrepOutput: PhaseOutput,
    dispatch: Dispatch,
  ): Promise<boolean>;
}

export function createPrManager(ctx: OrchestratorContext): PrManager
```

Functions to move here:
- `commitPushAndCreatePR()` -- the entire commit/push/PR creation workflow
- `logPrStepFailure()` -- PR step failure logging

**Improvement -- Secret sanitization on LLM input**: Before building the PR description from LLM output, run `sanitizeSecrets()` on the content. The current code sanitizes LLM output generally but PR descriptions should be explicitly sanitized since they become public:
```typescript
import { sanitizeSecrets } from "../../utils/sanitize.js";

const prDescription = sanitizeSecrets(
  (demoPrepOutput.data as { pr_description?: string }).pr_description ??
    `Automated PR for: ${dispatch.task.title}`
);
```

**Improvement -- Trace context**: Log the trace ID in all PR workflow steps for correlation:
```typescript
console.log(`[pr-workflow] [trace=${traceId}] pushing branch ${record.branch}...`);
```
Accept `traceId` as a parameter in the `commitPushAndCreatePR` method signature.

### Module: `decomposition-handler.ts`

Extract task decomposition logic:

```typescript
export interface DecompositionHandler {
  /**
   * Check if planning output contains a decomposition plan.
   * If so, create child tasks and transition parent to supervising.
   * Returns ExecuteTaskResult if decomposed, null otherwise.
   */
  handleDecomposition(
    sessionId: string,
    taskId: string,
    planningOutput: PhaseOutput,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): ExecuteTaskResult | null;
}

export function createDecompositionHandler(ctx: OrchestratorContext): DecompositionHandler
```

Functions to move here:
- `handleDecomposition()` -- the entire decomposition workflow (validate plan, create children, transition parent, journal, comment)

This is a clean extraction -- the function is already well-isolated in the current code.

### Module: `llm-caller.ts`

Extract LLM invocation, cost tracking, and response validation:

```typescript
export interface LlmCaller {
  /** Call LLM through ActionPipeline. Throws on rejection. */
  callLlm(prompt: string, taskId: string, systemPrompt?: string | null): Promise<CompletionResult>;
  /** Call LLM, parse JSON response, validate against phase schema. */
  callLlmAndParse(phase: Phase, taskId: string, prompt: string): Promise<PhaseOutput>;
  /** Run a phase through the agent loop (multi-turn LLM + tool execution). */
  runPhaseWithAgentLoop(
    phase: Phase,
    taskId: string,
    systemPrompt: string,
    initialPrompt: string,
    traceId: string | null,
    sessionId: string | null,
  ): Promise<PhaseOutput>;
  /** Emit cost.incurred event. */
  emitCostIncurred(taskId: string, completion: CompletionResult): void;
  /** Build a PhaseOutput envelope. */
  buildPhaseOutput(
    phase: Phase,
    taskId: string,
    data: Record<string, unknown>,
    confidence: "high" | "medium" | "low",
    openQuestions: string[],
  ): PhaseOutput;
  /** Build a fallback PhaseOutput when validation fails. */
  buildFallbackOutput(phase: Phase, taskId: string, errorMessage: string): PhaseOutput;
  /** Get default data for a phase. */
  getDefaultData(phase: Phase): Record<string, unknown>;
}

export function createLlmCaller(ctx: OrchestratorContext): LlmCaller
```

Functions to move here:
- `callLlm()` -- LLM invocation through ActionPipeline
- `callLlmAndParse()` -- LLM call + JSON parse + schema validation
- `runPhaseWithAgentLoop()` -- agent loop orchestration
- `emitCostIncurred()` -- cost event emission
- `emitAgentLoopCost()` -- agent loop cost event emission
- `buildPhaseOutput()` -- PhaseOutput envelope builder
- `buildFallbackOutput()` -- fallback output builder (D85)
- `getDefaultData()` -- default data per phase
- `validateLoopResult()` -- agent loop result validation
- `buildObservabilityCallbacks()` -- observability callback builder

**Improvement -- LLM retry with exponential backoff**: Wrap `callLlm()` with retry logic for transient failures. The assessment identified "No LLM retry/circuit breaker" as a resilience gap:
```typescript
const MAX_LLM_RETRIES = 3;
const LLM_RETRY_BASE_MS = 1000;

async function callLlmWithRetry(
  prompt: string,
  taskId: string,
  systemPrompt?: string | null,
): Promise<CompletionResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt++) {
    try {
      return await callLlmInner(prompt, taskId, systemPrompt);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error)) throw error;
      const delay = LLM_RETRY_BASE_MS * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return msg.includes("timeout") ||
         msg.includes("rate limit") ||
         msg.includes("503") ||
         msg.includes("529") ||
         msg.includes("overloaded");
}
```

**Improvement -- Tool result structuring (SWE-agent pattern)**: When feeding tool results back to the LLM in the agent loop, structure them with clear delimiters and metadata. This is already partially done in `agent-loop.ts` -- verify the pattern is consistent and add a formatting function if needed:
```typescript
export function formatToolResult(action: AgentAction, result: ActionResult): string {
  const header = `[${action.action}] ${result.success ? "SUCCESS" : "FAILURE"}`;
  const output = result.output ? `\nOutput:\n${result.output}` : "";
  const error = result.error ? `\nError: ${result.error}` : "";
  return `${header}${output}${error}`;
}
```

### Updated `index.ts` (Orchestrator facade)

The `Orchestrator` class becomes a thin facade:

```typescript
export class Orchestrator {
  private readonly ctx: OrchestratorContext;
  private readonly llmCaller: LlmCaller;
  private readonly workspaceLifecycle: WorkspaceLifecycle;
  private readonly prManager: PrManager;
  private readonly decompositionHandler: DecompositionHandler;
  private readonly andonCord: AndonCord;
  private readonly phaseHandlers: PhaseHandlerRegistry;

  private preemptionRequested = false;
  private preemptionPayload: { target_task_id: string; preempting_task_id: string } | null = null;

  constructor(deps: OrchestratorDependencies) {
    this.ctx = { ...deps, observability: deps.observability ?? null };
    this.llmCaller = createLlmCaller(this.ctx);
    this.workspaceLifecycle = createWorkspaceLifecycle(this.ctx);
    this.prManager = createPrManager(this.ctx);
    this.decompositionHandler = createDecompositionHandler(this.ctx);
    this.andonCord = createAndonCord();

    // Build phase handlers -- each delegates to llmCaller.runPhaseWithAgentLoop
    this.phaseHandlers = createPhaseHandlerRegistry({
      intake_analysis: (taskId, dispatch, priorOutputs) =>
        this.handleIntakeAnalysis(taskId, dispatch, priorOutputs),
      // ... etc for all 7 phases
    });

    // Subscribe to preemption requests (Protocol P8)
    this.ctx.eventBus.subscribe("orchestrator", "preemption.requested", (event) => {
      this.preemptionRequested = true;
      // ...
    });
  }

  async executeTask(dispatch: Dispatch): Promise<ExecuteTaskResult> {
    // Delegate to runPhasePipeline
    const { sessionId } = this.workspaceLifecycle.setupWorkspace(dispatch, traceId);
    return runPhasePipeline(dispatch, sessionId, traceId, {
      ctx: this.ctx,
      handlers: this.phaseHandlers,
      llmCaller: this.llmCaller,
      workspaceLifecycle: this.workspaceLifecycle,
      prManager: this.prManager,
      decompositionHandler: this.decompositionHandler,
    });
  }

  async attemptSelfUnblock(taskId: string): Promise<boolean> {
    // Keep in Orchestrator -- thin method that uses llmCaller
  }
}
```

**Keep in `index.ts`**:
- `Orchestrator` class (slim facade)
- `OrchestratorDependencies` type
- `ExecuteTaskResult` discriminated union type
- `PHASE_SEQUENCE` export (widely referenced)
- Phase handler methods (thin wrappers that call prompt builders + `llmCaller.runPhaseWithAgentLoop`)
- `attemptSelfUnblock()` method
- Preemption subscription setup

### Barrel exports

```typescript
export { runPhasePipeline, type PhaseHandler, type PhaseHandlerRegistry, isCriticalPhase, buildPhaseHandoff } from "./phase-runner.js";
export { createWorkspaceLifecycle, type WorkspaceLifecycle, createAndonCord, type AndonCord } from "./workspace-lifecycle.js";
export { createPrManager, type PrManager } from "./pr-manager.js";
export { createDecompositionHandler, type DecompositionHandler } from "./decomposition-handler.js";
export { createLlmCaller, type LlmCaller, formatToolResult } from "./llm-caller.js";
```

---

## 6. Refinement Checklist

Apply these improvements during the decomposition:

- [ ] **LLM retry with exponential backoff**: Transient failure recovery in `llm-caller.ts` (see spec above)
- [ ] **Andon cord / stop signals**: Emergency halt mechanism in `workspace-lifecycle.ts` (see spec above)
- [ ] **SBAR handoffs**: Structured phase transition logging in `phase-runner.ts` (see spec above)
- [ ] **Sterile cockpit**: Critical phase awareness in `phase-runner.ts` (see spec above)
- [ ] **Phase handlers as registry**: Pluggable phase handler registration (see spec above)
- [ ] **Trace context propagation**: Pass `traceId` through all subsystem calls. Log it in structured log output. The current `this.currentTraceId` becomes a parameter, not class state.
- [ ] **Secret sanitization on LLM input**: Sanitize PR descriptions in `pr-manager.ts` (see spec above)
- [ ] **Tool result structuring**: Consistent formatting for SWE-agent pattern (see spec above)
- [ ] **No circular imports**: Subsystems depend on `OrchestratorContext`. They do NOT import each other directly. Cross-subsystem calls go through interfaces passed as constructor parameters.
- [ ] **Eliminate class-level mutable state**: The `loopbackCount`, `currentTraceId`, `currentSessionId` fields on the Orchestrator class are per-task state stored at class level. Move them into the `runPhasePipeline` call scope so they are naturally scoped to a single executeTask invocation. This prevents bugs when concurrent tasks are eventually supported.

---

## 7. Verification Steps

After completing all changes, run these commands and verify they pass:

```bash
# 1. Type check
pnpm tsc --noEmit

# 2. Run Orchestrator unit tests
pnpm vitest run src/core/orchestrator/

# 3. Run full test suite to catch any consumer breakage
pnpm vitest run

# 4. Biome lint + format
pnpm biome check --write .

# 5. Verify no new lint errors
pnpm biome check .
```

All existing tests (35 Orchestrator tests + agent loop tests + action executor tests + PR workflow tests + decomposition tests + all consumer tests) MUST pass without modification to test assertions. If any test imports internal methods that moved, update the imports only.

Additionally, write NEW tests for each extracted subsystem:

- `src/core/orchestrator/phase-runner.test.ts` -- Test pipeline execution, fast-path, loopback, preemption, SBAR handoffs, critical phase detection (at least 12 tests)
- `src/core/orchestrator/workspace-lifecycle.test.ts` -- Test workspace setup, session creation, notifications, andon cord (at least 8 tests)
- `src/core/orchestrator/pr-manager.test.ts` -- Test commit/push/PR flow, rework path, sanitization (extend existing 10 tests or add at least 6 new ones)
- `src/core/orchestrator/decomposition-handler.test.ts` -- Test decomposition validation, child creation, parent transition (extend existing tests or add at least 6 new ones)
- `src/core/orchestrator/llm-caller.test.ts` -- Test LLM retry with backoff, cost emission, schema validation, fallback output, tool result formatting (at least 10 tests)

Use `vi.fn()` mocks for dependencies. Follow the existing test patterns.

---

## Commit

When all verification passes, run `/commit` to stage and commit your changes.
