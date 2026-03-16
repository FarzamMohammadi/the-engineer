import type { HealthStatus, InitResult, PluginManifest } from "../schemas/adapters.js";

/**
 * Minimal observer interface used by BaseAdapter for structured logging.
 *
 * Matches the subset of `IObserver` (from `../core/observer/facade.js`) that
 * adapters need. Defined locally to avoid tier import violations (adapters
 * cannot import core). The Registry injects the real IObserver instance.
 */
interface AdapterObserver {
  info(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Base class for all adapter implementations.
 *
 * Provides shared infrastructure: manifest storage (injected by Registry),
 * capability checking, and template method wrappers for lifecycle methods
 * (initialize, shutdown, healthCheck) with timing, logging, and error catching.
 *
 * Plugin authors extend type-specific subclasses (TriggerAdapter, etc.)
 * and implement the protected `do*` methods.
 */
export abstract class BaseAdapter {
  /**
   * Plugin identity, injected by the Registry after factory instantiation.
   * Not set by the plugin itself.
   */
  manifest!: PluginManifest;

  /**
   * Hook registry, injected by the Registry if available.
   * Plugins can use this to register lifecycle hooks during initialization.
   * Typed as `unknown` to avoid tier import violations (adapters cannot import core).
   * Plugins should cast to `HookRegistry` from `../core/hooks/index.js` if needed.
   */
  hookRegistry?: unknown;

  /**
   * Observer facade, injected by the Registry before initialize() is called.
   * Provides structured logging (info/error/warn/debug) and tracing.
   * Typed as `unknown` to avoid tier import violations (adapters cannot import core).
   * Internally cast to `AdapterObserver` for safe usage.
   *
   * When not set, lifecycle logging is silently skipped.
   */
  observer?: unknown;

  /**
   * Check whether this adapter supports a named capability.
   *
   * Reads the `capabilities` array from `manifest.adapter_meta`.
   * Core components call this before invoking optional methods.
   */
  hasCapability(capability: string): boolean {
    const meta = this.manifest.adapter_meta;
    const caps = meta["capabilities"];
    return Array.isArray(caps) && caps.includes(capability);
  }

  // ── Lifecycle Template Methods ──────────────────────────────────────────────

  /**
   * Initialize the adapter with validated configuration.
   *
   * Wraps `doInitialize()` with timing and error catching.
   * If `doInitialize()` throws, returns `{ success: false, message }`.
   */
  async initialize(config: Record<string, unknown>): Promise<InitResult> {
    const obs = this.observer as AdapterObserver | undefined;
    const start = Date.now();
    try {
      const result = await this.doInitialize(config);
      const elapsed = Date.now() - start;
      obs?.info(`Plugin "${this.manifest.id}" initialized in ${String(elapsed)}ms`, {
        pluginId: this.manifest.id,
        elapsedMs: elapsed,
      });
      return result;
    } catch (error) {
      const elapsed = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      obs?.error(
        `Plugin "${this.manifest.id}" failed to initialize after ${String(elapsed)}ms: ${message}`,
        { pluginId: this.manifest.id, elapsedMs: elapsed, error: message },
      );
      return { success: false, message };
    }
  }

  /**
   * Shut down the adapter gracefully.
   *
   * Wraps `doShutdown()` with error swallowing — shutdown must never throw.
   */
  async shutdown(): Promise<void> {
    const obs = this.observer as AdapterObserver | undefined;
    try {
      await this.doShutdown();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      obs?.error(`Plugin "${this.manifest.id}" shutdown error (non-fatal): ${message}`, {
        pluginId: this.manifest.id,
        error: message,
      });
    }
  }

  /**
   * Check adapter health.
   *
   * Wraps `doHealthCheck()` with error catching.
   * If `doHealthCheck()` throws, returns `{ healthy: false, message, details: null }`.
   * Timeout is handled by the Registry (Phase 6), not here.
   */
  async healthCheck(): Promise<HealthStatus> {
    try {
      return await this.doHealthCheck();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { healthy: false, message, details: null };
    }
  }

  // ── Protected Abstract (plugin authors implement) ──────────────────────────

  protected abstract doInitialize(config: Record<string, unknown>): Promise<InitResult>;
  protected abstract doShutdown(): Promise<void>;
  protected abstract doHealthCheck(): Promise<HealthStatus>;
}
