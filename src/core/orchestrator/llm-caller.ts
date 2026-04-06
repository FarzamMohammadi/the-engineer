import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AdapterMethodError } from "../../adapters/index.js";
import type { LLMAdapter } from "../../adapters/llm.js";
import { AdapterTypes, type InferenceResult } from "../../schemas/adapters.js";
import { type Phase, type PhaseOutput, Phases } from "../../schemas/orchestrator.js";
import { ActionClasses } from "../../schemas/task.js";
import type { PublishInput } from "../event-bus/index.js";
import {
  LlmCallRejectedError,
  LlmUnavailableError,
  NoLlmPluginError,
  WorkspaceNotReadyError,
} from "./errors.js";
import { backupSessionResult, readSessionResult } from "./session-result.js";
import type { OrchestratorContext, PipelineState } from "./types.js";

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

/** Map phase → human-readable directory name for session traces. */
const PHASE_TRACE_DIR_MAP: Record<Phase, string> = {
  [Phases.requirements_gathering]: "requirements-gathering",
  [Phases.research]: "research",
  [Phases.planning]: "planning",
  [Phases.execution]: "execution",
  [Phases.self_review]: "self-review",
  [Phases.demo_prep]: "demo-prep",
  [Phases.integration]: "integration",
};

/** Maximum LLM retry attempts for transient failures. */
const MAX_LLM_RETRIES = 3;

/** Base delay in ms for exponential backoff. */
const LLM_RETRY_BASE_MS = 1000;

// ── Trace Path Generation ──────────────────────────────────────────────────

/** Per-task step counter for trace file naming within a phase directory. */
const taskStepCounters = new Map<string, number>();

/**
 * Generate a structured trace output path for a CLI invocation.
 *
 * Path format: {tracesDir}/sessions/{taskId}/{seq}-{phase}/{stepSeq}-{stepName}.ndjson
 *
 * Returns null if tracing is disabled (tracesDir is null).
 */
export function generateTracePath(
  tracesDir: string | null,
  taskId: string,
  phaseSequence: number,
  phase: Phase,
  stepName: string,
): string | null {
  if (!tracesDir) {
    return null;
  }

  const seqStr = String(phaseSequence).padStart(2, "0");
  const phaseDirName = PHASE_TRACE_DIR_MAP[phase];
  const phaseDir = path.join(tracesDir, "sessions", taskId, `${seqStr}-${phaseDirName}`);

  // Get and increment step counter for this task+phase combo
  const counterKey = `${taskId}:${seqStr}-${phaseDirName}`;
  const stepSeq = (taskStepCounters.get(counterKey) ?? 0) + 1;
  taskStepCounters.set(counterKey, stepSeq);

  const stepSeqStr = String(stepSeq).padStart(3, "0");
  const fileName = `${stepSeqStr}-${stepName}.ndjson`;

  const tracePath = path.join(phaseDir, fileName);

  // Ensure directory exists
  try {
    mkdirSync(phaseDir, { recursive: true, mode: 0o700 });
  } catch {
    // If mkdir fails, return null — tracing is best-effort
    return null;
  }

  return tracePath;
}

/** Reset the step counter for a task (call on task completion/cleanup). */
export function resetTraceStepCounters(taskId: string): void {
  for (const key of taskStepCounters.keys()) {
    if (key.startsWith(`${taskId}:`)) {
      taskStepCounters.delete(key);
    }
  }
}

// ── Session Trace Manifest ─────────────────────────────────────────────────

interface ManifestStep {
  file: string;
  step_name: string;
  started_at: string;
  duration_ms: number;
  cost_usd: number | null;
}

interface ManifestPhase {
  sequence: number;
  phase: string;
  dir: string;
  steps: ManifestStep[];
}

interface SessionManifest {
  task_id: string;
  created_at: string;
  phases: ManifestPhase[];
  total_cost_usd: number;
  total_duration_ms: number;
}

/**
 * Update the session trace manifest.json with a completed step.
 * Creates the manifest if it doesn't exist. Best-effort — never throws.
 */
function updateManifest(
  tracesDir: string,
  taskId: string,
  phaseSequence: number,
  phase: Phase,
  stepName: string,
  traceFileName: string,
  startedAt: string,
  durationMs: number,
  costUsd: number | null,
): void {
  try {
    const manifestPath = path.join(tracesDir, "sessions", taskId, "manifest.json");
    let manifest: SessionManifest;

    try {
      const raw = readFileSync(manifestPath, "utf-8");
      manifest = JSON.parse(raw) as SessionManifest;
    } catch {
      manifest = {
        task_id: taskId,
        created_at: new Date().toISOString(),
        phases: [],
        total_cost_usd: 0,
        total_duration_ms: 0,
      };
    }

    const seqStr = String(phaseSequence).padStart(2, "0");
    const phaseDirName = `${seqStr}-${PHASE_TRACE_DIR_MAP[phase]}`;

    // Find or create phase entry
    let phaseEntry = manifest.phases.find((p) => p.dir === phaseDirName);
    if (!phaseEntry) {
      phaseEntry = {
        sequence: phaseSequence,
        phase,
        dir: phaseDirName,
        steps: [],
      };
      manifest.phases.push(phaseEntry);
    }

    phaseEntry.steps.push({
      file: traceFileName,
      step_name: stepName,
      started_at: startedAt,
      duration_ms: durationMs,
      cost_usd: costUsd,
    });

    manifest.total_cost_usd += costUsd ?? 0;
    manifest.total_duration_ms += durationMs;

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Best-effort — manifest write failure never blocks inference
  }
}

