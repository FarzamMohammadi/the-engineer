import type { CommunicationAdapter } from "../../adapters/communication.js";
import { AdapterTypes, MessageTypes } from "../../schemas/adapters.js";
import type { MessageType } from "../../schemas/adapters.js";
import type { DaemonConfig } from "../../schemas/config.js";
import type { TaskStateChangedPayload } from "../../schemas/events.js";
import { type Notification, NotificationKinds, recipientsForKind } from "../../schemas/notifications.js";
import { ObservationTypes } from "../../schemas/observer.js";
import { isTerminal } from "../../schemas/task.js";
import type { Clock } from "../../utils/clock.js";
import { sanitizeErrorMessage, sanitizeSecrets } from "../../utils/sanitize.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { INotificationRouter } from "../interfaces/notification-router.interface.js";
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
  config: Pick<DaemonConfig, "notification_retry" | "notification_suppress_window_ms">;
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

// Re-export the interface for consumers that import from here
export type { INotificationRouter as NotificationRouter } from "../interfaces/notification-router.interface.js";

// ── Factory ──────────────────────────────────────────────────────────────────

export function createNotificationRouter(ctx: NotificationRouterContext): INotificationRouter {
  const { registry, taskEngine, peopleDirectory, eventBus, observer, config, clock } = ctx;
  const retryConfig = config.notification_retry;
  const suppressWindowMs = config.notification_suppress_window_ms;

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

  // ── Suppression (duplicate dedup) ────────────────────────────────────
  // The single source of outbound dedup: drop an identical notification — same kind and scope
  // (taskId, or `source` for null-task alerts) — seen within `suppressWindowMs`. This replaced the
  // daemon's former hardcoded health-alert cooldown, so it deliberately covers ALERTS too: a trigger
  // failing every tick must not DM the owner every tick. The window only suppresses a true duplicate;
  // the first occurrence and any distinct kind/scope always pass through immediately. Keyed on `kind`
  // (not the resolved messageType) so distinct events that share a type — a task_error and a cost_limit
  // on the same task both map to `alert` — never falsely dedup each other.
  const lastDeliveredAt = new Map<string, number>();

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

  // ── Suppression ────────────────────────────────────────────────────────

  /**
   * The dedup identity of a notification: its kind plus its scope. Scope is the taskId, or a `source` for
   * null-task kinds that carry one (an alert's "trigger:github-trigger", a plugin recovery's
   * "plugin:github-trigger"), or "" when neither exists. Two notifications with the same dedup key inside
   * the window are duplicates.
   *
   * Plugin recovery MUST key on its source: it has no taskId, so without the source every plugin's recovery
   * would collapse to the single key "plugin_recovered:" — two distinct plugins recovering in the window
   * would dedup to one DM, and one plugin flapping failed↔healthy would never re-key to suppress its own
   * repeats. Keying on "plugin:<plugin_id>" keeps distinct plugins distinct and a single flapping plugin
   * suppressed within the window.
   */
  function dedupKeyFor(notification: Notification): string {
    const scope = notification.taskId ?? sourceScope(notification);
    return `${notification.kind}:${scope}`;
  }

  /** The `source` scope for the null-task kinds that carry one (alerts, plugin recoveries); "" otherwise. */
  function sourceScope(notification: Notification): string {
    if (notification.kind === NotificationKinds.alert || notification.kind === NotificationKinds.plugin_recovered) {
      return notification.source ?? "";
    }
    return "";
  }

  /**
   * Pure decision: is this notification a duplicate seen within the suppress window? Returns the verdict
   * plus the time since the last identical delivery (null on the first occurrence) for observability.
   */
  function decideSuppress(key: string, now: number): { suppressed: boolean; sinceLastMs: number | null } {
    const last = lastDeliveredAt.get(key);
    if (last === undefined) {
      return { suppressed: false, sinceLastMs: null };
    }
    const sinceLastMs = now - last;
    return { suppressed: sinceLastMs < suppressWindowMs, sinceLastMs };
  }

  /**
   * Decide whether to drop this notification as a duplicate, recording the decision when it does and
   * stamping the dedup timestamp when it does not. Returns true when the caller should stop (suppressed).
   */
  function isSuppressedDuplicate(notification: Notification): boolean {
    const key = dedupKeyFor(notification);
    const now = clock.now();
    const { suppressed, sinceLastMs } = decideSuppress(key, now);
    if (suppressed && sinceLastMs !== null) {
      observer.recordDecision(
        "notification_suppressed",
        `Duplicate ${notification.kind} for "${key}" — last delivered ${String(sinceLastMs)}ms ago, within the ${String(suppressWindowMs)}ms suppress window`,
        [
          { id: "deliver", description: "Deliver the notification now" },
          { id: "suppress", description: "Drop it as a duplicate of a recent identical notification" },
        ],
        "suppress",
        "An identical notification (same kind and scope) was delivered inside the suppress window — dropping it avoids flooding the owner",
        1,
        { task_id: notification.taskId ?? undefined },
      );
      observer.debug("Notification suppressed as duplicate", { kind: notification.kind, key, sinceLastMs });
      return true;
    }
    lastDeliveredAt.set(key, now);
    return false;
  }

  // ── Core Dispatch ──────────────────────────────────────────────────────

  function notify(notification: Notification): void {
    try {
      // Ticket comments route through ticket_management capability, not person channels — they target
      // the source ticket (a different surface from the owner's DM) and their cadence is already
      // controlled by the emitter, so they are not subject to the owner-flooding dedup.
      if (notification.kind === NotificationKinds.ticket_comment) {
        handleTicketComment(notification.taskId, notification.message);
        return;
      }

      if (isSuppressedDuplicate(notification)) {
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

      fanOutToContacts(notification, contacts);
    } catch (err) {
      observer.warn("Unexpected error in notify()", {
        kind: notification.kind,
        error: sanitizeErrorMessage(err),
      });
    }
  }

  /** Send one notification to every resolved person, trying each person's contacts in preferred order. */
  function fanOutToContacts(notification: Notification, contacts: ResolvedContact[]): void {
    const { content, messageType } = resolveMessage(notification);
    const safeContent = sanitizeSecrets(content);
    const commPlugins = getCommPlugins();

    // Group contacts by person — try each person's contacts in order (first = preferred).
    const contactsByPerson = new Map<string, ResolvedContact[]>();
    for (const contact of contacts) {
      const existing = contactsByPerson.get(contact.personId) ?? [];
      existing.push(contact);
      contactsByPerson.set(contact.personId, existing);
    }

    // For each person, try contacts in order until one succeeds (fire-and-forget).
    for (const [personId, personContacts] of contactsByPerson) {
      sendToFirstReachable({ personId, personContacts, safeContent, messageType, notification, commPlugins });
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
        observer.observe(
          ObservationTypes.tool_execution,
          "notification_delivered",
          {
            kind: notification.kind,
            message_type: messageType,
            person_id: contact.personId,
            channel: contact.channel,
            plugin_id: plugin.manifest.id,
            content_summary: safeContent,
          },
          { task_id: notification.taskId ?? undefined, level: "info" },
        );
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
        error: sanitizeErrorMessage(err),
      });
    }
    return { delivered: false, retryable: false };
  }

  interface SendToFirstReachableInput {
    readonly personId: string;
    readonly personContacts: ResolvedContact[];
    readonly safeContent: string;
    readonly messageType: MessageType;
    readonly notification: Notification;
    readonly commPlugins: CommunicationAdapter[];
  }

  /**
   * Try contacts in order (first = preferred). Stop on first successful delivery.
   * If none reachable, emit comm.send_failed and enqueue for retry if retryable.
   */
  function sendToFirstReachable(input: SendToFirstReachableInput): void {
    const { personId, personContacts, safeContent, messageType, notification, commPlugins } = input;
    // Fire-and-forget async chain — try contacts sequentially
    (async () => {
      let anyRetryable = false;
      for (const contact of personContacts) {
        const plugin = findPluginForChannel(contact.channel, commPlugins);
        if (!plugin) {
          observer.debug("No plugin for channel — trying next contact", { channel: contact.channel, personId });
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
        anyRetryable = anyRetryable || retryable;
      }
      handleAllContactsFailed(personId, personContacts, notification, anyRetryable);
    })().catch((err) => {
      observer.warn("Unexpected error in delivery chain", {
        personId,
        error: sanitizeErrorMessage(err),
      });
    });
  }

  /** No contact reached this person: emit the send-failed event + observation, and enqueue a retry when retryable. */
  function handleAllContactsFailed(
    personId: string,
    personContacts: ResolvedContact[],
    notification: Notification,
    anyRetryable: boolean,
  ): void {
    const channelsTried = personContacts.map((c) => c.channel);
    observer.warn("Notification not delivered — no reachable channel for person", {
      kind: notification.kind,
      personId,
      triedChannels: channelsTried,
      retryable: anyRetryable,
    });
    observer.observe(
      ObservationTypes.tool_execution,
      "notification_send_failed",
      { kind: notification.kind, person_id: personId, channels_tried: channelsTried, retryable: anyRetryable },
      { task_id: notification.taskId ?? undefined, level: "warn" },
    );

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
  }

  // ── Retry Processing ──────────────────────────────────────────────────

  type RetryExhaustedReason = "task_terminal" | "max_age" | "max_attempts";

  /** Record an abandoned-retry outcome on both the audit ledger (event) and the dashboard trail (observation). */
  function emitRetryExhausted(entry: RetryEntry, taskId: string, reason: RetryExhaustedReason): void {
    eventBus.publish({
      type: "comm.retry_exhausted",
      source: "notification-router",
      task_id: taskId,
      payload: {
        task_id: taskId,
        person_id: entry.personId,
        kind: entry.notification.kind,
        attempts: entry.attempts,
        reason,
      },
    } satisfies PublishInput<"comm.retry_exhausted">);
    observer.observe(
      ObservationTypes.tool_execution,
      "notification_retry_exhausted",
      {
        kind: entry.notification.kind,
        person_id: entry.personId,
        attempts: entry.attempts,
        reason,
      },
      { task_id: taskId, level: "warn" },
    );
    observer.debug("Retry entry removed", { taskId, personId: entry.personId, attempts: entry.attempts, reason });
  }

  /** Record a retry that finally landed on both the audit ledger (event) and the dashboard trail (observation). */
  function emitRetrySucceeded(entry: RetryEntry, taskId: string, channel: string, attempt: number): void {
    eventBus.publish({
      type: "comm.retry_succeeded",
      source: "notification-router",
      task_id: taskId,
      payload: { task_id: taskId, person_id: entry.personId, kind: entry.notification.kind, channel, attempt },
    } satisfies PublishInput<"comm.retry_succeeded">);
    observer.info("Notification retry succeeded", {
      kind: entry.notification.kind,
      personId: entry.personId,
      channel,
      attempt,
    });
    observer.observe(
      ObservationTypes.tool_execution,
      "notification_retry_succeeded",
      { kind: entry.notification.kind, person_id: entry.personId, channel, attempt },
      { task_id: taskId, level: "info" },
    );
  }

  /**
   * The fate of one retry entry this tick: abandon it (with the exhausted reason), attempt a redelivery now
   * (`due`), or leave it to wait for its interval/in-flight (`wait`). Pure — reads the entry and the clock,
   * touches nothing — so the eviction policy reads as one table apart from the splice/async effects.
   */
  function decideRetryFate(entry: RetryEntry, now: number): RetryExhaustedReason | "due" | "wait" {
    if (entry.inFlight) {
      return "wait";
    }
    const task = taskEngine.getTask(entry.notification.taskId as string);
    if (!task || isTerminal(task.state)) {
      return "task_terminal";
    }
    if (now - entry.enqueuedAt > retryConfig.max_age_ms) {
      return "max_age";
    }
    if (entry.attempts >= retryConfig.max_attempts) {
      return "max_attempts";
    }
    if (now - entry.lastAttemptAt < retryConfig.interval_ms) {
      return "wait";
    }
    return "due";
  }

  function processRetries(now: number): void {
    // Iterate backwards for safe splice
    for (let i = retryQueue.length - 1; i >= 0; i--) {
      const entry = retryQueue[i];
      if (!entry) {
        continue;
      }
      const fate = decideRetryFate(entry, now);
      if (fate === "wait") {
        continue;
      }
      if (fate !== "due") {
        retryQueue.splice(i, 1);
        emitRetryExhausted(entry, entry.notification.taskId as string, fate);
        continue;
      }
      // Due — claim the attempt and fire the redelivery (the splice on success happens inside).
      entry.inFlight = true;
      entry.attempts++;
      entry.lastAttemptAt = now;
      attemptRetryDelivery(entry);
    }
  }

  /**
   * Fire-and-forget shell around one due retry entry's redelivery: it owns the `inFlight` flag and the
   * error boundary, so {@link redeliverEntry} stays a plain "did it land?" async with no bookkeeping.
   */
  function attemptRetryDelivery(entry: RetryEntry): void {
    redeliverEntry(entry)
      .then((delivered) => {
        // On success the entry was already dequeued; on failure it stays for the next tick — either way it
        // is no longer in flight.
        if (!delivered) {
          entry.inFlight = false;
        }
      })
      .catch((err) => {
        entry.inFlight = false;
        observer.warn("Unexpected error in retry delivery", {
          personId: entry.personId,
          error: sanitizeErrorMessage(err),
        });
      });
  }

  /** Re-resolve the person's contacts and re-attempt delivery once; on the first success, dequeue + emit, return true. */
  async function redeliverEntry(entry: RetryEntry): Promise<boolean> {
    const personContacts = resolveContacts(entry.notification).filter((c) => c.personId === entry.personId);
    if (personContacts.length === 0) {
      return false;
    }
    const { content, messageType } = resolveMessage(entry.notification);
    const safeContent = sanitizeSecrets(content);
    const commPlugins = getCommPlugins();

    for (const contact of personContacts) {
      const plugin = findPluginForChannel(contact.channel, commPlugins);
      if (!plugin) {
        continue;
      }
      const { delivered } = await tryDeliverToContact(contact, plugin, safeContent, messageType, entry.notification);
      if (delivered) {
        const idx = retryQueue.indexOf(entry);
        if (idx >= 0) {
          retryQueue.splice(idx, 1);
        }
        emitRetrySucceeded(entry, entry.notification.taskId as string, contact.channel, entry.attempts);
        return true;
      }
    }
    return false;
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
