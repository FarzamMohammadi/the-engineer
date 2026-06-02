import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { AgentAdapter } from "../../../adapters/agent.js";
import { AdapterMethodError } from "../../../adapters/index.js";
import { AdapterTypes, type AgentRunRequest, type AgentRunResult } from "../../../schemas/adapters.js";
import { ObservationTypes } from "../../../schemas/observer.js";
import { ActionClasses } from "../../../schemas/task.js";
import { sanitizeSecrets } from "../../../utils/sanitize.js";
import type { ObservationSpan } from "../../observer/index.js";
import { emitAgentCost } from "../agent-cost.js";
import { traceScope } from "./observability.js";
import type { Ctx, FailureCause, SubPhaseResult } from "./types.js";

// ── The Handoff File ─────────────────────────────────────────────────────────

const RESULT_FILE = "session-result.json";

/**
 * The agent's self-report. It names *what happened* — never a phase. `details` is an
 * optional, sub-phase-specific payload validated against that sub-phase's `detailsSchema`.
 */
const SessionResultSchema = z.object({
  status: z.enum(["ok", "needs_human", "failed"]),
  summary: z.string(),
  details: z.record(z.unknown()).optional(),
});
type SessionResult = z.infer<typeof SessionResultSchema>;

// ── Retry Policy ─────────────────────────────────────────────────────────────

const MAX_AGENT_RETRIES = 3;
const RETRY_BASE_MS = 1_000;

// ── agentStep ────────────────────────────────────────────────────────────────

/** What an agent sub-phase declares so `agentStep` can run its agent and read its result. */
export interface AgentStepOptions<TDetails = unknown> {
  /** Stable name for this step, used in the trace file name. */
  readonly stepName: string;
  /** Absolute directory holding this step's `session-result.json`. Derived from the workspace. */
  readonly directory: (ctx: Ctx) => string;
  /** Build the agent prompt from context. */
  readonly prompt: (ctx: Ctx) => string;
  /** Build the system prompt from context, if any. */
  readonly systemPrompt?: (ctx: Ctx) => string;
  /** Optional schema the agent's `details` payload must satisfy. A mismatch fails the sub-phase. */
  readonly detailsSchema?: z.ZodType<TDetails>;
}

/**
 * Build the `run` for an agent sub-phase: the one defended boundary around the opaque agent
 * subprocess. It spawns the agent (handing over the abort signal), retries transient
 * failures with backoff, hard-validates `session-result.json` (a stale template or
 * malformed file fails loud rather than routing a lie), recovers a result the agent wrote
 * before dying, and validates the optional `details` payload. Orchestration bookkeeping —
 * cost events, the safety pipeline, usage tracking — wraps this at the cutover wiring.
 */
export function agentStep<TDetails = unknown>(
  options: AgentStepOptions<TDetails>,
): (ctx: Ctx) => Promise<SubPhaseResult> {
  return (ctx) => runStep(options, ctx);
}

async function runStep<TDetails>(options: AgentStepOptions<TDetails>, ctx: Ctx): Promise<SubPhaseResult> {
  const agent = ctx.registry.getPrimaryPlugin<AgentAdapter>(AdapterTypes.agent);
  if (!agent) {
    return failed("agent_unavailable", "No agent plugin is registered");
  }

  const directory = options.directory(ctx);
  resetResultFile(directory);

  // Build the prompt once (it reads the worktree) and reuse it for the run and the drill-down blob.
  const systemPrompt = options.systemPrompt?.(ctx) ?? null;
  const prompt = options.prompt(ctx);
  const traceOutputPath = tracePath(ctx, options.stepName);

  // The agent run is the single largest activity in a task. Make it a first-class span the observer can open:
  // the step and the full prompt up front; on end, the outcome plus the result and full transcript, all drillable.
  const span = ctx.observer.startSpan(
    ObservationTypes.agent_call,
    options.stepName,
    { step: options.stepName, prompt_blob: captureBlob(ctx, "prompt", combinePrompt(systemPrompt, prompt)) },
    traceScope(ctx),
  );

  try {
    const run = await runAgent(agent, { prompt, systemPrompt, traceOutputPath }, options.stepName, ctx);
    const parsed = readResult(directory);
    const spanScope: AgentSpanScope = {
      ctx,
      directory,
      traceOutputPath,
      spend: run.result ? toAgentSpend(run.result) : null,
    };

    // The agent may have written a valid result before dying — prefer the work over the error.
    if (parsed !== null && parsed !== "invalid") {
      return endAgentSpan(span, spanScope, mapResult(parsed, options.detailsSchema));
    }

    // No usable result. An abort means preemption — re-throw so the caller checkpoints and resumes.
    if (run.error) {
      if (ctx.signal?.aborted) {
        throw run.error;
      }
      return endAgentSpan(span, spanScope, failed("agent_unavailable", describe(run.error)));
    }

    const reason =
      parsed === "invalid"
        ? "session-result.json was not updated by the agent (still a template or malformed)"
        : "session-result.json was not created by the agent";
    return endAgentSpan(span, spanScope, failed("no_result", reason));
  } catch (error) {
    // The abort re-thrown above, or any unexpected throw — close the span errored before it propagates.
    span.setError(error);
    span.end({ outcome: ctx.signal?.aborted ? "aborted" : "error" });
    throw error;
  }
}

