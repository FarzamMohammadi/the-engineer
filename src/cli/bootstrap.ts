import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";

import type { BaseAdapter } from "../adapters/base.js";
import type { ConfigBundle } from "../config/loader.js";
import { resolveEnvVars } from "../config/loader.js";
import { ActionPipeline } from "../core/action-pipeline/index.js";
import { type Daemon, RealClock, createDaemon } from "../core/daemon/index.js";
import { createChildLogger, createLogger } from "../core/daemon/logging.js";
import { EventBus } from "../core/event-bus/index.js";
import { BlobStore } from "../core/observability/blob-store.js";
import { ObservabilityStore } from "../core/observability/index.js";
import { Orchestrator } from "../core/orchestrator/index.js";
import { PeopleDirectory } from "../core/people-directory/index.js";
import { Registry } from "../core/registry/index.js";
import { SafetyLayer } from "../core/safety-layer/index.js";
import { SessionMemory } from "../core/session-memory/index.js";
import { TaskEngine } from "../core/task-engine/index.js";
import { WorkspaceManager } from "../core/workspace-manager/index.js";
import { type DatabaseHandle, createDatabase } from "../db/database.js";
import { createPlugin as createGitHubComm } from "../plugins/communication/github-comm/index.js";
import { createPlugin as createTelegramComm } from "../plugins/communication/telegram-comm/index.js";
import { createPlugin as createGitHubHosting } from "../plugins/git-hosting/github-hosting/index.js";
import { createPlugin as createClaudeCodeLlm } from "../plugins/llm/claude-code-llm/index.js";
import { createPlugin as createBashTool } from "../plugins/tool/bash-tool/index.js";
import { createPlugin as createGitHubTrigger } from "../plugins/trigger/github-trigger/index.js";
import type { PluginManifest } from "../schemas/adapters.js";

/** Result of bootstrapping all components. */
export interface BootstrapResult {
  daemon: Daemon;
  logger: Logger;
  cleanup: () => void;
}

/**
 * Instantiates all Core components in dependency order, loads and initializes
 * built-in plugins, and creates the Daemon. Async because plugin initialization
 * is async.
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

  // 8b. Observability Store
  const blobStore = new BlobStore(join(engineerHome, "traces"));
  const observability = new ObservabilityStore(dbHandle.db, blobStore);

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
    peopleDirectory,
    observability,
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

  // 13. Load and initialize built-in plugins
  const pluginConfigDir = join(engineerHome, "config", "plugins");
  await loadBuiltinPlugins(registry, pluginConfigDir, cliLogger);

  cliLogger.info("Bootstrap complete.");

  return {
    daemon,
    logger,
    cleanup() {
      dbHandle.close();
    },
  };
}

// ── Built-in Plugin Manifests ──────────────────────────────────────────────────

const BUILTIN_PLUGINS: Array<{
  manifest: PluginManifest;
  factory: () => BaseAdapter;
  configFile: string;
}> = [
  {
    manifest: {
      id: "github-comm",
      type: "communication",
      version: "1.0.0",
      name: "GitHub Communication",
      description: "Comments on issues and PRs, manages labels",
      config_schema: {},
      critical: false,
      enabled: true,
      entry: "index.ts",
      adapter_meta: {},
    },
    factory: createGitHubComm,
    configFile: "github-comm.yaml",
  },
  {
    manifest: {
      id: "telegram-comm",
      type: "communication",
      version: "1.0.0",
      name: "Telegram Communication",
      description: "Sends notifications via Telegram bot",
      config_schema: {},
      critical: false,
      enabled: true,
      entry: "index.ts",
      adapter_meta: {},
    },
    factory: createTelegramComm,
    configFile: "telegram-comm.yaml",
  },
  {
    manifest: {
      id: "claude-code-llm",
      type: "llm",
      version: "1.0.0",
      name: "Claude Code LLM",
      description: "Uses Claude CLI for LLM completions",
      config_schema: {},
      critical: true,
      enabled: true,
      entry: "index.ts",
      adapter_meta: {},
    },
    factory: createClaudeCodeLlm,
    configFile: "claude-code-llm.yaml",
  },
  {
    manifest: {
      id: "bash-tool",
      type: "tool",
      version: "1.0.0",
      name: "Bash Tool",
      description: "Executes bash commands in workspace",
      config_schema: {},
      critical: true,
      enabled: true,
      entry: "index.ts",
      adapter_meta: {},
    },
    factory: createBashTool,
    configFile: "bash-tool.yaml",
  },
  {
    manifest: {
      id: "github-hosting",
      type: "git_hosting",
      version: "1.0.0",
      name: "GitHub Hosting",
      description: "Creates PRs, manages branches, handles reviews",
      config_schema: {},
      critical: false,
      enabled: true,
      entry: "index.ts",
      adapter_meta: {},
    },
    factory: createGitHubHosting,
    configFile: "github-hosting.yaml",
  },
  {
    manifest: {
      id: "github-trigger",
      type: "trigger",
      version: "1.0.0",
      name: "GitHub Trigger",
      description: "Polls GitHub for assigned issues",
      config_schema: {},
      critical: true,
      enabled: true,
      entry: "index.ts",
      adapter_meta: {},
    },
    factory: createGitHubTrigger,
    configFile: "github-trigger.yaml",
  },
];

/**
 * Register and initialize all built-in plugins.
 * Loads config from config/plugins/{configFile} with env var resolution.
 * Non-critical plugins that fail to initialize are skipped with a warning.
 * Critical plugins that fail throw an error (blocking startup).
 */
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
  logger: Logger,
): Promise<void> {
  for (const plugin of BUILTIN_PLUGINS) {
    const instance = plugin.factory();
    const regResult = registry.register(plugin.manifest, instance);
    if (!regResult.success) {
      logger.warn(`Failed to register plugin "${plugin.manifest.id}": ${regResult.message}`);
      continue;
    }

    const configPath = join(pluginConfigDir, plugin.configFile);
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
