import type { CommMessageReceivedPayload } from "../../schemas/events.js";
import { type TaskState, TaskStates } from "../../schemas/task.js";
import type { ISafetyLayer } from "../interfaces/safety-layer.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { NotificationRouter } from "./notification-router.js";

const PROGRESS_RE = /progress.*#(\d+)|#(\d+).*progress/;

export interface QueryHandlerDeps {
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
  notifications: NotificationRouter;
}

/**
 * Handle an inbound communication message as a query.
 *
 * Basic v1: keyword-match query type, route to data source, format response,
 * send back via the centralized notification router.
 *
 * Query types supported:
 * - "status" → task summary (counts by state)
 * - "progress #N" → detail for a specific task
 * - "cost" → cost status from safety layer
 */
export function handleQuery(payload: CommMessageReceivedPayload, deps: QueryHandlerDeps): void {
  const { taskEngine, safetyLayer, notifications } = deps;
  const content = payload.content.toLowerCase();

  let response: string;

  const taskMatch = PROGRESS_RE.exec(content);
  if (taskMatch) {
    const taskNum = taskMatch[1] ?? taskMatch[2];
    response = formatProgressResponse(taskEngine, taskNum as string);
  } else if (content.includes("cost")) {
    response = formatCostResponse(safetyLayer);
  } else if (content.includes("status")) {
    response = formatStatusResponse(taskEngine);
  } else {
    response = "I didn't understand the query. Try: `status`, `progress #N`, or `cost`.";
  }

  // Route response through centralized notification router
  notifications.notify({
    kind: "status_response",
    taskId: null,
    personId: payload.sender,
    message: response,
  });
}

// ── Response Formatters ───────────────────────────────────────────────────

function formatStatusResponse(taskEngine: ITaskEngine): string {
  const states: TaskState[] = [
    TaskStates.intake,
    TaskStates.queued,
    TaskStates.active,
    TaskStates.blocked,
    TaskStates.review_pending,
    TaskStates.completed,
    TaskStates.failed,
  ];
  const counts: string[] = [];
  for (const state of states) {
    const tasks = taskEngine.getTasksByState(state);
    if (tasks.length > 0) {
      counts.push(`${state}: ${String(tasks.length)}`);
    }
  }
  return counts.length > 0 ? `Task status:\n${counts.join("\n")}` : "No tasks found.";
}

function formatProgressResponse(taskEngine: ITaskEngine, taskId: string): string {
  const task = taskEngine.getTask(taskId);
  if (!task) {
    return `Task #${taskId} not found.`;
  }
  return [
    `Task #${taskId}: ${task.title}`,
    `State: ${task.state}${task.sub_state ? ` (${task.sub_state})` : ""}`,
    `Priority: ${String(task.priority)}`,
    task.phase ? `Phase: ${task.phase}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCostResponse(safetyLayer: ISafetyLayer): string {
  const judgment = safetyLayer.consultJudgment({
    type: "cost_check",
    context: { task_id: "", repo: "", details: {} },
  });
  return `Cost check: ${judgment.allowed ? "within limits" : "limit reached"}${judgment.reason ? ` — ${judgment.reason}` : ""}`;
}
