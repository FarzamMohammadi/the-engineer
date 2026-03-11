import { join } from "node:path";

import type { Logger } from "pino";

import type { ConfigBundle } from "../config/loader.js";
import { ActionPipeline } from "../core/action-pipeline/index.js";
import { type Daemon, RealClock, createDaemon } from "../core/daemon/index.js";
import { createChildLogger, createLogger } from "../core/daemon/logging.js";
import { EventBus } from "../core/event-bus/index.js";
import { Orchestrator } from "../core/orchestrator/index.js";
import { PeopleDirectory } from "../core/people-directory/index.js";
import { Registry } from "../core/registry/index.js";
import { SafetyLayer } from "../core/safety-layer/index.js";
import { SessionMemory } from "../core/session-memory/index.js";
import { TaskEngine } from "../core/task-engine/index.js";
import { WorkspaceManager } from "../core/workspace-manager/index.js";
import { type DatabaseHandle, createDatabase } from "../db/database.js";

/** Result of bootstrapping all components. */
export interface BootstrapResult {
  daemon: Daemon;
  logger: Logger;
  cleanup: () => void;
}

/**
 * Instantiates all Core components in dependency order and creates the Daemon.
 * This is the "big wiring" function — separated from the start command for
 * testability (Phase 15 integration tests can call bootstrap directly).
 */
export function bootstrap(
  engineerHome: string,
  config: ConfigBundle,
  verbose: boolean,
): BootstrapResult {
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

  // 3. Event Bus
  const eventBus = new EventBus(dbHandle.db);

  // 4. Registry
  const registry = new Registry({
    eventBus,
    healthCheckIntervalMs: config.daemon.plugins.health_check_interval_ms,
    healthCheckTimeoutMs: config.daemon.plugins.health_check_timeout_ms,
    consecutiveFailuresThreshold: config.daemon.plugins.consecutive_failures_threshold,
  });

  // 5. Task Engine
  const taskEngine = new TaskEngine(dbHandle.db, eventBus);

  // 6. Safety Layer
  const safetyLayer = new SafetyLayer(dbHandle.db, eventBus, config.safety);

  // 7. Action Pipeline
  const actionPipeline = new ActionPipeline(taskEngine, safetyLayer, eventBus);

  // 8. Session Memory
  const sessionMemory = new SessionMemory(dbHandle.db);

  // 9. Workspace Manager
  const workspaceManager = new WorkspaceManager(eventBus, config.workspace);

  // 10. People Directory
  const peopleDirectory = new PeopleDirectory({ people: config.people });

  // 11. Orchestrator
  const orchestrator = new Orchestrator({
    eventBus,
    registry,
    taskEngine,
    safetyLayer,
    actionPipeline,
    sessionMemory,
    workspaceManager,
  });

  // 12. Daemon
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

  cliLogger.info("Bootstrap complete.");

  return {
    daemon,
    logger,
    cleanup() {
      dbHandle.close();
    },
  };
}
