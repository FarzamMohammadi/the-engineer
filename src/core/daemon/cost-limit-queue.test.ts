import { describe, expect, it, vi } from "vitest";

import { createTestObserverFacade } from "../../../test/helpers/test-observer-facade.js";
import { createCostLimitQueue } from "./cost-limit-queue.js";
import type { NotificationRouter } from "./notification-router.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    title: "Test task",
    state: "active",
    sub_state: "working",
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

describe("CostLimitQueue", () => {
  it("transitions active task to blocked and sends notification", () => {
    const taskEngine = {
      getTask: vi.fn().mockReturnValue(makeTask({ id: "cost-1", state: "active" })),
      requestTransition: vi.fn().mockReturnValue({ success: true }),
    };
    const notifications = makeNotifications();
    const observer = createTestObserverFacade("daemon");

    const queue = createCostLimitQueue(
      taskEngine as unknown as Parameters<typeof createCostLimitQueue>[0],
      notifications,
      observer,
    );

    queue.add("cost-1");
    queue.process();

    expect(taskEngine.requestTransition).toHaveBeenCalledWith(
      "cost-1",
      "blocked",
      null,
      "cost_limit_reached",
      "daemon",
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cost_limit", taskId: "cost-1" }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ticket_comment",
        taskId: "cost-1",
        message: "Task blocked \u2014 cost limit reached.",
      }),
    );
  });

  it("drains the queue — subsequent process is a no-op", () => {
    const taskEngine = {
      getTask: vi.fn().mockReturnValue(makeTask({ id: "cost-2", state: "active" })),
      requestTransition: vi.fn().mockReturnValue({ success: true }),
    };
    const notifications = makeNotifications();
    const observer = createTestObserverFacade("daemon");

    const queue = createCostLimitQueue(
      taskEngine as unknown as Parameters<typeof createCostLimitQueue>[0],
      notifications,
      observer,
    );

    queue.add("cost-2");
    queue.process();
    expect(taskEngine.requestTransition).toHaveBeenCalledOnce();

    queue.process();
    expect(taskEngine.requestTransition).toHaveBeenCalledOnce();
  });

  it("skips non-active tasks in the queue", () => {
    const taskEngine = {
      getTask: vi.fn().mockReturnValue(makeTask({ id: "cost-3", state: "blocked" })),
      requestTransition: vi.fn(),
    };
    const notifications = makeNotifications();
    const observer = createTestObserverFacade("daemon");

    const queue = createCostLimitQueue(
      taskEngine as unknown as Parameters<typeof createCostLimitQueue>[0],
      notifications,
      observer,
    );

    queue.add("cost-3");
    queue.process();

    expect(taskEngine.requestTransition).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});
