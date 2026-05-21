import type { HealthStatus, InitResult, PluginManifest } from "../schemas/adapters.js";

/**
 * Minimal observer interface used by BaseAdapter for structured logging.
 *
 * Matches the subset of `IObserver` (from `../core/observer/facade.js`) that
 * adapters need. Defined locally to avoid tier import violations (adapters
 * cannot import core). The Registry injects the real IObserver instance.
 */
export interface AdapterObserver {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Opaque key-value store for plugin-owned state (watermarks, cursors, mappings).
 *
 * Namespaced per plugin by Core — a plugin can only access its own keys.
 * Values are JSON-serializable; the plugin decides what to store and parses
 * what it reads back. Backed by the database, atomic, `--home`-aware.
 */
export interface StateStore {
  /** Get a value by key. Returns `null` if the key does not exist. */
  get(key: string): unknown;
  /** Set a value by key. Overwrites any existing value. */
  set(key: string, value: unknown): void;
  /** Delete a key. No-op if the key does not exist. */
  delete(key: string): void;
}

/**
 * Everything Core provides to a plugin, injected by the Registry before
 * `initialize()` runs. Identity (`manifest`) is separate — this carries
 * the capabilities a plugin uses to do its work.
 */
export interface PluginContext {
  /** Structured logger scoped to this plugin (every line carries its `plugin_id`). */
  readonly logger: AdapterObserver;
  /** Per-plugin key-value store for durable state. */
  readonly stateStore: StateStore;
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
   * Core-provided capabilities (logger, state store), injected by the Registry
   * before `initialize()` is called. Plugins read `this.context.logger` and
   * `this.context.stateStore`; they never set it.
   */
  context!: PluginContext;

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
      this.context.logger.info(`Plugin "${this.manifest.id}" initialized in ${String(elapsed)}ms`, {
        elapsedMs: elapsed,
      });
      return result;
    } catch (error) {
      const elapsed = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      this.context.logger.error(
        `Plugin "${this.manifest.id}" failed to initialize after ${String(elapsed)}ms: ${message}`,
        {
          adapterType: this.manifest.type,
          capability: `${this.manifest.type}_adapter`,
          elapsedMs: elapsed,
          critical: this.manifest.critical,
          error: message,
        },
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
      this.context.logger.error(`Plugin "${this.manifest.id}" shutdown error (non-fatal): ${message}`, {
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
