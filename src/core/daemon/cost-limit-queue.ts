import { NotificationKinds } from "../../schemas/notifications.js";
import { TaskStates } from "../../schemas/task.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { DispatchTracker } from "../dispatch-tracker/index.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IObserver } from "../observer/index.js";
import type { NotificationRouter } from "./notification-router.js";

// ── CostLimitQueue Interface ────────────────────────────────────────────────

/** Queues cost-limit-breached tasks for deferred processing in the tick loop. */
export interface CostLimitQueue {
  /**
   * Register a task that breached a cost limit (called from the EventBus subscription). `ownerAlert`
   * controls whether the owner gets a per-task DM when this task is terminated: a task-attributed breach
   * (per-task or provider) sets it true; a task enqueued only because a global daily/monthly cap tripped
   * sets it false, because that breach fires its own single global alert instead of one DM per task.
   */
  add(taskId: string, ownerAlert: boolean): void;
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
  // Keyed by taskId so the same task enqueued twice in one tick (a per-task and a daily breach landing
  // together) terminates once and comments once. `ownerAlert` OR-combines: if any source for this task
  // wants the owner DM, it gets it. This dedup is what prevents the double ticket comment.
  const pending = new Map<string, { ownerAlert: boolean }>();

  function add(taskId: string, ownerAlert: boolean): void {
    const existing = pending.get(taskId);
    pending.set(taskId, { ownerAlert: (existing?.ownerAlert ?? false) || ownerAlert });
  }

  function process(): void {
    if (pending.size === 0) {
      return;
    }

    // Drain and clear in one pass.
    const batch = [...pending.entries()];
    pending.clear();
    // Each breached task is isolated: the batch was already drained from `pending`, so an unhandled throw
    // mid-loop would silently drop every task after it — and a runaway agent whose termination was dropped
    // keeps spending. Per-task try/catch keeps one failure from aborting the rest of the tick.
    for (const [taskId, { ownerAlert }] of batch) {
      try {
        terminateBreachedTask(taskId, ownerAlert);
      } catch (error) {
        observer.warn("Cost-limit termination failed — dropping this task's action, continuing the batch", {
          taskId,
          ownerAlert,
          err: sanitizeErrorMessage(error),
        });
      }
    }
  }

  function terminateBreachedTask(taskId: string, ownerAlert: boolean): void {
    const task = taskEngine.getTask(taskId);
    if (!task || task.state !== TaskStates.active) {
      return;
    }

    observer.recordDecision(
      "cost_limit_terminate",
      `Cost limit breached for active task ${taskId}`,
      [
        { id: "terminate_now", description: "Abort dispatch and notify owner immediately" },
        { id: "let_finish", description: "Let the current agent run finish before blocking" },
      ],
      "terminate_now",
      "Owner must hear about the limit before the next agent run accrues more spend",
      1,
      { task_id: taskId },
    );
    observer.warn("Task hit cost limit — terminating dispatch", { taskId, ownerAlert });

    // Termination is async via the dispatch-tracker — the scheduler's terminate
    // routing will transition the task to `blocked` when the in-flight dispatch
    // settles. But the owner must hear about the limit *now*, not whenever the
    // agent run eventually finishes, so notifications fire immediately.
    dispatchTracker.terminate(taskId, "cost_limit_reached");

    // The ticket comment is per-task and always fires (the source ticket should record why its task was
    // blocked). The owner DM fires only for a task-attributed breach — a global daily/monthly breach
    // sends one alert from the breach handler instead, so it does not DM the owner once per task here.
    if (ownerAlert) {
      notifications.notify({ kind: NotificationKinds.cost_limit, taskId });
    }
    notifications.notify({
      kind: NotificationKinds.ticket_comment,
      taskId,
      message: "Task blocked — cost limit reached.",
    });
  }

  return { add, process };
}
