import { describe, expect, it } from "vitest";

import { BaseAdapter } from "../../../src/adapters/base.js";
import { CommunicationAdapter } from "../../../src/adapters/communication.js";
import { AdapterMethodError, createAdapterError } from "../../../src/adapters/errors.js";
import type {
  FormattedMessage,
  HealthStatus,
  InitResult,
  MessageType,
  PluginManifest,
  ReconciliationResult,
  SendResult,
  SyncMetadata,
  Target,
  TaskReconciliationInput,
  TicketOptions,
  TicketResult,
} from "../../../src/schemas/adapters.js";
import { MessageTypes } from "../../../src/schemas/adapters.js";
import { TaskStates } from "../../../src/schemas/task.js";

/** Minimal concrete implementation — only required methods. */
class MinimalCommAdapter extends CommunicationAdapter {
  lastTarget: Target | null = null;
  lastMessage: FormattedMessage | null = null;
  sendError: Error | null = null;

  protected doSendMessage(target: Target, message: FormattedMessage): Promise<SendResult> {
    if (this.sendError) {
      return Promise.reject(this.sendError);
    }
    this.lastTarget = target;
    this.lastMessage = message;
    return Promise.resolve({ success: true, message_id: "msg-123", error: null });
  }

  formatMessage(content: string, _type: MessageType): string {
    return `[formatted] ${content}`;
  }

  protected doInitialize(_config: Record<string, unknown>): Promise<InitResult> {
    return Promise.resolve({ success: true, message: null });
  }

  protected doShutdown(): Promise<void> {
    // No-op for test double
    return Promise.resolve();
  }

  protected doHealthCheck(): Promise<HealthStatus> {
    return Promise.resolve({ healthy: true, message: null, details: null });
  }
}

/** Full-capability implementation that overrides all optional methods. */
class FullCommAdapter extends MinimalCommAdapter {
  listening = false;
  syncCalls: Array<{ taskId: string; oldState: string; newState: string }> = [];
  reconcileCalls: TaskReconciliationInput[][] = [];
  issueCalls: Array<{ method: string; repo: string }> = [];

  protected override doStartListening(): Promise<void> {
    this.listening = true;
    return Promise.resolve();
  }

  protected override doStopListening(): Promise<void> {
    this.listening = false;
    return Promise.resolve();
  }

  protected override doSyncTaskState(
    taskId: string,
    oldState: string,
    newState: string,
    _metadata: SyncMetadata,
  ): Promise<void> {
    this.syncCalls.push({ taskId, oldState, newState });
    return Promise.resolve();
  }

  protected override doReconcileState(tasks: TaskReconciliationInput[]): Promise<ReconciliationResult> {
    this.reconcileCalls.push(tasks);
    return Promise.resolve({ reconciled: tasks.length, errors: [] });
  }

  protected override doCommentOnTicket(
    _externalRef: { type: string; repo: string; id: string },
    _comment: string,
  ): Promise<void> {
    this.issueCalls.push({ method: "commentOnTicket", repo: _externalRef.repo });
    return Promise.resolve();
  }

  protected override doCreateTicket(repo: string, _options: TicketOptions): Promise<TicketResult> {
    this.issueCalls.push({ method: "createTicket", repo });
    return Promise.resolve({ id: "42", url: "https://github.com/test/repo/issues/42" });
  }

  protected override doUpdateTicket(repo: string, _ticketId: string, _updates: unknown): Promise<void> {
    this.issueCalls.push({ method: "updateTicket", repo });
    return Promise.resolve();
  }
}

function createManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    id: "test-comm",
    type: "communication",
    version: "1.0.0",
    name: "Test Communication",
    description: "A test comm plugin",
    config_schema: {},
    critical: true,
    entry: "index.ts",
    adapter_meta: { capabilities: ["send"] },
    requirements: [],
    combined_with: [],
    contributes: { events: [], commands: [], config_keys: [], hooks: [] },
    startup_hints: [],
    ...overrides,
  };
}

