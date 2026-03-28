import type { CommunicationAdapter } from "../../adapters/communication.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { TaskStateChangedPayload } from "../../schemas/events.js";
import { sanitizeErrorMessage, sanitizeSecrets } from "../../utils/sanitize.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type { NotificationRouterContext } from "./types.js";

// ── Notification Templates ───────────────────────────────────────────────────

type MessageType = "milestone" | "notification" | "alert";
type Recipients = "owner" | "reviewers" | "owner_and_reviewers";

const NOTIFICATION_TEMPLATES = {
  completion: {
    format: (v: { title: string }) => `Task "${v.title}" completed successfully.`,
    messageType: "milestone" as MessageType,
    recipients: "owner" as Recipients,
  },
  review_pending: {
    format: (v: { title: string }) => `Task "${v.title}" — PR created, awaiting review.`,
    messageType: "milestone" as MessageType,
    recipients: "owner" as Recipients,
  },
  task_error: {
    format: (v: { title: string; reason: string }) =>
      `Task "${v.title}" encountered an error: ${v.reason}. Status: blocked.`,
    messageType: "alert" as MessageType,
    recipients: "owner" as Recipients,
  },
  cost_limit: {
    format: (v: { title: string }) => `Task "${v.title}" blocked — cost limit reached.`,
    messageType: "alert" as MessageType,
    recipients: "owner" as Recipients,
  },
  blocked_reminder: {
    format: (v: { title: string }) =>
      `Task "${v.title}" is still blocked and waiting for attention.`,
    messageType: "notification" as MessageType,
    recipients: "owner" as Recipients,
  },
  escalation_alert: {
    format: (v: { title: string }) =>
      `ALERT: Task "${v.title}" has been blocked too long and was transitioned to failed. Please investigate.`,
    messageType: "alert" as MessageType,
    recipients: "owner_and_reviewers" as Recipients,
  },
  review_reminder: {
    format: (v: { title: string; hours: string }) =>
      `Review reminder: Task "${v.title}" has been pending review for ${v.hours}h.`,
    messageType: "notification" as MessageType,
    recipients: "reviewers" as Recipients,
  },
} as const;

// ── NotificationRouter Interface ─────────────────────────────────────────────

