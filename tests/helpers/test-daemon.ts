import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Mock, vi } from "vitest";

import { type Daemon, type DaemonState, createDaemon } from "../../src/core/daemon/index.js";
import { createNotificationRouter } from "../../src/core/daemon/notification-router.js";
import type { EventBus, EventCallback } from "../../src/core/event-bus/index.js";
import type { ISafetyLayer } from "../../src/core/interfaces/safety-layer.interface.js";
import type { ITaskEngine, TransitionResult } from "../../src/core/interfaces/task-engine.interface.js";
import type { ExecuteTaskResult, Orchestrator } from "../../src/core/orchestrator/index.js";
import type { PeopleDirectory } from "../../src/core/people-directory/index.js";
import type { Registry } from "../../src/core/registry/index.js";
import type { SessionMemory } from "../../src/core/session-memory/index.js";
import type { WorkspaceManager } from "../../src/core/workspace-manager/index.js";
import type { TriggerEvent } from "../../src/schemas/adapters.js";
import { type DaemonConfig, TimeoutStageActions, WorkspaceConfigSchema } from "../../src/schemas/config.js";
import { TaskStates } from "../../src/schemas/task.js";
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
    getBlockedTasksByReason: Mock;
    getQueuedByPriority: Mock;
    updateTaskField: Mock;
    updateTracking: Mock;
    checkPermission: Mock;
    getStateHistory: Mock;
  };
  orchestrator: {
    executeTask: Mock;
    attemptSelfUnblock: Mock;
    requestShutdown: Mock;
  };
  sessionMemory: {
    sessions: { create: Mock; end: Mock };
    journal: { addEntry: Mock; query: Mock; getLatestTimestamp: Mock };
    checkpoints: { create: Mock; getLatest: Mock };
  };
  safetyLayer: {
    evaluateAction: Mock;
    consultJudgment: Mock;
    getTimeoutPolicy: Mock;
    getCostStatus: Mock;
    updateConfig: Mock;
    checkAutoMergeAllowed: Mock;
    isCommentApprovalEnabled: Mock;
    shouldExcludeThoughtsOnMerge: Mock;
    flushCostSnapshot: Mock;
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
    shutdown_timeout_ms: 30_000,
    trigger_poll_interval_ms: 30_000,
    response_poll_interval_ms: 5_000,
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
        events: { max_age_days: 90 },
        observations: { max_age_days: 90 },
        journal_entries: { max_age_days: 90 },
        checkpoints: { max_age_days: 90 },
      },
    },
    database: { cache_size_mb: 64 },
    notification_retry: { interval_ms: 100, max_attempts: 3, max_age_ms: 10_000 },
    review_polling: { failure_window_ms: 300_000, max_failures_before_pause: 3 },
    retry_policy: {
      crash: { backoff_minutes: [1, 5, 15, 30, 30], max_attempts: 5 },
      agent_unavailable: { backoff_minutes: [2, 5, 10, 15, 15], max_attempts: 5 },
    },
    evaluation: { enabled: false },
    ...overrides,
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────

let taskCounter = 0;

