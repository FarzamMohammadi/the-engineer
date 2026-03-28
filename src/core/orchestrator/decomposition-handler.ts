import type { Dispatch } from "../../schemas/ephemeral.js";
import {
  LLMDecompositionPlanSchema,
  type Phase,
  type PhaseOutput,
  Phases,
} from "../../schemas/orchestrator.js";
import { JournalEntryTypes, SessionEndReasons } from "../../schemas/session-memory.js";
import { type ChildEntry, SubStates, TaskStates } from "../../schemas/task.js";
import type { OrchestratorNotifier } from "./orchestrator-notifier.js";
import type { ExecuteTaskResult, OrchestratorContext } from "./types.js";

// ── DecompositionHandler Interface ──────────────────────────────────────────

/** Task decomposition logic — splits a task into child tasks. */
export interface DecompositionHandler {
  /**
   * After planning: check if the LLM produced a decomposition plan.
   * If so, create child tasks, transition parent to supervising, and return.
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

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create a DecompositionHandler bound to the given OrchestratorContext. */
export function createDecompositionHandler(
  ctx: OrchestratorContext,
  notifier: OrchestratorNotifier,
): DecompositionHandler {
  function handleDecomposition(
    sessionId: string,
    taskId: string,
    planningOutput: PhaseOutput,
    dispatch: Dispatch,
    priorOutputs: Map<Phase, PhaseOutput>,
  ): ExecuteTaskResult | null {
    const planData = planningOutput.data as { decomposition_plan?: unknown };
    if (!planData.decomposition_plan) {
      return null;
    }

    const parseResult = LLMDecompositionPlanSchema.safeParse(planData.decomposition_plan);
    if (!parseResult.success) {
      ctx.observer.warn("Invalid decomposition plan from LLM — skipping decomposition", {
        taskId,
        error: parseResult.error.message,
      });
      ctx.sessionMemory.addJournalEntry({
        sessionId,
        taskId,
        phase: Phases.planning,
        type: JournalEntryTypes.error,
        summary: `Invalid decomposition plan from LLM: ${parseResult.error.message}`,
        tags: ["decomposition", "validation_error"],
      });
      return null;
    }

    const plan = parseResult.data;
    const childIds: string[] = [];
    const decompStart = Date.now();

    // Guard against partial child creation: if any child fails to create or
    // transition, log the orphaned IDs and skip decomposition (graceful degradation).
    try {
      for (const childSpec of plan.children) {
        const childTask = ctx.taskEngine.createTask({
          title: childSpec.title,
          repo: dispatch.task.repo ?? "",
          source: "decomposition",
          description: childSpec.description,
          parent_id: taskId,
          acceptance_criteria: childSpec.acceptance_criteria,
          clone_url: dispatch.task.clone_url,
          cascade_policy: "pause_siblings",
        });

        ctx.taskEngine.requestTransition(
          childTask.id,
          TaskStates.queued,
          null,
          "decomposition",
          "orchestrator",
        );

        childIds.push(childTask.id);
      }
    } catch (childErr) {
      const errMsg = childErr instanceof Error ? childErr.message : String(childErr);
      ctx.observer.error("Decomposition partially failed — orphaned children may exist", {
        taskId,
        createdChildIds: childIds,
        totalPlanned: plan.children.length,
        error: errMsg,
      });
      ctx.sessionMemory.addJournalEntry({
        sessionId,
        taskId,
        phase: Phases.planning,
        type: JournalEntryTypes.error,
        summary: `Decomposition failed after creating ${String(childIds.length)}/${String(plan.children.length)} children: ${errMsg}`,
        detail: `Orphaned child IDs: ${childIds.join(", ") || "none"}`,
        tags: ["decomposition", "partial_failure"],
      });
      return null;
    }

    // Build children array with dependency mapping (index-based → task ID)
    const childEntries: ChildEntry[] = childIds.map((id, idx) => {
      // biome-ignore lint/style/noNonNullAssertion: idx is within bounds
      const spec = plan.children[idx]!;
      const dependsOnIds = spec.depends_on
        .filter((depIdx) => depIdx >= 0 && depIdx < childIds.length)
        // biome-ignore lint/style/noNonNullAssertion: filter guarantees valid index
        .map((depIdx) => childIds[depIdx]!);
      return { id, state: TaskStates.queued, depends_on: dependsOnIds };
    });
    ctx.taskEngine.updateTaskField(taskId, "children", childEntries);

    // Transition parent: active.working → active.supervising
    ctx.taskEngine.requestTransition(
      taskId,
      TaskStates.active,
      SubStates.supervising,
      "decomposed_into_children",
      "orchestrator",
    );

    ctx.observer.info("Task decomposed into children", {
      taskId,
      childCount: childIds.length,
      childIds,
      durationMs: Date.now() - decompStart,
    });

    ctx.sessionMemory.addJournalEntry({
      sessionId,
      taskId,
      phase: Phases.planning,
      type: JournalEntryTypes.phase_change,
      summary: `Task decomposed into ${String(childIds.length)} child tasks: ${childIds.join(", ")}`,
      tags: ["decomposition"],
    });

    const subtaskList = plan.children.map((c, i) => `${String(i + 1)}. ${c.title}`).join("\n");
    notifier.commentOnSourceTicket(
      dispatch,
      `Decomposing into ${String(plan.children.length)} subtasks:\n${subtaskList}`,
    );

    ctx.sessionMemory.endSession(sessionId, SessionEndReasons.decomposed);

    return { outcome: "decomposed", childTaskIds: childIds, phaseOutputs: priorOutputs };
  }

  return { handleDecomposition };
}
