import { NotificationKinds } from "../../schemas/notifications.js";
import { TaskStates } from "../../schemas/task.js";
import type { DispatchTracker } from "../dispatch-tracker/index.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IObserver } from "../observer/index.js";
import type { NotificationRouter } from "./notification-router.js";

// ── CostLimitQueue Interface ────────────────────────────────────────────────

/** Queues cost-limit-breached tasks for deferred processing in the tick loop. */
export interface CostLimitQueue {
  /** Register a task that breached a cost limit (called from EventBus subscription). */
  add(taskId: string): void;
  /** Drain the queue: terminate in-flight dispatches and notify the owner immediately. */
  process(): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createCostLimitQueue(
  taskEngine: ITaskEngine,
  notifications: NotificationRouter,
  dispatchTracker: DispatchTracker,
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
      if (!task || task.state !== TaskStates.active) {
        continue;
      }

      observer.warn("Task hit cost limit — terminating dispatch", { taskId });

      // Termination is async via the dispatch-tracker — the scheduler's terminate
      // routing will transition the task to `blocked` when the in-flight dispatch
      // settles. But the owner must hear about the limit *now*, not whenever the
      // LLM call eventually finishes, so notifications fire immediately.
      dispatchTracker.terminate(taskId, "cost_limit_reached");
      notifications.notify({ kind: NotificationKinds.cost_limit, taskId });
      notifications.notify({
        kind: NotificationKinds.ticket_comment,
        taskId,
        message: "Task blocked — cost limit reached.",
      });
    }
  }

  return { add, process };
}
