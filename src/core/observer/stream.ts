/**
 * Observer real-time subscriber management.
 *
 * Simple pub/sub for live dashboard SSE. Subscriber errors are caught
 * and never propagate (fire-and-forget, same pattern as EventBus).
 */
import type { Observation } from "../../schemas/observer.js";

// ── ObserverStream ───────────────────────────────────────────────────────────

export class ObserverStream {
  private readonly subscribers = new Set<(obs: Observation) => void>();

  /** Subscribe to real-time observations. Returns unsubscribe function. */
  subscribe(callback: (obs: Observation) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /** Notify all subscribers. Errors are caught per-subscriber and logged. */
  notify(obs: Observation): void {
    for (const callback of this.subscribers) {
      try {
        callback(obs);
      } catch (error) {
        console.error(
          "[Observer] Subscriber error (fire-and-forget):",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /** Number of active subscribers. */
  subscriberCount(): number {
    return this.subscribers.size;
  }
}
