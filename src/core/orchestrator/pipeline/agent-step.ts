import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

import type { AgentAdapter } from "../../../adapters/agent.js";
import { AdapterMethodError } from "../../../adapters/index.js";
import { AdapterTypes, type AgentRunRequest, type AgentRunResult } from "../../../schemas/adapters.js";
import { ActionClasses } from "../../../schemas/task.js";
import type { PublishInput } from "../../interfaces/event-bus.interface.js";
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

  const agentError = await runAgent(agent, options, ctx);
  const parsed = readResult(directory);

  // The agent may have written a valid result before dying — prefer the work over the error.
  if (parsed !== null && parsed !== "invalid") {
    return mapResult(parsed, options.detailsSchema);
  }

  // No usable result. An abort means preemption — re-throw so the caller checkpoints and resumes.
  if (agentError) {
    if (ctx.signal?.aborted) {
      throw agentError;
    }
    return failed("agent_unavailable", describe(agentError));
  }

  const reason =
    parsed === "invalid"
      ? "session-result.json was not updated by the agent (still a template or malformed)"
      : "session-result.json was not created by the agent";
  return failed("no_result", reason);
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

/** Run the agent with retry/backoff. Returns the final error (caller decides recovery), or null on success. */
async function runAgent<TDetails>(
  agent: AgentAdapter,
  options: AgentStepOptions<TDetails>,
  ctx: Ctx,
): Promise<unknown> {
  const request = {
    prompt: options.prompt(ctx),
    system_prompt: options.systemPrompt?.(ctx) ?? null,
    cwd: ctx.worktreePath,
    trace_output_path: tracePath(ctx, options.stepName),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_AGENT_RETRIES; attempt += 1) {
    try {
      await gatedRun(agent, request, options.stepName, ctx);
      return null;
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === MAX_AGENT_RETRIES - 1;
      if (ctx.signal?.aborted || isLastAttempt || !isRetryable(error)) {
        return error;
      }
      const delayMs = RETRY_BASE_MS * 2 ** attempt;
      ctx.observer.warn("Agent run failed — retrying", {
        taskId: ctx.task.id,
        step: options.stepName,
        attempt: attempt + 1,
        delayMs,
      });
      await sleep(delayMs, ctx.signal);
    }
  }
  return lastError;
}

/**
 * Run the agent through the action pipeline so the safety layer gates it, then record what it cost.
 * A pipeline `error` re-throws the original so the retry logic can judge it; a `rejected`/`ask_human`
 * stop is a non-transient throw the runner blocks on.
 */
async function gatedRun(agent: AgentAdapter, request: AgentRunRequest, stepName: string, ctx: Ctx): Promise<void> {
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
  recordCost(agent, pipelineResult.result, ctx);
}

/** Emit cost.incurred carrying the real plugin id (Session 37 handoff), and accumulate task usage. */
function recordCost(agent: AgentAdapter, result: AgentRunResult, ctx: Ctx): void {
  const usage = result.usage;
  ctx.eventBus.publish({
    type: "cost.incurred",
    source: "orchestrator",
    task_id: ctx.task.id,
    payload: {
      task_id: ctx.task.id,
      repo: ctx.task.repo ?? "",
      provider_id: agent.manifest.id,
      operation: "agent_step",
      spend_usd: result.cost_usd,
      duration_ms: result.duration_ms,
      input_tokens: usage?.tokens.input_tokens ?? null,
      output_tokens: usage?.tokens.output_tokens ?? null,
      total_tokens: usage?.tokens.total_tokens ?? null,
      cache_read_tokens: usage?.tokens.cache_read_tokens ?? null,
      model_id: usage?.model_id ?? null,
    },
  } satisfies PublishInput<"cost.incurred">);
  ctx.taskEngine.updateTracking(ctx.task.id, usage?.tokens.total_tokens ?? 0, result.cost_usd ?? 0, result.duration_ms);
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
  } catch {
    return null;
  }
  return path.join(directory, `${stepName}-${stamp()}.ndjson`);
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
