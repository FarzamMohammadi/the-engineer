import type { Logger } from "pino";

import type { CommunicationAdapter } from "../../adapters/communication.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { DaemonConfig } from "../../schemas/config.js";
import type { TaskStateChangedPayload } from "../../schemas/events.js";
import type { EventBus } from "../event-bus/index.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { PeopleDirectory } from "../people-directory/index.js";
import type { Registry } from "../registry/index.js";
import type { Clock } from "./index.js";

// ── DaemonContext (subset) ───────────────────────────────────────────────────

/** Shared dependencies available to all Daemon subsystems. */
export interface DaemonContext {
  config: DaemonConfig;
  eventBus: EventBus;
  registry: Registry;
  taskEngine: ITaskEngine;
  peopleDirectory: PeopleDirectory;
  clock: Clock;
  logger: Logger;
  [key: string]: unknown;
}

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
  sendCompletion(taskId: string, taskTitle: string): void;
  /** Send review-pending notification to owner. */
  sendReviewPending(taskId: string, taskTitle: string): void;
  /** Send task error notification to owner. */
  sendTaskError(taskId: string, taskTitle: string, reason: string): void;
  /** Send cost limit notification to owner. */
  sendCostLimit(taskId: string, taskTitle: string): void;
  /** Send blocked reminder to owner. */
  sendBlockedReminder(taskId: string, taskTitle: string): void;
  /** Send escalation alert to owner + reviewers. */
  sendEscalationAlert(taskId: string, taskTitle: string): void;
  /** Send review reminder to reviewers. */
  sendReviewReminder(taskId: string, taskTitle: string, elapsedMs: number): void;
  /** Comment on a task's source GitHub issue. */
  commentOnTaskIssue(taskId: string, message: string): void;
  /** Sync task state change to communication plugins. */
  syncStateToCommPlugin(payload: TaskStateChangedPayload): void;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createNotificationRouter(ctx: DaemonContext): NotificationRouter {
  const { registry, taskEngine, logger } = ctx;
  const peopleDirectory = ctx.peopleDirectory as PeopleDirectory;

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
      return;
    }

    const commPlugins = getCommPlugins();

    for (const person of people) {
      for (const comm of commPlugins) {
        if (!comm.hasCapability("send")) {
          continue;
        }
        const formatted = comm.formatMessage(content, messageType);
        comm
          .sendMessage(
            { user_id: person.id, channel: null },
            { content: formatted, metadata: { task_id: taskId, type: messageType } },
          )
          .catch((err) => {
            logger.error({ err, taskId }, `Failed to send ${logLabel} notification`);
          });
      }
    }
  }

  function sendCompletion(taskId: string, taskTitle: string): void {
    const t = NOTIFICATION_TEMPLATES.completion;
    sendToRecipients(
      taskId,
      t.format({ title: taskTitle }),
      t.messageType,
      t.recipients,
      "completion",
    );
  }

  function sendReviewPending(taskId: string, taskTitle: string): void {
    const t = NOTIFICATION_TEMPLATES.review_pending;
    sendToRecipients(
      taskId,
      t.format({ title: taskTitle }),
      t.messageType,
      t.recipients,
      "review_pending",
    );
  }

  function sendTaskError(taskId: string, taskTitle: string, reason: string): void {
    const t = NOTIFICATION_TEMPLATES.task_error;
    sendToRecipients(
      taskId,
      t.format({ title: taskTitle, reason }),
      t.messageType,
      t.recipients,
      "task_error",
    );
  }

  function sendCostLimit(taskId: string, taskTitle: string): void {
    const t = NOTIFICATION_TEMPLATES.cost_limit;
    sendToRecipients(
      taskId,
      t.format({ title: taskTitle }),
      t.messageType,
      t.recipients,
      "cost_limit",
    );
  }

  function sendBlockedReminder(taskId: string, taskTitle: string): void {
    const t = NOTIFICATION_TEMPLATES.blocked_reminder;
    sendToRecipients(
      taskId,
      t.format({ title: taskTitle }),
      t.messageType,
      t.recipients,
      "blocked_reminder",
    );
  }

  function sendEscalationAlert(taskId: string, taskTitle: string): void {
    const t = NOTIFICATION_TEMPLATES.escalation_alert;
    sendToRecipients(
      taskId,
      t.format({ title: taskTitle }),
      t.messageType,
      t.recipients,
      "escalation_alert",
    );
  }

  function sendReviewReminder(taskId: string, taskTitle: string, elapsedMs: number): void {
    const hours = String(Math.floor(elapsedMs / 3_600_000));
    const t = NOTIFICATION_TEMPLATES.review_reminder;
    sendToRecipients(
      taskId,
      t.format({ title: taskTitle, hours }),
      t.messageType,
      t.recipients,
      "review_reminder",
    );
  }

  function commentOnTaskIssue(taskId: string, message: string): void {
    const task = taskEngine.getTask(taskId);
    if (!task?.external_ref) {
      return;
    }
    const { type, repo, number } = task.external_ref;
    if (type !== "github_issue" && type !== "github_pr") {
      return;
    }

    const commPlugins = getCommPlugins();
    const plugin = commPlugins.find((p) => p.hasCapability("issue_management"));
    if (!plugin) {
      return;
    }

    plugin.commentOnIssue(repo, number, message).catch((err) => {
      logger.error({ err, taskId }, "Failed to comment on task issue");
    });
  }

  function syncStateToCommPlugin(payload: TaskStateChangedPayload): void {
    const commPlugins = getCommPlugins();
    for (const comm of commPlugins) {
      if (!comm.hasCapability("sync")) {
        continue;
      }
      const task = taskEngine.getTask(payload.task_id);
      const externalRef = task?.external_ref
        ? `https://github.com/${task.external_ref.repo}/issues/${String(task.external_ref.number)}`
        : null;

      comm
        .syncTaskState(payload.task_id, payload.from_state, payload.to_state, {
          task_title: task?.title ?? "",
          external_ref: externalRef,
          sub_state: payload.to_sub,
          reason: payload.reason,
        })
        .catch((err) => {
          logger.error(
            { err, pluginId: comm.manifest.id, taskId: payload.task_id },
            "Failed to sync task state to comm plugin",
          );
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
    commentOnTaskIssue,
    syncStateToCommPlugin,
  };
}
