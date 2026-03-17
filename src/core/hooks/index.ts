import type { IObserver } from "../observer/index.js";

// ── Hook Points ───────────────────────────────────────────────────────────────

/** Hook points in The Engineer lifecycle. */
export type HookPoint =
  | "pre:task:create"
  | "post:task:create"
  | "pre:task:transition"
  | "post:task:transition"
  | "pre:phase:start"
  | "post:phase:complete"
  | "pre:tool:execute"
  | "post:tool:execute"
  | "pre:publish"
  | "post:publish";

export interface HookContext {
  hookPoint: HookPoint;
  data: Record<string, unknown>;
  timestamp: string;
}

export type HookHandler = (context: HookContext) => Promise<void> | void;

// ── Errors ────────────────────────────────────────────────────────────────────

export class HookAbortError extends Error {
  readonly pluginId: string;
  readonly reason: string;

  constructor(pluginId: string, reason: string) {
    super(`Hook aborted by ${pluginId}: ${reason}`);
    this.name = "HookAbortError";
    this.pluginId = pluginId;
    this.reason = reason;
  }
}

// ── Hook Registry ─────────────────────────────────────────────────────────────

interface HookEntry {
  pluginId: string;
  handler: HookHandler;
}

/**
 * Lightweight hook system that plugins can tap into for lifecycle events.
 *
 * Handlers execute sequentially in registration order.
 * - `pre:` hooks: HookAbortError propagates (aborts the operation).
 *   Other errors are logged and execution continues.
 * - `post:` hooks: All errors are logged, never abort.
 */
export class HookRegistry {
  private readonly hooks = new Map<HookPoint, HookEntry[]>();
  private readonly observer: IObserver;

  constructor(observer: IObserver) {
    this.observer = observer;
  }

  /**
   * Register a hook handler for a specific hook point.
   * Multiple handlers can be registered for the same hook point.
   * Handlers execute in registration order.
   */
  register(pluginId: string, hookPoint: HookPoint, handler: HookHandler): void {
    let entries = this.hooks.get(hookPoint);
    if (!entries) {
      entries = [];
      this.hooks.set(hookPoint, entries);
    }
    entries.push({ pluginId, handler });
  }

  /**
   * Remove all hooks registered by a specific plugin.
   */
  deregister(pluginId: string): void {
    for (const [hookPoint, entries] of this.hooks) {
      const filtered = entries.filter((e) => e.pluginId !== pluginId);
      if (filtered.length === 0) {
        this.hooks.delete(hookPoint);
      } else {
        this.hooks.set(hookPoint, filtered);
      }
    }
  }

  /**
   * Execute all handlers for a hook point.
   * Handlers run sequentially in registration order.
   *
   * For `pre:` hooks, a HookAbortError propagates (aborts the operation).
   * Other errors are logged and execution continues to the next handler.
   *
   * For `post:` hooks, all errors are logged and never abort.
   */
  async execute(hookPoint: HookPoint, data: Record<string, unknown>): Promise<void> {
    const entries = this.hooks.get(hookPoint);
    if (!entries || entries.length === 0) {
      return;
    }

    const isPre = hookPoint.startsWith("pre:");
    const context: HookContext = {
      hookPoint,
      data,
      timestamp: new Date().toISOString(),
    };

    for (const entry of entries) {
      try {
        await entry.handler(context);
      } catch (error) {
        if (isPre && error instanceof HookAbortError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.observer.error(
          `Hook error [${hookPoint}] from plugin "${entry.pluginId}": ${message}`,
          {
            hookPoint,
            pluginId: entry.pluginId,
          },
        );
      }
    }
  }

  /**
   * Get all registered hook points and their handler counts.
   */
  getRegisteredHooks(): Map<HookPoint, number> {
    const result = new Map<HookPoint, number>();
    for (const [hookPoint, entries] of this.hooks) {
      result.set(hookPoint, entries.length);
    }
    return result;
  }
}
