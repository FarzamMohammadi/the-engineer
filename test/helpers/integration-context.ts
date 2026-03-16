import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { ActionPipeline } from "../../src/core/action-pipeline/index.js";
import { type Daemon, createDaemon } from "../../src/core/daemon/index.js";
import { EventBus } from "../../src/core/event-bus/index.js";
import type { ISafetyLayer } from "../../src/core/interfaces/safety-layer.interface.js";
import { Orchestrator } from "../../src/core/orchestrator/index.js";
import { PeopleDirectory } from "../../src/core/people-directory/index.js";
import type { Registry } from "../../src/core/registry/index.js";
import { SafetyLayer } from "../../src/core/safety-layer/index.js";
import { SessionMemory } from "../../src/core/session-memory/index.js";
import { TaskEngine } from "../../src/core/task-engine/index.js";
import { WorkspaceManager } from "../../src/core/workspace-manager/index.js";
import type { Person } from "../../src/schemas/adapters.js";
import type { DaemonConfig, SafetyConfig, WorkspaceConfig } from "../../src/schemas/config.js";
import {
  DaemonConfigSchema,
  PeopleConfigSchema,
  SafetyConfigSchema,
  WorkspaceConfigSchema,
} from "../../src/schemas/config.js";
import { FakeClock } from "./fake-clock.js";
import type { FakeCommunicationPlugin } from "./fake-plugins/fake-comm/index.js";
import type { FakeGitHostingPlugin } from "./fake-plugins/fake-git-hosting/index.js";
import type { FakeLLMPlugin } from "./fake-plugins/fake-llm/index.js";
import type { FakeToolPlugin } from "./fake-plugins/fake-tool/index.js";
import type { FakeTriggerPlugin } from "./fake-plugins/fake-trigger/index.js";
import { createTestDatabase } from "./test-database.js";
import { createTestObserverFacade } from "./test-observer-facade.js";
import { type TestRegistryFakes, createTestRegistry } from "./test-registry.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface IntegrationContextFakes extends TestRegistryFakes {
  trigger: FakeTriggerPlugin;
  communication: FakeCommunicationPlugin;
  llm: FakeLLMPlugin;
  tool: FakeToolPlugin;
  gitHosting: FakeGitHostingPlugin;
}

export interface IntegrationContext {
  daemon: Daemon;
  clock: FakeClock;
  db: Database.Database;
  eventBus: EventBus;
  registry: Registry;
  taskEngine: TaskEngine;
  safetyLayer: ISafetyLayer;
  actionPipeline: ActionPipeline;
  orchestrator: Orchestrator;
  sessionMemory: SessionMemory;
  workspaceManager: WorkspaceManager;
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
    stuck_threshold_ms: 5_000,
    max_active_duration_ms: 30_000,
    preemption_timeout_ms: 10_000,
    shutdown_timeout_ms: 5_000,
    aging_threshold_ms: 10_000,
    aging_interval_ms: 5_000,
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
  const engineerHome = join(
    tmpdir(),
    `engineer-integ-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
  );
  mkdirSync(join(engineerHome, "run"), { recursive: true });
  mkdirSync(join(engineerHome, "data"), { recursive: true });

  // 1. Database (in-memory)
  const dbHandle = createTestDatabase();
  const db = dbHandle.db;

  // 1.5. Observer (silent for tests)
  const observer = createTestObserverFacade("cli");

  // 2. Event Bus
  const eventBus = new EventBus(db, { observer: observer.child("event-bus") });

  // 3. Registry + fake plugins
  const registryHandle = createTestRegistry(eventBus);
  const { registry, fakes } = registryHandle;

  // 4. Task Engine
  const taskEngine = new TaskEngine(db, eventBus, observer.child("task-engine"));

  // 5. Safety Layer
  const safetyConfig = SafetyConfigSchema.parse(options?.safetyConfig ?? {});
  const safetyLayer = new SafetyLayer(db, eventBus, safetyConfig);

  // 6. Action Pipeline
  const actionPipeline = new ActionPipeline(
    taskEngine,
    safetyLayer,
    eventBus,
    observer.child("action-pipeline"),
  );

  // 7. Session Memory
  const sessionMemory = new SessionMemory(db);

  // 8. Workspace Manager
  const workspaceConfig = WorkspaceConfigSchema.parse(options?.workspaceConfig ?? {});
  const workspaceManager = new WorkspaceManager(eventBus, workspaceConfig);

  // 9. People Directory
  const peopleConfig = PeopleConfigSchema.parse({ people: options?.people ?? [] });
  const peopleDirectory = new PeopleDirectory(peopleConfig);

  // 10. Orchestrator
  const orchestrator = new Orchestrator({
    eventBus,
    registry,
    taskEngine,
    safetyLayer,
    actionPipeline,
    sessionMemory,
    workspaceManager,
    peopleDirectory,
    observer: createTestObserverFacade("orchestrator"),
  });

  // 11. Daemon
  const daemonConfig = defaultDaemonConfig(options?.daemonConfig);

  const daemon = createDaemon(daemonConfig, {
    eventBus,
    registry,
    taskEngine,
    safetyLayer,
    actionPipeline,
    orchestrator,
    sessionMemory,
    workspaceManager,
    peopleDirectory,
    clock,
    observer: createTestObserverFacade("daemon"),
    engineerHome,
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
