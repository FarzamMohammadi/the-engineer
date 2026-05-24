import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import { runEvaluation } from "./runner.js";
import { captureSnapshot } from "./snapshot.js";
import type { EvaluationManager, EvaluationManagerContext, EvaluationSnapshot } from "./types.js";

export type { EvaluationManager, EvaluationManagerContext } from "./types.js";

// ── Factory ──────────────────────────────────────────────────────────────────

export function createEvaluationManager(ctx: EvaluationManagerContext): EvaluationManager {
  const activeEvaluations = new Map<string, Promise<void>>();

  function triggerEvaluation(taskId: string, worktreePath: string, thoughtsDir: string): void {
    if (!ctx.config.evaluation.enabled) {
      return;
    }

    // Guard against duplicate trigger for the same task
    if (activeEvaluations.has(taskId)) {
      ctx.observer.debug("Evaluation already in-flight — skipping duplicate trigger", { taskId });
      return;
    }

    const task = ctx.taskEngine.getTask(taskId);
    if (!task) {
      ctx.observer.warn("Evaluation skipped — task not found", { taskId });
      return;
    }

    const record = ctx.workspaceManager.getWorkspaceRecord(taskId);
    if (!record) {
      ctx.observer.warn("Evaluation skipped — no workspace record", { taskId });
      return;
    }

    // Capture snapshot synchronously while worktree is alive
    let snapshot: EvaluationSnapshot;
    try {
      snapshot = captureSnapshot({
        taskId,
        worktreePath,
        thoughtsDir,
        task,
        record,
        engineerHome: ctx.engineerHome,
      });
    } catch (error) {
      ctx.observer.warn("Evaluation skipped — snapshot capture failed", {
        taskId,
        error: sanitizeErrorMessage(error),
      });
      return;
    }

    ctx.observer.info("Evaluation triggered", {
      taskId,
      evaluationDir: snapshot.evaluationDir,
    });

    // Fire-and-forget: run async, track promise for shutdown drain.
    // runEvaluation catches internally, but guard against an escape so the
    // promise never goes unhandled.
    const promise = runEvaluation(snapshot, ctx)
      .catch((err: unknown) => {
        ctx.observer.error("Evaluation runner threw unexpectedly", {
          taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        activeEvaluations.delete(taskId);
      });

    activeEvaluations.set(taskId, promise);
  }

  async function drainForShutdown(timeoutMs: number): Promise<void> {
    if (activeEvaluations.size === 0) {
      return;
    }

    ctx.observer.info("Draining active evaluations", {
      count: activeEvaluations.size,
      timeoutMs,
    });

    const allSettled = Promise.allSettled(activeEvaluations.values());
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));

    await Promise.race([allSettled, timeout]);

    if (activeEvaluations.size > 0) {
      ctx.observer.warn("Evaluation drain timed out — some evaluations may be incomplete", {
        remaining: activeEvaluations.size,
      });
    }
  }

  function getActiveCount(): number {
    return activeEvaluations.size;
  }

  return {
    triggerEvaluation,
    drainForShutdown,
    getActiveCount,
  };
}
