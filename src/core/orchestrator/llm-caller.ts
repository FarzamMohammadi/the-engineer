import path from "node:path";
import type { LLMAdapter } from "../../adapters/llm.js";
import { AdapterTypes, type InferenceResult } from "../../schemas/adapters.js";
import { type Phase, type PhaseOutput, Phases } from "../../schemas/orchestrator.js";
import { ActionClasses } from "../../schemas/task.js";
import type { PublishInput } from "../event-bus/index.js";
import { LlmCallRejectedError, NoLlmPluginError, WorkspaceNotReadyError } from "./errors.js";
import { readSessionResult } from "./session-result.js";
import { type OrchestratorContext, PHASE_SEQUENCE, type PipelineState } from "./types.js";

// ── Constants ───────────────────────────────────────────────────────────────

/** Map phase → subdirectory name inside the thoughts/ directory. */
const PHASE_DIR_MAP: Record<Phase, string> = {
  [Phases.requirements_gathering]: "requirements",
  [Phases.research]: "research",
  [Phases.planning]: "planning",
  [Phases.execution]: "implementation",
  [Phases.self_review]: "review",
  [Phases.demo_prep]: "demo-prep",
  [Phases.integration]: "integration",
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
  /** Run a phase via CLI-native invocation. Single CLI call, file-based routing. */
  runPhaseWithCli(
    phase: Phase,
    taskId: string,
    systemPrompt: string,
    prompt: string,
    state: PipelineState,
    thoughtsDir: string,
    overridePhaseDir?: string,
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
    overridePhaseDir?: string,
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

    const phaseSubDir = overridePhaseDir ?? PHASE_DIR_MAP[phase];
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

    const finalResult =
      sessionResult && sessionResult !== "invalid"
        ? sessionResult
        : (() => {
            if (sessionResult === "invalid") {
              ctx.observer.error("session-result.json invalid — falling back to need_more_info", {
                phase,
                taskId,
              });
              return { status: "need_more_info" as const, next_phase: expectedNext, summary: "" };
            }
            ctx.observer.warn("session-result.json not found, using defaults", {
              phase,
              taskId,
              expectedNext,
            });
            return { status: "ready" as const, next_phase: expectedNext, summary: "" };
          })();

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
    return {
      phase,
      task_id: taskId,
      timestamp: new Date().toISOString(),
      data: {
        deliverable_path: phaseSubDir ? `${thoughtsDir}/${phaseSubDir}` : "",
        status: finalResult.status,
        next_phase: finalResult.next_phase,
        summary: finalResult.summary,
      },
      confidence: finalResult.status === "ready" ? ("high" as const) : ("medium" as const),
      open_questions: finalResult.status === "need_more_info" ? [finalResult.summary] : [],
    };
  }

  return {
    callLlm,
    runPhaseWithCli,
    emitCostIncurred,
  };
}
