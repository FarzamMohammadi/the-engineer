import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Daemon } from "../../src/core/daemon/index.js";
import { createDaemon } from "../../src/core/daemon/index.js";
import type { CompletionResult } from "../../src/schemas/adapters.js";
import { type DaemonConfig, DaemonConfigSchema } from "../../src/schemas/config.js";
import {
  type IntegrationContext,
  createIntegrationContext,
} from "../helpers/integration-context.js";
import { createTestObserverFacade } from "../helpers/test-observer-facade.js";

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

/** Build a CompletionResult with the given JSON content (wrapped in agent loop format). */
function makeResponse(json: Record<string, unknown>): CompletionResult {
  return {
    content: JSON.stringify({ action: "done", result: json }),
    tool_calls: null,
    finish_reason: "stop",
    usage: {
      tokens_in: 100,
      tokens_out: 50,
      spend_usd: 0.003,
      remaining: null,
      resets_at: null,
    },
  };
}

/** Build canned responses for the 4 remaining phases (execution → integration). */
function makeRemainingPhasesResponses(): CompletionResult[] {
  return [
    makeResponse({
      files_changed: ["src/index.ts"],
      tests_written: ["test/index.test.ts"],
      test_results: { passed: 3, failed: 0, skipped: 0 },
      build_status: "passing",
    }),
    makeResponse({
      findings: [],
      refactoring_applied: [],
      quality_assessment: "ship_it",
    }),
    makeResponse({
      artifacts: [],
      pr_number: 1,
      pr_description: "Implements the feature",
    }),
    makeResponse({
      children_verified: [],
      integration_tests: { passed: 2, failed: 0 },
      conflicts_found: [],
      resolution_actions: [],
    }),
  ];
}

/**
 * Create an orphaned task in active.working state with a checkpoint.
 * Simulates a daemon crash that left the task mid-execution.
 */
function createOrphanedTask(
  ctx: IntegrationContext,
  options?: { title?: string; checkpointPhase?: string },
): string {
  const title = options?.title ?? "Orphaned task";
  const checkpointPhase = options?.checkpointPhase ?? "planning";

  // Create task (starts in intake)
  const task = ctx.taskEngine.createTask({
    title,
    repo: "test/repo",
    source: "test",
  });

  // Transition: intake → queued → active.working
  ctx.taskEngine.requestTransition(task.id, "queued", null, "created", "test");
  ctx.taskEngine.requestTransition(task.id, "active", "working", "scheduled", "test");

  // Create a session + checkpoint to simulate partial execution
  const session = ctx.sessionMemory.createSession({ taskId: task.id });

  // Add journal entries for completed phases
  ctx.sessionMemory.addJournalEntry({
    sessionId: session.id,
    taskId: task.id,
    phase: checkpointPhase,
    type: "phase_change",
    summary: `Completed ${checkpointPhase}`,
    tags: ["phase_transition"],
  });

  // Create checkpoint at the specified phase
  ctx.sessionMemory.createCheckpoint({
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
    reason: "phase_transition",
    journalOffset: 1,
  });

  // Don't end the session — in a real crash, the session would be left open.
  // The Orchestrator creates a new session on resume (linked via previousSessionId).

  return task.id;
}

