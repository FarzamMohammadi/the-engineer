import { AdapterMethodError } from "../../adapters/errors.js";
import type { TriggerAdapter } from "../../adapters/trigger.js";
import { AdapterTypes, type TriggerEvent } from "../../schemas/adapters.js";
import { EventTypes } from "../../schemas/events.js";
import { ObservationTypes } from "../../schemas/observer.js";
import { type TaskState, TaskStates } from "../../schemas/task.js";
import { sanitizeErrorMessage } from "../../utils/sanitize.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import { extractEventVariables } from "./event-variables.js";
import type { TriggerPollerContext } from "./types.js";

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
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum backoff interval for adaptive polling (5 minutes). */
const MAX_BACKOFF_MS = 300_000;

/** Maximum exponent for backoff calculation to avoid overflow. */
const MAX_BACKOFF_EXPONENT = 8;

// ── Factory ──────────────────────────────────────────────────────────────────

export function createTriggerPoller(ctx: TriggerPollerContext): TriggerPoller {
  const { config, eventBus, registry, taskEngine, observer } = ctx;

  // ── Internal State ──────────────────────────────────────────────────────
  const triggerLastPoll = new Map<string, number>();
  const triggerFailures = new Map<string, number>();
  const triggerRateLimitUntil = new Map<string, number>();
  const seenTriggerKeys = new Map<string, number>();

  // ── Adaptive Polling ────────────────────────────────────────────────────

  /** Compute effective poll interval with exponential backoff on failures. */
  function getEffectivePollInterval(pluginId: string, baseIntervalMs: number): number {
    const failures = triggerFailures.get(pluginId) ?? 0;

    if (failures === 0) {
      return baseIntervalMs;
    }

    const backoff = baseIntervalMs * 2 ** Math.min(failures, MAX_BACKOFF_EXPONENT);
    return Math.min(backoff, MAX_BACKOFF_MS);
  }

  // ── Polling ─────────────────────────────────────────────────────────────

  async function poll(now: number): Promise<void> {
    const triggers = registry.getPluginsByType<TriggerAdapter>(AdapterTypes.trigger);

    // Poll every trigger in parallel; allSettled so one plugin's failure never blocks the others.
    await Promise.allSettled(triggers.map((t) => pollSingleTrigger(t, now)));
  }

  async function pollSingleTrigger(trigger: TriggerAdapter, now: number): Promise<void> {
    const pluginId = trigger.manifest.id;

    const rateLimitUntil = triggerRateLimitUntil.get(pluginId) ?? 0;
    if (now < rateLimitUntil) {
      return;
    }

    const lastPoll = triggerLastPoll.get(pluginId) ?? 0;
    const baseInterval = trigger.manifest.poll_interval_ms ?? config.trigger_poll_interval_ms;
    const effectiveInterval = getEffectivePollInterval(pluginId, baseInterval);

    if (now - lastPoll < effectiveInterval) {
      return;
    }

    try {
      const events = await trigger.poll();
      triggerLastPoll.set(pluginId, now);
      triggerFailures.set(pluginId, 0);
      triggerRateLimitUntil.delete(pluginId);

      for (const event of events) {
        processNewTriggerEvent(event, now);
      }
    } catch (error) {
      handlePollFailure(pluginId, error, now, effectiveInterval);
    }
  }

  /**
   * Route a failed poll. A reported rate-limit (retry_after_ms) sets a per-plugin
   * deadline and is not counted as a failure — it is transient and self-resolving.
   * Any other error increments the failure counter and feeds exponential backoff.
   */
  function handlePollFailure(pluginId: string, error: unknown, now: number, effectiveInterval: number): void {
    if (error instanceof AdapterMethodError && error.adapterError.retry_after_ms !== null) {
      triggerRateLimitUntil.set(pluginId, now + error.adapterError.retry_after_ms);
      triggerLastPoll.set(pluginId, now);
      observer.warn("Trigger rate-limited — honoring retry_after_ms", {
        pluginId,
        retryAfterMs: error.adapterError.retry_after_ms,
      });
      return;
    }

    const failures = (triggerFailures.get(pluginId) ?? 0) + 1;
    triggerFailures.set(pluginId, failures);
    observer.warn("Trigger poll failed — backing off", {
      pluginId,
      capability: "trigger_polling",
      failures,
      retryInMs: effectiveInterval,
      error,
    });

    if (failures >= config.plugins.consecutive_failures_threshold) {
      emitHealthTriggerFailure(pluginId, failures, error);
    }
  }

  function processNewTriggerEvent(event: TriggerEvent, now: number): void {
    // 1. Hot cache check (fast path)
    const expiry = seenTriggerKeys.get(event.idempotency_key);
    if (expiry !== undefined && expiry > now) {
      return; // Already seen and not expired
    }

    // 2. DB check (cold path — durable dedup on idempotency_key). Runs for every
    // event regardless of external_ref, so a restart that wiped the hot cache still
    // suppresses duplicates — the crash-safe guarantee for all trigger plugins.
    if (taskEngine.findByIdempotencyKey(event.idempotency_key)) {
      seenTriggerKeys.set(event.idempotency_key, now + config.seen_keys_ttl_ms);
      emitRetriggerSuppressed(event.idempotency_key, taskEngine.findKeyHolder(event.idempotency_key));
      return;
    }

    // 3. Mark seen with TTL
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

    // Extract priority from ticket body (@priority: <number>)
    const vars = extractEventVariables(event.body);

    // Create task: intake → queued
    const task = taskEngine.createTask({
      title: event.title,
      repo: event.repo,
      source: event.source,
      idempotency_key: event.idempotency_key,
      description: event.body ?? "",
      external_ref: event.external_ref,
      clone_url: event.clone_url,
      thoughts_id: event.thoughts_id,
      ...(vars.priority !== undefined ? { priority: vars.priority } : {}),
    });

    taskEngine.requestTransition(task.id, TaskStates.queued, null, "new_trigger_event", "daemon");
    observer.info("Task created from trigger event", { taskId: task.id, title: event.title });
  }

  // A re-trigger was suppressed because a task already holds the key. Surface it (instead of a silent
  // debug log) on the holder's timeline, so a failed holder silently blocking re-triggers is visible.
  function emitRetriggerSuppressed(idempotencyKey: string, holder: { id: string; state: TaskState } | null): void {
    if (!holder) {
      // The gate found a holder; this sync follow-up did not (effectively never — better-sqlite3 is
      // synchronous, so nothing transitions between the two reads). Fall back to a quiet note.
      observer.debug("Re-trigger suppressed; holder no longer present", { idempotencyKey });
      return;
    }
    const failed = holder.state === TaskStates.failed;
    const hint = failed
      ? "A failed task holds this key. Run `engineer retry` to resume it, or `engineer cancel` to start fresh."
      : "A live task already holds this key — nothing to do until it finishes.";
    observer.observe(
      ObservationTypes.state_transition,
      "retrigger_suppressed",
      { idempotency_key: idempotencyKey, holder_task_id: holder.id, holder_state: holder.state, hint },
      { task_id: holder.id, level: failed ? "warn" : "info" },
    );
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
        last_error: sanitizeErrorMessage(error),
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

  return {
    poll,
    getSeenKeyCount,
    getTriggerFailures,
    cleanupExpiredKeys,
  };
}
