import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Mock, vi } from "vitest";

import type { ActionPipeline } from "../../src/core/action-pipeline/index.js";
import {
  type Daemon,
  type DaemonDependencies,
  type DaemonState,
  createDaemon,
} from "../../src/core/daemon/index.js";
import type { EventBus, EventCallback } from "../../src/core/event-bus/index.js";
import type { ISafetyLayer } from "../../src/core/interfaces/safety-layer.interface.js";
import type { ISessionMemory } from "../../src/core/interfaces/session-memory.interface.js";
import type {
  ITaskEngine,
  TransitionResult,
} from "../../src/core/interfaces/task-engine.interface.js";
import type { ExecuteTaskResult, Orchestrator } from "../../src/core/orchestrator/index.js";
import type { PeopleDirectory } from "../../src/core/people-directory/index.js";
import type { Registry } from "../../src/core/registry/index.js";
import type { WorkspaceManager } from "../../src/core/workspace-manager/index.js";
import type { TriggerEvent } from "../../src/schemas/adapters.js";
import type { DaemonConfig } from "../../src/schemas/config.js";
import { FakeClock } from "./fake-clock.js";
import { createTestObserverFacade } from "./test-observer-facade.js";
import { createMockTask } from "./test-orchestrator.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface TestDaemonHandle {
  daemon: Daemon;
  clock: FakeClock;
  engineerHome: string;
  eventBus: {
    publish: Mock;
    subscribe: Mock;
    unsubscribe: Mock;
    replay: Mock;
    getEventsForTask: Mock;
    getEventsSince: Mock;
  };
  registry: {
    getPluginsByType: Mock;
    getPrimaryPlugin: Mock;
    getPlugin: Mock;
    getManifest: Mock;
    startHealthCheckLoop: Mock;
    stopHealthCheckLoop: Mock;
    shutdownAll: Mock;
    healthCheckAll: Mock;
    register: Mock;
    deregister: Mock;
  };
  taskEngine: {
    createTask: Mock;
    requestTransition: Mock;
    getTask: Mock;
    getTasksByState: Mock;
    getQueuedByPriority: Mock;
    updateTaskField: Mock;
    updateTracking: Mock;
    checkPermission: Mock;
    getChildren: Mock;
    getStateHistory: Mock;
  };
  orchestrator: {
    executeTask: Mock;
    attemptSelfUnblock: Mock;
  };
  sessionMemory: {
    getLatestCheckpoint: Mock;
    getKnowledge: Mock;
    queryJournal: Mock;
    createSession: Mock;
    endSession: Mock;
    addJournalEntry: Mock;
    createCheckpoint: Mock;
    getSessionChain: Mock;
    storeKnowledge: Mock;
    supersedeKnowledge: Mock;
    confirmKnowledge: Mock;
  };
  safetyLayer: {
    evaluateAction: Mock;
    consultJudgment: Mock;
    getTimeoutPolicy: Mock;
    getCostStatus: Mock;
    updateConfig: Mock;
    checkAutoMergeAllowed: Mock;
  };
  actionPipeline: {
    execute: Mock;
  };
  workspaceManager: {
    createWorkspace: Mock;
    verifyWorkspace: Mock;
    getWorktreePath: Mock;
    cleanupWorkspace: Mock;
  };
  peopleDirectory: {
    getPerson: Mock;
    getByRole: Mock;
    getOwner: Mock;
    getReviewers: Mock;
    resolveContact: Mock;
    getAll: Mock;
    updateConfig: Mock;
  };
  /** Event subscription callbacks captured for manual triggering. */
  getSubscriptionCallback(eventType: string): EventCallback | undefined;
  getState(): DaemonState;
  cleanup(): void;
}

// ── Default Config ──────────────────────────────────────────────────────────

