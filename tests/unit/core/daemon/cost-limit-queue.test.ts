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

    queue.add("cost-1");
    queue.process();

    // Termination goes through the dispatch-tracker — scheduler routes the eventual
    // settle to `blocked` via the terminate routing.
    expect(dispatchTracker.terminate).toHaveBeenCalledWith("cost-1", "cost_limit_reached");
    // No direct state transition from cost-limit-queue anymore.
    expect(taskEngine.requestTransition).not.toHaveBeenCalled();
    // Notifications fire immediately — owner gets the signal *now*, not when the
    // in-flight LLM call eventually settles.
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

    queue.add("cost-2");
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

    queue.add("cost-3");
    queue.process();

    expect(dispatchTracker.terminate).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
