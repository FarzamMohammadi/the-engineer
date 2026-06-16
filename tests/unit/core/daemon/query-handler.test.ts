import { describe, expect, it, vi } from "vitest";
import {
  type QueryHandlerDeps,
  classifyQuery,
  handleQuery,
  isQueryVocabulary,
} from "../../../../src/core/daemon/query-handler.js";
import type { CommMessageReceivedPayload } from "../../../../src/schemas/events.js";
import { NotificationKinds } from "../../../../src/schemas/notifications.js";
import { SubStates, TaskStates } from "../../../../src/schemas/task.js";
import { createTestObserverFacade } from "../../../helpers/test-observer-facade.js";

const OWNER = { id: "owner-1", role: "owner", contacts: [] };

function createMockDeps(): QueryHandlerDeps {
  return {
    taskEngine: {
      getTasksByState: vi.fn().mockReturnValue([]),
    } as unknown as QueryHandlerDeps["taskEngine"],
    safetyLayer: {
      consultJudgment: vi.fn().mockReturnValue({
        allowed: true,
        action: "proceed",
        reason: "cost within limits",
      }),
    } as unknown as QueryHandlerDeps["safetyLayer"],
    notifications: {
      notify: vi.fn(),
      syncStateToCommPlugin: vi.fn(),
    } as unknown as QueryHandlerDeps["notifications"],
    peopleDirectory: {
      getOwner: vi.fn().mockReturnValue(OWNER),
    } as unknown as QueryHandlerDeps["peopleDirectory"],
    observer: createTestObserverFacade("daemon"),
  };
}

function payload(content: string): CommMessageReceivedPayload {
  return {
    source: "telegram",
    sender: "farzam",
    content,
    reply_to: null,
    task_id: null,
    platform_metadata: {},
  };
}

function lastNotification(deps: QueryHandlerDeps): { message: string; personId: string; kind: string } {
  return (deps.notifications.notify as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
    message: string;
    personId: string;
    kind: string;
  };
}

describe("classifyQuery", () => {
  it("classifies the supported forms and rejects free text", () => {
    expect(classifyQuery("what's the status?")).toBe("status");
    expect(classifyQuery("how much cost so far")).toBe("cost");
    expect(classifyQuery("progress #42")).toBe("progress");
    expect(classifyQuery("#42 progress")).toBe("progress");
    expect(classifyQuery("progress #PROJ-123")).toBe("progress");
    expect(classifyQuery("PROGRESS #ENG-512")).toBe("progress");
    expect(classifyQuery("help")).toBe("help");
    expect(classifyQuery("looks good, go ahead")).toBe("unknown");
  });
});

describe("isQueryVocabulary", () => {
  it("is true for any supported form and false for free text", () => {
    expect(isQueryVocabulary("status")).toBe(true);
    expect(isQueryVocabulary("cost")).toBe(true);
    expect(isQueryVocabulary("progress #1")).toBe(true);
    expect(isQueryVocabulary("help")).toBe(true);
    expect(isQueryVocabulary("use the second option")).toBe(false);
  });
});

