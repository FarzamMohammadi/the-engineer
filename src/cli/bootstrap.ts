import { join } from "node:path";

import type { Logger } from "pino";

import type { ConfigBundle } from "../config/loader.js";
import { EVENTS as DAEMON_EVENTS, type Daemon, createDaemon } from "../core/daemon/index.js";
import { createDataLifecycleManager } from "../core/data-lifecycle/index.js";
import type { EventTopology } from "../core/event-bus/topology.js";
import { HookRegistry } from "../core/hooks/index.js";
import { createChildLogger, createLogger } from "../core/logging.js";
import { BlobStore } from "../core/observability/blob-store.js";
import { ObservabilityStore } from "../core/observability/index.js";
import { createObserver } from "../core/observer/index.js";
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
  topology: EventTopology;
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
  const cliLogger = createChildLogger(logger, "cli");
  const bootstrapStartMs = Date.now();
  cliLogger.info("Bootstrapping The Engineer...");
  progress?.("Initializing logger", "done");

  // Database handle declared before try block so it can be cleaned up on failure
  let dbHandle: DatabaseHandle | undefined;

  try {
    // 2. Database
    progress?.("Initializing database", "start");
    const dbPath = join(engineerHome, "data", "engineer.db");
    dbHandle = createDatabase(dbPath, {
      cacheSizeMb: config.daemon.database.cache_size_mb,
    });
    progress?.("Initializing database", "done");

    // 3-9. Core components (EventBus, TaskEngine, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager)
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
      safetyConfig: config.safety,
      workspaceConfig: config.workspace,
      subscriberWarnThresholdMs: config.daemon.subscriber_warn_threshold_ms,
      logger: createChildLogger(logger, "event-bus"),
    });

    // 4. Hook Registry
    const hookRegistry = new HookRegistry();

    // 5. Registry (needs eventBus + health config + hook registry)
    topology.registerPublisher("registry", REGISTRY_EVENTS);
    const registry = new Registry({
      eventBus,
      healthCheckIntervalMs: config.daemon.plugins.health_check_interval_ms,
      healthCheckTimeoutMs: config.daemon.plugins.health_check_timeout_ms,
      consecutiveFailuresThreshold: config.daemon.plugins.consecutive_failures_threshold,
      hookRegistry,
    });

    // 6. Observability (BlobStore + ObservabilityStore)
    const blobStore = new BlobStore(join(engineerHome, "traces"));
    const observability = new ObservabilityStore(dbHandle.db, blobStore);

    // 7. Observer (centralized visibility for War Room)
    const observer = createObserver(dbHandle.db, blobStore);

    // 8. People Directory
    const peopleDirectory = new PeopleDirectory({ people: config.people });

    // 9. Orchestrator
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
      observability,
      observer,
    });

    // 10. Data Lifecycle Manager
    const tracesDir = join(engineerHome, "traces");
    const dataLifecycleManager = createDataLifecycleManager({
      db: dbHandle.db,
      eventBus,
      config: config.daemon.data_lifecycle,
      blobsDir: tracesDir,
      clock: new RealClock(),
    });

    // 11. Daemon
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
      logger: createChildLogger(logger, "daemon"),
      engineerHome,
      dataLifecycleManager,
    });
    progress?.("Creating core components", "done");

    // ── Event Topology: Subscribers ──────────────────────────────────────────

    // 12. Register event topology subscriptions
    topology.registerSubscriber("orchestrator", "preemption.requested");
    topology.registerSubscriber("safety_layer", "cost.incurred");
    topology.registerSubscriber("daemon:cost", "cost.limit_reached");
    topology.registerSubscriber("daemon:comm", "comm.message_received");
    topology.registerSubscriber("daemon:state-sync", "task.state_changed");
    topology.registerSubscriber("daemon:children-done", "task.children_all_done");
    topology.registerSubscriber("daemon:feedback", "task.feedback_received");

    // ── Plugin Loading ───────────────────────────────────────────────────────

    // 13. Load built-in plugins
    // Note: Plugin instances created via create() are lightweight — no OS resources
    // are allocated until initialize(). If config loading fails for a non-critical
    // plugin, the instance is deregistered without calling shutdown(), which is safe.
    progress?.("Loading plugins", "start");
    const pluginConfigDir = join(engineerHome, "config", "plugins");
    await loadBuiltinPlugins(registry, pluginConfigDir, cliLogger);
    progress?.("Plugins loaded", "done");

    cliLogger.info({ elapsedMs: Date.now() - bootstrapStartMs, dbPath }, "Bootstrap complete");

    return {
      daemon,
      topology,
      logger,
      cleanup() {
        dbHandle?.close();
      },
    };
  } catch (error) {
    cliLogger.error({ err: error }, "Bootstrap failed");
    // Clean up resources allocated before the failure point
    dbHandle?.close();
    throw error;
  }
}
