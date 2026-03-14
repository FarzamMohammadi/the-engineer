import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";

import type { BaseAdapter } from "../adapters/base.js";
import type { ConfigBundle } from "../config/loader.js";
import { resolveEnvVars } from "../config/loader.js";
import {
  EVENTS as DAEMON_EVENTS,
  type Daemon,
  RealClock,
  createDaemon,
} from "../core/daemon/index.js";
import { createChildLogger, createLogger } from "../core/daemon/logging.js";
import type { EventTopology } from "../core/event-bus/topology.js";
import { HookRegistry } from "../core/hooks/index.js";
import { BlobStore } from "../core/observability/blob-store.js";
import { ObservabilityStore } from "../core/observability/index.js";
import { createObserver } from "../core/observer/index.js";
import { EVENTS as ORCHESTRATOR_EVENTS, Orchestrator } from "../core/orchestrator/index.js";
import { PeopleDirectory } from "../core/people-directory/index.js";
import { EVENTS as REGISTRY_EVENTS, Registry } from "../core/registry/index.js";
import { discoverPlugins } from "../core/registry/plugin-discovery.js";
import { createCoreComponents } from "../core/system.js";
import { type DatabaseHandle, createDatabase } from "../db/database.js";

/** Result of bootstrapping all components. */
export interface BootstrapResult {
  daemon: Daemon;
  topology: EventTopology;
  logger: Logger;
  cleanup: () => void;
}

/**
 * Instantiates all Core components in dependency order, discovers and initializes
 * plugins via auto-discovery, and creates the Daemon.
 */
export async function bootstrap(
  engineerHome: string,
  config: ConfigBundle,
  verbose: boolean,
): Promise<BootstrapResult> {
  // 1. Logger
  const loggingConfig = { ...config.daemon.logging };
  if (verbose) {
    loggingConfig.level = "debug";
    loggingConfig.console = true;
  }
  const logger = createLogger(loggingConfig, engineerHome);
  const cliLogger = createChildLogger(logger, "cli");

  cliLogger.info("Bootstrapping The Engineer...");

  // 2. Database
  const dbPath = join(engineerHome, "data", "engineer.db");
  const dbHandle: DatabaseHandle = createDatabase(dbPath);

  // 3-9. Core components (EventBus, TaskEngine, SafetyLayer, ActionPipeline, SessionMemory, WorkspaceManager)
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

  // 12. Daemon
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
  });

  // 13. Register event topology subscriptions
  topology.registerSubscriber("orchestrator", "preemption.requested");
  topology.registerSubscriber("safety_layer", "cost.incurred");
  topology.registerSubscriber("daemon:cost", "cost.limit_reached");
  topology.registerSubscriber("daemon:comm", "comm.message_received");
  topology.registerSubscriber("daemon:state-sync", "task.state_changed");
  topology.registerSubscriber("daemon:children-done", "task.children_all_done");
  topology.registerSubscriber("daemon:feedback", "task.feedback_received");

  // 14. Discover and initialize plugins via auto-discovery
  const pluginConfigDir = join(engineerHome, "config", "plugins");
  await loadDiscoveredPlugins(registry, pluginConfigDir, config, cliLogger);

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

async function loadDiscoveredPlugins(
  registry: Registry,
  pluginConfigDir: string,
  config: ConfigBundle,
  logger: Logger,
): Promise<void> {
  const discovered = discoverPlugins({
    dirs: config.daemon.plugins.dirs,
    includeBuiltins: true,
  });

  for (const plugin of discovered) {
    const module = (await import(plugin.entryPath)) as { createPlugin?: () => BaseAdapter };
    if (typeof module.createPlugin !== "function") {
      const msg = `Plugin "${plugin.manifest.id}" entry does not export createPlugin()`;
      if (plugin.manifest.critical) {
        throw new Error(msg);
      }
      logger.warn(msg);
      continue;
    }

    const instance = module.createPlugin();
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
