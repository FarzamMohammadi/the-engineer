import { join } from "node:path";

import type { GitHostingAdapter } from "../adapters/git-hosting.js";
import type { ConfigBundle } from "../config/loader.js";
import { EVENTS as DAEMON_EVENTS, type Daemon, createDaemon } from "../core/daemon/index.js";
import { createNotificationRouter } from "../core/daemon/notification-router.js";
import {
  EVENTS as DATA_LIFECYCLE_EVENTS,
  createDataLifecycleManager,
} from "../core/data-lifecycle/index.js";
import { HookRegistry } from "../core/hooks/index.js";
import type { AuthUrlProvider } from "../core/interfaces/workspace-manager.interface.js";
import {
  BlobStore,
  type IObserver,
  createLogger,
  createObservationStore,
  createObserverFacade,
} from "../core/observer/index.js";
import { EVENTS as ORCHESTRATOR_EVENTS, Orchestrator } from "../core/orchestrator/index.js";
import { PeopleDirectory } from "../core/people-directory/index.js";
import { EVENTS as REGISTRY_EVENTS, Registry } from "../core/registry/index.js";
import { createCoreComponents } from "../core/system.js";
import { type DatabaseHandle, createDatabase } from "../db/index.js";
import { loadBuiltinPlugins } from "../plugins/loader.js";
import { AdapterTypes } from "../schemas/adapters.js";
import { RealClock } from "../utils/clock.js";
import { sanitizeErrorMessage } from "../utils/sanitize.js";
import { SecureValue } from "../utils/secure-value.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Result of bootstrapping all components. */
export interface BootstrapResult {
  daemon: Daemon;
  observer: IObserver;
  cleanup: () => void;
  /** Startup hints collected from loaded plugins. */
  hints: Array<{ pluginName: string; message: string }>;
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

  // 1. Logger — created first; transport handle captured for shutdown cleanup
  progress?.("Initializing logger", "start");
  const loggingConfig = { ...config.daemon.logging };
  if (verbose) {
    loggingConfig.level = "debug";
    loggingConfig.console = true;
  }
  const loggerHandle = createLogger(loggingConfig, engineerHome);
  const logger = loggerHandle.logger;
  // Safe outside try: createObserverFacade is a pure constructor (no I/O, cannot throw).
  const observer = createObserverFacade(logger, "cli");
  const bootstrapStartMs = Date.now();
  const milestones: Record<string, number> = {};
  observer.info("Bootstrapping The Engineer...");
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
    milestones["db"] = Date.now() - bootstrapStartMs;
    observer.debug("Database initialized", {
      dbPath,
      cacheSizeMb: config.daemon.database.cache_size_mb,
    });
    progress?.("Initializing database", "done");

    // 3. Core components (EventBus, TaskEngine, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager)
    //    AuthUrlProvider uses a late-binding closure — the git hosting plugin
    //    reference is populated after plugin loading (step 12), but by the time
    //    any git operation runs (during task execution), the reference is set.
    progress?.("Wiring system", "start");
    let gitHostingPlugin: GitHostingAdapter | null = null;
    const authUrlProvider: AuthUrlProvider = (remoteUrl) => {
      if (gitHostingPlugin) {
        return gitHostingPlugin.getAuthenticatedRemoteUrl(remoteUrl);
      }
      return new SecureValue(remoteUrl);
    };
    const {
      components: {
        eventBus,
        taskEngine,
        safetyLayer,
        actionPipeline,
        sessionMemory,
        workspaceManager,
      },
      topology: eventTopology,
    } = createCoreComponents({
      db: dbHandle.db,
      observer,
      safetyConfig: config.safety,
      workspaceConfig: config.workspace,
      subscriberWarnThresholdMs: config.daemon.subscriber_warn_threshold_ms,
      authUrlProvider,
    });
    milestones["components"] = Date.now() - bootstrapStartMs;
    observer.debug(
      "Core components created: EventBus, TaskEngine, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager",
    );

    // 4. Hook Registry (after core components so it can observe them)
    const hookRegistry = new HookRegistry(observer.child("hooks"));

    // 5. Registry (needs eventBus + health config + hook registry)
    eventTopology.registerPublisher("registry", REGISTRY_EVENTS);
    registry = new Registry({
      eventBus,
      observer: observer.child("registry"),
      healthCheckIntervalMs: config.daemon.plugins.health_check_interval_ms,
      healthCheckTimeoutMs: config.daemon.plugins.health_check_timeout_ms,
      consecutiveFailuresThreshold: config.daemon.plugins.consecutive_failures_threshold,
      hookRegistry,
    });

    // 6. Observability (BlobStore + ObservationStore for War Room)
    const tracesDir = join(engineerHome, "traces");
    const blobStore = new BlobStore(tracesDir);
    const observationStore = createObservationStore(dbHandle.db, blobStore);
    observer.upgrade(observationStore);
    milestones["observability"] = Date.now() - bootstrapStartMs;
    observer.info("Observer upgraded — tracing enabled");

    // 7. People Directory
    const peopleDirectory = new PeopleDirectory({ people: config.people });

