import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { type Daemon, createDaemon } from "../../src/core/daemon/index.js";
import { createNotificationRouter } from "../../src/core/daemon/notification-router.js";
import type { IActionPipeline } from "../../src/core/interfaces/action-pipeline.interface.js";
import type { IEventBus } from "../../src/core/interfaces/event-bus.interface.js";
import type { ISafetyLayer } from "../../src/core/interfaces/safety-layer.interface.js";
import type { ITaskEngine } from "../../src/core/interfaces/task-engine.interface.js";
import type { IWorkspaceManager } from "../../src/core/interfaces/workspace-manager.interface.js";
import { Orchestrator } from "../../src/core/orchestrator/index.js";
import { PeopleDirectory } from "../../src/core/people-directory/index.js";
import type { Registry } from "../../src/core/registry/index.js";
import type { SessionMemory } from "../../src/core/session-memory/index.js";
import { createCoreComponents } from "../../src/core/system.js";
import type { Person } from "../../src/schemas/adapters.js";
import {
  type DaemonConfig,
  DaemonConfigSchema,
  OrchestratorConfigSchema,
  PeopleConfigSchema,
  type SafetyConfig,
  SafetyConfigSchema,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
} from "../../src/schemas/config.js";
import { FakeClock } from "./fake-clock.js";
import type { FakeAgentPlugin } from "./fake-plugins/fake-agent/index.js";
import type { FakeCommunicationPlugin } from "./fake-plugins/fake-comm/index.js";
import type { FakeGitHostingPlugin } from "./fake-plugins/fake-git-hosting/index.js";
import type { FakeTriggerPlugin } from "./fake-plugins/fake-trigger/index.js";
import { createTestDatabase } from "./test-database.js";
import { createTestObserverFacade } from "./test-observer-facade.js";
import { type TestRegistryFakes, createTestRegistry } from "./test-registry.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface IntegrationContextFakes extends TestRegistryFakes {
  trigger: FakeTriggerPlugin;
  communication: FakeCommunicationPlugin;
  llm: FakeAgentPlugin;
  gitHosting: FakeGitHostingPlugin;
}

export interface IntegrationContext {
  daemon: Daemon;
  clock: FakeClock;
  db: Database.Database;
  eventBus: IEventBus;
  registry: Registry;
  taskEngine: ITaskEngine;
  safetyLayer: ISafetyLayer;
  actionPipeline: IActionPipeline;
  orchestrator: Orchestrator;
  sessionMemory: SessionMemory;
  workspaceManager: IWorkspaceManager;
  peopleDirectory: PeopleDirectory;
  fakes: IntegrationContextFakes;
  engineerHome: string;
  cleanup(): void;
}

export interface IntegrationContextOptions {
  daemonConfig?: Partial<DaemonConfig>;
  safetyConfig?: Partial<SafetyConfig>;
  workspaceConfig?: Partial<WorkspaceConfig>;
  people?: Person[];
}

// ── Default Configs (tuned for test speed) ──────────────────────────────────

function defaultDaemonConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  const base = DaemonConfigSchema.parse({});
  return {
    ...base,
    tick_interval_ms: 0,
    trigger_poll_interval_ms: 0,
    response_poll_interval_ms: 0,
    stuck_threshold_ms: 5_000,
    max_active_duration_ms: 30_000,
    preemption_timeout_ms: 10_000,
    shutdown_timeout_ms: 5_000,
    seen_keys_ttl_ms: 60_000,
    logging: { ...base.logging, level: "error", console: false },
    plugins: {
      ...base.plugins,
      health_check_interval_ms: 5_000,
      health_check_timeout_ms: 1_000,
      consecutive_failures_threshold: 3,
    },
    ...overrides,
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a fully wired integration context with real Core components
 * and fake plugins. Mirrors `bootstrap()` wiring order.
 *
 * All components are real — only plugins are fakes.
 * Uses in-memory SQLite and FakeClock for determinism.
 */
export function createIntegrationContext(options?: IntegrationContextOptions): IntegrationContext {
  const clock = new FakeClock();

  // Temp directory for PID file and workspace operations
  const engineerHome = join(tmpdir(), `engineer-integ-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`);
  mkdirSync(join(engineerHome, "run"), { recursive: true });
  mkdirSync(join(engineerHome, "data"), { recursive: true });

  // 1. Database (in-memory)
  const dbHandle = createTestDatabase();
  const db = dbHandle.db;

  // 1.5. Observer (silent for tests)
  const observer = createTestObserverFacade("cli");

  // 2-8. Core components via shared factory (mirrors bootstrap.ts wiring)
  const safetyConfig = SafetyConfigSchema.parse(options?.safetyConfig ?? {});
  // Default workspace_root inside engineerHome so tests never touch ~/.engineer.
  const workspaceConfig = WorkspaceConfigSchema.parse({
    workspace_root: join(engineerHome, "workspaces"),
    ...(options?.workspaceConfig ?? {}),
  });
  const {
    components: { eventBus, taskEngine, safetyLayer, actionPipeline, sessionMemory, workspaceManager, skillsManager },
  } = createCoreComponents({
    db,
    observer: observer.child("event-bus"),
    safetyConfig,
    workspaceConfig,
  });

  // 3. Registry + fake plugins (needs eventBus from core components)
  const registryHandle = createTestRegistry(eventBus as import("../../src/core/event-bus/index.js").EventBus, db);
  const { registry, fakes } = registryHandle;

  // 9. People Directory
  const peopleConfig = PeopleConfigSchema.parse({ people: options?.people ?? [] });
  const peopleDirectory = new PeopleDirectory(peopleConfig);

  // 9b. Notification Router
  const notifications = createNotificationRouter({
    registry,
    taskEngine,
    peopleDirectory,
    eventBus,
    observer: createTestObserverFacade("notifications"),
    config: {
      notification_retry: { interval_ms: 100, max_attempts: 3, max_age_ms: 10_000 },
      notification_suppress_window_ms: 300_000,
    },
    clock: { now: () => Date.now() },
  });

  // 10. Orchestrator
  const orchestrator = new Orchestrator({
    config: OrchestratorConfigSchema.parse({}),
    workspaceConfig,
    safetyConfig,
    eventBus,
    registry,
    taskEngine,
    safetyLayer,
    actionPipeline,
    sessionMemory,
    workspaceManager,
    skillsManager,
    peopleDirectory,
    observer: createTestObserverFacade("orchestrator"),
    notifications,
    tracesDir: null,
  });

  // 11. Daemon
  const daemonConfig = defaultDaemonConfig(options?.daemonConfig);

  const daemon = createDaemon({
    config: daemonConfig,
    workspaceConfig,
    eventBus,
    registry,
    taskEngine,
    safetyLayer,
    orchestrator,
    sessionMemory,
    workspaceManager,
    peopleDirectory,
    clock,
    observer: createTestObserverFacade("daemon"),
    engineerHome,
    notifications,
  });

  return {
    daemon,
    clock,
    db,
    eventBus,
    registry,
    taskEngine,
    safetyLayer,
    actionPipeline,
    orchestrator,
    sessionMemory,
    workspaceManager,
    peopleDirectory,
    fakes,
    engineerHome,
    cleanup() {
      registryHandle.cleanup();
      dbHandle.cleanup();
      try {
        rmSync(engineerHome, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    },
  };
}
