import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Daemon } from "../../src/core/daemon/index.js";
import { createDaemon } from "../../src/core/daemon/index.js";
import { createNotificationRouter } from "../../src/core/daemon/notification-router.js";
import type { AgentRunResult } from "../../src/schemas/adapters.js";
import { type DaemonConfig, DaemonConfigSchema, WorkspaceConfigSchema } from "../../src/schemas/config.js";
import { CheckpointReasons, JournalEntryTypes } from "../../src/schemas/session-memory.js";
import { SubStates, TaskStates } from "../../src/schemas/task.js";
import { writeSessionResultFromPrompt } from "../helpers/fake-cli-writer.js";
import { type IntegrationContext, createIntegrationContext } from "../helpers/integration-context.js";
import { createTestObserverFacade } from "../helpers/test-observer-facade.js";
import { type TestRepo, createTestRepo } from "../helpers/test-repo.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Wait for the daemon to have no active dispatches. */
async function waitForIdle(daemon: Daemon, maxMs = 5_000): Promise<void> {
  const start = Date.now();
  while (daemon.getState().activeTaskIds.length > 0) {
    await new Promise((r) => setTimeout(r, 10));
    if (Date.now() - start > maxMs) {
      throw new Error("Daemon still has active dispatches");
    }
  }
}

/** Build an AgentRunResult with the given JSON content. */
function makeResponse(json: Record<string, unknown>): AgentRunResult {
  return {
    content: JSON.stringify({ action: "done", result: json }),
    cost_usd: 0.003,
    duration_ms: 100,
    usage: null,
  };
}

/**
 * Build responses for the phases that run after resuming from a `planning` checkpoint.
 * Sequence: execution → self_review (1 sub + 1 refinement) → demo_prep. After demo_prep
 * the orchestrator creates a PR and exits at `review_pending`.
 */
function makeResumeFromPlanningResponses(): AgentRunResult[] {
  const ready = (extra: Record<string, unknown> = {}) => makeResponse({ status: "ready", ...extra });
  return [
    ready(), // execution
    ready({ quality_assessment: "ship_it" }), // self-review sub-phase
    ready({ quality_assessment: "ship_it" }), // self-review refinement
    ready(), // demo_prep
  ];
}

/** Number of LLM calls when resuming from a `planning` checkpoint. */
const RESUME_FROM_PLANNING_LLM_CALLS = 4;

interface CreateOrphanOptions {
  title?: string;
  checkpointPhase?: string;
  /** If provided, the orphan is created with a real worktree backed by this repo. */
  repo?: TestRepo;
}

/**
 * Create an orphaned task in active.working state with a checkpoint.
 * Simulates a daemon crash that left the task mid-execution.
 *
 * When `repo` is provided, also creates a real worktree on disk and stores it
 * in the task's `workspace` field — so the resumed dispatch can re-register
 * the workspace instead of running phases against a missing worktree.
 */
function createOrphanedTask(ctx: IntegrationContext, options?: CreateOrphanOptions): string {
  const title = options?.title ?? "Orphaned task";
  const checkpointPhase = options?.checkpointPhase ?? "planning";
  const repo = options?.repo;

  const task = ctx.taskEngine.createTask({
    title,
    repo: "test/repo",
    source: "test",
    idempotency_key: `e2e:${title}`,
    ...(repo ? { clone_url: repo.cloneUrl } : {}),
  });

  // If a real repo is provided, create an actual worktree — mirrors what the
  // orchestrator would have done before the crash. createWorkspace persists
  // task.workspace itself; no separate updateTaskField call is needed.
  if (repo) {
    ctx.workspaceManager.createWorkspace(task.id, "test/repo", {
      title,
      cloneUrl: repo.cloneUrl,
      thoughtsId: "crash-recovery",
    });
  }

  ctx.taskEngine.requestTransition(task.id, TaskStates.queued, null, "created", "test");
  ctx.taskEngine.requestTransition(task.id, TaskStates.active, SubStates.working, "scheduled", "test");

  const session = ctx.sessionMemory.sessions.create({ taskId: task.id });

  ctx.sessionMemory.journal.addEntry({
    sessionId: session.id,
    taskId: task.id,
    phase: checkpointPhase,
    type: JournalEntryTypes.phase_change,
    summary: `Completed ${checkpointPhase}`,
    tags: ["phase_transition"],
  });

  ctx.sessionMemory.checkpoints.create({
    sessionId: session.id,
    taskId: task.id,
    phase: checkpointPhase,
    phaseProgress: `Completed ${checkpointPhase} phase fully`,
    contextSummary: `Task was working on ${title}. Completed through ${checkpointPhase}.`,
    keyFindings: ["test finding"],
    openQuestions: [],
    nextAction: "Continue with next phase",
    lastEventId: "test-event-001",
    workspaceRef: null,
    reason: CheckpointReasons.phase_transition,
    journalOffset: 1,
  });

  // Don't end the session — in a real crash, the session would be left open.
  // The Orchestrator creates a new session on resume (linked via previousSessionId).

  return task.id;
}

