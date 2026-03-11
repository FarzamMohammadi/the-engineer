import { describe, expect, it, vi } from "vitest";
import type { CommMessageReceivedPayload } from "../../schemas/events.js";
import { type QueryHandlerDeps, handleQuery } from "./query-handler.js";

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
    registry: {
      getPluginsByType: vi.fn().mockReturnValue([]),
    } as unknown as QueryHandlerDeps["registry"],
    logger: {
      error: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
    } as unknown as QueryHandlerDeps["logger"],
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
    (deps.taskEngine.getTasksByState as ReturnType<typeof vi.fn>).mockImplementation(
      (state: string) => {
        if (state === "active") {
          return [{ id: "1" }];
        }
        if (state === "queued") {
          return [{ id: "2" }, { id: "3" }];
        }
        return [];
      },
    );

    const mockComm = {
      manifest: { id: "github-comm" },
      hasCapability: vi.fn().mockReturnValue(true),
      sendMessage: vi.fn().mockResolvedValue({ success: true, message_id: "1", error: null }),
      formatMessage: vi.fn().mockImplementation((c: string) => c),
    };
    (deps.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([mockComm]);

    await handleQuery(payload("what's the status?"), deps);

    expect(mockComm.sendMessage).toHaveBeenCalledTimes(1);
    const sentContent = (mockComm.formatMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(sentContent).toContain("queued: 2");
    expect(sentContent).toContain("active: 1");
  });

  it("responds to 'progress #42' with task details", async () => {
    const deps = createMockDeps();
    (deps.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "42",
      title: "Fix login bug",
      state: "active",
      sub_state: "working",
      priority: 50,
      phase: "execution",
    });

    const mockComm = {
      manifest: { id: "github-comm" },
      sendMessage: vi.fn().mockResolvedValue({ success: true, message_id: "1", error: null }),
      formatMessage: vi.fn().mockImplementation((c: string) => c),
    };
    (deps.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([mockComm]);

    await handleQuery(payload("progress #42"), deps);

    const sentContent = (mockComm.formatMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(sentContent).toContain("Fix login bug");
    expect(sentContent).toContain("active");
    expect(sentContent).toContain("execution");
  });

  it("responds to 'cost' query with safety layer data", async () => {
    const deps = createMockDeps();
    const mockComm = {
      manifest: { id: "github-comm" },
      sendMessage: vi.fn().mockResolvedValue({ success: true, message_id: "1", error: null }),
      formatMessage: vi.fn().mockImplementation((c: string) => c),
    };
    (deps.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([mockComm]);

    await handleQuery(payload("how much cost?"), deps);

    const sentContent = (mockComm.formatMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(sentContent).toContain("within limits");
  });

  it("responds with help for unrecognized queries", async () => {
    const deps = createMockDeps();
    const mockComm = {
      manifest: { id: "github-comm" },
      sendMessage: vi.fn().mockResolvedValue({ success: true, message_id: "1", error: null }),
      formatMessage: vi.fn().mockImplementation((c: string) => c),
    };
    (deps.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([mockComm]);

    await handleQuery(payload("hello"), deps);

    const sentContent = (mockComm.formatMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(sentContent).toContain("didn't understand");
  });

  it("handles no comm plugins gracefully", async () => {
    const deps = createMockDeps();
    await expect(handleQuery(payload("status"), deps)).resolves.toBeUndefined();
  });

  it("logs error when sendMessage fails", async () => {
    const deps = createMockDeps();
    const mockComm = {
      manifest: { id: "github-comm" },
      sendMessage: vi.fn().mockRejectedValue(new Error("API down")),
      formatMessage: vi.fn().mockImplementation((c: string) => c),
    };
    (deps.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([mockComm]);

    await handleQuery(payload("status"), deps);

    expect(deps.logger.error).toHaveBeenCalled();
  });

  it("handles task not found for progress query", async () => {
    const deps = createMockDeps();
    (deps.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const mockComm = {
      manifest: { id: "github-comm" },
      sendMessage: vi.fn().mockResolvedValue({ success: true, message_id: "1", error: null }),
      formatMessage: vi.fn().mockImplementation((c: string) => c),
    };
    (deps.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([mockComm]);

    await handleQuery(payload("progress #999"), deps);

    const sentContent = (mockComm.formatMessage as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(sentContent).toContain("not found");
  });

  it("handles '#42 progress' format (reversed)", async () => {
    const deps = createMockDeps();
    (deps.taskEngine.getTask as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "42",
      title: "Test",
      state: "queued",
      sub_state: null,
      priority: 50,
      phase: null,
    });

    const mockComm = {
      manifest: { id: "github-comm" },
      sendMessage: vi.fn().mockResolvedValue({ success: true, message_id: "1", error: null }),
      formatMessage: vi.fn().mockImplementation((c: string) => c),
    };
    (deps.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([mockComm]);

    await handleQuery(payload("#42 progress"), deps);

    expect(deps.taskEngine.getTask).toHaveBeenCalledWith("42");
  });

  it("formats status_response message type", async () => {
    const deps = createMockDeps();
    const mockComm = {
      manifest: { id: "github-comm" },
      sendMessage: vi.fn().mockResolvedValue({ success: true, message_id: "1", error: null }),
      formatMessage: vi.fn().mockReturnValue("formatted"),
    };
    (deps.registry.getPluginsByType as ReturnType<typeof vi.fn>).mockReturnValue([mockComm]);

    await handleQuery(payload("status"), deps);

    expect(mockComm.formatMessage).toHaveBeenCalledWith(expect.any(String), "status_response");
  });
});
