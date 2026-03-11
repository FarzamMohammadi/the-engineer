import type { Logger } from "pino";
import type { CommunicationAdapter } from "../../adapters/communication.js";
import type { CommMessageReceivedPayload } from "../../schemas/events.js";
import type { TaskState } from "../../schemas/task.js";
import type { Registry } from "../registry/index.js";
import type { SafetyLayer } from "../safety-layer/index.js";
import type { TaskEngine } from "../task-engine/index.js";

const PROGRESS_RE = /progress.*#(\d+)|#(\d+).*progress/;

export interface QueryHandlerDeps {
  taskEngine: TaskEngine;
  safetyLayer: SafetyLayer;
  registry: Registry;
  logger: Logger;
}

/**
 * Handle an inbound communication message as a query.
 *
 * Basic v1: keyword-match query type, route to data source, format response,
 * send back via the same communication plugin. No LLM involved.
 *
 * Query types supported:
 * - "status" → task summary (counts by state)
 * - "progress #N" → detail for a specific task
 * - "cost" → cost status from safety layer
 */
export async function handleQuery(
  payload: CommMessageReceivedPayload,
  deps: QueryHandlerDeps,
): Promise<void> {
  const { taskEngine, safetyLayer, registry, logger } = deps;
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

  // Send response via communication plugins
  const commPlugins = registry.getPluginsByType<CommunicationAdapter>("communication");
  for (const comm of commPlugins) {
    try {
      await comm.sendMessage(
        { user_id: payload.sender, channel: null },
        {
          content: comm.formatMessage(response, "status_response"),
          metadata: { task_id: null, type: "status_response" },
        },
      );
    } catch (err) {
      logger.error({ err, pluginId: comm.manifest.id }, "Failed to send query response");
    }
  }
}

// ── Response Formatters ───────────────────────────────────────────────────

function formatStatusResponse(taskEngine: TaskEngine): string {
  const states: TaskState[] = [
    "intake",
    "queued",
    "active",
    "blocked",
    "review_pending",
    "completed",
    "failed",
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

function formatProgressResponse(taskEngine: TaskEngine, taskId: string): string {
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

function formatCostResponse(safetyLayer: SafetyLayer): string {
  const judgment = safetyLayer.consultJudgment({
    type: "cost_check",
    context: { task_id: "", repo: "", details: {} },
  });
  return `Cost check: ${judgment.allowed ? "within limits" : "limit reached"}${judgment.reason ? ` — ${judgment.reason}` : ""}`;
}
