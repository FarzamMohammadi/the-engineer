import type { ZodType } from "zod";
import type { LLMAdapter } from "../../adapters/llm.js";
import type { ToolAdapter } from "../../adapters/tool.js";
import { AdapterTypes, type CompletionResult } from "../../schemas/adapters.js";
import {
  DemoPrepOutputSchema,
  ExecutionOutputSchema,
  IntakeAnalysisOutputSchema,
  IntegrationOutputSchema,
  type Phase,
  type PhaseOutput,
  Phases,
  PlanningOutputSchema,
  ResearchOutputSchema,
  SelfReviewOutputSchema,
} from "../../schemas/orchestrator.js";
import { ActionClasses } from "../../schemas/task.js";
import type { PublishInput } from "../event-bus/index.js";
import { executeAction as executeAgentAction } from "./action-executor.js";
import { type AgentLoopCallbacks, type AgentLoopResult, runAgentLoop } from "./agent-loop.js";
import { LlmCallRejectedError, NoLlmPluginError, WorkspaceNotReadyError } from "./errors.js";
import { getPhaseToolConfig } from "./phase-tools.js";
import { type OrchestratorContext, PHASE_SEQUENCE, type PipelineState } from "./types.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** Phase-specific Zod schemas for output validation. */
const PHASE_OUTPUT_SCHEMAS: Record<Phase, ZodType> = {
  [Phases.intake_analysis]: IntakeAnalysisOutputSchema,
  [Phases.research]: ResearchOutputSchema,
  [Phases.planning]: PlanningOutputSchema,
  [Phases.execution]: ExecutionOutputSchema,
  [Phases.self_review]: SelfReviewOutputSchema,
  [Phases.demo_prep]: DemoPrepOutputSchema,
  [Phases.integration]: IntegrationOutputSchema,
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
  callLlm(prompt: string, taskId: string, systemPrompt?: string | null): Promise<CompletionResult>;
  /** Run a phase through the agent loop (multi-turn LLM + tool execution). */
  runPhaseWithAgentLoop(
    phase: Phase,
    taskId: string,
    systemPrompt: string,
    initialPrompt: string,
    state: PipelineState,
  ): Promise<PhaseOutput>;
  /** Emit cost.incurred event from completion usage data. */
  emitCostIncurred(taskId: string, completion: CompletionResult): void;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create an LlmCaller bound to the given OrchestratorContext. */
export function createLlmCaller(ctx: OrchestratorContext): LlmCaller {
  /** Single LLM call attempt without retry. */
  async function callLlmOnce(
    prompt: string,
    taskId: string,
    systemPrompt?: string | null,
  ): Promise<CompletionResult> {
    const llm = ctx.registry.getPrimaryPlugin<LLMAdapter>(AdapterTypes.llm);
    if (!llm) {
      throw new NoLlmPluginError();
    }

    const worktreePath = ctx.workspaceManager.getWorktreePath(taskId);

    const pipelineResult = await ctx.actionPipeline.execute<CompletionResult>({
      taskId,
      actionClass: ActionClasses.read,
      details: { operation: "llm_complete" },
      requestedBy: "orchestrator",
      executeFn: () =>
        llm.complete({
          prompt,
          system_prompt: systemPrompt ?? null,
          options: {
            max_tokens: null,
            temperature: null,
            stop: null,
            tools: null,
            cwd: worktreePath,
          },
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
  ): Promise<CompletionResult> {
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

  function emitCostIncurred(taskId: string, completion: CompletionResult): void {
    ctx.eventBus.publish({
      type: "cost.incurred",
      source: "orchestrator",
      task_id: taskId,
      payload: {
        task_id: taskId,
        repo: "",
        provider_id: "llm",
        provider_type: "api",
        operation: "phase_completion",
        tokens_in: completion.usage.tokens_in,
        tokens_out: completion.usage.tokens_out,
        spend_usd: completion.usage.spend_usd,
        usage_units: null,
        remaining: completion.usage.remaining,
      },
    } satisfies PublishInput<"cost.incurred">);
  }

  function emitAgentLoopCost(taskId: string, phase: string, loopResult: AgentLoopResult): void {
    ctx.eventBus.publish({
      type: "cost.incurred",
      source: "orchestrator",
      task_id: taskId,
      payload: {
        task_id: taskId,
        repo: "",
        provider_id: "llm",
        provider_type: "api",
        operation: `agent_loop:${phase}`,
        tokens_in: loopResult.totalCost.tokens_in,
        tokens_out: loopResult.totalCost.tokens_out,
        spend_usd: loopResult.totalCost.spend_usd,
        usage_units: null,
        remaining: null,
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
          "completion",
          {
            prompt_length: trace.prompt_length,
            response_length: trace.response_length,
            tokens_in: trace.tokens_in,
            tokens_out: trace.tokens_out,
            spend_usd: trace.spend_usd,
            latency_ms: trace.latency_ms,
            provider_id: "llm",
            model_id: null,
            finish_reason: null,
            prompt_ref: promptRef,
            response_ref: responseRef,
            iteration: trace.iteration,
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
      [Phases.intake_analysis]: {
        complexity: "moderate",
        estimated_phases: [...PHASE_SEQUENCE],
        ambiguities: [],
        fast_path: false,
        decomposition_likely: false,
      },
      [Phases.research]: {
        relevant_files: [],
        relevant_modules: [],
        conventions: [],
        existing_patterns: [],
        dependencies: [],
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
        tokens_in: loopResult.totalCost.tokens_in,
        tokens_out: loopResult.totalCost.tokens_out,
        spend_usd: loopResult.totalCost.spend_usd,
        actions_executed: actionsExecuted,
        actions_failed: actionsFailed,
        outcome: "completed",
      });
    }

    emitAgentLoopCost(taskId, phase, loopResult);
    return validateLoopResult(phase, taskId, loopResult);
  }

  return {
    callLlm,
    runPhaseWithAgentLoop,
    emitCostIncurred,
  };
}
