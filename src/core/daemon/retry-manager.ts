import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CommunicationAdapter } from "../../adapters/communication.js";
import { AdapterTypes } from "../../schemas/adapters.js";
import type { MessageType } from "../../schemas/adapters.js";
import type { DaemonConfig } from "../../schemas/config.js";
import type {
  RetryAttemptResult,
  RetryConfig,
  RetryScheduleEntry,
  RetryState,
  ScheduleRetryInput,
} from "../../schemas/retry.js";
import { TaskStates } from "../../schemas/task.js";
import type { PublishInput } from "../interfaces/event-bus.interface.js";
import type { IEventBus } from "../interfaces/event-bus.interface.js";
import type { IPluginLookup } from "../interfaces/plugin-lookup.interface.js";
import type { ITaskEngine } from "../interfaces/task-engine.interface.js";
import type { IObserver } from "../observer/index.js";

// ── Interface ────────────────────────────────────────────────────────────────

export interface RetryManager {
  /** Schedule a retry for failed outreach delivery. */
  scheduleRetry(input: ScheduleRetryInput): void;

  /** Poll for retry schedules and process due attempts. */
  poll(now: number): Promise<void>;

  /** Clean up retry schedules for completed/failed tasks. */
  cleanup(): void;

  /** Get current retry statistics for observability. */
  getStats(): {
    activeRetries: number;
    totalAttempts: number;
    successfulRetries: number;
  };
}

