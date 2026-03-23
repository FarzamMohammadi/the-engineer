import { existsSync } from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";
import type { LLMAdapter } from "../../adapters/llm.js";
import type { ToolAdapter } from "../../adapters/tool.js";
import { AdapterTypes, type InferenceResult } from "../../schemas/adapters.js";
import {
  DemoPrepOutputSchema,
  ExecutionOutputSchema,
  IntegrationOutputSchema,
  PHASE_DIRECTORIES,
  type Phase,
  type PhaseOutput,
  Phases,
  PlanningOutputSchema,
  RequirementsGatheringOutputSchema,
  ResearchOutputSchema,
  SelfReviewOutputSchema,
} from "../../schemas/orchestrator.js";
import { ActionClasses } from "../../schemas/task.js";
import type { PublishInput } from "../event-bus/index.js";
import { executeAction as executeAgentAction } from "./action-executor.js";
import { type AgentLoopCallbacks, type AgentLoopResult, runAgentLoop } from "./agent-loop.js";
import { LlmCallRejectedError, NoLlmPluginError, WorkspaceNotReadyError } from "./errors.js";
import { getPhaseToolConfig } from "./phase-tools.js";
import { readSessionResult } from "./session-result.js";
import { type OrchestratorContext, PHASE_SEQUENCE, type PipelineState } from "./types.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** Phase-specific Zod schemas for output validation. */
const PHASE_OUTPUT_SCHEMAS: Record<Phase, ZodType> = {
  [Phases.requirements_gathering]: RequirementsGatheringOutputSchema,
  [Phases.research]: ResearchOutputSchema,
  [Phases.planning]: PlanningOutputSchema,
  [Phases.execution]: ExecutionOutputSchema,
  [Phases.self_review]: SelfReviewOutputSchema,
  [Phases.demo_prep]: DemoPrepOutputSchema,
  [Phases.integration]: IntegrationOutputSchema,
};

/**
 * Map phase → subdirectory name inside the thoughts/ directory.
 * Directory names come from PHASE_DIRECTORIES in schemas/orchestrator.ts.
 */
const PHASE_DIR_MAP: Partial<Record<Phase, string>> = {
  [Phases.requirements_gathering]: PHASE_DIRECTORIES[0],
  [Phases.research]: PHASE_DIRECTORIES[1],
  [Phases.planning]: PHASE_DIRECTORIES[2],
  [Phases.execution]: PHASE_DIRECTORIES[3],
  [Phases.self_review]: PHASE_DIRECTORIES[4],
  [Phases.demo_prep]: PHASE_DIRECTORIES[6],
  [Phases.integration]: "integration",
};

/** Map phase → expected .md deliverable filename. */
const PHASE_DELIVERABLE_MAP: Partial<Record<Phase, string>> = {
  [Phases.requirements_gathering]: "requirements.md",
  [Phases.research]: "research.md",
  [Phases.planning]: "plan.md",
  [Phases.self_review]: "requirements-check.md",
  [Phases.demo_prep]: "pr-description.md",
};

/** Maximum LLM retry attempts for transient failures. */
const MAX_LLM_RETRIES = 3;

/** Base delay in ms for exponential backoff. */
const LLM_RETRY_BASE_MS = 1000;

// ── Retry Logic ─────────────────────────────────────────────────────────────

/** Check if an error is retryable (transient network/rate-limit failures). */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("rate limit") ||
    msg.includes("429") ||
    msg.includes("503") ||
    msg.includes("529") ||
    msg.includes("overloaded")
  );
}

// ── LlmCaller Interface ────────────────────────────────────────────────────

