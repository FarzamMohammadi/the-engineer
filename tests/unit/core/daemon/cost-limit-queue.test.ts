import { describe, expect, it, vi } from "vitest";

import { createCostLimitQueue } from "../../../../src/core/daemon/cost-limit-queue.js";
import type { NotificationRouter } from "../../../../src/core/daemon/notification-router.js";
import type { DispatchTracker } from "../../../../src/core/dispatch-tracker/index.js";
import { NotificationKinds } from "../../../../src/schemas/notifications.js";
import { SubStates, TaskStates } from "../../../../src/schemas/task.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Test task",
    state: TaskStates.active,
    sub_state: SubStates.working,
    priority: 50,
    started_at: new Date(1_000_000).toISOString(),
    last_transition_at: new Date(1_000_000).toISOString(),
    created_at: new Date(0).toISOString(),
    updated_at: new Date(1_000_000).toISOString(),
    ...overrides,
  };
}

function makeNotifications(): NotificationRouter {
  return {
    notify: vi.fn(),
    syncStateToCommPlugin: vi.fn(),
  };
}

function makeDispatchTracker(): DispatchTracker {
  return {
    register: vi.fn(),
    terminate: vi.fn(),
    isInFlight: vi.fn().mockReturnValue(true),
    getActiveCount: vi.fn().mockReturnValue(0),
    getActiveTaskIds: vi.fn().mockReturnValue([]),
    drain: vi.fn().mockResolvedValue(undefined),
  };
}

/** Count how many of the router's notify() calls carried the given kind. */
function countNotifyByKind(notifications: NotificationRouter, kind: string): number {
  return (notifications.notify as ReturnType<typeof vi.fn>).mock.calls.filter(
    (call) => (call[0] as { kind: string }).kind === kind,
  ).length;
}

