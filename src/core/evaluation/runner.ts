import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LLMAdapter } from "../../adapters/llm.js";
import { AdapterTypes, type InferenceResult } from "../../schemas/adapters.js";
import { EventTypes } from "../../schemas/events.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import {
  buildBlindPlanPrompt,
  buildBlindPlanSystemPrompt,
  buildComparisonPrompt,
  buildComparisonSystemPrompt,
} from "./prompts.js";
import type { EvaluationManagerContext, EvaluationSnapshot } from "./types.js";

// ── Persona Loading ──────────────────────────────────────────────────────────

const PERSONA_PATHS = ["docs/persona.md", "persona.md"];

function loadPersonaContent(bareCloneDir: string): string {
  for (const rel of PERSONA_PATHS) {
    const full = join(bareCloneDir, rel);
    if (existsSync(full)) {
      return readFileSync(full, "utf-8");
    }
  }
  return "No persona document found. Evaluate against the standard of a world-class senior engineer.";
}

// ── Types ���───────────────────────────────────────────────────────────────────

interface SessionResult {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  costUsd: number | null;
}

// ── Evaluation Runner ────────────────────────────────────────────────────────

/**
 * Run the two-session evaluation against a captured snapshot.
 *
 * Session 1: Blind plan (CWD = bare clone, base branch perspective).
 * Session 2: Comparison verdict (CWD = evaluation dir).
 *
 * This function never throws — all errors are logged and swallowed.
 */
export async function runEvaluation(
  snapshot: EvaluationSnapshot,
  ctx: EvaluationManagerContext,
): Promise<void> {
  const startTime = Date.now();
  let session1: SessionResult | null = null;
  let session2: SessionResult | null = null;

  try {
    const llm = ctx.registry.getPrimaryPlugin<LLMAdapter>(AdapterTypes.llm);
    if (!llm) {
      ctx.observer.warn("Evaluation skipped — no LLM plugin available", {
        taskId: snapshot.taskId,
      });
      return;
    }

    // Skip if LLM is currently rate-limited — don't waste a call that will fail
    const quota = await llm.getQuotaStatus();
    if (quota?.is_rate_limited) {
      ctx.observer.info("Evaluation skipped — LLM is rate-limited", {
        taskId: snapshot.taskId,
        resetsAt: quota.earliest_reset_at,
      });
      return;
    }

    session1 = await runBlindPlan(llm, snapshot, ctx);
    session2 = await runComparison(llm, snapshot, ctx);

    const totalCost = (session1.costUsd ?? 0) + (session2.costUsd ?? 0) || null;
    const totalDuration = Date.now() - startTime;

    writeMetadata(snapshot, session1, session2, totalCost, totalDuration, "completed");
    emitEvent(ctx, snapshot, totalCost, totalDuration, "completed");
  } catch (error) {
    handleEvaluationError(error, snapshot, ctx, startTime, session1, session2);
  }
}

// ── Session Runners ���─────────────────────────────────────────────────────────

async function runBlindPlan(
  llm: LLMAdapter,
  snapshot: EvaluationSnapshot,
  ctx: EvaluationManagerContext,
): Promise<SessionResult> {
  ctx.observer.info("Evaluation Session 1 starting — blind plan", {
    taskId: snapshot.taskId,
    repo: snapshot.repo,
  });

  const result = await runSession(
    llm,
    buildBlindPlanSystemPrompt(),
    buildBlindPlanPrompt(snapshot),
    snapshot.bareCloneDir,
  );

  ctx.observer.info("Evaluation Session 1 complete — blind plan written", {
    taskId: snapshot.taskId,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
  });

  return result;
}

async function runComparison(
  llm: LLMAdapter,
  snapshot: EvaluationSnapshot,
  ctx: EvaluationManagerContext,
): Promise<SessionResult> {
  ctx.observer.info("Evaluation Session 2 starting — comparison", {
    taskId: snapshot.taskId,
  });

  const personaContent = loadPersonaContent(snapshot.bareCloneDir);

  const result = await runSession(
    llm,
    buildComparisonSystemPrompt(personaContent),
    buildComparisonPrompt(snapshot),
    snapshot.evaluationDir,
  );

  ctx.observer.info("Evaluation Session 2 complete — verdict written", {
    taskId: snapshot.taskId,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
  });

  return result;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function runSession(
  llm: LLMAdapter,
  systemPrompt: string,
  prompt: string,
  cwd: string,
): Promise<SessionResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  const result: InferenceResult = await llm.infer({
    prompt,
    system_prompt: systemPrompt,
    cwd,
    trace_output_path: null,
  });

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - start;

  return { startedAt, completedAt, durationMs, costUsd: result.cost_usd };
}

function serializeSession(session: SessionResult | null) {
  if (!session) {
    return null;
  }
  return {
    started_at: session.startedAt,
    completed_at: session.completedAt,
    duration_ms: session.durationMs,
    cost_usd: session.costUsd,
  };
}

function writeMetadata(
  snapshot: EvaluationSnapshot,
  session1: SessionResult | null,
  session2: SessionResult | null,
  totalCost: number | null,
  totalDuration: number,
  status: "completed" | "failed",
  error?: string,
): void {
  const metadata = {
    task_id: snapshot.taskId,
    task_title: snapshot.taskTitle,
    repo: snapshot.repo,
    branch: snapshot.branch,
    base_branch: snapshot.baseBranch,
    triggered_at: snapshot.snapshotTimestamp,
    session_1: serializeSession(session1),
    session_2: serializeSession(session2),
    total_cost_usd: totalCost,
    total_duration_ms: totalDuration,
    status,
    ...(error ? { error } : {}),
  };

  writeFileSync(join(snapshot.evaluationDir, "metadata.json"), JSON.stringify(metadata, null, 2));
}

function emitEvent(
  ctx: EvaluationManagerContext,
  snapshot: EvaluationSnapshot,
  totalCost: number | null,
  totalDuration: number,
  status: "completed" | "failed",
): void {
  ctx.eventBus.publish({
    type: EventTypes["evaluation.completed"],
    source: "evaluation",
    task_id: snapshot.taskId,
    payload: {
      task_id: snapshot.taskId,
      evaluation_dir: snapshot.evaluationDir,
      total_cost_usd: totalCost,
      duration_ms: totalDuration,
      status,
    },
  } satisfies PublishInput<"evaluation.completed">);
}

function handleEvaluationError(
  error: unknown,
  snapshot: EvaluationSnapshot,
  ctx: EvaluationManagerContext,
  startTime: number,
  session1: SessionResult | null,
  session2: SessionResult | null,
): void {
  const totalDuration = Date.now() - startTime;
  const errorMsg = error instanceof Error ? error.message : String(error);

  ctx.observer.warn("Evaluation failed", {
    taskId: snapshot.taskId,
    error: errorMsg,
    durationMs: totalDuration,
  });

  const totalCost = (session1?.costUsd ?? 0) + (session2?.costUsd ?? 0) || null;

  try {
    writeMetadata(snapshot, session1, session2, totalCost, totalDuration, "failed", errorMsg);
  } catch {
    // Best effort — don't let metadata write failure mask the real error
  }

  emitEvent(ctx, snapshot, totalCost, totalDuration, "failed");
}
