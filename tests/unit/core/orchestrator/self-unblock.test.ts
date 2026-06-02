import { describe, expect, it, vi } from "vitest";

import { Orchestrator } from "../../../../src/core/orchestrator/index.js";
import type { OrchestratorContext } from "../../../../src/core/orchestrator/types.js";
import { OrchestratorConfigSchema, WorkspaceConfigSchema } from "../../../../src/schemas/config.js";
import { TaskStates } from "../../../../src/schemas/task.js";
import type { Task } from "../../../../src/schemas/task.js";
import { createRecordingObserver } from "../../../helpers/test-mock-pipeline.js";

// ── attemptSelfUnblock — the autonomy fork ─────────────────────────────────────
//
// attemptSelfUnblock asks the agent whether a blocked task can resume on its own. That choice — resume
// vs leave-escalated — is a real fork, so it is recorded as a decision the dashboard can inspect, with
// the road not taken and the agent's own reasoning, not a log line.

const observer = createRecordingObserver();

/** A blocked task the diagnosis runs against. */
function blockedTask(): Task {
  return {
    id: "t1",
    title: "Add dark mode",
    state: TaskStates.blocked,
    blocked: { reason: "need_more_info" },
    repo: "acme/app",
  } as unknown as Task;
}

/** An Orchestrator whose agent answers self-unblock with the given JSON, over a recording observer. */
function orchestratorWith(agentContent: string, task: Task | null): Orchestrator {
  const agent = {
    run: vi.fn().mockResolvedValue({ content: agentContent, cost_usd: 0, duration_ms: 1, usage: null }),
    manifest: { id: "fake-agent" },
  };
  const ctx = {
    config: OrchestratorConfigSchema.parse({}),
    workspaceConfig: WorkspaceConfigSchema.parse({}),
    eventBus: { publish: vi.fn() },
    registry: { getPrimaryPlugin: (type: string) => (type === "agent" ? agent : null) },
    taskEngine: { getTask: vi.fn().mockReturnValue(task), updateTracking: vi.fn() },
    actionPipeline: {
      execute: async (input: { executeFn: () => unknown }) => ({
        outcome: "executed",
        result: await input.executeFn(),
      }),
    },
    sessionMemory: { journal: { query: vi.fn().mockReturnValue([]) } },
    skillsManager: { sync: vi.fn() },
    observer,
  } as unknown as OrchestratorContext;
  return new Orchestrator(ctx);
}

describe("attemptSelfUnblock", () => {
  it("records a self_unblock_diagnosis decision choosing auto_resolve with the agent's reasoning", async () => {
    observer.decisions.length = 0;
    const orchestrator = orchestratorWith(
      JSON.stringify({ can_resolve: true, action: "the missing config now exists — resume it" }),
      blockedTask(),
    );

    const result = await orchestrator.attemptSelfUnblock("t1");

    expect(result).toBe(true);
    const decision = observer.decisions.find((d) => d.name === "self_unblock_diagnosis");
    expect(decision?.chosen).toBe("auto_resolve");
    expect(decision?.reasoning).toBe("the missing config now exists — resume it");
    expect(decision?.options.map((o) => o.id)).toEqual(["auto_resolve", "escalate"]);
  });

  it("records the escalate alternative when the agent says the block cannot self-resolve", async () => {
    observer.decisions.length = 0;
    const orchestrator = orchestratorWith(
      JSON.stringify({ can_resolve: false, action: "needs a human decision on scope" }),
      blockedTask(),
    );

    const result = await orchestrator.attemptSelfUnblock("t1");

    expect(result).toBe(false);
    const decision = observer.decisions.find((d) => d.name === "self_unblock_diagnosis");
    expect(decision?.chosen).toBe("escalate");
    expect(decision?.reasoning).toBe("needs a human decision on scope");
  });
});