/** Handles all outbound notifications and communication. */
export interface NotificationRouter {
  /** Send completion notification to owner. */
  sendCompletion(taskId: string): void;
  /** Send review-pending notification to owner. */
  sendReviewPending(taskId: string): void;
  /** Send task error notification to owner. */
  sendTaskError(taskId: string, reason: string): void;
  /** Send cost limit notification to owner. */
  sendCostLimit(taskId: string): void;
  /** Send blocked reminder to owner. */
  sendBlockedReminder(taskId: string): void;
  /** Send escalation alert to owner + reviewers. */
  sendEscalationAlert(taskId: string): void;
  /** Send review reminder to reviewers. */
  sendReviewReminder(taskId: string, elapsedMs: number): void;
  /** Comment on a task's source trigger ticket. */
  commentOnTaskTicket(taskId: string, message: string): void;
  /** Sync task state change to communication plugins. */
  syncStateToCommPlugin(payload: TaskStateChangedPayload): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createNotificationRouter(ctx: NotificationRouterContext): NotificationRouter {
  const { registry, taskEngine, peopleDirectory, eventBus, observer } = ctx;

  function getCommPlugins(): CommunicationAdapter[] {
    return registry.getPluginsByType<CommunicationAdapter>(AdapterTypes.communication);
  }

  /** Resolve recipients based on the recipient type. */
  function resolveRecipients(recipients: Recipients): Array<{ id: string }> {
    const people: Array<{ id: string }> = [];
    if (recipients === "owner" || recipients === "owner_and_reviewers") {
      const owner = peopleDirectory.getOwner();
      if (owner) {
        people.push(owner);
      }
    }
    if (recipients === "reviewers" || recipients === "owner_and_reviewers") {
      people.push(...peopleDirectory.getReviewers());
    }
    return people;
  }

  /** Send a notification to recipients via all comm plugins with send capability. */
  function sendToRecipients(
    taskId: string,
    content: string,
    messageType: MessageType,
    recipients: Recipients,
    logLabel: string,
  ): void {
    const people = resolveRecipients(recipients);
    if (people.length === 0) {
      observer.debug("No recipients resolved — skipping notification", {
        taskId,
        recipients,
        logLabel,
      });
      return;
    }

    // SECURITY: sanitize before sending to external channels (Telegram, GitHub).
    // Error reasons may contain auth URLs from failed git operations.
    const safeContent = sanitizeSecrets(content);
    const commPlugins = getCommPlugins();

    for (const person of people) {
      for (const comm of commPlugins) {
        if (!comm.hasCapability("send")) {
          continue;
        }
        const formatted = comm.formatMessage(safeContent, messageType);
        comm
          .sendMessage(
            { user_id: person.id, channel: null },
            { content: formatted, metadata: { task_id: taskId, type: messageType } },
          )
          .then(() => {
            observer.debug("Notification sent", {
              taskId,
              logLabel,
              recipientId: person.id,
              pluginId: comm.manifest.id,
            });
            eventBus.publish({
              type: "comm.message_sent",
              source: "daemon",
              task_id: taskId,
              payload: {
                task_id: taskId,
                target: person.id,
                message_type: messageType,
                content_summary: safeContent,
                channel: comm.manifest.id,
              },
            } satisfies PublishInput<"comm.message_sent">);
          })
          .catch((err) => {
            observer.error(`Failed to send ${logLabel} notification`, {
              error: sanitizeErrorMessage(err),
              taskId,
            });
          });
      }
    }
  }

  /** Resolve task title from taskEngine, falling back to taskId. */
  function resolveTitle(taskId: string): string {
    return taskEngine.getTask(taskId)?.title ?? taskId;
  }

  function sendCompletion(taskId: string): void {
    const t = NOTIFICATION_TEMPLATES.completion;
    sendToRecipients(
      taskId,
      t.format({ title: resolveTitle(taskId) }),
      t.messageType,
      t.recipients,
      "completion",
    );
  }

  function sendReviewPending(taskId: string): void {
    const t = NOTIFICATION_TEMPLATES.review_pending;
    sendToRecipients(
      taskId,
      t.format({ title: resolveTitle(taskId) }),
      t.messageType,
      t.recipients,
      "review_pending",
    );
  }

  function sendTaskError(taskId: string, reason: string): void {
    const t = NOTIFICATION_TEMPLATES.task_error;
    sendToRecipients(
      taskId,
      t.format({ title: resolveTitle(taskId), reason }),
      t.messageType,
      t.recipients,
      "task_error",
    );
  }

  function sendCostLimit(taskId: string): void {
    const t = NOTIFICATION_TEMPLATES.cost_limit;
    sendToRecipients(
      taskId,
      t.format({ title: resolveTitle(taskId) }),
      t.messageType,
      t.recipients,
      "cost_limit",
    );
  }

  function sendBlockedReminder(taskId: string): void {
    const t = NOTIFICATION_TEMPLATES.blocked_reminder;
    sendToRecipients(
      taskId,
      t.format({ title: resolveTitle(taskId) }),
      t.messageType,
      t.recipients,
      "blocked_reminder",
    );
  }

  function sendEscalationAlert(taskId: string): void {
    const t = NOTIFICATION_TEMPLATES.escalation_alert;
    sendToRecipients(
      taskId,
      t.format({ title: resolveTitle(taskId) }),
      t.messageType,
      t.recipients,
      "escalation_alert",
    );
  }

  function sendReviewReminder(taskId: string, elapsedMs: number): void {
    const hours = String(Math.floor(elapsedMs / 3_600_000));
    const t = NOTIFICATION_TEMPLATES.review_reminder;
    sendToRecipients(
      taskId,
      t.format({ title: resolveTitle(taskId), hours }),
      t.messageType,
      t.recipients,
      "review_reminder",
    );
  }

  function commentOnTaskTicket(taskId: string, message: string): void {
    const task = taskEngine.getTask(taskId);
    if (!task?.external_ref) {
      return;
    }

    const commPlugins = getCommPlugins();
    const plugin = commPlugins.find((p) => p.hasCapability("ticket_management"));
    if (!plugin) {
      return;
    }

    observer.debug("Commenting on task ticket", { taskId });
    plugin.commentOnTicket(task.external_ref, sanitizeSecrets(message)).catch((err) => {
      observer.error("Failed to comment on task ticket", {
        error: sanitizeErrorMessage(err),
        taskId,
      });
    });
  }

  function syncStateToCommPlugin(payload: TaskStateChangedPayload): void {
    const commPlugins = getCommPlugins();
    for (const comm of commPlugins) {
      if (!comm.hasCapability("sync")) {
        continue;
      }
      const task = taskEngine.getTask(payload.task_id);

      comm
        .syncTaskState(payload.task_id, payload.from_state, payload.to_state, {
          task_title: sanitizeSecrets(task?.title ?? ""),
          external_ref: task?.external_ref ?? null,
          sub_state: payload.to_sub,
          reason: payload.reason,
        })
        .catch((err) => {
          observer.error("Failed to sync task state to comm plugin", {
            error: sanitizeErrorMessage(err),
            pluginId: comm.manifest.id,
            taskId: payload.task_id,
          });
        });
    }
  }

  return {
    sendCompletion,
    sendReviewPending,
    sendTaskError,
    sendCostLimit,
    sendBlockedReminder,
    sendEscalationAlert,
    sendReviewReminder,
    commentOnTaskTicket,
    syncStateToCommPlugin,
  };
}