describe("handleQuery", () => {
  it("enumerates active and blocked tasks with ids, titles, and block reason for 'status'", () => {
    const deps = createMockDeps();
    (deps.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockImplementation((state: string) => {
      if (state === TaskStates.active) {
        return [{ id: "01ACTIVE0000000000000000AA", title: "Add login" }];
      }
      if (state === TaskStates.blocked) {
        return [{ id: "01BLOCKED000000000000000BB", title: "Refactor auth", blocked: { reason: "needs_more_info" } }];
      }
      if (state === TaskStates.queued) {
        return [{ id: "q1" }, { id: "q2" }];
      }
      return [];
    });

    handleQuery(payload("status"), deps);

    const notification = lastNotification(deps);
    expect(notification.message).toContain("01ACTIVE");
    expect(notification.message).toContain("Add login");
    expect(notification.message).toContain("01BLOCKE");
    expect(notification.message).toContain("Refactor auth");
    expect(notification.message).toContain("needs_more_info");
    expect(notification.message).toContain("queued: 2");
  });

  it("resolves the response recipient to the owner, not the raw sender handle", () => {
    const deps = createMockDeps();

    handleQuery(payload("status"), deps);

    const notification = lastNotification(deps);
    expect(notification.kind).toBe(NotificationKinds.status_response);
    expect(notification.personId).toBe("owner-1");
  });

  it("does not reply when no owner is configured", () => {
    const deps = createMockDeps();
    (deps.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue(null);

    handleQuery(payload("status"), deps);

    expect(deps.notifications.notify).not.toHaveBeenCalled();
  });

  it("returns task detail for 'progress #42', matching the issue number on external_ref", () => {
    const deps = createMockDeps();
    (deps.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockImplementation((state: string) => {
      if (state === TaskStates.active) {
        return [
          {
            id: "01J0000000000000000000ABCD",
            external_ref: { type: "issue", repo: "owner/repo", id: "42" },
            title: "Fix login bug",
            state: TaskStates.active,
            sub_state: SubStates.working,
            priority: 50,
            phase: "execution",
          },
        ];
      }
      return [];
    });

    handleQuery(payload("progress #42"), deps);

    const notification = lastNotification(deps);
    expect(notification.message).toContain("Issue #42");
    expect(notification.message).toContain("Fix login bug");
    expect(notification.message).toContain("active");
    expect(notification.message).toContain("execution");
  });

  it("matches a non-numeric tracker key like 'progress #PROJ-123', case-insensitively", () => {
    const deps = createMockDeps();
    (deps.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockImplementation((state: string) => {
      if (state === TaskStates.active) {
        return [
          {
            id: "01J0000000000000000000ABCD",
            external_ref: { type: "jira_issue", repo: "acme/app", id: "PROJ-123" },
            title: "Fix login bug",
            state: TaskStates.active,
            sub_state: SubStates.working,
            priority: 50,
            phase: "execution",
          },
        ];
      }
      return [];
    });

    // Lowercase input against an uppercase Jira key — proves both non-numeric ids and a case-insensitive match.
    handleQuery(payload("progress #proj-123"), deps);

    const notification = lastNotification(deps);
    expect(notification.message).toContain("Fix login bug");
    expect(notification.message).toContain("execution");
  });

  it("surfaces the cost verdict and any percent-of-limit warnings for 'cost'", () => {
    const deps = createMockDeps();
    (deps.safetyLayer.consultJudgment as ReturnType<typeof vi.fn>).mockReturnValue({
      allowed: true,
      action: "proceed",
      reason: "cost within limits",
      warnings: ["daily spend at 85% of limit"],
    });

    handleQuery(payload("cost"), deps);

    const notification = lastNotification(deps);
    expect(notification.message).toContain("within limits");
    expect(notification.message).toContain("85% of limit");
  });

  it("enumerates the supported forms for 'help'", () => {
    const deps = createMockDeps();

    handleQuery(payload("help"), deps);

    const notification = lastNotification(deps);
    expect(notification.message).toContain("status");
    expect(notification.message).toContain("progress #N");
    expect(notification.message).toContain("cost");
  });

  it("falls back to help for unrecognized content with no multi-blocked context", () => {
    const deps = createMockDeps();

    handleQuery(payload("hello there"), deps, { reason: "no_blocked_task" });

    const notification = lastNotification(deps);
    expect(notification.message).toContain("didn't understand");
  });

  it("emits a couldn't-match notice naming the blocked count when 2+ tasks are blocked", () => {
    const deps = createMockDeps();

    handleQuery(payload("yes go ahead"), deps, { reason: "unmatched_multi_blocked", blockedCount: 3 });

    const notification = lastNotification(deps);
    expect(notification.message).toContain("couldn't match");
    expect(notification.message).toContain("3");
  });

  it("handles task not found for a progress query", () => {
    const deps = createMockDeps();
    (deps.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockReturnValue([]);

    handleQuery(payload("progress #999"), deps);

    const notification = lastNotification(deps);
    expect(notification.message).toContain("not found");
  });
});
