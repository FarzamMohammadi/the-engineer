import { afterEach, describe, expect, it } from "vitest";

import type { AgentRunResult, TriggerEvent } from "../../src/schemas/adapters.js";
import type { Event } from "../../src/schemas/events.js";
import { TaskStates } from "../../src/schemas/task.js";
import { writeSessionResultFromPrompt } from "../helpers/fake-cli-writer.js";
import { type IntegrationContext, createIntegrationContext } from "../helpers/integration-context.js";
import { type TestRepo, createTestRepo } from "../helpers/test-repo.js";

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
    external_ref: { type: "test_issue", repo: "test/repo", id: "1" },
    title: "Test happy path issue",
    body: "Test body for happy path",
    repo: "test/repo",
    clone_url: "",
    metadata: null,
    thoughts_id: "test-1",
    ...overrides,
  };
}

/** Build an AgentRunResult with the given JSON content (wrapped in agent loop format). */
function makeResponse(json: Record<string, unknown>): AgentRunResult {
  return {
    content: JSON.stringify({ action: "done", result: json }),
    cost_usd: 0.003,
    duration_ms: 100,
    usage: null,
  };
}

/**
 * Build canned responses for one full happy-path pipeline run.
 *
 * The CLI-native pipeline makes 7 LLM calls in order: requirements, research, planning,
 * execution, self-review (1 sub-phase + 1 refinement), demo-prep. After demo-prep the
 * orchestrator commits/pushes and creates a PR — the pipeline exits at `review_pending`
 * for human review.
 */
function makeFullPipelineResponses(): AgentRunResult[] {
  const ready = (extra: Record<string, unknown> = {}) => makeResponse({ status: "ready", ...extra });
  return [
    ready(), // requirements_gathering
    ready(), // research
    ready({ decomposition_plan: null }), // planning
    ready(), // execution
    ready({ findings: [], quality_assessment: "ship_it" }), // self-review sub-phase
    ready({ quality_assessment: "ship_it" }), // self-review refinement
    ready(), // demo_prep
  ];
}