/** Create a second daemon using the same context deps. */
function createSecondDaemon(ctx: IntegrationContext): Daemon {
  const base = DaemonConfigSchema.parse({});
  const config: DaemonConfig = {
    ...base,
    tick_interval_ms: 0,
    trigger_poll_interval_ms: 0,
    stuck_threshold_ms: 5_000,
    max_active_duration_ms: 30_000,
    shutdown_timeout_ms: 5_000,
    logging: { ...base.logging, level: "error", console: false },
    plugins: {
      ...base.plugins,
      health_check_interval_ms: 5_000,
      health_check_timeout_ms: 1_000,
      consecutive_failures_threshold: 3,
    },
  };

  return createDaemon({
    config,
    workspaceConfig: WorkspaceConfigSchema.parse({}),
    eventBus: ctx.eventBus,
    registry: ctx.registry,
    taskEngine: ctx.taskEngine,
    safetyLayer: ctx.safetyLayer,
    orchestrator: ctx.orchestrator,
    sessionMemory: ctx.sessionMemory,
    workspaceManager: ctx.workspaceManager,
    peopleDirectory: ctx.peopleDirectory,
    clock: ctx.clock,
    observer: createTestObserverFacade("daemon"),
    engineerHome: ctx.engineerHome,
    notifications: createNotificationRouter({
      registry: ctx.registry,
      taskEngine: ctx.taskEngine,
      peopleDirectory: ctx.peopleDirectory,
      eventBus: ctx.eventBus,
      observer: createTestObserverFacade("notifications"),
      config: { notification_retry: { interval_ms: 100, max_attempts: 3, max_age_ms: 10_000 } },
      clock: { now: () => Date.now() },
    }),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: Crash recovery", () => {
  let ctx: IntegrationContext;
  let daemon2: Daemon | null = null;
  let repo: TestRepo | null = null;

  function setup(options?: Parameters<typeof createIntegrationContext>[0]): IntegrationContext {
    ctx = createIntegrationContext(options);
    return ctx;
  }

  afterEach(async () => {
    if (daemon2) {
      try {
        await daemon2.stop();
      } catch {
        // May not be started
      }
      daemon2 = null;
    }
    if (ctx) {
      try {
        await ctx.daemon.stop();
      } catch {
        // May not be started
      }
      ctx.cleanup();
    }
    if (repo) {
      repo.cleanup();
      repo = null;
    }
  });

  function pidFilePath(): string {
    return join(ctx.engineerHome, "run", "engineer.pid");
  }

  it("recovers orphaned active task on startup", async () => {
    setup();

    const taskId = createOrphanedTask(ctx, { title: "Orphan recovery" });

    const taskBefore = ctx.taskEngine.getTask(taskId);
    expect(taskBefore?.state).toBe(TaskStates.active);
    expect(taskBefore?.sub_state).toBe(SubStates.working);

    daemon2 = createSecondDaemon(ctx);
    await daemon2.start();

    const taskAfter = ctx.taskEngine.getTask(taskId);
    expect(taskAfter?.state).toBe(TaskStates.queued);
  });

  it("resumes from checkpoint after crash recovery", async () => {
    repo = createTestRepo();
    setup();

    // Orphan with real worktree + checkpoint at `planning`.
    const taskId = createOrphanedTask(ctx, {
      title: "Checkpoint resume",
      checkpointPhase: "planning",
      repo,
    });

    ctx.fakes.llm.setCannedResponses(makeResumeFromPlanningResponses());
    ctx.fakes.llm.setInferSideEffect(writeSessionResultFromPrompt);

    await ctx.registry.initializePlugin("fake-agent", {});

    daemon2 = createSecondDaemon(ctx);
    await daemon2.start();

    // Recovery transitioned the orphan back to queued.
    expect(ctx.taskEngine.getTask(taskId)?.state).toBe(TaskStates.queued);

    // Tick to dispatch the queued task — orchestrator resumes from the planning
    // checkpoint, skipping requirements/research/planning. Advance past the
    // first-crash retry-policy backoff (~1 minute) so the task is eligible.
    ctx.clock.advance(60_000 + 1_000);
    await daemon2.tick();
    await waitForIdle(daemon2);

    expect(ctx.fakes.llm.getCallCount()).toBe(RESUME_FROM_PLANNING_LLM_CALLS);
    expect(daemon2.getState().tasksCompleted).toBe(1);
    // After demo_prep the orchestrator created a PR and exited at review_pending.
    expect(ctx.taskEngine.getTask(taskId)?.state).toBe(TaskStates.review_pending);
  });

  it("handles multiple orphaned tasks", async () => {
    setup({ daemonConfig: { max_concurrent: 1 } });

    const taskId1 = createOrphanedTask(ctx, { title: "Orphan A" });
    const taskId2 = createOrphanedTask(ctx, { title: "Orphan B" });

    expect(ctx.taskEngine.getTask(taskId1)?.state).toBe(TaskStates.active);
    expect(ctx.taskEngine.getTask(taskId2)?.state).toBe(TaskStates.active);

    daemon2 = createSecondDaemon(ctx);
    await daemon2.start();

    expect(ctx.taskEngine.getTask(taskId1)?.state).toBe(TaskStates.queued);
    expect(ctx.taskEngine.getTask(taskId2)?.state).toBe(TaskStates.queued);
  });

  it("PID file from dead process is overwritten", async () => {
    setup();

    writeFileSync(pidFilePath(), "999999999", "utf-8");
    expect(existsSync(pidFilePath())).toBe(true);

    daemon2 = createSecondDaemon(ctx);
    await daemon2.start();

    expect(daemon2.getState().running).toBe(true);
  });

  it("recovered task retains journal history from before crash", async () => {
    setup();

    const taskId = createOrphanedTask(ctx, {
      title: "Journal history",
      checkpointPhase: "research",
    });

    daemon2 = createSecondDaemon(ctx);
    await daemon2.start();

    // Recovery alone (no dispatch) is enough — the resume journal entry is
    // written by the orchestrator's `resolveStartState` when the task is later
    // dispatched. For this test we just verify pre-crash entries survive.
    const journal = ctx.sessionMemory.journal.query(taskId);
    expect(journal.length).toBeGreaterThanOrEqual(1);
    expect(journal.some((j) => j.summary.includes("research"))).toBe(true);
  });
});
