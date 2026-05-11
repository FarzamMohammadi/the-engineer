import type { CommunicationAdapter } from "../../adapters/communication.js";
import { AdapterTypes, MessageTypes } from "../../schemas/adapters.js";
import type { MessageType } from "../../schemas/adapters.js";
import type { DaemonConfig } from "../../schemas/config.js";
import type { TaskStateChangedPayload } from "../../schemas/events.js";
import { type Notification, NotificationKinds, recipientsForKind } from "../../schemas/notifications.js";
import { TaskStates } from "../../schemas/task.js";
import type { Clock } from "../../utils/clock.js";
import { sanitizeErrorMessage, sanitizeSecrets } from "../../utils/sanitize.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { IPeopleDirectory } from "../interfaces/people-directory.interface.js";
import type { IPluginLookup } from "../interfaces/plugin-lookup.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IObserver } from "../observer/index.js";

export interface NotificationRouterContext {
  registry: IPluginLookup;
  taskEngine: ITaskEngine;
  peopleDirectory: IPeopleDirectory;
  eventBus: IEventBus;
  observer: IObserver;
  config: Pick<DaemonConfig, "notification_retry">;
  clock: Clock;
}

// ── Notification Templates ───────────────────────────────────────────────────

interface TemplateEntry {
  format: (vars: Record<string, string>) => string;
  messageType: MessageType;
}

const NOTIFICATION_TEMPLATES: Partial<Record<Notification["kind"], TemplateEntry>> = {
  [NotificationKinds.completion]: {
    format: (v) => `Task "${v["title"]}" completed successfully.`,
    messageType: MessageTypes.milestone,
  },
  [NotificationKinds.review_pending]: {
    format: (v) => `Task "${v["title"]}" — PR created, awaiting review.`,
    messageType: MessageTypes.milestone,
  },
  [NotificationKinds.task_error]: {
    format: (v) => `Task "${v["title"]}" encountered an error: ${v["reason"]}. Status: blocked.`,
    messageType: MessageTypes.alert,
  },
  [NotificationKinds.cost_limit]: {
    format: (v) => `Task "${v["title"]}" blocked — cost limit reached.`,
    messageType: MessageTypes.alert,
  },
  [NotificationKinds.blocked_reminder]: {
    format: (v) => `Task "${v["title"]}" is still blocked and waiting for attention.`,
    messageType: MessageTypes.notification,
  },
  [NotificationKinds.escalation_alert]: {
    format: (v) =>
      `ALERT: Task "${v["title"]}" has been blocked too long and was transitioned to failed. Please investigate.`,
    messageType: MessageTypes.alert,
  },
  [NotificationKinds.review_reminder]: {
    format: (v) => `Review reminder: Task "${v["title"]}" has been pending review for ${v["hours"]}h.`,
    messageType: MessageTypes.notification,
  },
};

import type { INotificationRouter } from "../interfaces/notification-router.interface.js";

// Re-export the interface for consumers that import from here
export type { INotificationRouter as NotificationRouter } from "../interfaces/notification-router.interface.js";

// ── Factory ──────────────────────────────────────────────────────────────────

