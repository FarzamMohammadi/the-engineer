import { afterEach, describe, expect, it } from "vitest";

import type { CompletionResult, TriggerEvent } from "../../src/schemas/adapters.js";
import type { Event } from "../../src/schemas/events.js";
import {
  type IntegrationContext,
  createIntegrationContext,
} from "../helpers/integration-context.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Wait for the daemon to have no active dispatches (fire-and-forget settled). */
async function waitForIdle(ctx: IntegrationContext, maxMs = 5_000): Promise<void> {
  const start = Date.now();
  while (ctx.daemon.getState().activeTaskIds.length > 0) {
    await new Promise((r) => setTimeout(r, 10));
    if (Date.now() - start > maxMs) {
      throw new Error(
        `Daemon still has active dispatches after ${String(maxMs)}ms: ${ctx.daemon.getState().activeTaskIds.join(", ")}`,
      );
    }
  }
}

function makeTriggerEvent(overrides?: Partial<TriggerEvent>): TriggerEvent {
  return {
    idempotency_key: `test:issue:repo:${String(Date.now())}:${String(Math.random()).slice(2, 8)}`,
    source: "fake-trigger",
    event_type: "issue_opened",
    external_ref: "https://github.com/test/repo/issues/1",
    title: "Test happy path issue",
    body: "Test body for happy path",
    repo: "test/repo",
    metadata: null,
    ...overrides,
  };
}