/** Number of LLM calls in a full happy-path pipeline (see makeFullPipelineResponses). */
const FULL_PIPELINE_LLM_CALLS = 7;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: Task happy path", () => {
  let ctx: IntegrationContext;
  let repo: TestRepo | null = null;

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
    if (repo) {
      repo.cleanup();
      repo = null;
    }
  });

  // ── Smoke test ─────────────────────────────────────────────────────────────
  // ONE end-to-end run with a real worktree (bare git repo on disk) and a FakeLLM
  // that simulates the file-writing behavior of a real CLI agent. If anything in
  // the daemon → orchestrator → phase pipeline wiring breaks, this alarms.

  it("smoke: full pipeline runs green end-to-end", async () => {
    repo = createTestRepo();
    setup();

    ctx.fakes.trigger.setEvents([makeTriggerEvent({ title: "Smoke test", clone_url: repo.cloneUrl })]);
    ctx.fakes.llm.setCannedResponses(makeFullPipelineResponses());
    ctx.fakes.llm.setInferSideEffect(writeSessionResultFromPrompt);

    await ctx.registry.initializePlugin("fake-trigger", {});
    await ctx.registry.initializePlugin("fake-agent", {});

    await ctx.daemon.start();

    // Tick 1: poll trigger → create task. Tick 2: schedule → dispatch.
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();
    await waitForIdle(ctx);

    expect(ctx.daemon.getState().tasksCompleted).toBe(1);
    expect(ctx.fakes.llm.getCallCount()).toBe(FULL_PIPELINE_LLM_CALLS);

    // After demo_prep the orchestrator created a PR via fake-git-hosting, so the
    // task is waiting on human review.
    const reviewPending = ctx.taskEngine.getTasksByState(TaskStates.review_pending);
    expect(reviewPending.length).toBe(1);

    const taskId = reviewPending[0]!.id;
    const checkpoint = ctx.sessionMemory.checkpoints.getLatest(taskId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.phase).toBe("demo_prep");
  });

  // ── Dispatch and routing tests ─────────────────────────────────────────────
  // These don't simulate a real CLI — they verify the daemon's orchestration
  // behavior with a vanilla FakeLLM. The phase pipeline throws WorkspaceNotReadyError
  // on the first phase (no clone_url → no workspace), so the orchestrator returns
  // outcome=error and the scheduler transitions the task to `blocked`. That's the
  // honest, deterministic thing to assert with these fakes.

  it("trigger → task creation → dispatch → terminal state (blocked, no workspace)", async () => {
    setup();

    ctx.fakes.trigger.setEvents([makeTriggerEvent({ title: "Routing test" })]);

    await ctx.registry.initializePlugin("fake-trigger", {});
    await ctx.registry.initializePlugin("fake-agent", {});

    await ctx.daemon.start();

    ctx.clock.advance(1_000);
    await ctx.daemon.tick();
    await waitForIdle(ctx);

    // Task was created, dispatched, and reached a terminal state.
    expect(ctx.daemon.getState().tasksCompleted).toBe(1);

    // Workspace creation was skipped (empty clone_url) → first phase threw
    // WorkspaceNotReadyError → orchestrator returned outcome=error → blocked.
    const blocked = ctx.taskEngine.getTasksByState(TaskStates.blocked);
    expect(blocked.length).toBe(1);
    expect(blocked[0]?.title).toBe("Routing test");
  });

  it("emits cost.incurred event for each LLM call (smoke pipeline)", async () => {
    repo = createTestRepo();
    setup();

    const costEvents: Event[] = [];
    ctx.eventBus.subscribe("test-cost", "cost.incurred", (e) => costEvents.push(e));

    ctx.fakes.trigger.setEvents([makeTriggerEvent({ title: "Cost tracking", clone_url: repo.cloneUrl })]);
    ctx.fakes.llm.setCannedResponses(makeFullPipelineResponses());
    ctx.fakes.llm.setInferSideEffect(writeSessionResultFromPrompt);

    await ctx.registry.initializePlugin("fake-trigger", {});
    await ctx.registry.initializePlugin("fake-agent", {});

    await ctx.daemon.start();
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();
    await waitForIdle(ctx);

    expect(costEvents.length).toBe(FULL_PIPELINE_LLM_CALLS);
    for (const event of costEvents) {
      const payload = event.payload as { spend_usd: number | null };
      expect(payload.spend_usd).toBe(0.003);
    }
  });

  it("trigger dedup prevents duplicate tasks", async () => {
    setup();

    const event = makeTriggerEvent({
      idempotency_key: "test:issue:repo:dedup-42",
      title: "Dedup test",
    });
    ctx.fakes.trigger.setEvents([event]);

    await ctx.registry.initializePlugin("fake-trigger", {});
    await ctx.registry.initializePlugin("fake-agent", {});

    await ctx.daemon.start();

    // First tick — creates task
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();
    await waitForIdle(ctx);

    const allBefore = [
      ...ctx.taskEngine.getTasksByState(TaskStates.queued),
      ...ctx.taskEngine.getTasksByState(TaskStates.active),
      ...ctx.taskEngine.getTasksByState(TaskStates.blocked),
      ...ctx.taskEngine.getTasksByState(TaskStates.completed),
    ];

    // Second tick — same event, should be deduped
    ctx.clock.advance(1_000);
    await ctx.daemon.tick();
    await waitForIdle(ctx);

    const allAfter = [
      ...ctx.taskEngine.getTasksByState(TaskStates.queued),
      ...ctx.taskEngine.getTasksByState(TaskStates.active),
      ...ctx.taskEngine.getTasksByState(TaskStates.blocked),
      ...ctx.taskEngine.getTasksByState(TaskStates.completed),
    ];

    expect(allAfter.length).toBe(allBefore.length);
  });
});