/** LLM invocation, cost tracking, and response validation. */
export interface LlmCaller {
  /** Call LLM through ActionPipeline. Throws on rejection or no plugin. */
  callLlm(prompt: string, taskId: string, systemPrompt?: string | null): Promise<InferenceResult>;
  /** Run a phase through the agent loop (multi-turn LLM + tool execution). Session 072: remove. */
  runPhaseWithAgentLoop(
    phase: Phase,
    taskId: string,
    systemPrompt: string,
    initialPrompt: string,
    state: PipelineState,
  ): Promise<PhaseOutput>;
  /** Run a phase via CLI-native invocation. Single CLI call, file-based routing. */
  runPhaseWithCli(
    phase: Phase,
    taskId: string,
    systemPrompt: string,
    prompt: string,
    state: PipelineState,
    thoughtsDir: string,
  ): Promise<PhaseOutput>;
  /** Emit cost.incurred event from inference result. */
  emitCostIncurred(taskId: string, result: InferenceResult): void;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create an LlmCaller bound to the given OrchestratorContext. */
export function createLlmCaller(ctx: OrchestratorContext): LlmCaller {
  /** Single LLM call attempt without retry. */
  async function callLlmOnce(
    prompt: string,
    taskId: string,
    systemPrompt?: string | null,
  ): Promise<InferenceResult> {
    const llm = ctx.registry.getPrimaryPlugin<LLMAdapter>(AdapterTypes.llm);
    if (!llm) {
      throw new NoLlmPluginError();
    }

    const worktreePath = ctx.workspaceManager.getWorktreePath(taskId);

    const pipelineResult = await ctx.actionPipeline.execute<InferenceResult>({
      taskId,
      actionClass: ActionClasses.read,
      details: { operation: "llm_infer" },
      requestedBy: "orchestrator",
      executeFn: () =>
        llm.infer({
          prompt,
          system_prompt: systemPrompt ?? null,
          cwd: worktreePath ?? null,
        }),
    });

    if (pipelineResult.outcome !== "executed") {
      const reason = "reason" in pipelineResult ? pipelineResult.reason : "unknown";
      throw new LlmCallRejectedError(pipelineResult.outcome, reason);
    }

    return pipelineResult.result;
  }

  /** Call LLM with retry for transient failures. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: retry loop with observability logging — extraction would fragment the retry state
  async function callLlm(
    prompt: string,
    taskId: string,
    systemPrompt?: string | null,
  ): Promise<InferenceResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt++) {
      try {
        return await callLlmOnce(prompt, taskId, systemPrompt);
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error)) {
          throw error;
        }
        if (attempt < MAX_LLM_RETRIES - 1) {
          const delay = LLM_RETRY_BASE_MS * 2 ** attempt;
          ctx.observer.warn("LLM call failed (transient) — retrying", {
            taskId,
            attempt: attempt + 1,
            maxRetries: MAX_LLM_RETRIES,
            delayMs: delay,
            error: error instanceof Error ? error.message : String(error),
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    ctx.observer.error("LLM retries exhausted", {
      taskId,
      attempts: MAX_LLM_RETRIES,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw lastError;
  }

  function emitCostIncurred(taskId: string, result: InferenceResult): void {
    const task = ctx.taskEngine.getTask(taskId);
    ctx.eventBus.publish({
      type: "cost.incurred",
      source: "orchestrator",
      task_id: taskId,
      payload: {
        task_id: taskId,
        repo: task?.repo ?? "",
        provider_id: "llm",
        operation: "phase_completion",
        spend_usd: result.cost_usd,
        duration_ms: result.duration_ms,
        input_tokens: result.usage?.tokens.input_tokens ?? null,
        output_tokens: result.usage?.tokens.output_tokens ?? null,
        total_tokens: result.usage?.tokens.total_tokens ?? null,
        cache_read_tokens: result.usage?.tokens.cache_read_tokens ?? null,
        model_id: result.usage?.model_id ?? null,
      },
    } satisfies PublishInput<"cost.incurred">);
  }

  function emitAgentLoopCost(taskId: string, phase: string, loopResult: AgentLoopResult): void {
    const task = ctx.taskEngine.getTask(taskId);
    ctx.eventBus.publish({
      type: "cost.incurred",
      source: "orchestrator",
      task_id: taskId,
      payload: {
        task_id: taskId,
        repo: task?.repo ?? "",
        provider_id: "llm",
        operation: `agent_loop:${phase}`,
        spend_usd: loopResult.totalCost.spend_usd,
        duration_ms: loopResult.totalCost.duration_ms,
        input_tokens: loopResult.totalCost.input_tokens,
        output_tokens: loopResult.totalCost.output_tokens,
        total_tokens: loopResult.totalCost.total_tokens,
        cache_read_tokens: null,
        model_id: null,
      },
    } satisfies PublishInput<"cost.incurred">);
  }

  function buildObservabilityCallbacks(
    taskId: string,
    sessionId: string,
    traceId: string,
    phase: string,
  ): AgentLoopCallbacks {
    // biome-ignore lint/style/noNonNullAssertion: caller checks observationStore is not null
    const store = ctx.observationStore!;
    const spanOpts = { task_id: taskId, session_id: sessionId, trace_id: traceId, phase };
    return {
      onActionComplete: (trace) => {
        store.observe(
          "tool_execution",
          trace.action_type,
          {
            action_params: trace.action_params,
            result_success: trace.result_success,
            result_output: trace.result_output,
            result_error: trace.result_error,
            duration_ms: trace.duration_ms,
            iteration: trace.iteration,
          },
          spanOpts,
        );
      },
      onLlmComplete: (trace) => {
        const promptRef = trace.prompt_content
          ? store.storeBlob(trace.prompt_content)
          : trace.prompt_ref;
        const responseRef = trace.response_content
          ? store.storeBlob(trace.response_content)
          : trace.response_ref;

        store.observe(
          "llm_call",
          "inference",
          {
            prompt_length: trace.prompt_length,
            response_length: trace.response_length,
            cost_usd: trace.cost_usd,
            duration_ms: trace.duration_ms,
            provider_id: "llm",
            model_id: trace.model_id,
            prompt_ref: promptRef,
            response_ref: responseRef,
            iteration: trace.iteration,
            input_tokens: trace.input_tokens,
            output_tokens: trace.output_tokens,
            total_tokens: trace.total_tokens,
            cache_read_tokens: trace.cache_read_tokens,
          },
          spanOpts,
        );
      },
    };
  }

  function validateLoopResult(
    phase: Phase,
    taskId: string,
    loopResult: AgentLoopResult,
  ): PhaseOutput {
    const schema = PHASE_OUTPUT_SCHEMAS[phase];
    const result = schema.safeParse(loopResult.phaseData);

    if (!result.success) {
      ctx.observer.warn("Agent loop output validation failed, using fallback", {
        phase,
        error: result.error.message,
      });
      return buildFallbackOutput(
        phase,
        taskId,
        `Agent loop output invalid: ${result.error.message} (after ${String(loopResult.iterations)} iterations)`,
      );
    }

    ctx.observer.debug("Agent loop output validation passed", {
      phase,
      dataKeys: Object.keys(result.data as Record<string, unknown>),
    });
    return buildPhaseOutput(phase, taskId, result.data as Record<string, unknown>, "high", []);
  }

  function buildPhaseOutput(
    phase: Phase,
    taskId: string,
    data: Record<string, unknown>,
    confidence: "high" | "medium" | "low",
    openQuestions: string[],
  ): PhaseOutput {
    return {
      phase,
      task_id: taskId,
      timestamp: new Date().toISOString(),
      data,
      confidence,
      open_questions: openQuestions,
    };
  }

  function getPhaseDefaults(phase: Phase): Record<string, unknown> {
    const defaults: Record<Phase, Record<string, unknown>> = {
      [Phases.requirements_gathering]: {
        deliverable_path: "",
        status: "ready",
        contact: null,
        question: null,
        assessment: null,
      },
      [Phases.research]: {
        deliverable_path: "",
        status: "ready",
        contact: null,
        question: null,
        complexity_hint: null,
      },
      [Phases.planning]: {
        approach: "Unable to generate plan from LLM output",
        file_changes: [],
        risks: [],
        decomposition_plan: null,
      },
      [Phases.execution]: {
        files_changed: [],
        tests_written: [],
        test_results: { passed: 0, failed: 0, skipped: 0 },
        build_status: "failing",
      },
      [Phases.self_review]: {
        findings: [],
        refactoring_applied: [],
        quality_assessment: "unknown",
      },
      [Phases.demo_prep]: {
        artifacts: [],
        pr_number: 1,
        pr_description: "Unable to generate PR description from LLM output",
      },
      [Phases.integration]: {
        children_verified: [],
        integration_tests: { passed: 0, failed: 0 },
        conflicts_found: [],
        resolution_actions: [],
      },
    };
    return defaults[phase];
  }

  function buildFallbackOutput(phase: Phase, taskId: string, errorMessage: string): PhaseOutput {
    return buildPhaseOutput(phase, taskId, getPhaseDefaults(phase), "low", [errorMessage]);
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: phase lifecycle with metrics, observability, cost, tracking, and quota persistence
  async function runPhaseWithAgentLoop(
    phase: Phase,
    taskId: string,
    systemPrompt: string,
    initialPrompt: string,
    state: PipelineState,
  ): Promise<PhaseOutput> {
    const toolConfig = getPhaseToolConfig(phase);
    const worktreePath = ctx.workspaceManager.getWorktreePath(taskId);
    if (!worktreePath) {
      throw new WorkspaceNotReadyError(taskId);
    }
    const toolAdapter = ctx.registry.getPrimaryPlugin<ToolAdapter>(AdapterTypes.tool) ?? null;
    const { traceId, sessionId } = state;

    // ── Phase metrics: start ─────────────────────────────────────────────
    const phaseSpan =
      ctx.observationStore && traceId && sessionId
        ? ctx.observationStore.startSpan(
            "phase_transition",
            phase,
            {
              task_id: taskId,
              session_id: sessionId,
            },
            { task_id: taskId, session_id: sessionId, trace_id: traceId, phase },
          )
        : null;

    // ── Observability callbacks ──────────────────────────────────────────
    const observabilityCallbacks =
      ctx.observationStore && traceId && sessionId
        ? { callbacks: buildObservabilityCallbacks(taskId, sessionId, traceId, phase) }
        : {};

    const loopResult = await runAgentLoop(
      {
        phase,
        taskId,
        systemPrompt,
        initialPrompt,
        toolConfig,
        worktreePath,
        observer: ctx.observer,
        ...observabilityCallbacks,
      },
      (prompt, sysPrompt) => callLlm(prompt, taskId, sysPrompt),
      (action, wPath) =>
        executeAgentAction(action, wPath, {
          actionPipeline: ctx.actionPipeline,
          toolAdapter,
          taskId,
        }),
    );

    // ── Phase metrics: complete ──────────────────────────────────────────
    if (phaseSpan) {
      const actionsExecuted = loopResult.actions.length;
      const actionsFailed = loopResult.actions.filter((a) => a.result && !a.result.success).length;
      phaseSpan.end({
        llm_iterations: loopResult.iterations,
        spend_usd: loopResult.totalCost.spend_usd,
        duration_ms: loopResult.totalCost.duration_ms,
        actions_executed: actionsExecuted,
        actions_failed: actionsFailed,
        outcome: "completed",
        input_tokens: loopResult.totalCost.input_tokens,
        output_tokens: loopResult.totalCost.output_tokens,
        total_tokens: loopResult.totalCost.total_tokens,
      });
    }

    emitAgentLoopCost(taskId, phase, loopResult);
    ctx.taskEngine.updateTracking(
      taskId,
      loopResult.totalCost.total_tokens,
      loopResult.totalCost.spend_usd ?? 0,
      loopResult.totalCost.duration_ms,
    );

    // ── Persist quota status for dashboard ────────────────────────────────
    // Zero extra API calls — reads cached data from the last infer() call.
    if (ctx.observationStore && traceId && sessionId) {
      const llm = ctx.registry.getPrimaryPlugin<LLMAdapter>(AdapterTypes.llm);
      if (llm) {
        const quota = await llm.getQuotaStatus();
        if (quota) {
          ctx.observationStore.observe("quota_status", "llm", quota, {
            task_id: taskId,
            session_id: sessionId,
            trace_id: traceId,
            phase,
          });
        }
      }
    }

    return validateLoopResult(phase, taskId, loopResult);
  }

  /**
   * Run a phase via CLI-native invocation (RRPIR).
   *
   * Single CLI call → read session-result.json → validate → continue-retry if needed.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: phase lifecycle with observability, cost tracking, continue-retry, and fallback
  async function runPhaseWithCli(
    phase: Phase,
    taskId: string,
    systemPrompt: string,
    prompt: string,
    state: PipelineState,
    thoughtsDir: string,
  ): Promise<PhaseOutput> {
    if (!thoughtsDir) {
      throw new WorkspaceNotReadyError(
        `${taskId}: thoughtsDir is required for CLI-native phase "${phase}"`,
      );
    }

    const worktreePath = ctx.workspaceManager.getWorktreePath(taskId);
    if (!worktreePath) {
      throw new WorkspaceNotReadyError(taskId);
    }

    const phaseSubDir = PHASE_DIR_MAP[phase];
    const phaseDir = phaseSubDir ? path.join(worktreePath, thoughtsDir, phaseSubDir) : null;
    const { traceId, sessionId } = state;

    // ── Observability span ────────────────────────────────────────────────
    const phaseSpan =
      ctx.observationStore && traceId && sessionId
        ? ctx.observationStore.startSpan(
            "phase_transition",
            phase,
            { task_id: taskId, session_id: sessionId },
            { task_id: taskId, session_id: sessionId, trace_id: traceId, phase },
          )
        : null;

    // ── Single CLI call ──────────────────────────────────────────────────
    const result = await callLlm(prompt, taskId, systemPrompt);

    // ── Read session-result.json ─────────────────────────────────────────
    const sessionResult = phaseDir ? readSessionResult(phaseDir) : null;

    // ── Resolve final session result ────────────────────────────────────
    // If the CLI wrote session-result.json, use it. Otherwise default to "ready"
    // with the next phase in sequence — no retry burn.
    const nextPhaseIndex = PHASE_SEQUENCE.indexOf(phase);
    const expectedNext: Phase =
      (nextPhaseIndex >= 0 && nextPhaseIndex < PHASE_SEQUENCE.length - 1
        ? PHASE_SEQUENCE[nextPhaseIndex + 1]
        : undefined) ?? phase;

    const finalResult = sessionResult
      ? sessionResult
      : (() => {
          ctx.observer.warn("session-result.json not filled, using defaults", {
            phase,
            taskId,
            expectedNext,
          });
          return { status: "ready" as const, next_phase: expectedNext, summary: "" };
        })();

    // ── Verify deliverable exists ────────────────────────────────────────
    const deliverableFile = PHASE_DELIVERABLE_MAP[phase];
    if (phaseDir && deliverableFile) {
      const deliverablePath = path.join(phaseDir, deliverableFile);
      if (!existsSync(deliverablePath)) {
        ctx.observer.warn("Phase deliverable not found", { phase, deliverablePath });
      }
    }

    // ── Cost + tracking ──────────────────────────────────────────────────
    emitCostIncurred(taskId, result);
    ctx.taskEngine.updateTracking(
      taskId,
      result.usage?.tokens.total_tokens ?? 0,
      result.cost_usd ?? 0,
      result.duration_ms,
    );

    // ── End span ─────────────────────────────────────────────────────────
    if (phaseSpan) {
      phaseSpan.end({
        llm_iterations: 1,
        spend_usd: result.cost_usd,
        duration_ms: result.duration_ms,
        outcome: finalResult.status,
        input_tokens: result.usage?.tokens.input_tokens ?? 0,
        output_tokens: result.usage?.tokens.output_tokens ?? 0,
        total_tokens: result.usage?.tokens.total_tokens ?? 0,
      });
    }

    // ── Build PhaseOutput ────────────────────────────────────────────────
    return buildPhaseOutput(
      phase,
      taskId,
      {
        deliverable_path:
          phaseDir && deliverableFile ? `${thoughtsDir}/${phaseSubDir}/${deliverableFile}` : "",
        status: finalResult.status,
        next_phase: finalResult.next_phase,
        summary: finalResult.summary,
      },
      finalResult.status === "ready" ? "high" : "medium",
      finalResult.status === "need_more_info" ? [finalResult.summary] : [],
    );
  }

  return {
    callLlm,
    runPhaseWithAgentLoop,
    runPhaseWithCli,
    emitCostIncurred,
  };
}
