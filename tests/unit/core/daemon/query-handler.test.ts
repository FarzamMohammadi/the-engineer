import { describe, expect, it, vi } from "vitest";
import { type QueryHandlerDeps, handleQuery } from "../../../../src/core/daemon/query-handler.js";
import type { CommMessageReceivedPayload } from "../../../../src/schemas/events.js";
import { NotificationKinds } from "../../../../src/schemas/notifications.js";
import { SubStates, TaskStates } from "../../../../src/schemas/task.js";

function createMockDeps(): QueryHandlerDeps {
  return {
    taskEngine: {
      getTasksByState: vi.fn().mockReturnValue([]),
      getTask: vi.fn().mockReturnValue(null),
    } as unknown as QueryHandlerDeps["taskEngine"],
    safetyLayer: {
      consultJudgment: vi.fn().mockReturnValue({
        allowed: true,
        action: "proceed",
        reason: "within daily limit",
      }),
    } as unknown as QueryHandlerDeps["safetyLayer"],
    notifications: {
      notify: vi.fn(),
      syncStateToCommPlugin: vi.fn(),
    } as unknown as QueryHandlerDeps["notifications"],
  };
}

function payload(content: string): CommMessageReceivedPayload {
  return {
    source: "github-comm",
    sender: "farzam",
    content,
    reply_to: null,
    task_id: null,
    platform_metadata: {},
  };
}

describe("handleQuery", () => {
  it("responds to 'status' query with task counts", async () => {
    const deps = createMockDeps();
    (deps.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockImplementation((state: string) => {
      if (state === TaskStates.active) {
        return [{ id: "1" }];
      }
      if (state === TaskStates.queued) {
        return [{ id: "2" }, { id: "3" }];
      }
      return [];
    });

    handleQuery(payload("what's the status?"), deps);

    expect(deps.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: NotificationKinds.status_response,
        personId: "farzam",
      }),
    );
    const notification = (deps.notifications.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      message: string;
    };
    expect(notification.message).toContain("queued: 2");
    expect(notification.message).toContain("active: 1");
  });

  it("responds to 'progress #42' with task details", () => {
    const deps = createMockDeps();
    (deps.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "42",
      title: "Fix login bug",
      state: TaskStates.active,
      sub_state: SubStates.working,
      priority: 50,
      phase: "execution",
    });

    handleQuery(payload("progress #42"), deps);

    const notification = (deps.notifications.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      message: string;
    };
    expect(notification.message).toContain("Fix login bug");
    expect(notification.message).toContain("active");
    expect(notification.message).toContain("execution");
  });

  it("responds to 'cost' query with safety layer data", () => {
    const deps = createMockDeps();

    handleQuery(payload("how much cost?"), deps);

    const notification = (deps.notifications.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      message: string;
    };
    expect(notification.message).toContain("within limits");
  });

  it("responds with help for unrecognized queries", () => {
    const deps = createMockDeps();

    handleQuery(payload("hello"), deps);

    const notification = (deps.notifications.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      message: string;
    };
    expect(notification.message).toContain("didn't understand");
  });

  it("calls notify even with no special conditions", () => {
    const deps = createMockDeps();
    handleQuery(payload("status"), deps);
    expect(deps.notifications.notify).toHaveBeenCalled();
  });

  it("handles task not found for progress query", () => {
    const deps = createMockDeps();
    (deps.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue(null);

    handleQuery(payload("progress #999"), deps);

    const notification = (deps.notifications.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      message: string;
    };
    expect(notification.message).toContain("not found");
  });

  it("handles '#42 progress' format (reversed)", () => {
    const deps = createMockDeps();
    (deps.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "42",
      title: "Test",
      state: TaskStates.queued,
      sub_state: null,
      priority: 50,
      phase: null,
    });

    handleQuery(payload("#42 progress"), deps);

    expect(deps.taskEngine.getTask).toHaveBeenCalledWith("42");
  });

  it("sends status_response notification kind", () => {
    const deps = createMockDeps();

    handleQuery(payload("status"), deps);

    expect(deps.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({ kind: NotificationKinds.status_response }),
    );
  });
});