// ── Agent-call Observation ───────────────────────────────────────────────────

/** Everything the agent_call span needs to close: where the drill-down files live and what the run cost. */
interface AgentSpanScope {
  readonly ctx: Ctx;
  readonly directory: string;
  readonly traceOutputPath: string | null;
  /** The run's cost/token spend, or null when the run never produced a result (e.g. a hard failure). */
  readonly spend: AgentSpend | null;
}

/**
 * Close the agent_call span with the outcome, the cost/token spend the metrics page aggregates per phase,
 * and the drill-down blobs (the agent's result and full transcript).
 */
function endAgentSpan(span: ObservationSpan, scope: AgentSpanScope, result: SubPhaseResult): SubPhaseResult {
  const { ctx, directory, traceOutputPath, spend } = scope;
  if (result.outcome === "failed") {
    span.setError(new Error(result.summary));
  }
  span.end({
    outcome: result.outcome,
    summary: result.summary,
    cost_usd: spend?.cost_usd ?? null,
    tokens_in: spend?.tokens_in ?? null,
    tokens_out: spend?.tokens_out ?? null,
    cache_read_tokens: spend?.cache_read ?? null,
    result_blob: captureFileBlob(ctx, "result", path.join(directory, RESULT_FILE)),
    transcript_blob: captureFileBlob(ctx, "transcript", traceOutputPath),
  });
  return result;
}

/** One agent run's cost and token spend, distilled from the AgentRunResult for the agent_call span. */
interface AgentSpend {
  readonly cost_usd: number | null;
  readonly tokens_in: number | null;
  readonly tokens_out: number | null;
  readonly cache_read: number | null;
}

/** Distil an AgentRunResult into the spend the agent_call span carries (null tokens when the CLI doesn't report them). */
function toAgentSpend(result: AgentRunResult): AgentSpend {
  return {
    cost_usd: result.cost_usd,
    tokens_in: result.usage?.tokens.input_tokens ?? null,
    tokens_out: result.usage?.tokens.output_tokens ?? null,
    cache_read: result.usage?.tokens.cache_read_tokens ?? null,
  };
}

/** Combine the system and user prompts into one payload for the drill-down blob. */
function combinePrompt(systemPrompt: string | null, prompt: string): string {
  return systemPrompt ? `=== SYSTEM ===\n${systemPrompt}\n\n=== USER ===\n${prompt}` : prompt;
}

/** Store content as a sanitized drill-down blob. Best-effort: a blob-store failure degrades to "" with a debug note. */
function captureBlob(ctx: Ctx, kind: string, content: string): string {
  try {
    return ctx.observer.storeBlob(sanitizeSecrets(content));
  } catch (error) {
    ctx.observer.debug("Could not store agent observation blob", { taskId: ctx.task.id, kind, error: describe(error) });
    return "";
  }
}

/** Read a file and store its content as a drill-down blob, or "" when the file is absent or unreadable. */
function captureFileBlob(ctx: Ctx, kind: string, file: string | null): string {
  if (!(file && existsSync(file))) {
    return "";
  }
  try {
    return captureBlob(ctx, kind, readFileSync(file, "utf-8"));
  } catch (error) {
    ctx.observer.debug("Could not read file for agent observation blob", {
      taskId: ctx.task.id,
      kind,
      error: describe(error),
    });
    return "";
  }
}

// ── Result Mapping (pure) ────────────────────────────────────────────────────

/** Map a validated session-result to a SubPhaseResult, gating `details` on the sub-phase's schema. */
function mapResult<TDetails>(result: SessionResult, detailsSchema?: z.ZodType<TDetails>): SubPhaseResult {
  if (result.status === "needs_human") {
    return { outcome: "needs_human", summary: result.summary };
  }
  if (result.status === "failed") {
    return failed("agent_failed", result.summary);
  }
  if (detailsSchema) {
    const validated = detailsSchema.safeParse(result.details ?? {});
    if (!validated.success) {
      return failed("details_invalid", validated.error.message);
    }
  }
  return result.details
    ? { outcome: "ok", summary: result.summary, data: result.details }
    : { outcome: "ok", summary: result.summary };
}

