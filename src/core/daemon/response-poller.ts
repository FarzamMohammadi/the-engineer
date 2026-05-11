import type { CommunicationAdapter } from "../../adapters/communication.js";
import type { InboundMessage } from "../../schemas/adapters.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { ExternalRef } from "../../schemas/task.js";
import { TaskStates } from "../../schemas/task.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
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

// ── Factory ──────────────────────────────────────────────────────────────────

export function createResponsePoller(ctx: ResponsePollerContext, unblockResolver: UnblockResolver): ResponsePoller {
  const { config, eventBus, registry, taskEngine, observer } = ctx;

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
    const blockedTasks = taskEngine.getTasksByState(TaskStates.blocked);

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
    let input = linkMessageToTask(msg);

    // Fallback: if message can't be linked via metadata (e.g., Telegram has no task context),
    // and exactly one task is blocked, assume the message is for that task.
    const soleBlockedTask = blockedTasks.length === 1 ? blockedTasks[0] : undefined;
    if (!input && soleBlockedTask) {
      input = {
        by: "task_id",
        taskId: soleBlockedTask.id,
        source: msg.source,
        content: msg.content,
      };
    }

    if (!input) {
      observer.warn("Inbound message could not be linked to a task — discarding", {
        source: msg.source,
        sender: msg.sender,
        blockedCount: blockedTasks.length,
      });
      return;
    }

    // Emit audit event
    eventBus.publish({
      type: "comm.message_received",
      source: "daemon",
      task_id: input.by === "task_id" ? input.taskId : null,
      payload: {
        source: msg.source,
        sender: msg.sender,
        content: msg.content,
        reply_to: msg.reply_to,
        task_id: input.by === "task_id" ? input.taskId : null,
        platform_metadata: msg.platform_metadata,
      },
    } satisfies PublishInput<"comm.message_received">);

    // Try to unblock
    const result = unblockResolver.tryUnblock(input);
    if (result.unblocked) {
      observer.info("Response unblocked task", {
        taskId: result.taskId,
        source: msg.source,
      });
    }
  }

  /** Scan event bus for comm.message_received events from non-plugin sources (dashboard). */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: nested conditionals for event filtering are inherent to the logic
  function scanEventBus(): void {
    const rows = eventBus.getEventsSince(lastEventSeq);
    for (const row of rows) {
      if (row.type === "comm.message_received" && row.source !== "daemon") {
        // Events from "daemon" source are ones WE published (from plugin messages above).
        // Only process events from other sources (e.g., "dashboard").
        const payload = row.payload as {
          source?: string;
          task_id?: string | null;
          content?: string;
        };
        if (payload.task_id) {
          unblockResolver.tryUnblock({
            by: "task_id",
            taskId: payload.task_id,
            source: payload.source ?? "unknown",
            ...(payload.content ? { content: payload.content } : {}),
          });
        }
      }
      lastEventSeq = row.sequence;
    }
  }

  return { poll };
}
