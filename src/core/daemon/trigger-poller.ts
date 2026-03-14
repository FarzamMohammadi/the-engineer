import type { Logger } from "pino";

import type { TriggerAdapter } from "../../adapters/trigger.js";
import { parseGitHubUrl, toExternalRef } from "../../plugins/github-shared/index.js";
import { AdapterTypes, type TriggerEvent } from "../../schemas/adapters.js";
import type { DaemonConfig } from "../../schemas/config.js";
import { EventTypes } from "../../schemas/events.js";
import { TaskStates } from "../../schemas/task.js";
import type { EventBus, PublishInput } from "../event-bus/index.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { Registry } from "../registry/index.js";
import type { Clock } from "./index.js";

// ── DaemonContext (subset) ───────────────────────────────────────────────────

export interface DaemonContext {
  config: DaemonConfig;
  eventBus: EventBus;
  registry: Registry;
  taskEngine: ITaskEngine;
  clock: Clock;
  logger: Logger;
  [key: string]: unknown;
}

// ── TriggerPoller Interface ──────────────────────────────────────────────────

/** Polls trigger plugins for new events and creates tasks. */
export interface TriggerPoller {
  /** Poll all registered triggers and process new events. */
  poll(now: number): Promise<void>;
  /** Get the current count of seen (deduped) trigger keys. */
  getSeenKeyCount(): number;
  /** Get failure counts per trigger plugin. */
  getTriggerFailures(): Record<string, number>;
  /** Clean up expired seen keys. */
  cleanupExpiredKeys(now: number): void;
  /** Track a base priority for a newly created task (for aging). */
  getBasePriorities(): Map<string, number>;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum backoff interval for adaptive polling (5 minutes). */
const MAX_BACKOFF_MS = 300_000;

/** Maximum exponent for backoff calculation to avoid overflow. */
const MAX_BACKOFF_EXPONENT = 8;

// ── Factory ──────────────────────────────────────────────────────────────────

export function createTriggerPoller(ctx: DaemonContext): TriggerPoller {
  const { config, eventBus, registry, taskEngine, logger } = ctx;

  // ── Internal State ──────────────────────────────────────────────────────
  const triggerLastPoll = new Map<string, number>();
  const triggerFailures = new Map<string, number>();
  const seenTriggerKeys = new Map<string, number>();
  const basePriorities = new Map<string, number>();

  // ── Adaptive Polling ────────────────────────────────────────────────────

  /** Compute effective poll interval with exponential backoff on failures. */
  function getEffectivePollInterval(pluginId: string): number {
    const failures = triggerFailures.get(pluginId) ?? 0;
    if (failures === 0) {
      return config.trigger_poll_interval_ms;
    }
    const backoff = config.trigger_poll_interval_ms * 2 ** Math.min(failures, MAX_BACKOFF_EXPONENT);
    return Math.min(backoff, MAX_BACKOFF_MS);
  }

  // ── Polling ─────────────────────────────────────────────────────────────

  async function poll(now: number): Promise<void> {
    const triggers = registry.getPluginsByType<TriggerAdapter>(AdapterTypes.trigger);

    // N+1 batch fetch: poll all triggers in parallel
    await Promise.allSettled(triggers.map((t) => pollSingleTrigger(t, now)));
  }

  async function pollSingleTrigger(trigger: TriggerAdapter, now: number): Promise<void> {
    const pluginId = trigger.manifest.id;
    const lastPoll = triggerLastPoll.get(pluginId) ?? 0;
    const effectiveInterval = getEffectivePollInterval(pluginId);

    if (now - lastPoll < effectiveInterval) {
      return;
    }

    try {
      const events = await trigger.poll();
      triggerLastPoll.set(pluginId, now);
      triggerFailures.set(pluginId, 0); // Reset on success

      for (const event of events) {
        processNewTriggerEvent(event, now);
      }
    } catch (error) {
      const failures = (triggerFailures.get(pluginId) ?? 0) + 1;
      triggerFailures.set(pluginId, failures);
      logger.warn({ pluginId, failures, error }, "Trigger poll failed");

      if (failures >= config.plugins.consecutive_failures_threshold) {
        emitHealthTriggerFailure(pluginId, failures, error);
      }
    }
  }

  function processNewTriggerEvent(event: TriggerEvent, now: number): void {
    const expiry = seenTriggerKeys.get(event.idempotency_key);
    if (expiry !== undefined && expiry > now) {
      return; // Already seen and not expired
    }

    // Mark seen with TTL
    seenTriggerKeys.set(event.idempotency_key, now + config.seen_keys_ttl_ms);

    // Emit trigger.new_event
    eventBus.publish({
      type: EventTypes["trigger.new_event"],
      source: "daemon",
      task_id: null,
      payload: {
        idempotency_key: event.idempotency_key,
        source: event.source,
        event_type: event.event_type,
        external_ref: event.external_ref,
        title: event.title,
        body: event.body,
        repo: event.repo,
        clone_url: event.clone_url,
        metadata: event.metadata,
      },
    } satisfies PublishInput<"trigger.new_event">);

    // Create task: intake → queued
    const parsed = parseGitHubUrl(event.external_ref);
    const externalRef = parsed
      ? toExternalRef(parsed.owner, parsed.repo, parsed.number, parsed.type)
      : null;

    const task = taskEngine.createTask({
      title: event.title,
      repo: event.repo,
      source: event.source,
      description: event.body ?? "",
      external_ref: externalRef,
      clone_url: event.clone_url,
    });

    taskEngine.requestTransition(task.id, TaskStates.queued, null, "new_trigger_event", "daemon");
    basePriorities.set(task.id, task.priority);
    logger.info({ taskId: task.id, title: event.title }, "Task created from trigger event");
  }

  // ── Health Events ───────────────────────────────────────────────────────

  function emitHealthTriggerFailure(pluginId: string, failures: number, error: unknown): void {
    eventBus.publish({
      type: EventTypes["health.trigger_failure"],
      source: "daemon",
      task_id: null,
      payload: {
        trigger_id: pluginId,
        consecutive_failures: failures,
        threshold: config.plugins.consecutive_failures_threshold,
        last_error: error instanceof Error ? error.message : String(error),
        last_success: null,
      },
    } satisfies PublishInput<"health.trigger_failure">);
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  function cleanupExpiredKeys(now: number): void {
    for (const [key, expiry] of seenTriggerKeys) {
      if (expiry <= now) {
        seenTriggerKeys.delete(key);
      }
    }
  }

  // ── Accessors ───────────────────────────────────────────────────────────

  function getSeenKeyCount(): number {
    return seenTriggerKeys.size;
  }

  function getTriggerFailures(): Record<string, number> {
    const failures: Record<string, number> = {};
    for (const [id, count] of triggerFailures) {
      failures[id] = count;
    }
    return failures;
  }

  function getBasePriorities(): Map<string, number> {
    return basePriorities;
  }

  return {
    poll,
    getSeenKeyCount,
    getTriggerFailures,
    cleanupExpiredKeys,
    getBasePriorities,
  };
}