/** Create a second daemon using the same context deps. */
function createSecondDaemon(ctx: IntegrationContext): Daemon {
  // Use the same config pattern as createIntegrationContext:
  // parse defaults first, then override with test-friendly values
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
    eventBus: ctx.eventBus,
    registry: ctx.registry,
    taskEngine: ctx.taskEngine,
    safetyLayer: ctx.safetyLayer,
    actionPipeline: ctx.actionPipeline,
    orchestrator: ctx.orchestrator,
    sessionMemory: ctx.sessionMemory,
    workspaceManager: ctx.workspaceManager,
    peopleDirectory: ctx.peopleDirectory,
    clock: ctx.clock,
    observer: createTestObserverFacade("daemon"),
    engineerHome: ctx.engineerHome,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: Crash recovery", () => {
  let ctx: IntegrationContext;
  let daemon2: Daemon | null = null;

  function setup(options?: Parameters<typeof createIntegrationContext>[0]): IntegrationContext {
    ctx = createIntegrationContext(options);
    return ctx;
  }

  afterEach(async () => {
    // Clean up daemon2 if created
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
  });

  function pidFilePath(): string {
    return join(ctx.engineerHome, "run", "engineer.pid");
  }

  it("recovers orphaned active task on startup", async () => {
    setup();

    const taskId = createOrphanedTask(ctx, { title: "Orphan recovery" });

    // Verify task is in active.working
    const taskBefore = ctx.taskEngine.getTask(taskId);
    expect(taskBefore?.state).toBe("active");
    expect(taskBefore?.sub_state).toBe("working");

    // Start daemon — should detect orphan and transition to queued
    daemon2 = createSecondDaemon(ctx);
    await daemon2.start();

    const taskAfter = ctx.taskEngine.getTask(taskId);
    expect(taskAfter?.state).toBe("queued");
  });

  it("resumes from checkpoint after crash recovery", async () => {
    setup();

    // Create orphaned task with checkpoint at "planning" phase
    const taskId = createOrphanedTask(ctx, {
      title: "Checkpoint resume",
      checkpointPhase: "planning",
    });

    // Set canned responses for remaining phases: execution → integration (4 phases)
    ctx.fakes.llm.setCannedResponses(makeRemainingPhasesResponses());

    await ctx.registry.initializePlugin("fake-llm", {});

    // Start fresh daemon — recovers orphan to queued
    daemon2 = createSecondDaemon(ctx);
    await daemon2.start();

    // Verify recovered to queued
    expect(ctx.taskEngine.getTask(taskId)?.state).toBe("queued");

    // Tick to schedule and dispatch
    ctx.clock.advance(1_000);
    await daemon2.tick();

    // Wait for orchestrator to complete
    await waitForIdle(daemon2);

    // Orchestrator should have resumed from checkpoint at "planning"
    // → skip intake_analysis, research, planning → run execution, self_review, demo_prep, integration
    expect(ctx.fakes.llm.getCallCount()).toBe(4);
    expect(daemon2.getState().tasksCompleted).toBe(1);
  });

  it("handles multiple orphaned tasks", async () => {
    setup({ daemonConfig: { max_concurrent: 1 } });

    const taskId1 = createOrphanedTask(ctx, { title: "Orphan A" });
    const taskId2 = createOrphanedTask(ctx, { title: "Orphan B" });

    // Both in active.working
    expect(ctx.taskEngine.getTask(taskId1)?.state).toBe("active");
    expect(ctx.taskEngine.getTask(taskId2)?.state).toBe("active");

    // Start daemon — recovers both to queued
    daemon2 = createSecondDaemon(ctx);
    await daemon2.start();

    expect(ctx.taskEngine.getTask(taskId1)?.state).toBe("queued");
    expect(ctx.taskEngine.getTask(taskId2)?.state).toBe("queued");
  });

  it("PID file from dead process is overwritten", async () => {
    setup();

    // Write a stale PID file
    writeFileSync(pidFilePath(), "999999999", "utf-8");
    expect(existsSync(pidFilePath())).toBe(true);

    daemon2 = createSecondDaemon(ctx);
    await daemon2.start();

    // PID file should now contain current process PID
    expect(daemon2.getState().running).toBe(true);
  });

  it("recovered task retains journal history from before crash", async () => {
    setup();

    const taskId = createOrphanedTask(ctx, {
      title: "Journal history",
      checkpointPhase: "research",
    });

    // Set responses for remaining phases: planning → integration (5 phases)
    ctx.fakes.llm.setCannedResponses([
      makeResponse({
        approach: "Test approach",
        file_changes: [],
        risks: [],
        decomposition_plan: null,
      }),
      ...makeRemainingPhasesResponses(),
    ]);

    await ctx.registry.initializePlugin("fake-llm", {});

    // Start daemon, recover, dispatch
    daemon2 = createSecondDaemon(ctx);
    await daemon2.start();

    ctx.clock.advance(1_000);
    await daemon2.tick();
    await waitForIdle(daemon2);

    // Query journal for the task — should have entries from both pre-crash and post-crash sessions
    const journal = ctx.sessionMemory.queryJournal(taskId);
    expect(journal.length).toBeGreaterThanOrEqual(2);

    // Should have a pre-crash entry and post-recovery entries
    const summaries = journal.map((j) => j.summary);
    const hasPreCrash = summaries.some((s) => s.includes("research"));
    const hasPostRecovery = summaries.some((s) => s.includes("Resumed") || s.includes("Completed"));
    expect(hasPreCrash).toBe(true);
    expect(hasPostRecovery).toBe(true);
  });
});