// ── Retry Logic ─────────────────────────────────────────────────────────────

/** Check if an error is retryable (transient network/rate-limit failures). */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // Structured adapter errors — use the explicit retryable flag set by the plugin
  if (error instanceof AdapterMethodError) {
    return error.adapterError.retryable;
  }

  // Unstructured errors — match only against a bounded prefix (first 500 chars)
  // to prevent false positives from CLI output containing words like "timeout"
  const msg = error.message.slice(0, 500).toLowerCase();
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
    stepName?: string,
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
    traceOutputPath?: string | null,
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
          trace_output_path: traceOutputPath ?? null,
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
    traceOutputPath?: string | null,
  ): Promise<InferenceResult> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt++) {
      try {
        return await callLlmOnce(prompt, taskId, systemPrompt, traceOutputPath);
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error)) {
          ctx.observer.warn("LLM call failed (non-retryable) — not retrying", {
            taskId,
            attempt: attempt + 1,
            errorType: error instanceof Error ? error.constructor.name : typeof error,
            error:
              error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          });
          throw error;
        }
        if (attempt < MAX_LLM_RETRIES - 1) {
          const delay = LLM_RETRY_BASE_MS * 2 ** attempt;
          ctx.observer.warn("LLM call failed (transient) — retrying", {
            taskId,
            attempt: attempt + 1,
            maxRetries: MAX_LLM_RETRIES,
            delayMs: delay,
            errorType: error instanceof Error ? error.constructor.name : typeof error,
            error:
              error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
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
    if (isRetryableError(lastError)) {
      throw new LlmUnavailableError(
        MAX_LLM_RETRIES,
        lastError instanceof Error ? lastError.message : String(lastError),
      );
    }
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
   * Generates a structured trace path and updates manifest.json after completion.
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
    stepName?: string,
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

    // ── Generate trace path ──────────────────────────────────────────────
    const resolvedStepName = stepName ?? "initial";
    const tracePath = generateTracePath(
      ctx.tracesDir,
      taskId,
      state.phaseSequence,
      phase,
      resolvedStepName,
    );
    const startedAt = new Date().toISOString();

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

    // ── Backup stale session-result.json before CLI call ──────────────────
    // Prevents files from prior runs masking failures. Backup preserved for debugging.
    if (phaseDir) {
      backupSessionResult(phaseDir);
    }

    // ── Single CLI call (with error-path recovery) ────────────────────────
    let result: InferenceResult;
    let recoveredFromError = false;

    try {
      result = await callLlm(prompt, taskId, systemPrompt, tracePath);
    } catch (error) {
      // CLI failed — but may have written session-result.json before dying.
      // This is the safety net for SIGTERM / timeout kills where work was done.
      const recoveryResult = phaseDir ? readSessionResult(phaseDir) : null;

      if (recoveryResult && recoveryResult !== "invalid") {
        ctx.observer.warn("CLI error but session-result.json found — recovering partial success", {
          taskId,
          phase,
          sessionResultStatus: recoveryResult.status,
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        });
        result = {
          content: recoveryResult.summary || "",
          cost_usd: null,
          duration_ms: 0,
          usage: null,
        };
        recoveredFromError = true;
      } else {
        ctx.observer.error("CLI error and no session-result.json — phase failed", {
          taskId,
          phase,
          sessionResultExists: recoveryResult !== null,
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        });
        throw error;
      }
    }

    // ── Read session-result.json ─────────────────────────────────────────
    const sessionResult = phaseDir ? readSessionResult(phaseDir) : null;

    // ── Resolve final session result ────────────────────────────────────
    // If the CLI wrote session-result.json, use it. If not, the phase failed —
    // the CLI must produce its routing output or it's a failure (Fail Loud).
    const finalResult =
      sessionResult && sessionResult !== "invalid"
        ? sessionResult
        : (() => {
            const detail =
              sessionResult === "invalid"
                ? "session-result.json was not updated by the CLI (still contains template placeholders or invalid data)"
                : "session-result.json was not created by the CLI";
            ctx.observer.error("Phase failed: CLI completed but no valid session-result.json", {
              taskId,
              phase,
              detail,
            });
            throw new Error(`Phase ${phase} failed: ${detail}`);
          })();

    // ── Cost + tracking (skip cost emission on recovery — no cost data) ──
    if (!recoveredFromError) {
      emitCostIncurred(taskId, result);
    }
    ctx.taskEngine.updateTracking(
      taskId,
      result.usage?.tokens.total_tokens ?? 0,
      result.cost_usd ?? 0,
      result.duration_ms,
    );

    // ── Update session trace manifest ────────────────────────────────────
    if (ctx.tracesDir && tracePath) {
      const traceFileName = path.basename(tracePath);
      updateManifest(
        ctx.tracesDir,
        taskId,
        state.phaseSequence,
        phase,
        resolvedStepName,
        traceFileName,
        startedAt,
        result.duration_ms,
        result.cost_usd,
      );
    }

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
        deliverable_path: phaseSubDir
          ? phase === Phases.demo_prep
            ? `${thoughtsDir}/${phaseSubDir}/pr-description.md`
            : `${thoughtsDir}/${phaseSubDir}`
          : "",
        status: finalResult.status,
        next_phase: finalResult.next_phase,
        summary: finalResult.summary,
        complexity: finalResult.complexity,
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
