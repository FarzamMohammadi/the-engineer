import {
  AdapterErrorSeverities,
  type FormattedMessage,
  type InboundMessage,
  type MessageType,
  type ReconciliationResult,
  type SendResult,
  type SyncMetadata,
  type Target,
  type TaskReconciliationInput,
  type TicketOptions,
  type TicketResult,
  type TicketUpdates,
} from "../schemas/adapters.js";
import type { ExternalRef } from "../schemas/task.js";
import { BaseAdapter } from "./base.js";
import { AdapterMethodError, createAdapterError } from "./errors.js";

/**
 * Helper to create an error for calling an unsupported optional method.
 */
function capabilityError(pluginId: string, capability: string, method: string): AdapterMethodError {
  return new AdapterMethodError(
    createAdapterError(
      "capability_not_available",
      `Plugin "${pluginId}" does not support capability "${capability}" (method: ${method})`,
    ),
  );
}

/**
 * Wrap an async `do*` method: rethrow `AdapterMethodError` as-is,
 * wrap unknown errors as `internal_error`.
 */
async function wrapAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AdapterMethodError) {
      throw error;
    }
    throw new AdapterMethodError(
      createAdapterError("internal_error", error instanceof Error ? error.message : String(error), {
        severity: AdapterErrorSeverities.fatal,
      }),
      { cause: error },
    );
  }
}

/**
 * Abstract base for communication adapters.
 *
 * Communication adapters are the Engineer's voice — how it communicates with
 * humans through external platforms. They are dumb transport: the Orchestrator
 * owns all intelligence (what to say, when).
 *
 * Required methods: `doSendMessage()`, `formatMessage()`.
 * Optional methods have default implementations that throw a descriptive error.
 * Core checks `hasCapability()` before calling optional methods.
 */
export abstract class CommunicationAdapter extends BaseAdapter {
  // ── Required: Outbound ────────────────────────────────────────────────────

  /**
   * Send a message to a target.
   * Wraps `doSendMessage()` with error handling.
   */
  async sendMessage(target: Target, message: FormattedMessage): Promise<SendResult> {
    return wrapAsync(() => this.doSendMessage(target, message));
  }

  /** Plugin authors implement the actual send logic. */
  protected abstract doSendMessage(target: Target, message: FormattedMessage): Promise<SendResult>;

  /**
   * Format content for this platform. Synchronous, pure — no wrapping needed.
   * Plugin authors implement directly.
   */
  abstract formatMessage(content: string, type: MessageType): string;

  // ── Optional: Inbound (capability: "receive") ─────────────────────────────

  /** Begin receiving inbound messages. Override if "receive" capability. */
  async startListening(): Promise<void> {
    return wrapAsync(() => this.doStartListening());
  }

  /** Stop receiving inbound messages. Override if "receive" capability. */
  async stopListening(): Promise<void> {
    return wrapAsync(() => this.doStopListening());
  }

  protected doStartListening(): Promise<void> {
    throw capabilityError(this.manifest.id, "receive", "startListening");
  }

  protected doStopListening(): Promise<void> {
    throw capabilityError(this.manifest.id, "receive", "stopListening");
  }

  /** Poll for new inbound messages on specific channels. Override if "receive" capability. */
  async pollMessages(channels: string[], since: string): Promise<{ messages: InboundMessage[]; cursor: string }> {
    return wrapAsync(() => this.doPollMessages(channels, since));
  }

  protected doPollMessages(
    _channels: string[],
    _since: string,
  ): Promise<{ messages: InboundMessage[]; cursor: string }> {
    throw capabilityError(this.manifest.id, "receive", "pollMessages");
  }

  // ── Optional: State Sync (capability: "sync") ─────────────────────────────

  /** Sync a task state change to the external platform. Override if "sync" capability. */
  async syncTaskState(taskId: string, oldState: string, newState: string, metadata: SyncMetadata): Promise<void> {
    return wrapAsync(() => this.doSyncTaskState(taskId, oldState, newState, metadata));
  }

  /** Reconcile task state after an outage. Override if "sync" capability. */
  async reconcileState(tasks: TaskReconciliationInput[]): Promise<ReconciliationResult> {
    return wrapAsync(() => this.doReconcileState(tasks));
  }

  protected doSyncTaskState(
    _taskId: string,
    _oldState: string,
    _newState: string,
    _metadata: SyncMetadata,
  ): Promise<void> {
    throw capabilityError(this.manifest.id, "sync", "syncTaskState");
  }

  protected doReconcileState(_tasks: TaskReconciliationInput[]): Promise<ReconciliationResult> {
    throw capabilityError(this.manifest.id, "sync", "reconcileState");
  }

  // ── Optional: Ticket Management (capability: "ticket_management") ──────────

  /** Comment on an external ticket. Override if "ticket_management" capability. */
  async commentOnTicket(externalRef: ExternalRef, comment: string): Promise<void> {
    return wrapAsync(() => this.doCommentOnTicket(externalRef, comment));
  }

  /** Create a new ticket. Override if "ticket_management" capability. */
  async createTicket(repo: string, options: TicketOptions): Promise<TicketResult> {
    return wrapAsync(() => this.doCreateTicket(repo, options));
  }

  /** Update an existing ticket. Override if "ticket_management" capability. */
  async updateTicket(repo: string, ticketId: string, updates: TicketUpdates): Promise<void> {
    return wrapAsync(() => this.doUpdateTicket(repo, ticketId, updates));
  }

  protected doCommentOnTicket(_externalRef: ExternalRef, _comment: string): Promise<void> {
    throw capabilityError(this.manifest.id, "ticket_management", "commentOnTicket");
  }

  protected doCreateTicket(_repo: string, _options: TicketOptions): Promise<TicketResult> {
    throw capabilityError(this.manifest.id, "ticket_management", "createTicket");
  }

  protected doUpdateTicket(_repo: string, _ticketId: string, _updates: TicketUpdates): Promise<void> {
    throw capabilityError(this.manifest.id, "ticket_management", "updateTicket");
  }
}