describe("CostLimitQueue", () => {
  it("terminates the in-flight dispatch with reason cost_limit_reached and notifies the owner immediately", () => {
    const taskEngine = {
      getTask: vi.fn().mockReturnValue(makeTask({ id: "cost-1", state: TaskStates.active })),
      requestTransition: vi.fn(),
    };
    const notifications = makeNotifications();
    const dispatchTracker = makeDispatchTracker();
    const observer = createTestObserverFacade("daemon");

    const queue = createCostLimitQueue(
      taskEngine as unknown as Parameters<typeof createCostLimitQueue>[0],
      notifications,
      dispatchTracker,
      observer,
    );

    queue.add("cost-1", true);
    queue.process();

    // Termination goes through the dispatch-tracker — scheduler routes the eventual
    // settle to `blocked` via the terminate routing.
    expect(dispatchTracker.terminate).toHaveBeenCalledWith("cost-1", "cost_limit_reached");
    // No direct state transition from cost-limit-queue anymore.
    expect(taskEngine.requestTransition).not.toHaveBeenCalled();
    // A task-attributed breach (ownerAlert=true) fires the owner DM immediately — owner gets the signal
    // *now*, not when the in-flight LLM call eventually settles.
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NotificationKinds.cost_limit, taskId: "cost-1" }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: NotificationKinds.ticket_comment,
        taskId: "cost-1",
        message: "Task blocked — cost limit reached.",
      }),
    );
  });

  it("drains the queue — subsequent process is a no-op", () => {
    const taskEngine = {
      getTask: vi.fn().mockReturnValue(makeTask({ id: "cost-2", state: TaskStates.active })),
      requestTransition: vi.fn(),
    };
    const notifications = makeNotifications();
    const dispatchTracker = makeDispatchTracker();
    const observer = createTestObserverFacade("daemon");

    const queue = createCostLimitQueue(
      taskEngine as unknown as Parameters<typeof createCostLimitQueue>[0],
      notifications,
      dispatchTracker,
      observer,
    );

    queue.add("cost-2", true);
    queue.process();
    expect(dispatchTracker.terminate).toHaveBeenCalledOnce();

    queue.process();
    expect(dispatchTracker.terminate).toHaveBeenCalledOnce();
  });

  it("skips non-active tasks in the queue", () => {
    const taskEngine = {
      getTask: vi.fn().mockReturnValue(makeTask({ id: "cost-3", state: TaskStates.blocked })),
      requestTransition: vi.fn(),
    };
    const notifications = makeNotifications();
    const dispatchTracker = makeDispatchTracker();
    const observer = createTestObserverFacade("daemon");

    const queue = createCostLimitQueue(
      taskEngine as unknown as Parameters<typeof createCostLimitQueue>[0],
      notifications,
      dispatchTracker,
      observer,
    );

    queue.add("cost-3", true);
    queue.process();

    expect(dispatchTracker.terminate).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("terminates every task enqueued for a global breach without DMing the owner per task", () => {
    // Models a daily/monthly breach at max_concurrent>1: the daemon enqueues every in-flight dispatch with
    // ownerAlert=false (the single global alert is fired by the breach handler, not here). The queue must
    // terminate all N but send NO cost_limit owner DMs — only the per-ticket comments.
    const tasksById: Record<string, ReturnType<typeof makeTask>> = {
      "g-1": makeTask({ id: "g-1", state: TaskStates.active }),
      "g-2": makeTask({ id: "g-2", state: TaskStates.active }),
      "g-3": makeTask({ id: "g-3", state: TaskStates.active }),
    };
    const taskEngine = {
      getTask: vi.fn((id: string) => tasksById[id]),
      requestTransition: vi.fn(),
    };
    const notifications = makeNotifications();
    const dispatchTracker = makeDispatchTracker();
    const observer = createTestObserverFacade("daemon");

    const queue = createCostLimitQueue(
      taskEngine as unknown as Parameters<typeof createCostLimitQueue>[0],
      notifications,
      dispatchTracker,
      observer,
    );

    queue.add("g-1", false);
    queue.add("g-2", false);
    queue.add("g-3", false);
    queue.process();

    // All three in-flight dispatches are terminated.
    expect(dispatchTracker.terminate).toHaveBeenCalledTimes(3);
    expect(dispatchTracker.terminate).toHaveBeenCalledWith("g-1", "cost_limit_reached");
    expect(dispatchTracker.terminate).toHaveBeenCalledWith("g-2", "cost_limit_reached");
    expect(dispatchTracker.terminate).toHaveBeenCalledWith("g-3", "cost_limit_reached");
    // ZERO owner DMs from the queue — the one global alert is the breach handler's job, not N here.
    expect(countNotifyByKind(notifications, NotificationKinds.cost_limit)).toBe(0);
    // One ticket comment per task (the source ticket records why each task was blocked).
    expect(countNotifyByKind(notifications, NotificationKinds.ticket_comment)).toBe(3);
  });

  it("isolates a failing task so the rest of the batch still terminates", () => {
    // One runaway task's termination throws (e.g. the dispatch-tracker errors). Because the batch was
    // already drained from `pending`, an unguarded throw would silently drop every task queued after it —
    // and a runaway agent whose termination was dropped keeps spending. Per-task isolation must keep the
    // throw from aborting the tick: the surviving tasks still terminate, and the failure is warned.
    const tasksById: Record<string, ReturnType<typeof makeTask>> = {
      "f-1": makeTask({ id: "f-1", state: TaskStates.active }),
      "f-2": makeTask({ id: "f-2", state: TaskStates.active }),
    };
    const taskEngine = {
      getTask: vi.fn((id: string) => tasksById[id]),
      requestTransition: vi.fn(),
    };
    const notifications = makeNotifications();
    const dispatchTracker = makeDispatchTracker();
    (dispatchTracker.terminate as ReturnType<typeof vi.fn>).mockImplementation((id: string) => {
      if (id === "f-1") {
        throw new Error("dispatch-tracker boom");
      }
    });
    const observer = createTestObserverFacade("daemon");
    const warnSpy = vi.spyOn(observer, "warn");

    const queue = createCostLimitQueue(
      taskEngine as unknown as Parameters<typeof createCostLimitQueue>[0],
      notifications,
      dispatchTracker,
      observer,
    );

    queue.add("f-1", true);
    queue.add("f-2", true);
    queue.process();

    // The throwing task did not abort the tick — the surviving task still terminated.
    expect(dispatchTracker.terminate).toHaveBeenCalledWith("f-2", "cost_limit_reached");
    // The failure is warned, naming the dropped task — not swallowed silently.
    const warnedFailure = warnSpy.mock.calls.some(
      (call) =>
        String(call[0]).includes("Cost-limit termination failed") && (call[1] as { taskId?: string })?.taskId === "f-1",
    );
    expect(warnedFailure).toBe(true);
  });

  it("comments once when a task is enqueued by both a per-task and a global breach in one tick", () => {
    // A same-tick per-task breach (ownerAlert=true) and a global daily breach (ownerAlert=false) both
    // enqueue the same task. The Map dedups by taskId, so the task terminates once and its ticket is
    // commented once — never the duplicate comment the old array-backed queue produced.
    const taskEngine = {
      getTask: vi.fn().mockReturnValue(makeTask({ id: "dup-1", state: TaskStates.active })),
      requestTransition: vi.fn(),
    };
    const notifications = makeNotifications();
    const dispatchTracker = makeDispatchTracker();
    const observer = createTestObserverFacade("daemon");

    const queue = createCostLimitQueue(
      taskEngine as unknown as Parameters<typeof createCostLimitQueue>[0],
      notifications,
      dispatchTracker,
      observer,
    );

    queue.add("dup-1", true);
    queue.add("dup-1", false);
    queue.process();

    // Terminated once, not twice.
    expect(dispatchTracker.terminate).toHaveBeenCalledOnce();
    // Exactly ONE ticket comment for the task — no double comment.
    expect(countNotifyByKind(notifications, NotificationKinds.ticket_comment)).toBe(1);
    // ownerAlert OR-combines to true, so the per-task owner DM still fires once.
    expect(countNotifyByKind(notifications, NotificationKinds.cost_limit)).toBe(1);
  });
});
