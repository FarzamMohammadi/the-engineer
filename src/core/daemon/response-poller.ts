import type { CommunicationAdapter } from "../../adapters/communication.js";
import type { InboundMessage } from "../../schemas/adapters.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { CommMessageReceivedPayload } from "../../schemas/events.js";
import type { ExternalRef } from "../../schemas/task.js";
import { BlockReasons, TaskStates } from "../../schemas/task.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import { type QueryHandlerDeps, type QueryRoutingReason, handleQuery, isCommand } from "./query-handler.js";
import type { ResponsePollerContext } from "./types.js";
import type { UnblockInput, UnblockResolver } from "./unblock-resolver.js";

// ── Interface ────────────────────────────────────────────────────────────────

/** Polls communication plugins for responses to blocked tasks. */
export interface ResponsePoller {
  /** Poll for responses and process dashboard events. */
  poll(now: number): Promise<void>;
}

// ── Pure Functions ───────────────────────────────────────────────────────────

/** Build a channel string from an ExternalRef (e.g., "owner/repo#42"). */
export function buildChannel(ref: ExternalRef): string {
  return `${ref.repo}#${ref.id}`;
}

/** Link an inbound message to an UnblockInput via platform_metadata. */
export function linkMessageToTask(msg: InboundMessage): UnblockInput | null {
  const meta = msg.platform_metadata as Record<string, unknown>;
  const taskId = meta["task_id"];
  const externalRef = meta["external_ref"];

  // Direct task_id (dashboard, future APIs)
  if (typeof taskId === "string") {
    return { by: "task_id", taskId, source: msg.source, content: msg.content };
  }

  // Structured external_ref from adapter metadata (plugin-agnostic)
  if (
    externalRef &&
    typeof externalRef === "object" &&
    "repo" in externalRef &&
    "id" in externalRef &&
    typeof (externalRef as Record<string, unknown>)["repo"] === "string" &&
    typeof (externalRef as Record<string, unknown>)["id"] === "string"
  ) {
    return {
      by: "external_ref",
      ref: externalRef as ExternalRef,
      source: msg.source,
      content: msg.content,
    };
  }

  return null;
}

/**
 * How the poller routes one inbound message. `linked_reply` already names a task via metadata;
 * `sole_blocked_reply` is the free-text answer to the one blocked task; `query` is a general query carrying
 * the routing reason (for observability and the multi-blocked diagnostic). Classification runs BEFORE the
 * sole-blocked fallback so an explicit query is never mis-attributed as an unblock reply.
 */
export type InboundRoute =
  | { route: "linked_reply" }
  | { route: "sole_blocked_reply" }
  | { route: "query"; reason: QueryRoutingReason; blockedCount: number };

/**
 * Decide whether an inbound message is an unblock reply or a general query.
 *
 * Order of decision (the precedence is deliberate — see `docs/plugins/communication/README.md`):
 * 1. Linked via metadata (task_id / external_ref) → it explicitly names a task → reply.
 * 2. Command vocabulary (!status / !cost / !progress #N / !help) → query. This WINS over the sole-blocked
 *    reply, so the owner can send "!status" even while exactly one task is blocked.
 * 3. Exactly one task blocked → reply (the sole-blocked fallback: a free-text answer to the one question).
 * 4. Zero or 2+ tasks blocked → query. With none blocked there is nothing to reply to; with several, a
 *    token-less message cannot be matched to one, so it is routed to the handler with a diagnostic reason.
 */
export function classifyInbound(hasLinkedTask: boolean, content: string, blockedCount: number): InboundRoute {
  if (hasLinkedTask) {
    return { route: "linked_reply" };
  }
  if (isCommand(content)) {
    return { route: "query", reason: "command", blockedCount };
  }
  if (blockedCount === 1) {
    return { route: "sole_blocked_reply" };
  }
  const reason: QueryRoutingReason = blockedCount === 0 ? "no_blocked_task" : "unmatched_multi_blocked";
  return { route: "query", reason, blockedCount };
}

/** Human-readable reasoning for the routing decision, for the recorded `inbound_route` observation. */
function reasonForRoute(decision: InboundRoute, blockedCount: number): string {
  switch (decision.route) {
    case "linked_reply":
      return "Message carries task metadata (task_id / external_ref) — routed as an unblock reply";
    case "sole_blocked_reply":
      return "No metadata and exactly one task blocked — routed the free-text message as that task's reply";
    default:
      return reasonForQueryRoute(decision.reason, blockedCount);
  }
}