describe("CommunicationAdapter", () => {
  it("extends BaseAdapter", () => {
    const adapter = new MinimalCommAdapter();
    expect(adapter).toBeInstanceOf(BaseAdapter);
    expect(adapter).toBeInstanceOf(CommunicationAdapter);
  });

  describe("sendMessage (required, template-wrapped)", () => {
    it("delegates to doSendMessage and returns result", async () => {
      const adapter = new MinimalCommAdapter();
      adapter.manifest = createManifest();
      const target: Target = { user_id: "farzam", channel: null };
      const message: FormattedMessage = {
        content: "Hello",
        metadata: { task_id: null, type: MessageTypes.notification },
      };
      const result = await adapter.sendMessage(target, message);
      expect(result.success).toBe(true);
      expect(adapter.lastTarget).toBe(target);
      expect(adapter.lastMessage).toBe(message);
    });

    it("wraps unknown errors as AdapterMethodError", async () => {
      const adapter = new MinimalCommAdapter();
      adapter.manifest = createManifest();
      adapter.sendError = new Error("Network failure");
      const target: Target = { user_id: "farzam", channel: null };
      const message: FormattedMessage = {
        content: "Hello",
        metadata: { task_id: null, type: MessageTypes.notification },
      };

      try {
        await adapter.sendMessage(target, message);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterMethodError);
        if (error instanceof AdapterMethodError) {
          expect(error.adapterError.code).toBe("internal_error");
        }
      }
    });

    it("rethrows AdapterMethodError from plugin as-is", async () => {
      const adapter = new MinimalCommAdapter();
      adapter.manifest = createManifest();
      const structured = createAdapterError("rate_limited", "Slow down", { retryable: true });
      adapter.sendError = new AdapterMethodError(structured);
      const target: Target = { user_id: "farzam", channel: null };
      const message: FormattedMessage = {
        content: "Hello",
        metadata: { task_id: null, type: MessageTypes.notification },
      };

      try {
        await adapter.sendMessage(target, message);
        expect.unreachable("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterMethodError);
        if (error instanceof AdapterMethodError) {
          expect(error.adapterError.code).toBe("rate_limited");
        }
      }
    });
  });

  describe("formatMessage (required, sync, no wrapping)", () => {
    it("calls subclass implementation directly", () => {
      const adapter = new MinimalCommAdapter();
      adapter.manifest = createManifest();
      expect(adapter.formatMessage("Hello", MessageTypes.notification)).toBe("[formatted] Hello");
    });
  });

  describe("optional methods — default throw when not overridden", () => {
    const optionalMethods: Array<{
      name: string;
      capability: string;
      call: (adapter: MinimalCommAdapter) => Promise<unknown>;
    }> = [
      {
        name: "startListening",
        capability: "receive",
        call: (a) => a.startListening(),
      },
      {
        name: "stopListening",
        capability: "receive",
        call: (a) => a.stopListening(),
      },
      {
        name: "syncTaskState",
        capability: "sync",
        call: (a) =>
          a.syncTaskState("task-1", TaskStates.queued, TaskStates.active, {
            task_title: "Test",
            external_ref: null,
            sub_state: null,
            reason: null,
          }),
      },
      {
        name: "reconcileState",
        capability: "sync",
        call: (a) => a.reconcileState([]),
      },
      {
        name: "commentOnTicket",
        capability: "ticket_management",
        call: (a) => a.commentOnTicket({ type: "test_issue", repo: "test/repo", id: "1" }, "A comment"),
      },
      {
        name: "createTicket",
        capability: "ticket_management",
        call: (a) =>
          a.createTicket("test/repo", {
            title: "Test",
            body: "Body",
            labels: null,
            assignees: null,
            parent_id: null,
          }),
      },
      {
        name: "updateTicket",
        capability: "ticket_management",
        call: (a) =>
          a.updateTicket("test/repo", "1", {
            state: null,
            labels_add: null,
            labels_remove: null,
            body: null,
          }),
      },
    ];

    for (const { name, capability, call } of optionalMethods) {
      it(`${name} throws AdapterMethodError with capability_not_available`, async () => {
        const adapter = new MinimalCommAdapter();
        adapter.manifest = createManifest();

        try {
          await call(adapter);
          expect.unreachable(`${name} should have thrown`);
        } catch (error) {
          expect(error).toBeInstanceOf(AdapterMethodError);
          if (error instanceof AdapterMethodError) {
            expect(error.adapterError.code).toBe("capability_not_available");
            expect(error.message).toContain(capability);
            expect(error.message).toContain(name);
            expect(error.message).toContain("test-comm");
          }
        }
      });
    }
  });

  describe("optional methods — work when overridden", () => {
    it("startListening/stopListening work", async () => {
      const adapter = new FullCommAdapter();
      adapter.manifest = createManifest({
        adapter_meta: { capabilities: ["send", "receive"] },
      });
      await adapter.startListening();
      expect(adapter.listening).toBe(true);
      await adapter.stopListening();
      expect(adapter.listening).toBe(false);
    });

    it("syncTaskState works", async () => {
      const adapter = new FullCommAdapter();
      adapter.manifest = createManifest({
        adapter_meta: { capabilities: ["send", "sync"] },
      });
      await adapter.syncTaskState("task-1", TaskStates.queued, TaskStates.active, {
        task_title: "Test",
        external_ref: null,
        sub_state: null,
        reason: null,
      });
      expect(adapter.syncCalls).toHaveLength(1);
      expect(adapter.syncCalls[0]?.taskId).toBe("task-1");
    });

    it("reconcileState works", async () => {
      const adapter = new FullCommAdapter();
      adapter.manifest = createManifest({
        adapter_meta: { capabilities: ["send", "sync"] },
      });
      const result = await adapter.reconcileState([]);
      expect(result.reconciled).toBe(0);
    });

    it("ticket management methods work", async () => {
      const adapter = new FullCommAdapter();
      adapter.manifest = createManifest({
        adapter_meta: { capabilities: ["send", "ticket_management"] },
      });
      await adapter.commentOnTicket({ type: "test_issue", repo: "test/repo", id: "1" }, "Comment");
      const issueResult = await adapter.createTicket("test/repo", {
        title: "Test",
        body: "Body",
        labels: null,
        assignees: null,
        parent_id: null,
      });
      await adapter.updateTicket("test/repo", "1", {
        state: null,
        labels_add: null,
        labels_remove: null,
        body: null,
      });
      expect(issueResult.id).toBe("42");
      expect(adapter.issueCalls).toHaveLength(3);
    });
  });
});
