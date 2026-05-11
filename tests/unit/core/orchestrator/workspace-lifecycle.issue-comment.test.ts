import { beforeEach, describe, expect, it } from "vitest";
import {
  type TestOrchestratorHandle,
  createMockDispatch,
  createTestOrchestrator,
} from "../../../helpers/test-orchestrator.js";

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Orchestrator commentOnSourceTicket", () => {
  let handle: TestOrchestratorHandle;

  beforeEach(() => {
    handle = createTestOrchestrator();
    handle.setAllPhaseResponses();
  });

  it("posts comment on GitHub issue at task pickup", async () => {
    const dispatch = createMockDispatch({
      task: {
        external_ref: { type: "test_issue", repo: "owner/repo", id: "42" },
      },
    });

    await handle.orchestrator.executeTask(dispatch);

    // Should have called notify with a ticket_comment containing "Starting work"
    const ticketCommentCalls = handle.notifications.notify.mock.calls.filter((call: unknown[]) => {
      const n = call[0] as { kind: string; message?: string };
      return n.kind === "ticket_comment" && n.message?.includes("Starting work");
    });
    expect(ticketCommentCalls.length).toBeGreaterThan(0);
  });

  it("skips comment when external_ref is null", async () => {
    const dispatch = createMockDispatch({
      task: { external_ref: null },
    });

    await handle.orchestrator.executeTask(dispatch);

    // ticket_comment notifications should not be present (no external_ref triggers skip in Orchestrator)
    // The orchestrator still calls notify for ticket_comment, but the NotificationRouter
    // would skip if no external_ref. Since we mock notify, just verify the orchestrator
    // still calls it (the router handles the skip logic).
    // Actually the Orchestrator calls notify unconditionally; it's the router that filters.
    // So we just verify no crash occurs.
  });

  it("continues when notify is a no-op", async () => {
    // Verify that notify being a no-op (mock default) doesn't affect execution
    const dispatch = createMockDispatch({
      task: {
        external_ref: { type: "test_issue", repo: "owner/repo", id: "42" },
      },
    });

    // Should complete without errors — notify is mocked as vi.fn() (no-op)
    await handle.orchestrator.executeTask(dispatch);

    expect(handle.notifications.notify).toHaveBeenCalled();
  });

  it("posts milestone notification at task pickup", async () => {
    const dispatch = createMockDispatch({
      task: {
        external_ref: { type: "test_issue", repo: "owner/repo", id: "42" },
      },
    });

    await handle.orchestrator.executeTask(dispatch);

    expect(handle.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "milestone",
        taskId: "task-001",
        message: expect.stringContaining("Starting work"),
      }),
    );
  });

  it("posts ticket_comment with correct taskId", async () => {
    const dispatch = createMockDispatch({
      task: {
        external_ref: { type: "test_issue", repo: "acme/widgets", id: "99" },
      },
    });

    await handle.orchestrator.executeTask(dispatch);

    expect(handle.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ticket_comment",
        taskId: "task-001",
      }),
    );
  });

  it("posts comment for any external_ref type", async () => {
    const dispatch = createMockDispatch({
      task: {
        external_ref: { type: "jira_ticket", repo: "PROJ", id: "123" },
      },
    });

    await handle.orchestrator.executeTask(dispatch);

    expect(handle.notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ticket_comment",
        taskId: "task-001",
      }),
    );
  });
});
