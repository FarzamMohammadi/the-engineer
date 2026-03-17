/**
 * Observer real-time subscriber management.
 *
 * Simple pub/sub for live dashboard SSE. Subscriber errors are caught
 * and never propagate (fire-and-forget, same pattern as EventBus).
 *
 * Subscribers that throw 3 consecutive errors are auto-removed to prevent
 * dead callbacks from accumulating over the daemon's lifetime.
 */
import type { Observation } from "../../schemas/observer.js";

/** Auto-remove threshold: consecutive errors before a subscriber is evicted. */
const MAX_CONSECUTIVE_ERRORS = 3;

// ── ObserverStream ───────────────────────────────────────────────────────────

export class ObserverStream {
  private readonly subscribers = new Set<(obs: Observation) => void>();
  private readonly errorCounts = new Map<(obs: Observation) => void, number>();

  /** Subscribe to real-time observations. Returns unsubscribe function. */
  subscribe(callback: (obs: Observation) => void): () => void {
    this.subscribers.add(callback);
    this.errorCounts.delete(callback);
    return () => {
      this.subscribers.delete(callback);
      this.errorCounts.delete(callback);
    };
  }

  /**
   * Notify all subscribers. Errors are caught per-subscriber.
   * Subscribers that throw {@link MAX_CONSECUTIVE_ERRORS} consecutive errors
   * are auto-removed (dead subscriber eviction).
   */
  notify(obs: Observation): void {
    for (const callback of this.subscribers) {
      try {
        callback(obs);
        this.errorCounts.delete(callback);
      } catch (_error) {
        // Fire-and-forget: subscriber errors are silently swallowed.
        // Logging here would create a circular dependency (Observer → Logger → Observer).
        const count = (this.errorCounts.get(callback) ?? 0) + 1;
        if (count >= MAX_CONSECUTIVE_ERRORS) {
          this.subscribers.delete(callback);
          this.errorCounts.delete(callback);
        } else {
          this.errorCounts.set(callback, count);
        }
      }
    }
  }

  /** Number of active subscribers. */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Remove all subscribers. Useful during shutdown or dashboard restart. */
  clear(): void {
    this.subscribers.clear();
    this.errorCounts.clear();
  }
}
