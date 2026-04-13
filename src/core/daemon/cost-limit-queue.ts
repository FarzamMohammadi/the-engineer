import { NotificationKinds } from "../../schemas/notifications.js";
import { TaskStates } from "../../schemas/task.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IObserver } from "../observer/index.js";
import type { NotificationRouter } from "./notification-router.js";

// ── CostLimitQueue Interface ────────────────────────────────────────────────

/** Queues cost-limit-breached tasks for deferred processing in the tick loop. */
export interface CostLimitQueue {
  /** Register a task that breached a cost limit (called from EventBus subscription). */
  add(taskId: string): void;
  /** Drain the queue: transition active tasks to blocked and notify. */
  process(): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createCostLimitQueue(
  taskEngine: ITaskEngine,
  notifications: NotificationRouter,
  observer: IObserver,
): CostLimitQueue {
  const pending: string[] = [];

  function add(taskId: string): void {
    pending.push(taskId);
  }

  function process(): void {
    if (pending.length === 0) {
      return;
    }

    // Drain and clear in one pass (FIFO order)
    const batch = pending.splice(0);
    for (const taskId of batch) {
      const task = taskEngine.getTask(taskId);
      if (task && task.state === TaskStates.active) {
        observer.warn("Task blocked due to cost limit", { taskId });
        const result = taskEngine.requestTransition(
          taskId,
          TaskStates.blocked,
          null,
          "cost_limit_reached",
          "daemon",
        );
        if (!result.success) {
          observer.warn("Cost limit transition failed — task may have already changed state", {
            taskId,
            reason: result.reason,
          });
        }
        notifications.notify({ kind: NotificationKinds.cost_limit, taskId });
        notifications.notify({
          kind: NotificationKinds.ticket_comment,
          taskId,
          message: "Task blocked \u2014 cost limit reached.",
        });
      }
    }
  }

  return { add, process };
}
