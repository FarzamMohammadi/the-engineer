import { join } from "node:path";

import type { Logger } from "pino";

import type { ConfigBundle } from "../config/loader.js";
import { EVENTS as DAEMON_EVENTS, type Daemon, createDaemon } from "../core/daemon/index.js";
import { createDataLifecycleManager } from "../core/data-lifecycle/index.js";
import { HookRegistry } from "../core/hooks/index.js";
import { BlobStore } from "../core/observer/blob-store.js";
import { createObserverFacade } from "../core/observer/facade.js";
import { createObservationStore } from "../core/observer/index.js";
import { createChildLogger, createLogger } from "../core/observer/logging.js";
import { EVENTS as ORCHESTRATOR_EVENTS, Orchestrator } from "../core/orchestrator/index.js";
import { PeopleDirectory } from "../core/people-directory/index.js";
import { EVENTS as REGISTRY_EVENTS, Registry } from "../core/registry/index.js";
import { createCoreComponents } from "../core/system.js";
import { type DatabaseHandle, createDatabase } from "../db/database.js";
import { loadBuiltinPlugins } from "../plugins/loader.js";
import { RealClock } from "../utils/clock.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Result of bootstrapping all components. */
export interface BootstrapResult {
  daemon: Daemon;
  logger: Logger;
  cleanup: () => void;
}

/** Progress callback for startup spinners. */
export type ProgressCallback = (step: string, status: "start" | "done" | "error") => void;

/** Options for the bootstrap function. */
export interface BootstrapOptions {
  engineerHome: string;
  config: ConfigBundle;
  verbose?: boolean;
  progress?: ProgressCallback;
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Instantiates all Core components in dependency order, discovers and initializes
 * plugins via auto-discovery, and creates the Daemon.
 *
 * Convention: `new` for classes with pure constructor injection (no I/O).
 * `create*()` factories for components needing setup logic or returning interfaces.
 */
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const { engineerHome, config, verbose, progress } = options;

  // 1. Logger — created first, outside the cleanup scope (no close method)
  progress?.("Initializing logger", "start");
  const loggingConfig = { ...config.daemon.logging };
  if (verbose) {
    loggingConfig.level = "debug";
    loggingConfig.console = true;
  }
  const logger = createLogger(loggingConfig, engineerHome);
  const observer = createObserverFacade(logger, "cli");
  const cliLogger = createChildLogger(logger, "cli");
  const bootstrapStartMs = Date.now();
  cliLogger.info("Bootstrapping The Engineer...");
  progress?.("Initializing logger", "done");

  // Handles declared before try block so they can be cleaned up on failure
  let dbHandle: DatabaseHandle | undefined;
  let registry: Registry | undefined;

  try {
    // 2. Database
    progress?.("Initializing database", "start");
    const dbPath = join(engineerHome, "data", "engineer.db");
    dbHandle = createDatabase(dbPath, {
      cacheSizeMb: config.daemon.database.cache_size_mb,
    });
    progress?.("Initializing database", "done");

    // 3. Core components (EventBus, TaskEngine, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager)
    progress?.("Creating core components", "start");
    cliLogger.debug("Creating core components");
    const {
      eventBus,
      topology,
      taskEngine,
      safetyLayer,
      actionPipeline,
      sessionMemory,
      workspaceManager,
    } = createCoreComponents({
      db: dbHandle.db,
      observer: observer.child("event-bus"),
      safetyConfig: config.safety,
      workspaceConfig: config.workspace,
      subscriberWarnThresholdMs: config.daemon.subscriber_warn_threshold_ms,
    });

    // 4. Hook Registry (after core components so it can observe them)
    const hookRegistry = new HookRegistry(observer.child("hooks"));

    // 5. Registry (needs eventBus + health config + hook registry)
    topology.registerPublisher("registry", REGISTRY_EVENTS);
    registry = new Registry({
      eventBus,
      observer: observer.child("registry"),
      healthCheckIntervalMs: config.daemon.plugins.health_check_interval_ms,
      healthCheckTimeoutMs: config.daemon.plugins.health_check_timeout_ms,
      consecutiveFailuresThreshold: config.daemon.plugins.consecutive_failures_threshold,
      hookRegistry,
    });

    // 6. Observability (BlobStore + ObservationStore for War Room)
    const blobStore = new BlobStore(join(engineerHome, "traces"));
    const observationStore = createObservationStore(dbHandle.db, blobStore);
    observer.upgrade(observationStore);

    // 7. People Directory
    const peopleDirectory = new PeopleDirectory({ people: config.people });

    // 8. Orchestrator
    topology.registerPublisher("orchestrator", ORCHESTRATOR_EVENTS);
    const orchestrator = new Orchestrator({
      eventBus,
      registry,
      taskEngine,
      safetyLayer,
      actionPipeline,
      sessionMemory,
      workspaceManager,
      peopleDirectory,
      observationStore,
      observer: observer.child("orchestrator"),
    });

    // 9. Data Lifecycle Manager
    const tracesDir = join(engineerHome, "traces");
    const dataLifecycleManager = createDataLifecycleManager({
      db: dbHandle.db,
      eventBus,
      config: config.daemon.data_lifecycle,
      blobsDir: tracesDir,
      clock: new RealClock(),
    });

    // 10. Daemon
    topology.registerPublisher("daemon", DAEMON_EVENTS);
    const daemon = createDaemon(config.daemon, {
      eventBus,
      registry,
      taskEngine,
      safetyLayer,
      actionPipeline,
      orchestrator,
      sessionMemory,
      workspaceManager,
      peopleDirectory,
      clock: new RealClock(),
      observer: observer.child("daemon"),
      engineerHome,
      dataLifecycleManager,
    });
    progress?.("Creating core components", "done");

    // ── Event Topology: Subscribers ──────────────────────────────────────────

    // 11. Register event topology subscriptions
    topology.registerSubscriber("orchestrator", "preemption.requested");
    topology.registerSubscriber("safety_layer", "cost.incurred");
    topology.registerSubscriber("daemon:cost", "cost.limit_reached");
    topology.registerSubscriber("daemon:comm", "comm.message_received");
    topology.registerSubscriber("daemon:state-sync", "task.state_changed");
    topology.registerSubscriber("daemon:children-done", "task.children_all_done");
    topology.registerSubscriber("daemon:feedback", "task.feedback_received");

    // ── Plugin Loading ───────────────────────────────────────────────────────

    // 12. Load built-in plugins
    // Note: Plugin instances created via create() are lightweight — no OS resources
    // are allocated until initialize(). If config loading fails for a non-critical
    // plugin, the instance is deregistered without calling shutdown(), which is safe.
    progress?.("Loading plugins", "start");
    const pluginConfigDir = join(engineerHome, "config", "plugins");
    await loadBuiltinPlugins(registry, pluginConfigDir, observer.child("plugin-loader"));
    progress?.("Plugins loaded", "done");

    cliLogger.info({ elapsedMs: Date.now() - bootstrapStartMs, dbPath }, "Bootstrap complete");

    return {
      daemon,
      logger,
      cleanup() {
        dbHandle?.close();
      },
    };
  } catch (error) {
    cliLogger.error({ err: error }, "Bootstrap failed");
    // Clean up resources allocated before the failure point — reverse order
    if (registry) {
      try {
        await registry.shutdownAll();
      } catch (shutdownError) {
        cliLogger.warn({ err: shutdownError }, "Registry shutdown during bootstrap cleanup failed");
      }
    }
    dbHandle?.close();
    throw error;
  }
}