    // 7b. Notification Router (shared by Orchestrator + Daemon)
    const notifications = createNotificationRouter({
      registry,
      taskEngine,
      peopleDirectory,
      eventBus,
      observer: observer.child("notifications"),
      config: { notification_retry: config.daemon.notification_retry },
      clock: new RealClock(),
    });

    // 8. Orchestrator
    eventTopology.registerPublisher("orchestrator", ORCHESTRATOR_EVENTS);
    const orchestrator = new Orchestrator({
      config: config.orchestrator,
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
      notifications,
      tracesDir,
    });

    // 9. Data Lifecycle Manager
    eventTopology.registerPublisher("data-lifecycle", DATA_LIFECYCLE_EVENTS);
    const dataLifecycleManager = createDataLifecycleManager({
      db: dbHandle.db,
      eventBus,
      config: config.daemon.data_lifecycle,
      blobsDir: tracesDir,
      clock: new RealClock(),
      observer: observer.child("data-lifecycle"),
    });

    // 10. Daemon
    eventTopology.registerPublisher("daemon", DAEMON_EVENTS);
    const daemon = createDaemon({
      config: config.daemon,
      workspaceConfig: config.workspace,
      eventBus,
      registry,
      taskEngine,
      safetyLayer,
      orchestrator,
      sessionMemory,
      workspaceManager,
      peopleDirectory,
      clock: new RealClock(),
      observer: observer.child("daemon"),
      engineerHome,
      notifications,
      dataLifecycleManager,
    });
    progress?.("Wiring system", "done");

    // ── Event Topology: Subscribers ──────────────────────────────────────────

    // 11. Register event topology subscriptions
    eventTopology.registerSubscriber("orchestrator", "preemption.requested");
    eventTopology.registerSubscriber("safety_layer", "cost.incurred");
    eventTopology.registerSubscriber("safety_layer:cleanup", "task.state_changed");
    eventTopology.registerSubscriber("daemon:cost", "cost.limit_reached");
    // daemon:comm subscribes to comm.message_received — topology registration deferred until
    // CommunicationAdapter.receive capability is implemented (see future-considerations.md)
    eventTopology.registerSubscriber("daemon:state-sync", "task.state_changed");
    eventTopology.registerSubscriber("daemon:children-done", "task.children_all_done");
    eventTopology.registerSubscriber("daemon:feedback", "task.feedback_received");

    const eventDeclarations = eventTopology.getAllDeclarations();
    const publisherIds = new Set(eventDeclarations.flatMap((d) => d.publishers));
    const subscriberIds = new Set(eventDeclarations.flatMap((d) => d.subscribers));
    observer.debug("Event topology registered", {
      eventTypes: eventDeclarations.length,
      publishers: publisherIds.size,
      subscribers: subscriberIds.size,
    });
    observer.debug("Event topology detail", {
      events: eventDeclarations.map((d) => d.type),
      publisherList: [...publisherIds],
      subscriberList: [...subscriberIds],
    });

    // ── Plugin Loading ───────────────────────────────────────────────────────

    // 12. Load built-in plugins
    // Note: Plugin instances created via create() are lightweight — no OS resources
    // are allocated until initialize(). If config loading fails for a non-critical
    // plugin, the instance is deregistered without calling shutdown(), which is safe.
    progress?.("Loading plugins", "start");
    const pluginConfigDir = join(engineerHome, "config", "plugins");
    const pluginResult = await loadBuiltinPlugins(
      registry,
      pluginConfigDir,
      observer.child("plugin-loader"),
      { [AdapterTypes.communication]: { people: config.people } },
    );
    milestones["plugins"] = Date.now() - bootstrapStartMs;
    progress?.("Plugins loaded", "done");

    // Late-bind git hosting plugin for AuthUrlProvider (step 3 closure)
    gitHostingPlugin = registry.getPrimaryPlugin<GitHostingAdapter>(AdapterTypes.git_hosting);

    observer.info("Plugins loaded", {
      loaded: pluginResult.loaded,
      failed: pluginResult.failed,
      total: pluginResult.loaded.length + pluginResult.failed.length,
    });

    const bootstrapElapsedMs = Date.now() - bootstrapStartMs;
    observer.info("Bootstrap complete", {
      elapsedMs: bootstrapElapsedMs,
      dbPath,
      milestones,
    });
    // Record bootstrap summary as a lifecycle observation for War Room visibility
    observer.observe("lifecycle", "bootstrap_complete", {
      elapsedMs: bootstrapElapsedMs,
      milestones,
      dbPath,
    });

    return {
      daemon,
      observer,
      cleanup() {
        dbHandle?.close();
        loggerHandle.close();
      },
      hints: pluginResult.hints,
    };
  } catch (error) {
    observer.error("Bootstrap failed", { err: sanitizeErrorMessage(error) });
    // Clean up resources allocated before the failure point — reverse order.
    // BlobStore (no open handles), ObservationStore (shares dbHandle, closed below),
    // and DataLifecycleManager (start() not yet called) need no explicit cleanup.
    if (registry) {
      try {
        await registry.shutdownAll();
      } catch (shutdownError) {
        observer.warn("Registry shutdown during bootstrap cleanup failed", {
          err: sanitizeErrorMessage(shutdownError),
        });
      }
    }
    dbHandle?.close();
    loggerHandle.close();
    throw error;
  }
}