function failed(category: FailureCause, message: string): SubPhaseResult {
  return { outcome: "failed", summary: `${category}: ${message}`.slice(0, 200), category, detail: message };
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

// ── Agent Invocation ─────────────────────────────────────────────────────────

/** The prebuilt request parts an agent run needs — built once in runStep so the prompt is not composed twice. */
interface AgentRequestParts {
  readonly prompt: string;
  readonly systemPrompt: string | null;
  readonly traceOutputPath: string | null;
}

/** The outcome of the retry loop: the agent run's result on success, or the final error the caller recovers from. */
interface AgentRunOutcome {
  readonly result: AgentRunResult | null;
  readonly error: unknown;
}

/** Run the agent with retry/backoff. Returns the run's result on success, or the final error for the caller to recover. */
async function runAgent(
  agent: AgentAdapter,
  parts: AgentRequestParts,
  stepName: string,
  ctx: Ctx,
): Promise<AgentRunOutcome> {
  const request = {
    prompt: parts.prompt,
    system_prompt: parts.systemPrompt,
    cwd: ctx.worktreePath,
    trace_output_path: parts.traceOutputPath,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_AGENT_RETRIES; attempt += 1) {
    try {
      return { result: await gatedRun(agent, request, stepName, ctx), error: null };
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === MAX_AGENT_RETRIES - 1;
      if (ctx.signal?.aborted || isLastAttempt || !isRetryable(error)) {
        return { result: null, error };
      }
      const delayMs = RETRY_BASE_MS * 2 ** attempt;
      ctx.observer.warn("Agent run failed — retrying", {
        taskId: ctx.task.id,
        step: stepName,
        attempt: attempt + 1,
        delayMs,
      });
      await sleep(delayMs, ctx.signal);
    }
  }
  return { result: null, error: lastError };
}

/**
 * Run the agent through the action pipeline so the safety layer gates it, then record what it cost.
 * Returns the run's result (cost/tokens) so the agent_call span can carry the spend. A pipeline `error`
 * re-throws the original so the retry logic can judge it; a `rejected`/`ask_human` stop is a non-transient
 * throw the runner blocks on.
 */
async function gatedRun(
  agent: AgentAdapter,
  request: AgentRunRequest,
  stepName: string,
  ctx: Ctx,
): Promise<AgentRunResult> {
  const pipelineResult = await ctx.actionPipeline.execute<AgentRunResult>({
    taskId: ctx.task.id,
    actionClass: ActionClasses.read,
    details: { operation: "agent_run", step: stepName },
    requestedBy: "orchestrator",
    executeFn: () => agent.run(request),
  });
  if (pipelineResult.outcome === "error") {
    throw pipelineResult.error;
  }
  if (pipelineResult.outcome !== "executed") {
    throw new Error(`Agent run ${pipelineResult.outcome}: ${pipelineResult.reason}`);
  }
  // Cost event carries the real plugin id (Session 37 handoff); the payload shape is single-sourced in agent-cost.
  emitAgentCost(ctx.eventBus, ctx.taskEngine, {
    taskId: ctx.task.id,
    repo: ctx.task.repo ?? "",
    providerId: agent.manifest.id,
    operation: "agent_step",
    result: pipelineResult.result,
  });
  return pipelineResult.result;
}

/** Transient failures (network, rate limit) are worth a retry; everything else is not. */
function isRetryable(error: unknown): boolean {
  if (error instanceof AdapterMethodError) {
    return error.adapterError.retryable;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.slice(0, 500).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("503") ||
    message.includes("529") ||
    message.includes("overloaded")
  );
}

/** Sleep that resolves after `ms`, or rejects early if the signal aborts mid-backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted during backoff"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted during backoff"));
      },
      { once: true },
    );
  });
}

// ── session-result.json I/O ──────────────────────────────────────────────────

/** Read and hard-validate the result file. Missing → null; malformed or a stale template → "invalid". */
function readResult(directory: string): SessionResult | null | "invalid" {
  const file = path.join(directory, RESULT_FILE);
  if (!existsSync(file)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    const result = SessionResultSchema.safeParse(raw);
    return result.success ? result.data : "invalid";
  } catch {
    return "invalid";
  }
}

/** Back up a real prior result, then write a fresh template so a no-op agent run fails loud. */
function resetResultFile(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, RESULT_FILE);
  const prior = readResult(directory);
  if (prior !== null && prior !== "invalid") {
    try {
      renameSync(file, path.join(directory, `session-result.${stamp()}.json.bak`));
    } catch {
      // Best effort — overwriting the template below still clears the stale result.
    }
  }
  const template = { status: "<ok | needs_human | failed>", summary: "<one-line summary>", details: {} };
  writeFileSync(file, `${JSON.stringify(template, null, 2)}\n`, "utf-8");
}

/** Structured trace path for this step, or null when tracing is disabled. */
function tracePath(ctx: Ctx, stepName: string): string | null {
  if (!ctx.tracesDir) {
    return null;
  }
  const directory = path.join(ctx.tracesDir, "sessions", ctx.task.id);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    ctx.observer.debug("Could not create the agent trace directory — transcript tracing is off for this step", {
      taskId: ctx.task.id,
      step: stepName,
      error: describe(error),
    });
    return null;
  }
  return path.join(directory, `${stepName}-${stamp()}.ndjson`);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