export function createNotificationRouter(ctx: NotificationRouterContext): INotificationRouter {
  const { registry, taskEngine, peopleDirectory, eventBus, observer, config, clock } = ctx;
  const retryConfig = config.notification_retry;

  // ── Retry Queue ─────────────────────────────────────────────────────
  interface RetryEntry {
    notification: Notification;
    personId: string;
    enqueuedAt: number;
    attempts: number;
    lastAttemptAt: number;
    inFlight: boolean;
  }

  const retryQueue: RetryEntry[] = [];

  // ── Plugin Lookup ──────────────────────────────────────────────────────

  function getCommPlugins(): CommunicationAdapter[] {
    return registry.getPluginsByType<CommunicationAdapter>(AdapterTypes.communication);
  }

  /**
   * Find the comm plugin that handles the given channel.
   * Matches adapter_meta.channel on the plugin manifest. Returns null if none found.
   */
  function findPluginForChannel(channel: string, plugins: CommunicationAdapter[]): CommunicationAdapter | null {
    return plugins.find((p) => p.hasCapability("send") && p.manifest.adapter_meta["channel"] === channel) ?? null;
  }

  // ── Recipient Resolution ───────────────────────────────────────────────

  interface ResolvedContact {
    personId: string;
    channel: string;
    handle: string;
  }

  function flattenContacts(
    people: Array<{ id: string; contacts: Array<{ channel: string; handle: string }> }>,
  ): ResolvedContact[] {
    const contacts: ResolvedContact[] = [];
    for (const person of people) {
      for (const c of person.contacts) {
        contacts.push({ personId: person.id, channel: c.channel, handle: c.handle });
      }
    }
    return contacts;
  }

  function resolvePersonContacts(notification: Notification): ResolvedContact[] {
    const personId = "personId" in notification ? notification.personId : null;
    if (!personId) {
      return [];
    }
    const person = peopleDirectory.getPerson(personId) ?? peopleDirectory.getOwner();
    if (!person) {
      return [];
    }
    return flattenContacts([person]);
  }

  function resolveRoleContacts(recipients: string): ResolvedContact[] {
    const people: Array<{ id: string; contacts: Array<{ channel: string; handle: string }> }> = [];

    if (recipients === "owner" || recipients === "owner_and_reviewers") {
      const owner = peopleDirectory.getOwner();
      if (owner) {
        people.push(owner);
      }
    }
    if (recipients === "reviewers" || recipients === "owner_and_reviewers") {
      people.push(...peopleDirectory.getReviewers());
    }

    return flattenContacts(people);
  }

  function resolveContacts(notification: Notification): ResolvedContact[] {
    const recipients = recipientsForKind(notification.kind);
    if (recipients === "person") {
      return resolvePersonContacts(notification);
    }
    return resolveRoleContacts(recipients);
  }

  // ── Message Construction ───────────────────────────────────────────────

  function resolveTitle(taskId: string): string {
    return taskEngine.getTask(taskId)?.title ?? taskId;
  }

  interface ResolvedMessage {
    content: string;
    messageType: MessageType;
  }

  function resolveMessage(notification: Notification): ResolvedMessage {
    // Custom message kinds — use the message directly
    if ("message" in notification) {
      const messageType = kindToMessageType(notification.kind);
      return { content: notification.message, messageType };
    }

    // Template-based kinds
    const template = NOTIFICATION_TEMPLATES[notification.kind];
    if (template) {
      const vars: Record<string, string> = { title: resolveTitle(notification.taskId) };
      if (notification.kind === NotificationKinds.task_error) {
        vars["reason"] = notification.reason;
      }
      if (notification.kind === NotificationKinds.review_reminder) {
        vars["hours"] = String(Math.floor(notification.elapsedMs / 3_600_000));
      }
      return { content: template.format(vars), messageType: template.messageType };
    }

    // Fallback (should not happen with exhaustive kinds)
    return {
      content: `Notification: ${notification.kind}`,
      messageType: MessageTypes.notification,
    };
  }

  function kindToMessageType(kind: Notification["kind"]): MessageType {
    switch (kind) {
      case NotificationKinds.question:
        return MessageTypes.question;
      case NotificationKinds.milestone:
        return MessageTypes.milestone;
      case NotificationKinds.alert:
        return MessageTypes.alert;
      case NotificationKinds.status_response:
        return MessageTypes.status_response;
      default:
        return MessageTypes.notification;
    }
  }

  // ── Core Dispatch ──────────────────────────────────────────────────────

  function notify(notification: Notification): void {
    try {
      // Ticket comments route through ticket_management capability, not person channels
      if (notification.kind === NotificationKinds.ticket_comment) {
        handleTicketComment(notification.taskId, notification.message);
        return;
      }

      const contacts = resolveContacts(notification);
      if (contacts.length === 0) {
        observer.debug("No recipients resolved — skipping notification", {
          kind: notification.kind,
          taskId: notification.taskId,
        });
        return;
      }

      const { content, messageType } = resolveMessage(notification);
      const safeContent = sanitizeSecrets(content);
      const commPlugins = getCommPlugins();

      // Group contacts by person — try each person's contacts in order (first = preferred)
      const contactsByPerson = new Map<string, ResolvedContact[]>();
      for (const contact of contacts) {
        const existing = contactsByPerson.get(contact.personId) ?? [];
        existing.push(contact);
        contactsByPerson.set(contact.personId, existing);
      }

      // For each person, try contacts in order until one succeeds (fire-and-forget)
      for (const [personId, personContacts] of contactsByPerson) {
        sendToFirstReachable(personId, personContacts, safeContent, messageType, notification, commPlugins);
      }
    } catch (err) {
      observer.warn("Unexpected error in notify()", {
        kind: notification.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Delivery with Fallback ──────────────────────────────────────────────

  /** Attempt to deliver a message via a single plugin+contact. Returns delivery and retryability status. */
  async function tryDeliverToContact(
    contact: ResolvedContact,
    plugin: CommunicationAdapter,
    safeContent: string,
    messageType: MessageType,
    notification: Notification,
  ): Promise<{ delivered: boolean; retryable: boolean }> {
    try {
      const formatted = plugin.formatMessage(safeContent, messageType);
      const result = await plugin.sendMessage(
        { user_id: contact.handle, channel: contact.channel },
        { content: formatted, metadata: { task_id: notification.taskId, type: messageType } },
      );

      if (result.success) {
        observer.debug("Notification delivered", {
          kind: notification.kind,
          personId: contact.personId,
          channel: contact.channel,
          pluginId: plugin.manifest.id,
        });
        eventBus.publish({
          type: "comm.message_sent",
          source: "notification-router",
          task_id: notification.taskId,
          payload: {
            task_id: notification.taskId,
            target: contact.personId,
            message_type: messageType,
            content_summary: safeContent,
            channel: contact.channel,
          },
        } satisfies PublishInput<"comm.message_sent">);
        return { delivered: true, retryable: false };
      }

      observer.debug("Send failed, trying next contact", {
        personId: contact.personId,
        channel: contact.channel,
        error: result.error?.message ?? "unknown",
      });
      return { delivered: false, retryable: result.error?.retryable === true };
    } catch (err) {
      observer.debug("Send error, trying next contact", {
        personId: contact.personId,
        channel: contact.channel,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { delivered: false, retryable: false };
  }

  /**
   * Try contacts in order (first = preferred). Stop on first successful delivery.
   * If none reachable, emit comm.send_failed and enqueue for retry if retryable.
   */
  function sendToFirstReachable(
    personId: string,
    personContacts: ResolvedContact[],
    safeContent: string,
    messageType: MessageType,
    notification: Notification,
    commPlugins: CommunicationAdapter[],
  ): void {
    // Fire-and-forget async chain — try contacts sequentially
    (async () => {
      let anyRetryable = false;
      for (const contact of personContacts) {
        const plugin = findPluginForChannel(contact.channel, commPlugins);
        if (!plugin) {
          observer.debug("No plugin for channel — trying next contact", {
            channel: contact.channel,
            personId,
          });
          continue;
        }

        const { delivered, retryable } = await tryDeliverToContact(
          contact,
          plugin,
          safeContent,
          messageType,
          notification,
        );
        if (delivered) {
          return;
        }
        if (retryable) {
          anyRetryable = true;
        }
      }

      // None succeeded
      const channelsTried = personContacts.map((c) => c.channel);
      observer.warn("Notification not delivered — no reachable channel for person", {
        kind: notification.kind,
        personId,
        triedChannels: channelsTried,
        retryable: anyRetryable,
      });

      const taskId = notification.taskId ?? "";
      eventBus.publish({
        type: "comm.send_failed",
        source: "notification-router",
        task_id: taskId,
        payload: {
          task_id: taskId,
          person_id: personId,
          kind: notification.kind,
          channels_tried: channelsTried,
          retryable: anyRetryable,
        },
      } satisfies PublishInput<"comm.send_failed">);

      if (anyRetryable && notification.taskId) {
        const enqueueTime = clock.now();
        retryQueue.push({
          notification,
          personId,
          enqueuedAt: enqueueTime,
          attempts: 0,
          lastAttemptAt: enqueueTime,
          inFlight: false,
        });
        observer.debug("Notification enqueued for retry", {
          kind: notification.kind,
          personId,
          taskId: notification.taskId,
        });
      }
    })().catch((err) => {
      observer.warn("Unexpected error in delivery chain", {
        personId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // ── Retry Processing ──────────────────────────────────────────────────

  function processRetries(now: number): void {
    // Iterate backwards for safe splice
    for (let i = retryQueue.length - 1; i >= 0; i--) {
      const entry = retryQueue[i];
      if (!entry) {
        continue;
      }

      // Skip in-flight entries
      if (entry.inFlight) {
        continue;
      }

      // taskId is guaranteed non-null — we only enqueue when notification.taskId is truthy
      const entryTaskId = entry.notification.taskId as string;

      // Check task terminal state
      const task = taskEngine.getTask(entryTaskId);
      if (!task || task.state === TaskStates.completed || task.state === TaskStates.failed) {
        retryQueue.splice(i, 1);
        eventBus.publish({
          type: "comm.retry_exhausted",
          source: "notification-router",
          task_id: entryTaskId,
          payload: {
            task_id: entryTaskId,
            person_id: entry.personId,
            kind: entry.notification.kind,
            attempts: entry.attempts,
            reason: "task_terminal",
          },
        } satisfies PublishInput<"comm.retry_exhausted">);
        observer.debug("Retry entry removed — task terminal", {
          taskId: entryTaskId,
          personId: entry.personId,
          state: task?.state ?? "not_found",
        });
        continue;
      }

      // Check max age
      if (now - entry.enqueuedAt > retryConfig.max_age_ms) {
        retryQueue.splice(i, 1);
        eventBus.publish({
          type: "comm.retry_exhausted",
          source: "notification-router",
          task_id: entryTaskId,
          payload: {
            task_id: entryTaskId,
            person_id: entry.personId,
            kind: entry.notification.kind,
            attempts: entry.attempts,
            reason: "max_age",
          },
        } satisfies PublishInput<"comm.retry_exhausted">);
        observer.debug("Retry entry removed — max age exceeded", {
          taskId: entryTaskId,
          personId: entry.personId,
        });
        continue;
      }

      // Check max attempts
      if (entry.attempts >= retryConfig.max_attempts) {
        retryQueue.splice(i, 1);
        eventBus.publish({
          type: "comm.retry_exhausted",
          source: "notification-router",
          task_id: entryTaskId,
          payload: {
            task_id: entryTaskId,
            person_id: entry.personId,
            kind: entry.notification.kind,
            attempts: entry.attempts,
            reason: "max_attempts",
          },
        } satisfies PublishInput<"comm.retry_exhausted">);
        observer.debug("Retry entry removed — max attempts exhausted", {
          taskId: entryTaskId,
          personId: entry.personId,
          attempts: entry.attempts,
        });
        continue;
      }

      // Check interval
      if (now - entry.lastAttemptAt < retryConfig.interval_ms) {
        continue;
      }

      // Attempt retry — re-resolve contacts, re-attempt delivery
      entry.inFlight = true;
      entry.attempts++;
      entry.lastAttemptAt = now;

      const attemptNumber = entry.attempts;
      const notification = entry.notification;
      const personId = entry.personId;

      (async () => {
        const contacts = resolveContacts(notification);
        const personContacts = contacts.filter((c) => c.personId === personId);

        if (personContacts.length === 0) {
          entry.inFlight = false;
          return;
        }

        const { content, messageType } = resolveMessage(notification);
        const safeContent = sanitizeSecrets(content);
        const commPlugins = getCommPlugins();

        for (const contact of personContacts) {
          const plugin = findPluginForChannel(contact.channel, commPlugins);
          if (!plugin) {
            continue;
          }

          const { delivered } = await tryDeliverToContact(contact, plugin, safeContent, messageType, notification);

          if (delivered) {
            // Remove from queue
            const idx = retryQueue.indexOf(entry);
            if (idx >= 0) {
              retryQueue.splice(idx, 1);
            }
            eventBus.publish({
              type: "comm.retry_succeeded",
              source: "notification-router",
              task_id: entryTaskId,
              payload: {
                task_id: entryTaskId,
                person_id: personId,
                kind: notification.kind,
                channel: contact.channel,
                attempt: attemptNumber,
              },
            } satisfies PublishInput<"comm.retry_succeeded">);
            observer.info("Notification retry succeeded", {
              kind: notification.kind,
              personId,
              channel: contact.channel,
              attempt: attemptNumber,
            });
            return;
          }
        }

        // Still failed — stays in queue for next tick
        entry.inFlight = false;
      })().catch((err) => {
        entry.inFlight = false;
        observer.warn("Unexpected error in retry delivery", {
          personId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // ── Ticket Comments ────────────────────────────────────────────────────

  /** Leave margin below GitHub's hard 65,536 char limit. */
  const TICKET_COMMENT_MAX = 65_000;

  function handleTicketComment(taskId: string, message: string): void {
    const task = taskEngine.getTask(taskId);
    if (!task?.external_ref) {
      return;
    }

    const commPlugins = getCommPlugins();
    const plugin = commPlugins.find((p) => p.hasCapability("ticket_management"));
    if (!plugin) {
      return;
    }

    let safeMessage = sanitizeSecrets(message);

    // Guard against platform comment size limits (GitHub: 65,536 chars)
    if (safeMessage.length > TICKET_COMMENT_MAX) {
      const notice = "\n\n---\n*Message truncated to fit platform comment limits.*";
      safeMessage = safeMessage.slice(0, TICKET_COMMENT_MAX - notice.length) + notice;
      observer.warn("Ticket comment truncated to fit platform limits", {
        taskId,
        originalLength: message.length,
        truncatedTo: TICKET_COMMENT_MAX,
      });
    }

    observer.debug("Commenting on task ticket", { taskId });
    plugin.commentOnTicket(task.external_ref, safeMessage).catch((err) => {
      observer.error("Failed to comment on task ticket", {
        error: sanitizeErrorMessage(err),
        taskId,
      });
    });
  }

  // ── State Sync ─────────────────────────────────────────────────────────

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

  return { notify, syncStateToCommPlugin, processRetries };
}