export interface RetryManagerContext {
  config: DaemonConfig;
  registry: IPluginLookup;
  taskEngine: ITaskEngine;
  eventBus: IEventBus;
  observer: IObserver;
  dataDir: string;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createRetryManager(ctx: RetryManagerContext): RetryManager {
  const { config, registry, taskEngine, eventBus, observer, dataDir } = ctx;
  const retryConfig = config.retry;

  // State file path
  const stateFile = join(dataDir, "retry-state.json");

  // In-memory retry state
  let retryState: RetryState = loadRetryState();

  // Statistics tracking
  let stats = {
    totalAttempts: 0,
    successfulRetries: 0,
  };

  // ── State Persistence ─────────────────────────────────────────────────────

  function loadRetryState(): RetryState {
    try {
      const content = readFileSync(stateFile, "utf-8");
      const parsed = JSON.parse(content);

      // Validate and return with defaults
      return {
        schedules: parsed.schedules || {},
        last_cleanup_at: parsed.last_cleanup_at || null,
      };
    } catch (err) {
      observer.debug("No existing retry state found, starting fresh", {
        error: err instanceof Error ? err.message : String(err)
      });
      return { schedules: {}, last_cleanup_at: null };
    }
  }

  function saveRetryState(): void {
    try {
      writeFileSync(stateFile, JSON.stringify(retryState, null, 2), "utf-8");
    } catch (err) {
      observer.error("Failed to save retry state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Plugin Lookup ────────────────────────────────────────────────────────

  function getCommPlugins(): CommunicationAdapter[] {
    return registry.getPluginsByType<CommunicationAdapter>(AdapterTypes.communication);
  }

  function findPluginForChannel(
    channel: string,
    plugins: CommunicationAdapter[],
  ): CommunicationAdapter | null {
    return (
      plugins.find(
        (p) => p.hasCapability("send") && p.manifest.adapter_meta["channel"] === channel,
      ) ?? null
    );
  }

  // ── Retry Scheduling ─────────────────────────────────────────────────────

  function scheduleRetry(input: ScheduleRetryInput): void {
    const now = new Date().toISOString();
    const entryId = randomUUID();

    const entry: RetryScheduleEntry = {
      id: entryId,
      task_id: input.task_id,
      contact: input.contact,
      notification: input.notification,
      scheduled_at: now,
      next_retry_at: new Date(Date.now() + retryConfig.outreach_retry_interval_ms).toISOString(),
      attempt_count: 0,
      attempts: [],
      paused: false,
      current_backoff_ms: retryConfig.outreach_retry_interval_ms,
    };

    retryState.schedules[entryId] = entry;
    saveRetryState();

    observer.debug("Scheduled retry for failed outreach", {
      taskId: input.task_id,
      personId: input.contact.person_id,
      channel: input.contact.channel,
      retryAt: entry.next_retry_at,
    });

    // Emit observability event
    eventBus.publish({
      type: "outreach.retry_scheduled",
      source: "retry-manager",
      task_id: input.task_id,
      payload: {
        task_id: input.task_id,
        person_id: input.contact.person_id,
        channel: input.contact.channel,
        next_retry_at: entry.next_retry_at,
        initial_failure: input.initial_failure_reason ?? "unknown",
      },
    });
  }

  // ── Retry Processing ──────────────────────────────────────────────────────

  async function poll(now: number): Promise<void> {
    await processRetryAttempts(now);
    if (shouldRunCleanup(now)) {
      cleanup();
    }
  }

  async function processRetryAttempts(now: number): Promise<void> {
    const nowMs = now;
    const commPlugins = getCommPlugins();

    const dueRetries = Object.values(retryState.schedules).filter(entry => {
      if (entry.paused) return false;

      // Check if task is still active
      const task = taskEngine.getTask(entry.task_id);
      if (!task || task.state === TaskStates.completed || task.state === TaskStates.failed) {
        return false;
      }

      // Check if retry is due
      const retryTime = new Date(entry.next_retry_at).getTime();
      return retryTime <= nowMs;
    });

    if (dueRetries.length > 0) {
      observer.debug("Processing retry attempts", { count: dueRetries.length });
    }

    // Process retries sequentially to avoid overwhelming plugins
    for (const entry of dueRetries) {
      await processRetryEntry(entry, commPlugins, nowMs);
    }
  }

  async function processRetryEntry(
    entry: RetryScheduleEntry,
    commPlugins: CommunicationAdapter[],
    nowMs: number,
  ): Promise<void> {
    const plugin = findPluginForChannel(entry.contact.channel, commPlugins);
    if (!plugin) {
      observer.debug("No plugin for retry channel - removing entry", {
        channel: entry.contact.channel,
        taskId: entry.task_id,
      });
      delete retryState.schedules[entry.id];
      saveRetryState();
      return;
    }

    stats.totalAttempts++;
    entry.attempt_count++;

    const attempt = {
      attempted_at: new Date(nowMs).toISOString(),
      success: false,
      error_message: null,
      retryable: null,
      retry_after_ms: null,
    };

    try {
      const result = await attemptRetryDelivery(entry, plugin);

      // Update attempt record
      attempt.success = result.success;
      attempt.error_message = result.error_message;
      attempt.retryable = result.retryable;
      attempt.retry_after_ms = result.retry_after_ms;

      entry.attempts.push(attempt);

      if (result.success) {
        // Success - remove from retry schedule
        stats.successfulRetries++;
        delete retryState.schedules[entry.id];

        observer.info("Retry delivery succeeded", {
          taskId: entry.task_id,
          personId: entry.contact.person_id,
          channel: entry.contact.channel,
          attemptCount: entry.attempt_count,
        });

        eventBus.publish({
          type: "outreach.retry_succeeded",
          source: "retry-manager",
          task_id: entry.task_id,
          payload: {
            task_id: entry.task_id,
            person_id: entry.contact.person_id,
            channel: entry.contact.channel,
            attempt_count: entry.attempt_count,
          },
        });
      } else if (result.should_continue) {
        // Failure but should retry - schedule next attempt
        scheduleNextRetry(entry, result);
      } else {
        // Failure and should not continue - remove from schedule
        delete retryState.schedules[entry.id];

        observer.warn("Retry abandoned due to permanent failure or max attempts", {
          taskId: entry.task_id,
          personId: entry.contact.person_id,
          channel: entry.contact.channel,
          attemptCount: entry.attempt_count,
          error: result.error_message,
        });

        eventBus.publish({
          type: "outreach.retry_abandoned",
          source: "retry-manager",
          task_id: entry.task_id,
          payload: {
            task_id: entry.task_id,
            person_id: entry.contact.person_id,
            channel: entry.contact.channel,
            attempt_count: entry.attempt_count,
            reason: result.error_message ?? "unknown",
          },
        });
      }
    } catch (err) {
      // Unexpected error during retry
      attempt.error_message = err instanceof Error ? err.message : String(err);
      attempt.retryable = true;
      entry.attempts.push(attempt);

      observer.warn("Unexpected error during retry attempt", {
        taskId: entry.task_id,
        personId: entry.contact.person_id,
        channel: entry.contact.channel,
        error: attempt.error_message,
      });

      // Schedule next retry with backoff
      scheduleNextRetry(entry, {
        success: false,
        error_message: attempt.error_message,
        retryable: true,
        retry_after_ms: null,
        should_continue: true,
      });
    }

    saveRetryState();
  }

  async function attemptRetryDelivery(
    entry: RetryScheduleEntry,
    plugin: CommunicationAdapter,
  ): Promise<RetryAttemptResult> {
    try {
      const formatted = plugin.formatMessage(
        entry.notification.content,
        entry.notification.message_type as MessageType,
      );

      const result = await plugin.sendMessage(
        { user_id: entry.contact.handle, channel: entry.contact.channel },
        {
          content: formatted,
          metadata: {
            task_id: entry.task_id,
            type: entry.notification.message_type,
            retry_attempt: entry.attempt_count + 1,
          }
        },
      );

      if (result.success) {
        // Emit successful delivery event
        eventBus.publish({
          type: "comm.message_sent",
          source: "retry-manager",
          task_id: entry.task_id,
          payload: {
            task_id: entry.task_id,
            target: entry.contact.person_id,
            message_type: entry.notification.message_type as MessageType,
            content_summary: entry.notification.content,
            channel: entry.contact.channel,
          },
        } satisfies PublishInput<"comm.message_sent">);

        return {
          success: true,
          error_message: null,
          retryable: null,
          retry_after_ms: null,
          should_continue: false,
        };
      }

      // Failed delivery - check if should continue retrying
      const error = result.error;
      const shouldContinue = checkShouldContinueRetry(entry, error);

      return {
        success: false,
        error_message: error?.message ?? "unknown send failure",
        retryable: error?.retryable ?? null,
        retry_after_ms: error?.retry_after ?? null,
        should_continue: shouldContinue,
      };
    } catch (err) {
      return {
        success: false,
        error_message: err instanceof Error ? err.message : String(err),
        retryable: true,
        retry_after_ms: null,
        should_continue: checkShouldContinueRetry(entry, null),
      };
    }
  }

  function checkShouldContinueRetry(
    entry: RetryScheduleEntry,
    error: { retryable?: boolean } | null,
  ): boolean {
    // Check max attempts limit
    if (retryConfig.max_outreach_retry_attempts !== null) {
      if (entry.attempt_count >= retryConfig.max_outreach_retry_attempts) {
        return false;
      }
    }

    // Check if error is explicitly not retryable
    if (error && error.retryable === false) {
      return false;
    }

    return true;
  }

  function scheduleNextRetry(
    entry: RetryScheduleEntry,
    result: RetryAttemptResult,
  ): void {
    let nextBackoff = entry.current_backoff_ms;

    // Use plugin-specified retry_after if available
    if (result.retry_after_ms) {
      nextBackoff = result.retry_after_ms;
    } else if (retryConfig.adaptive_backoff_enabled) {
      // Apply adaptive backoff (exponential backoff with max)
      nextBackoff = Math.min(
        entry.current_backoff_ms * 2,
        retryConfig.max_backoff_interval_ms,
      );
    }

    entry.current_backoff_ms = nextBackoff;
    entry.next_retry_at = new Date(Date.now() + nextBackoff).toISOString();

    observer.debug("Scheduled next retry attempt", {
      taskId: entry.task_id,
      personId: entry.contact.person_id,
      channel: entry.contact.channel,
      attemptCount: entry.attempt_count,
      nextRetryAt: entry.next_retry_at,
      backoffMs: nextBackoff,
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  function shouldRunCleanup(now: number): boolean {
    if (!retryState.last_cleanup_at) {
      return true;
    }

    const lastCleanup = new Date(retryState.last_cleanup_at).getTime();
    const cleanupInterval = 3_600_000; // 1 hour
    return now - lastCleanup > cleanupInterval;
  }

  function cleanup(): void {
    const now = new Date().toISOString();
    let removedCount = 0;

    // Remove retry schedules for completed/failed tasks
    for (const [entryId, entry] of Object.entries(retryState.schedules)) {
      const task = taskEngine.getTask(entry.task_id);
      if (!task || task.state === TaskStates.completed || task.state === TaskStates.failed) {
        delete retryState.schedules[entryId];
        removedCount++;
      }
    }

    // Remove old completed schedules (older than 7 days)
    const oldThreshold = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    for (const [entryId, entry] of Object.entries(retryState.schedules)) {
      const scheduledAt = new Date(entry.scheduled_at).getTime();
      if (scheduledAt < oldThreshold && entry.attempts.some(a => a.success)) {
        delete retryState.schedules[entryId];
        removedCount++;
      }
    }

    retryState.last_cleanup_at = now;
    saveRetryState();

    if (removedCount > 0) {
      observer.debug("Cleaned up retry schedules", { removedCount });
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  function getStats(): { activeRetries: number; totalAttempts: number; successfulRetries: number } {
    return {
      activeRetries: Object.keys(retryState.schedules).length,
      totalAttempts: stats.totalAttempts,
      successfulRetries: stats.successfulRetries,
    };
  }

  // ── Event Subscriptions ──────────────────────────────────────────────────

  // Subscribe to task state changes to clean up retries for terminal states
  eventBus.subscribe("task.state_changed", (event) => {
    const payload = event.payload;
    if (payload.to_state === TaskStates.completed || payload.to_state === TaskStates.failed) {
      // Remove retry schedules for this task
      const removedEntries: string[] = [];
      for (const [entryId, entry] of Object.entries(retryState.schedules)) {
        if (entry.task_id === payload.task_id) {
          delete retryState.schedules[entryId];
          removedEntries.push(entryId);
        }
      }

      if (removedEntries.length > 0) {
        saveRetryState();
        observer.debug("Cleaned up retries for terminal task", {
          taskId: payload.task_id,
          state: payload.to_state,
          removedEntries: removedEntries.length,
        });
      }
    }
  });

  return { scheduleRetry, poll, cleanup, getStats };
}