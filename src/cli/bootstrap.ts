import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";

const YAML_EXT_RE = /\.yaml$/;

import type { ConfigBundle } from "../config/loader.js";
import { resolveEnvVars } from "../config/loader.js";
import {
  EVENTS as DAEMON_EVENTS,
  type Daemon,
  RealClock,
  createDaemon,
} from "../core/daemon/index.js";
import { createChildLogger, createLogger } from "../core/daemon/logging.js";
import { createDataLifecycleManager } from "../core/data-lifecycle/index.js";
import type { EventTopology } from "../core/event-bus/topology.js";
import { HookRegistry } from "../core/hooks/index.js";
import { BlobStore } from "../core/observability/blob-store.js";
import { ObservabilityStore } from "../core/observability/index.js";
import { createObserver } from "../core/observer/index.js";
import { EVENTS as ORCHESTRATOR_EVENTS, Orchestrator } from "../core/orchestrator/index.js";
import { PeopleDirectory } from "../core/people-directory/index.js";
import { EVENTS as REGISTRY_EVENTS, Registry } from "../core/registry/index.js";
import { createCoreComponents } from "../core/system.js";
import { type DatabaseHandle, createDatabase } from "../db/database.js";
import { BUILTIN_PLUGINS } from "../plugins/builtin.js";

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

// ── Bootstrap ────────────────────────────────────────────────────────────────

/**
 * Instantiates all Core components in dependency order, discovers and initializes
 * plugins via auto-discovery, and creates the Daemon.
 */
export async function bootstrap(
  engineerHome: string,
  config: ConfigBundle,
  verbose: boolean,
  progress?: ProgressCallback,
): Promise<BootstrapResult> {
  // 1. Logger
  progress?.("Initializing logger", "start");
  const loggingConfig = { ...config.daemon.logging };
  if (verbose) {
    loggingConfig.level = "debug";
    loggingConfig.console = true;
  }
  const logger = createLogger(loggingConfig, engineerHome);
  const cliLogger = createChildLogger(logger, "cli");
  cliLogger.info("Bootstrapping The Engineer...");
  progress?.("Initializing logger", "done");

  // 2. Database
  progress?.("Initializing database", "start");
  const dbPath = join(engineerHome, "data", "engineer.db");
  const dbHandle: DatabaseHandle = createDatabase(dbPath, {
    cacheSizeMb: config.daemon.database.cache_size_mb,
  });
  progress?.("Initializing database", "done");

  // 3-9. Core components (EventBus, TaskEngine, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager)
  progress?.("Creating core components", "start");
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

  // 8b. Observability Store
  const blobStore = new BlobStore(join(engineerHome, "traces"));
  const observability = new ObservabilityStore(dbHandle.db, blobStore);

  // 8c. Observer (centralized visibility for War Room)
  const observer = createObserver(dbHandle.db, blobStore);

  // 10. People Directory
  const peopleDirectory = new PeopleDirectory({ people: config.people });

  // 11. Orchestrator
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

  // 12. Data Lifecycle Manager
  const tracesDir = join(engineerHome, "traces");
  const dataLifecycleManager = createDataLifecycleManager({
    db: dbHandle.db,
    eventBus,
    config: config.daemon.data_lifecycle,
    blobsDir: tracesDir,
    clock: new RealClock(),
  });

  // 13. Daemon
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

  // 13. Register event topology subscriptions
  topology.registerSubscriber("orchestrator", "preemption.requested");
  topology.registerSubscriber("safety_layer", "cost.incurred");
  topology.registerSubscriber("daemon:cost", "cost.limit_reached");
  topology.registerSubscriber("daemon:comm", "comm.message_received");
  topology.registerSubscriber("daemon:state-sync", "task.state_changed");
  topology.registerSubscriber("daemon:children-done", "task.children_all_done");
  topology.registerSubscriber("daemon:feedback", "task.feedback_received");

  // 14. Load built-in plugins
  progress?.("Loading plugins", "start");
  const pluginConfigDir = join(engineerHome, "config", "plugins");
  await loadBuiltinPlugins(registry, pluginConfigDir, config, cliLogger);
  progress?.("Plugins loaded", "done");

  cliLogger.info("Bootstrap complete.");

  return {
    daemon,
    topology,
    logger,
    cleanup() {
      dbHandle.close();
    },
  };
}

// ── Plugin Discovery & Loading ────────────────────────────────────────────────

/** Load plugin config from YAML file, resolving env vars. Returns null on error for non-critical plugins. */
function loadPluginConfig(
  configPath: string,
  pluginId: string,
  critical: boolean,
): Record<string, unknown> | null {
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    return (parsed ? resolveEnvVars(parsed, configPath) : {}) as Record<string, unknown>;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (critical) {
      throw new Error(`Failed to load config for critical plugin "${pluginId}": ${msg}`);
    }
    return null;
  }
}

async function loadBuiltinPlugins(
  registry: Registry,
  pluginConfigDir: string,
  _config: ConfigBundle,
  logger: Logger,
): Promise<void> {
  // A plugin is enabled if its config file exists in ~/.engineer/config/plugins/
  const enabledIds = new Set(
    existsSync(pluginConfigDir)
      ? readdirSync(pluginConfigDir)
          .filter((f) => f.endsWith(".yaml"))
          .map((f) => f.replace(YAML_EXT_RE, ""))
      : [],
  );
  const plugins = BUILTIN_PLUGINS.filter((p) => enabledIds.has(p.manifest.id));

  for (const plugin of plugins) {
    const instance = plugin.create();
    const regResult = registry.register(plugin.manifest, instance);
    if (!regResult.success) {
      logger.warn(`Failed to register plugin "${plugin.manifest.id}": ${regResult.message}`);
      continue;
    }

    const configPath = join(pluginConfigDir, `${plugin.manifest.id}.yaml`);
    const pluginConfig = loadPluginConfig(configPath, plugin.manifest.id, plugin.manifest.critical);
    if (pluginConfig === null) {
      logger.warn(`Failed to load config for "${plugin.manifest.id}". Skipping.`);
      registry.deregister(plugin.manifest.id);
      continue;
    }

    const result = await registry.initializePlugin(plugin.manifest.id, pluginConfig);
    if (!result.success) {
      if (plugin.manifest.critical) {
        throw new Error(
          `Critical plugin "${plugin.manifest.id}" failed to initialize: ${result.message}`,
        );
      }
      logger.warn(
        `Plugin "${plugin.manifest.id}" failed to initialize: ${result.message}. Deregistering.`,
      );
      registry.deregister(plugin.manifest.id);
    }
  }
}
