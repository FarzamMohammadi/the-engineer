import { describe, expect, it, vi } from "vitest";
import {
  type QueryHandlerDeps,
  classifyQuery,
  handleQuery,
  isCommand,
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
      getCostSummary: vi.fn().mockReturnValue({
        daily_usd: 0,
        daily_limit_usd: null,
        monthly_usd: 0,
        monthly_limit_usd: null,
        breached: false,
        warnings: [],
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
  it("classifies the prefixed command forms", () => {
    expect(classifyQuery("!status")).toBe("status");
    expect(classifyQuery("!cost")).toBe("cost");
    expect(classifyQuery("!progress #42")).toBe("progress");
    // The id after `#` is an opaque tracker ref — non-numeric and case-insensitive (Jira, Linear).
    expect(classifyQuery("!progress #PROJ-123")).toBe("progress");
    expect(classifyQuery("!PROGRESS #ENG-512")).toBe("progress");
    // Bare `!progress` (no `#N`) is still a command — it lists the tasks to choose from.
    expect(classifyQuery("!progress")).toBe("progress");
    expect(classifyQuery("!help")).toBe("help");
  });

  it("tolerates surrounding whitespace and casing on a command", () => {
    expect(classifyQuery("  !STATUS ")).toBe("status");
    expect(classifyQuery("!status please")).toBe("status");
    expect(classifyQuery("!help me with status")).toBe("help");
  });

  it("treats a command word in free text as not a command (the incident)", () => {
    // The reported incident: prose merely containing "help" must never classify as the help command.
    expect(classifyQuery("the desc should help capture why the changes are proposed")).toBe("unknown");
    expect(classifyQuery("what's the status?")).toBe("unknown");
    expect(classifyQuery("how much cost so far")).toBe("unknown");
    expect(classifyQuery("looks good, go ahead")).toBe("unknown");
  });

  it("requires the prefix — a bare command word is not a command", () => {
    expect(classifyQuery("status")).toBe("unknown");
    expect(classifyQuery("cost")).toBe("unknown");
    expect(classifyQuery("help")).toBe("unknown");
    expect(classifyQuery("progress #42")).toBe("unknown");
    expect(classifyQuery("#42 progress")).toBe("unknown");
  });

  it("requires a known keyword as a whole token immediately after the prefix", () => {
    expect(classifyQuery("!helpme")).toBe("unknown");
    expect(classifyQuery("!statuses")).toBe("unknown");
    expect(classifyQuery("!foo")).toBe("unknown");
    expect(classifyQuery("! status")).toBe("unknown");
  });
});

describe("isCommand", () => {
  it("is true for any prefixed command form", () => {
    expect(isCommand("!status")).toBe(true);
    expect(isCommand("!cost")).toBe(true);
    expect(isCommand("!progress #1")).toBe(true);
    expect(isCommand("!help")).toBe(true);
  });

  it("is false for free text and prefix-without-known-keyword", () => {
    expect(isCommand("use the second option")).toBe(false);
    expect(isCommand("the desc should help capture why")).toBe(false);
    expect(isCommand("!foo")).toBe(false);
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

    handleQuery(payload("!status"), deps);

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

    handleQuery(payload("!status"), deps);

    const notification = lastNotification(deps);
    expect(notification.kind).toBe(NotificationKinds.status_response);
    expect(notification.personId).toBe("owner-1");
  });

  it("does not reply when no owner is configured", () => {
    const deps = createMockDeps();
    (deps.peopleDirectory.getOwner as ReturnType<typeof vi.fn>).mockReturnValue(null);

    handleQuery(payload("!status"), deps);

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

    handleQuery(payload("!progress #42"), deps);

    const notification = lastNotification(deps);
    expect(notification.message).toContain("Issue #42");
    expect(notification.message).toContain("Fix login bug");
    expect(notification.message).toContain("active");
    expect(notification.message).toContain("execution");
  });

  it("lists active and blocked tasks with their issue numbers for bare '!progress'", () => {
    const deps = createMockDeps();
    (deps.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockImplementation((state: string) => {
      if (state === TaskStates.active) {
        return [
          {
            id: "01ACTIVE0000000000000000AA",
            external_ref: { type: "issue", repo: "owner/repo", id: "42" },
            title: "Fix login bug",
            state: TaskStates.active,
          },
        ];
      }
      if (state === TaskStates.blocked) {
        return [
          {
            id: "01BLOCKED000000000000000BB",
            external_ref: { type: "issue", repo: "owner/repo", id: "25" },
            title: "Require an explicit prefix",
            state: TaskStates.blocked,
          },
        ];
      }
      return [];
    });

    handleQuery(payload("!progress"), deps);

    const notification = lastNotification(deps);
    // The menu surfaces the issue number — the one place the owner can discover what to pass to !progress #N.
    expect(notification.message).toContain("#42: Fix login bug");
    expect(notification.message).toContain("#25: Require an explicit prefix");
    expect(notification.message).toContain("!progress #N");
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
    handleQuery(payload("!progress #proj-123"), deps);

    const notification = lastNotification(deps);
    expect(notification.message).toContain("Fix login bug");
    expect(notification.message).toContain("execution");
  });

  it("surfaces account-wide spend, limits, and percent-of-limit warnings for 'cost'", () => {
    const deps = createMockDeps();
    (deps.safetyLayer.getCostSummary as ReturnType<typeof vi.fn>).mockReturnValue({
      daily_usd: 3.2,
      daily_limit_usd: 25,
      monthly_usd: 48,
      monthly_limit_usd: 250,
      breached: false,
      warnings: ["daily spend at 85% of limit"],
    });

    handleQuery(payload("!cost"), deps);

    const notification = lastNotification(deps);
    expect(notification.message).toContain("within limits");
    expect(notification.message).toContain("$3.20 / $25.00");
    expect(notification.message).toContain("$48.00 / $250.00");
    expect(notification.message).toContain("85% of limit");
    expect(notification.message).toContain("midnight UTC");
  });

  it("reports limit reached and unbounded windows for 'cost'", () => {
    const deps = createMockDeps();
    (deps.safetyLayer.getCostSummary as ReturnType<typeof vi.fn>).mockReturnValue({
      daily_usd: 30,
      daily_limit_usd: 25,
      monthly_usd: 30,
      monthly_limit_usd: null,
      breached: true,
      warnings: [],
    });

    handleQuery(payload("!cost"), deps);

    const notification = lastNotification(deps);
    expect(notification.message).toContain("limit reached");
    expect(notification.message).toContain("$30.00 / $25.00");
    expect(notification.message).toContain("$30.00 (no limit set)");
  });

  it("enumerates the prefixed command forms for '!help'", () => {
    const deps = createMockDeps();

    handleQuery(payload("!help"), deps);

    const notification = lastNotification(deps);
    expect(notification.message).toContain("!status");
    expect(notification.message).toContain("!progress #N");
    expect(notification.message).toContain("!cost");
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

    handleQuery(payload("!progress #999"), deps);

    const notification = lastNotification(deps);
    expect(notification.message).toContain("not found");
  });
});