/** Why a message was routed to the query handler rather than treated as an unblock reply. */
function reasonForQueryRoute(reason: QueryRoutingReason, blockedCount: number): string {
  switch (reason) {
    case "command":
      return "Matches the command vocabulary (!status/!cost/!progress/!help) — routed to the query handler, which wins over the sole-blocked reply";
    case "no_blocked_task":
      return "No metadata and no task blocked — nothing to reply to, routed to the query handler";
    default:
      return `No metadata and ${String(blockedCount)} tasks blocked — cannot match to one, routed to the query handler with a couldn't-match notice`;
  }
}

/** Build the query-handler payload from an inbound message. task_id mirrors the resolved reply input (null for a query). */
function toQueryPayload(msg: InboundMessage, input: UnblockInput | null): CommMessageReceivedPayload {
  return {
    source: msg.source,
    sender: msg.sender,
    content: msg.content,
    reply_to: msg.reply_to,
    task_id: input?.by === "task_id" ? input.taskId : null,
    platform_metadata: msg.platform_metadata,
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createResponsePoller(ctx: ResponsePollerContext, unblockResolver: UnblockResolver): ResponsePoller {
  const { config, eventBus, registry, taskEngine, safetyLayer, notifications, peopleDirectory, observer } = ctx;

  const queryDeps: QueryHandlerDeps = { taskEngine, safetyLayer, notifications, peopleDirectory, observer };

  // Per-plugin cursor for pollMessages
  const pluginCursors = new Map<string, string>();
  // Failure tracking for adaptive backoff (same pattern as trigger-poller)
  const pluginFailures = new Map<string, number>();
  // Last processed event sequence for event bus scanning (dashboard responses).
  // Initialize to current max sequence — skip historical events on startup/restart.
  // Only new events written after this point will be processed.
  const startupEvents = eventBus.getEventsSince(0);
  let lastEventSeq = startupEvents.length > 0 ? (startupEvents[startupEvents.length - 1]?.sequence ?? 0) : 0;

  /** Maximum backoff interval (5 minutes, same as trigger-poller). */
  const MAX_BACKOFF_MS = 300_000;
  const MAX_BACKOFF_EXPONENT = 8;

  function getEffectivePollInterval(pluginId: string): number {
    const failures = pluginFailures.get(pluginId) ?? 0;
    if (failures === 0) {
      return config.response_poll_interval_ms;
    }
    const backoff = config.response_poll_interval_ms * 2 ** Math.min(failures, MAX_BACKOFF_EXPONENT);
    return Math.min(backoff, MAX_BACKOFF_MS);
  }

  // Per-plugin last poll timestamp
  const pluginLastPoll = new Map<string, number>();

  async function poll(now: number): Promise<void> {
    // 1. Poll comm plugins with "receive" capability for blocked task responses
    await pollCommPlugins(now);

    // 2. Scan event bus for comm.message_received from non-plugin sources (dashboard)
    scanEventBus();
  }

  async function pollCommPlugins(now: number): Promise<void> {
    // Always poll — comm plugins capture /start handshakes and general
    // messages even when no tasks are blocked.
    //
    // PR-review-pending tasks resume only through PR events (the PR-event poller), never a human comment, so
    // they are excluded here: their channels are not polled and the sole-blocked-task fallback never targets
    // them. The unblock-resolver guard is the authoritative backstop (it also covers the dashboard path).
    const blockedTasks = taskEngine
      .getTasksByState(TaskStates.blocked)
      .filter((task) => task.blocked?.reason !== BlockReasons.pr_review_pending);

    // Build channel list from blocked tasks' external_ref (may be empty for Telegram-only tasks)
    const channels: string[] = [];
    for (const task of blockedTasks) {
      if (task.external_ref) {
        channels.push(buildChannel(task.external_ref));
      }
    }

    // Get receive-capable comm plugins
    const commPlugins = registry.getPluginsByType<CommunicationAdapter>(AdapterTypes.communication);
    const receivePlugins = commPlugins.filter((p) => p.hasCapability("receive"));

    // Poll each plugin (channels may be empty — Telegram ignores them, uses getUpdates)
    await Promise.allSettled(receivePlugins.map((plugin) => pollSinglePlugin(plugin, channels, now, blockedTasks)));
  }

  async function pollSinglePlugin(
    plugin: CommunicationAdapter,
    channels: string[],
    now: number,
    blockedTasks: Array<{ id: string }>,
  ): Promise<void> {
    const pluginId = plugin.manifest.id;

    // Respect poll interval with adaptive backoff
    const lastPoll = pluginLastPoll.get(pluginId) ?? 0;
    const effectiveInterval = getEffectivePollInterval(pluginId);
    if (now - lastPoll < effectiveInterval) {
      return;
    }

    // Default cursor to "now" on first poll — skip historical comments that predate blocking
    const cursor = pluginCursors.get(pluginId) ?? new Date(now).toISOString();

    try {
      const result = await plugin.pollMessages(channels, cursor);
      pluginLastPoll.set(pluginId, now);
      pluginFailures.set(pluginId, 0);
      pluginCursors.set(pluginId, result.cursor);

      for (const msg of result.messages) {
        processInboundMessage(msg, blockedTasks);
      }
    } catch (err) {
      const failures = (pluginFailures.get(pluginId) ?? 0) + 1;
      pluginFailures.set(pluginId, failures);
      observer.warn("Response poll failed", {
        pluginId,
        failures,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function processInboundMessage(msg: InboundMessage, blockedTasks: Array<{ id: string }>): void {
    const linked = linkMessageToTask(msg);
    const decision = classifyInbound(linked !== null, msg.content, blockedTasks.length);
    recordInboundRoute(msg, decision, blockedTasks.length);

    // Resolve the unblock input the route implies (null for a query): the metadata link, or the sole blocked
    // task for the free-text fallback. The audit event's task_id mirrors this — null when routed as a query.
    const input = resolveReplyInput(decision, linked, msg, blockedTasks);
    publishReceivedAudit(msg, input);

    if (decision.route === "query") {
      handleQuery(toQueryPayload(msg, input), queryDeps, {
        reason: decision.reason,
        blockedCount: decision.blockedCount,
      });
      return;
    }

    if (!input) {
      return;
    }
    const result = unblockResolver.tryUnblock(input);
    if (result.unblocked) {
      observer.info("Response unblocked task", { taskId: result.taskId, source: msg.source });
    }
  }

  /** The unblock input a reply route implies, or null for a query route (which never unblocks a task). */
  function resolveReplyInput(
    decision: InboundRoute,
    linked: UnblockInput | null,
    msg: InboundMessage,
    blockedTasks: Array<{ id: string }>,
  ): UnblockInput | null {
    if (decision.route === "linked_reply") {
      return linked;
    }
    if (decision.route === "sole_blocked_reply") {
      const soleBlockedTask = blockedTasks[0];
      return soleBlockedTask
        ? { by: "task_id", taskId: soleBlockedTask.id, source: msg.source, content: msg.content }
        : null;
    }
    return null;
  }

  /** Record the query-vs-reply classification so the routing (invisible today) is inspectable on the dashboard. */
  function recordInboundRoute(msg: InboundMessage, decision: InboundRoute, blockedCount: number): void {
    const chosen = decision.route;
    observer.recordDecision(
      "inbound_route",
      `Inbound "${msg.source}" message classified with ${String(blockedCount)} task(s) blocked`,
      [
        { id: "linked_reply", description: "Metadata links it to a task — route as an unblock reply" },
        {
          id: "sole_blocked_reply",
          description: "Free-text answer to the one blocked task — route as an unblock reply",
        },
        {
          id: "query",
          description: "General query (status/cost/progress/help, or unmatchable) — route to the query handler",
        },
      ],
      chosen,
      reasonForRoute(decision, blockedCount),
      decision.route === "query" && decision.reason === "unmatched_multi_blocked" ? 0.5 : 1,
    );
  }

  /** The audit-trail event. task_id is non-null only for a reply that resolved a concrete task. */
  function publishReceivedAudit(msg: InboundMessage, input: UnblockInput | null): void {
    const taskId = input?.by === "task_id" ? input.taskId : null;
    eventBus.publish({
      type: "comm.message_received",
      source: "daemon",
      task_id: taskId,
      payload: {
        source: msg.source,
        sender: msg.sender,
        content: msg.content,
        reply_to: msg.reply_to,
        task_id: taskId,
        platform_metadata: msg.platform_metadata,
      },
    } satisfies PublishInput<"comm.message_received">);
  }

  /** Scan event bus for comm.message_received events from non-plugin sources (dashboard). */
  function scanEventBus(): void {
    const rows = eventBus.getEventsSince(lastEventSeq);
    for (const row of rows) {
      // Advance the cursor for every scanned row up front, before any filter — the next poll
      // must never re-read a row we have already inspected, whether or not it matched.
      lastEventSeq = row.sequence;

      // Events from "daemon" source are ones WE published (from plugin messages above).
      // Only process comm.message_received from other sources (e.g., "dashboard").
      if (row.type !== "comm.message_received" || row.source === "daemon") {
        continue;
      }
      const payload = row.payload as {
        source?: string;
        task_id?: string | null;
        content?: string;
      };
      if (!payload.task_id) {
        continue;
      }
      unblockResolver.tryUnblock({
        by: "task_id",
        taskId: payload.task_id,
        source: payload.source ?? "unknown",
        ...(payload.content ? { content: payload.content } : {}),
      });
    }
  }

  return { poll };
}