/** Build a CompletionResult with the given JSON content. */
function makeResponse(json: Record<string, unknown>): CompletionResult {
  return {
    content: JSON.stringify(json),
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

/** Build 7 canned LLM responses for the full phase pipeline. */
function makeFullPipelineResponses(): CompletionResult[] {
  return [
    makeResponse({
      complexity: "moderate",
      estimated_phases: [
        "intake_analysis",
        "research",
        "planning",
        "execution",
        "self_review",
        "demo_prep",
        "integration",
      ],
      ambiguities: [],
      fast_path: false,
      decomposition_likely: false,
    }),
    makeResponse({
      relevant_files: ["src/index.ts"],
      relevant_modules: ["core"],
      conventions: [],
      existing_patterns: ["singleton"],
      dependencies: ["zod"],
    }),
    makeResponse({
      approach: "Modify the settings module to add dark mode toggle",
      file_changes: [{ file: "src/settings.ts", change_type: "modify", description: "Add toggle" }],
      risks: [],
      decomposition_plan: null,
    }),
    makeResponse({
      files_changed: ["src/settings.ts"],
      tests_written: ["test/settings.test.ts"],
      test_results: { passed: 5, failed: 0, skipped: 0 },
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
      pr_description: "Adds dark mode toggle to settings page",
    }),
    makeResponse({
      children_verified: [],
      integration_tests: { passed: 3, failed: 0 },
      conflicts_found: [],
      resolution_actions: [],
    }),
  ];
}

/** Run trigger → create → schedule → dispatch → completion cycle. */
async function runFullLifecycle(ctx: IntegrationContext): Promise<void> {
  await ctx.registry.initializePlugin("fake-trigger", {});
  await ctx.registry.initializePlugin("fake-llm", {});

  await ctx.daemon.start();

  // Tick 1: poll trigger → create task (intake → queued)
  ctx.clock.advance(1_000);
  await ctx.daemon.tick();

  // Tick 2: schedule queued task → dispatch to orchestrator
  ctx.clock.advance(1_000);
  await ctx.daemon.tick();

  // Wait for orchestrator to finish (FakeLLM resolves instantly)
  await waitForIdle(ctx);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: Task happy path", () => {
  let ctx: IntegrationContext;

  function setup(options?: Parameters<typeof createIntegrationContext>[0]): IntegrationContext {
    ctx = createIntegrationContext(options);
    return ctx;
  }

  afterEach(async () => {
    if (ctx) {
      try {
        await ctx.daemon.stop();
      } catch {
        // May not be started or already stopped
      }
      ctx.cleanup();
    }
  });

  it("full lifecycle: trigger → 7 phases → completed", async () => {
    setup();

    ctx.fakes.trigger.setEvents([makeTriggerEvent({ title: "Add dark mode" })]);
    ctx.fakes.llm.setCannedResponses(makeFullPipelineResponses());

    await runFullLifecycle(ctx);

    // Verify dispatch completed
    expect(ctx.daemon.getState().tasksCompleted).toBe(1);
    expect(ctx.fakes.llm.getCallCount()).toBe(7);
  });

  it("emits cost.incurred event for each LLM call", async () => {
    setup();

    const costEvents: Event[] = [];
    ctx.eventBus.subscribe("test-cost", "cost.incurred", (e) => costEvents.push(e));

    ctx.fakes.trigger.setEvents([makeTriggerEvent({ title: "Cost tracking" })]);
    ctx.fakes.llm.setCannedResponses(makeFullPipelineResponses());

    await runFullLifecycle(ctx);

    // One cost event per phase
    expect(costEvents.length).toBe(7);
    for (const event of costEvents) {
      const payload = event.payload as { tokens_in: number; tokens_out: number };
      expect(payload.tokens_in).toBe(100);
      expect(payload.tokens_out).toBe(50);
    }
  });

  it("creates checkpoint at final phase boundary", async () => {
    setup();

    ctx.fakes.trigger.setEvents([makeTriggerEvent({ title: "Checkpoint test" })]);
    ctx.fakes.llm.setCannedResponses(makeFullPipelineResponses());

    await runFullLifecycle(ctx);

    // Find the task that was created
    const completed = ctx.taskEngine.getTasksByState("completed");
    const queued = ctx.taskEngine.getTasksByState("queued");
    const active = ctx.taskEngine.getTasksByState("active");
    const allTasks = [...completed, ...queued, ...active];

    // At least 1 task should exist
    expect(allTasks.length).toBeGreaterThanOrEqual(1);

    // Get latest checkpoint for first task
    const task = allTasks[0];
    expect(task).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
    const checkpoint = ctx.sessionMemory.getLatestCheckpoint(task!.id);
    expect(checkpoint).not.toBeNull();
    // Final checkpoint should be for integration (last phase)
    expect(checkpoint?.phase).toBe("integration");
  });

  it("fast path skips phases when intake says fast_path=true", async () => {
    setup();

    const fastPathResponses = [
      // intake_analysis with fast_path: true
      makeResponse({
        complexity: "trivial",
        estimated_phases: ["intake_analysis", "execution", "self_review"],
        ambiguities: [],
        fast_path: true,
        decomposition_likely: false,
      }),
      // execution (phase 2 of fast path)
      makeResponse({
        files_changed: ["src/typo.ts"],
        tests_written: [],
        test_results: { passed: 1, failed: 0, skipped: 0 },
        build_status: "passing",
      }),
      // self_review (phase 3 of fast path)
      makeResponse({
        findings: [],
        refactoring_applied: [],
        quality_assessment: "ship_it",
      }),
    ];

    ctx.fakes.trigger.setEvents([makeTriggerEvent({ title: "Fix typo" })]);
    ctx.fakes.llm.setCannedResponses(fastPathResponses);

    await runFullLifecycle(ctx);

    // Fast path: intake_analysis + execution + self_review = 3 LLM calls
    expect(ctx.fakes.llm.getCallCount()).toBe(3);
    expect(ctx.daemon.getState().tasksCompleted).toBe(1);
  });

  it("trigger dedup prevents duplicate tasks", async () => {
    setup();

    const event = makeTriggerEvent({
      idempotency_key: "test:issue:repo:dedup-42",
      title: "Dedup test",
    });
    ctx.fakes.trigger.setEvents([event]);
    ctx.fakes.llm.setCannedResponses(makeFullPipelineResponses());

    await ctx.registry.initializePlugin("fake-trigger", {});
    await ctx.registry.initializePlugin("fake-llm", {});

    await ctx.daemon.start();

    // First tick — creates task
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();

    // Count tasks after first tick
    const queued1 = ctx.taskEngine.getTasksByState("queued");
    const active1 = ctx.taskEngine.getTasksByState("active");
    const taskCount1 = queued1.length + active1.length;

    // Second tick — same event, should be deduped
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();

    const queued2 = ctx.taskEngine.getTasksByState("queued");
    const active2 = ctx.taskEngine.getTasksByState("active");
    const completed2 = ctx.taskEngine.getTasksByState("completed");
    const taskCount2 = queued2.length + active2.length + completed2.length;

    // Same total task count (may have been dispatched/completed, but no new task)
    expect(taskCount2).toBe(taskCount1);
  });
});
