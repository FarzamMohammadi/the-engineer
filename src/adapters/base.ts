import type { HealthStatus, InitResult, PluginManifest } from "../schemas/adapters.js";

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
    const start = Date.now();
    try {
      const result = await this.doInitialize(config);
      const elapsed = Date.now() - start;
      console.log(`Plugin "${this.manifest.id}" initialized in ${String(elapsed)}ms`);
      return result;
    } catch (error) {
      const elapsed = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Plugin "${this.manifest.id}" failed to initialize after ${String(elapsed)}ms: ${message}`,
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
    try {
      await this.doShutdown();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Plugin "${this.manifest.id}" shutdown error (non-fatal): ${message}`);
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
