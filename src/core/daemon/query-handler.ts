import type { CommMessageReceivedPayload } from "../../schemas/events.js";
import { NotificationKinds } from "../../schemas/notifications.js";
import { type Task, type TaskState, TaskStates } from "../../schemas/task.js";
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
    const issueNumber = taskMatch[1] ?? taskMatch[2];
    response = formatProgressResponse(taskEngine, issueNumber as string);
  } else if (content.includes("cost")) {
    response = formatCostResponse(safetyLayer);
  } else if (content.includes("status")) {
    response = formatStatusResponse(taskEngine);
  } else {
    response = "I didn't understand the query. Try: `status`, `progress #N`, or `cost`.";
  }

  // Route response through centralized notification router
  notifications.notify({
    kind: NotificationKinds.status_response,
    taskId: null,
    personId: payload.sender,
    message: response,
  });
}

// ── Response Formatters ───────────────────────────────────────────────────

function formatStatusResponse(taskEngine: ITaskEngine): string {
  const states: TaskState[] = [
    TaskStates.requirements_gathering,
    TaskStates.queued,
    TaskStates.active,
    TaskStates.blocked,
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

/**
 * Resolve a "progress #N" query, where N is the external issue number (e.g. issue 42),
 * not the internal task id (a ULID). Tasks carry the issue number on `external_ref.id`,
 * so match against that across all states. v1 keyword-match preview — Slice 10 owns the
 * real comms-query design.
 */
function formatProgressResponse(taskEngine: ITaskEngine, issueNumber: string): string {
  const task = findTaskByIssueNumber(taskEngine, issueNumber);
  if (!task) {
    return `Issue #${issueNumber} not found.`;
  }
  return [
    `Issue #${issueNumber}: ${task.title}`,
    `State: ${task.state}${task.sub_state ? ` (${task.sub_state})` : ""}`,
    `Priority: ${String(task.priority)}`,
    task.phase ? `Phase: ${task.phase}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Find the task whose external reference matches the given issue number, scanning all states. */
function findTaskByIssueNumber(taskEngine: ITaskEngine, issueNumber: string): Task | null {
  const states: TaskState[] = [
    TaskStates.requirements_gathering,
    TaskStates.queued,
    TaskStates.active,
    TaskStates.blocked,
    TaskStates.completed,
    TaskStates.failed,
  ];
  for (const state of states) {
    for (const task of taskEngine.getTasksByState(state)) {
      if (task.external_ref?.id === issueNumber) {
        return task;
      }
    }
  }
  return null;
}

function formatCostResponse(safetyLayer: ISafetyLayer): string {
  const judgment = safetyLayer.consultJudgment({
    type: "cost_check",
    context: { task_id: "", repo: "", details: {} },
  });
  return `Cost check: ${judgment.allowed ? "within limits" : "limit reached"}${judgment.reason ? ` — ${judgment.reason}` : ""}`;
}
