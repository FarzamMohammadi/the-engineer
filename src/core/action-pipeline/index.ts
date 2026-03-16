import { ActionRejectedPayloadSchema, EventTypes } from "../../schemas/events.js";
import { ActionClasses } from "../../schemas/task.js";
import type { ActionClass } from "../../schemas/task.js";
import type { EventBus } from "../event-bus/index.js";
import type { EventDeclaration } from "../event-bus/topology.js";
import type {
  ExecuteInput,
  IActionPipeline,
  PipelineResult,
} from "../interfaces/action-pipeline.interface.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type { ISafetyLayer, SafetyVerdict } from "../interfaces/safety-layer.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IObserver } from "../observer/facade.js";

// Re-export interface types so existing consumers don't break
export type { ExecuteInput, PipelineResult } from "../interfaces/action-pipeline.interface.js";

// ── Event Declarations ──────────────────────────────────────────────────────

export const EVENTS: EventDeclaration[] = [
  {
    type: "action.rejected",
    description: "Emitted when the pipeline rejects an action (Gate 1 or Gate 2)",
    payloadSchema: ActionRejectedPayloadSchema,
    publishers: ["action-pipeline"],
    subscribers: [],
  },
];

// ── ActionPipeline ────────────────────────────────────────────────────────────

/**
 * Thin authorization middleware: Gate 1 (Task Engine) → Gate 2 (Safety Layer) → Execute → Notify.
 * Every side-effect action flows through this pipeline. The intelligence lives in the gates,
 * not the pipeline itself.
 */
export class ActionPipeline implements IActionPipeline {
  private readonly taskEngine: ITaskEngine;
  private readonly safetyLayer: ISafetyLayer;
  private readonly eventBus: EventBus;
  private readonly observer: IObserver;

  constructor(
    taskEngine: ITaskEngine,
    safetyLayer: ISafetyLayer,
    eventBus: EventBus,
    observer: IObserver,
  ) {
    this.taskEngine = taskEngine;
    this.safetyLayer = safetyLayer;
    this.eventBus = eventBus;
    this.observer = observer;
  }

  async execute<T>(input: ExecuteInput<T>): Promise<PipelineResult<T>> {
    const { taskId, actionClass, details, requestedBy, executeFn, notifyFn } = input;

    // Gate 1: Task Engine — is this action class legal in the current task state?
    const permission = this.taskEngine.checkPermission(taskId, actionClass);
    if (!permission.allowed) {
      this.emitRejection(
        taskId,
        actionClass,
        "task_engine",
        permission.reason ?? "denied",
        details,
        requestedBy,
      );
      return { outcome: "rejected", gate: "task_engine", reason: permission.reason ?? "denied" };
    }

    // Gate 2: Safety Layer — does policy allow this action? (skip for read-only)
    if (actionClass !== ActionClasses.read) {
      const verdict = this.safetyLayer.evaluateAction(taskId, actionClass, details);
      const rejection = this.checkSafetyVerdict<T>(
        verdict,
        taskId,
        actionClass,
        details,
        requestedBy,
      );
      if (rejection) {
        return rejection;
      }
    }

    // Execute
    let result: T;
    try {
      result = await executeFn();
    } catch (err: unknown) {
      return {
        outcome: "error",
        reason: err instanceof Error ? err.message : String(err),
        error: err,
      };
    }

    // Notify (optional, fire-and-forget)
    if (notifyFn) {
      try {
        notifyFn(result);
      } catch (err: unknown) {
        this.observer.error("notifyFn threw", { err });
      }
    }

    return { outcome: "executed", result };
  }

  private checkSafetyVerdict<T>(
    verdict: SafetyVerdict,
    taskId: string,
    actionClass: ActionClass,
    details: Record<string, unknown>,
    requestedBy: string,
  ): PipelineResult<T> | null {
    if (verdict.action === "deny") {
      this.emitRejection(taskId, actionClass, "safety_layer", verdict.reason, details, requestedBy);
      return { outcome: "rejected", gate: "safety_layer", reason: verdict.reason };
    }

    if (verdict.action === "ask_human") {
      this.emitRejection(taskId, actionClass, "safety_layer", verdict.reason, details, requestedBy);
      const result: PipelineResult<T> = { outcome: "ask_human", reason: verdict.reason };
      if (verdict.warnings && verdict.warnings.length > 0) {
        result.warnings = verdict.warnings;
      }
      return result;
    }

    return null;
  }

  private emitRejection(
    taskId: string,
    actionClass: ActionClass,
    gate: "task_engine" | "safety_layer",
    reason: string,
    details: Record<string, unknown>,
    requestedBy: string,
  ): void {
    this.eventBus.publish({
      type: EventTypes["action.rejected"],
      source: "action_pipeline",
      task_id: taskId,
      payload: {
        task_id: taskId,
        action_class: actionClass,
        gate,
        reason,
        details,
        requested_by: requestedBy,
      },
    } satisfies PublishInput<"action.rejected">);
  }
}