/** Create a Daemon with all-mock dependencies for testing. */
export function createTestDaemon(configOverrides?: Partial<DaemonConfig>): TestDaemonHandle {
  taskCounter = 0;
  const clock = new FakeClock();
  const subscriptions = new Map<string, { eventType: string; callback: EventCallback }>();

  // Temp directory for PID file operations
  const engineerHome = join(tmpdir(), `engineer-test-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`);
  mkdirSync(join(engineerHome, "run"), { recursive: true });

  // ── EventBus mock ────────────────────────────────────────────────────
  const eventBus = {
    publish: vi.fn(),
    subscribe: vi.fn((subscriberId: string, eventType: string, callback: EventCallback) => {
      subscriptions.set(subscriberId, { eventType, callback });
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
        state: TaskStates.requirements_gathering,
        sub_state: null,
        priority: input.priority ?? 50,
        created_at: new Date(clock.now()).toISOString(),
        started_at: null,
      });
    }),
    requestTransition: vi.fn().mockReturnValue({ success: true } satisfies TransitionResult),
    getTask: vi.fn().mockReturnValue(null),
    getTasksByState: vi.fn().mockReturnValue([]),
    getBlockedTasksByReason: vi.fn().mockReturnValue([]),
    getQueuedByPriority: vi.fn().mockReturnValue([]),
    updateTaskField: vi.fn(),
    updateTracking: vi.fn(),
    checkPermission: vi.fn().mockReturnValue({ allowed: true }),
    getStateHistory: vi.fn().mockReturnValue([]),
    findByIdempotencyKey: vi.fn().mockReturnValue(false),
  };

  // ── Orchestrator mock ─────────────────────────────────────────────────
  const orchestrator = {
    executeTask: vi.fn().mockResolvedValue({
      outcome: "completed",
      phaseOutputs: new Map(),
    } satisfies ExecuteTaskResult),
    attemptSelfUnblock: vi.fn().mockResolvedValue(false),
    requestShutdown: vi.fn(),
  };

  // ── SessionMemory mock ────────────────────────────────────────────────
  const sessionMemory = {
    sessions: { create: vi.fn(), end: vi.fn() },
    journal: {
      addEntry: vi.fn(),
      query: vi.fn().mockReturnValue([]),
      getLatestTimestamp: vi.fn().mockReturnValue(null),
    },
    checkpoints: {
      create: vi.fn(),
      getLatest: vi.fn().mockReturnValue(null),
    },
  };

  // ── SafetyLayer mock ──────────────────────────────────────────────────
  const safetyLayer = {
    evaluateAction: vi.fn().mockReturnValue({ allowed: true, action: "proceed", reason: "allowed" }),
    consultJudgment: vi.fn(),
    getTimeoutPolicy: vi.fn().mockReturnValue({
      blocked: {
        stages: [
          {
            name: "reminder",
            after_ms: 14_400_000,
            action: TimeoutStageActions.send_reminder,
            repeat: true,
            repeat_interval_ms: 14_400_000,
          },
          {
            name: "self_unblock_check",
            after_ms: 28_800_000,
            action: TimeoutStageActions.evaluate_self_unblock,
            repeat: null,
            repeat_interval_ms: null,
          },
          {
            name: "escalation",
            after_ms: 172_800_000,
            action: TimeoutStageActions.escalation_alert,
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
    isCommentApprovalEnabled: vi.fn().mockReturnValue(false),
    shouldExcludeThoughtsOnMerge: vi.fn().mockReturnValue(false),
    flushCostSnapshot: vi.fn(),
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
  const observer = createTestObserverFacade("daemon");

  const notifications = createNotificationRouter({
    registry: registry as unknown as Registry,
    taskEngine: taskEngine as unknown as ITaskEngine,
    peopleDirectory: peopleDirectory as unknown as PeopleDirectory,
    eventBus: eventBus as unknown as EventBus,
    observer,
    config: { notification_retry: { interval_ms: 100, max_attempts: 3, max_age_ms: 10_000 } },
    clock: { now: vi.fn().mockReturnValue(Date.now()) },
  });

  const daemon = createDaemon({
    config,
    workspaceConfig: WorkspaceConfigSchema.parse({}),
    eventBus: eventBus as unknown as EventBus,
    registry: registry as unknown as Registry,
    taskEngine: taskEngine as unknown as ITaskEngine,
    safetyLayer: safetyLayer as unknown as ISafetyLayer,
    orchestrator: orchestrator as unknown as Orchestrator,
    sessionMemory: sessionMemory as unknown as SessionMemory,
    workspaceManager: workspaceManager as unknown as WorkspaceManager,
    peopleDirectory: peopleDirectory as unknown as PeopleDirectory,
    notifications,
    clock,
    observer,
    engineerHome,
  });

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
    workspaceManager,
    peopleDirectory,
    getSubscriptionCallback: (key: string) => {
      // Try subscriber ID first; fall back to first subscriber registered for that event type.
      const bySubscriber = subscriptions.get(key);
      if (bySubscriber) {
        return bySubscriber.callback;
      }
      for (const entry of subscriptions.values()) {
        if (entry.eventType === key) {
          return entry.callback;
        }
      }
      return undefined;
    },
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
    external_ref: { type: "test_issue", repo: "test/repo", id: "1" },
    title: "Test issue",
    body: "Test body",
    repo: "test/repo",
    clone_url: "https://github.com/test/repo.git",
    metadata: null,
    thoughts_id: "test-1",
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
