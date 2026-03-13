import type { ActionClass } from "../../schemas/task.js";

/** Input for ActionPipeline.execute(). */
export interface ExecuteInput<T> {
  taskId: string;
  actionClass: ActionClass;
  details: Record<string, unknown>;
  requestedBy: string;
  executeFn: () => T | Promise<T>;
  notifyFn?: (result: T) => void;
}

/** Discriminated union of pipeline outcomes. */
export type PipelineResult<T> =
  | { outcome: "executed"; result: T }
  | { outcome: "rejected"; gate: "task_engine" | "safety_layer"; reason: string }
  | { outcome: "ask_human"; reason: string; warnings?: string[] }
  | { outcome: "error"; reason: string; error: unknown };

export interface IActionPipeline {
  execute<T>(input: ExecuteInput<T>): Promise<PipelineResult<T>>;
}