function defaultTestConfig(overrides?: Partial<DaemonConfig>): DaemonConfig {
  return {
    max_concurrent: 1,
    tick_interval_ms: 5_000,
    preemption_threshold: 20,
    preemption_timeout_ms: 60_000,
    stuck_threshold_ms: 1_800_000,
    max_active_duration_ms: 28_800_000,
    aging_threshold_ms: 86_400_000,
    aging_increment: 5,
    aging_interval_ms: 86_400_000,
    aging_cap: 75,
    shutdown_timeout_ms: 30_000,
    trigger_poll_interval_ms: 30_000,
    seen_keys_ttl_ms: 86_400_000,
    logging: {
      level: "error",
      dir: "logs",
      max_size_bytes: 524_288_000,
      max_files: 7,
      console: false,
    },
    plugins: {
      dirs: ["src/plugins"],
      health_check_interval_ms: 60_000,
      health_check_timeout_ms: 5_000,
      consecutive_failures_threshold: 3,
    },
    subscriber_warn_threshold_ms: 50,
    data_lifecycle: {
      enabled: false,
      interval_ms: 3_600_000,
      retention: {
        events: { max_age_days: 90, max_count: null },
        action_traces: { max_age_days: 60, max_count: null },
        phase_metrics: { max_age_days: 180, max_count: null },
        llm_traces: { max_age_days: 60, max_count: null },
        journal_entries: { max_age_days: 90, max_count: null },
        checkpoints: { max_age_days: 90, max_count: null },
      },
      vacuum_on_cleanup: true,
    },
    database: { cache_size_mb: 64 },
    ...overrides,
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────

let taskCounter = 0;

/** Create a Daemon with all-mock dependencies for testing. */
export function createTestDaemon(configOverrides?: Partial<DaemonConfig>): TestDaemonHandle {
  taskCounter = 0;
  const clock = new FakeClock();
  const subscriptions = new Map<string, EventCallback>();

  // Temp directory for PID file operations
  const engineerHome = join(
    tmpdir(),
    `engineer-test-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`,
  );
  mkdirSync(join(engineerHome, "run"), { recursive: true });

  // ── EventBus mock ────────────────────────────────────────────────────
  const eventBus = {
    publish: vi.fn(),
    subscribe: vi.fn((_subscriberId: string, eventType: string, callback: EventCallback) => {
      subscriptions.set(eventType, callback);
    }),
    unsubscribe: vi.fn(),
    replay: vi.fn(),
    getEventsForTask: vi.fn().mockReturnValue([]),
    getEventsSince: vi.fn().mockReturnValue([]),
  };

  // ── Registry mock ─────────────────────────────────────────────────────
  const registry = {
    getPluginsByType: vi.fn().mockReturnValue([]),
    getPrimaryPlugin: vi.fn().mockReturnValue(null),
    getPlugin: vi.fn().mockReturnValue(null),
    getManifest: vi.fn().mockReturnValue(null),
    startHealthCheckLoop: vi.fn(),
    stopHealthCheckLoop: vi.fn(),
    shutdownAll: vi.fn().mockResolvedValue(undefined),
    healthCheckAll: vi.fn().mockResolvedValue([]),
    register: vi.fn(),
    deregister: vi.fn(),
  };

  // ── TaskEngine mock ──────────────────────────────────────────────────
  const taskEngine = {
    createTask: vi.fn((input: { title: string; priority?: number }) => {
      taskCounter++;
      return createMockTask({
        id: `task-${String(taskCounter).padStart(3, "0")}`,
        title: input.title,
        state: "intake",
        sub_state: null,
        priority: input.priority ?? 50,
        created_at: new Date(clock.now()).toISOString(),
        started_at: null,
      });
    }),
    requestTransition: vi.fn().mockReturnValue({ success: true } satisfies TransitionResult),
    getTask: vi.fn().mockReturnValue(null),
    getTasksByState: vi.fn().mockReturnValue([]),
    getQueuedByPriority: vi.fn().mockReturnValue([]),
    updateTaskField: vi.fn(),
    updateTracking: vi.fn(),
    checkPermission: vi.fn().mockReturnValue({ allowed: true }),
    getChildren: vi.fn().mockReturnValue([]),
    getStateHistory: vi.fn().mockReturnValue([]),
  };

  // ── Orchestrator mock ─────────────────────────────────────────────────
  const orchestrator = {
    executeTask: vi.fn().mockResolvedValue({
      outcome: "completed",
      phaseOutputs: new Map(),
    } satisfies ExecuteTaskResult),
    attemptSelfUnblock: vi.fn().mockResolvedValue(false),
  };

  // ── SessionMemory mock ────────────────────────────────────────────────
  const sessionMemory = {
    getLatestCheckpoint: vi.fn().mockReturnValue(null),
    getKnowledge: vi.fn().mockReturnValue([]),
    queryJournal: vi.fn().mockReturnValue([]),
    createSession: vi.fn(),
    endSession: vi.fn(),
    addJournalEntry: vi.fn(),
    createCheckpoint: vi.fn(),
    getSessionChain: vi.fn().mockReturnValue([]),
    storeKnowledge: vi.fn(),
    supersedeKnowledge: vi.fn(),
    confirmKnowledge: vi.fn(),
  };

  // ── SafetyLayer mock ──────────────────────────────────────────────────
  const safetyLayer = {
    evaluateAction: vi
      .fn()
      .mockReturnValue({ allowed: true, action: "proceed", reason: "allowed" }),
    consultJudgment: vi.fn(),
    getTimeoutPolicy: vi.fn().mockReturnValue({
      blocked: {
        stages: [
          {
            name: "reminder",
            after_ms: 14_400_000,
            action: "send_reminder",
            repeat: true,
            repeat_interval_ms: 14_400_000,
          },
          {
            name: "self_unblock_check",
            after_ms: 28_800_000,
            action: "evaluate_self_unblock",
            repeat: null,
            repeat_interval_ms: null,
          },
          {
            name: "escalation",
            after_ms: 172_800_000,
            action: "escalation_alert",
            repeat: null,
            repeat_interval_ms: null,
          },
        ],
      },
      review_pending: {
        reminder_after_ms: 86_400_000,
        repeat_interval_ms: 86_400_000,
      },
    }),
    getCostStatus: vi.fn().mockReturnValue({}),
    updateConfig: vi.fn(),
    checkAutoMergeAllowed: vi.fn().mockReturnValue(false),
  };

  // ── ActionPipeline mock ───────────────────────────────────────────────
  const actionPipeline = {
    execute: vi.fn(),
  };

  // ── WorkspaceManager mock ─────────────────────────────────────────────
  const workspaceManager = {
    createWorkspace: vi.fn(),
    verifyWorkspace: vi.fn(),
    getWorktreePath: vi.fn().mockReturnValue(null),
    cleanupWorkspace: vi.fn(),
  };

  // ── PeopleDirectory mock ──────────────────────────────────────────────
  const peopleDirectory = {
    getPerson: vi.fn().mockReturnValue(null),
    getByRole: vi.fn().mockReturnValue([]),
    getOwner: vi.fn().mockReturnValue(null),
    getReviewers: vi.fn().mockReturnValue([]),
    resolveContact: vi.fn().mockReturnValue(null),
    getAll: vi.fn().mockReturnValue([]),
    updateConfig: vi.fn(),
  };

  // ── Build Daemon ──────────────────────────────────────────────────────
  const config = defaultTestConfig(configOverrides);

  const deps: DaemonDependencies = {
    eventBus: eventBus as unknown as EventBus,
    registry: registry as unknown as Registry,
    taskEngine: taskEngine as unknown as ITaskEngine,
    safetyLayer: safetyLayer as unknown as ISafetyLayer,
    actionPipeline: actionPipeline as unknown as ActionPipeline,
    orchestrator: orchestrator as unknown as Orchestrator,
    sessionMemory: sessionMemory as unknown as ISessionMemory,
    workspaceManager: workspaceManager as unknown as WorkspaceManager,
    peopleDirectory: peopleDirectory as unknown as PeopleDirectory,
    clock,
    observer: createTestObserverFacade("daemon"),
    engineerHome,
  };

  const daemon = createDaemon(config, deps);

  return {
    daemon,
    clock,
    engineerHome,
    eventBus,
    registry,
    taskEngine,
    orchestrator,
    sessionMemory,
    safetyLayer,
    actionPipeline,
    workspaceManager,
    peopleDirectory,
    getSubscriptionCallback: (eventType: string) => subscriptions.get(eventType),
    getState: () => daemon.getState(),
    cleanup: () => {
      try {
        rmSync(engineerHome, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    },
  };
}

// ── Trigger Event Factory ───────────────────────────────────────────────────

/** Create a mock TriggerEvent for testing. */
export function createTestTriggerEvent(overrides?: Partial<TriggerEvent>): TriggerEvent {
  return {
    idempotency_key: `test:issue:repo:${String(Date.now())}`,
    source: "test-trigger",
    event_type: "issue_opened",
    external_ref: "https://github.com/test/repo/issues/1",
    title: "Test issue",
    body: "Test body",
    repo: "test/repo",
    clone_url: "https://github.com/test/repo.git",
    metadata: null,
    ...overrides,
  };
}

/** Create a mock trigger plugin with configurable responses. */
export function createMockTriggerPlugin(events: TriggerEvent[] = []) {
  return {
    manifest: { id: "test-trigger", type: "trigger", version: "1.0.0", name: "Test Trigger" },
    poll: vi.fn().mockResolvedValue(events),
    hasCapability: vi.fn().mockReturnValue(false),
  };
}
