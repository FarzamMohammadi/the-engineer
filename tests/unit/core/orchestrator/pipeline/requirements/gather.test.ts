import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gather, gatherNext } from "../../../../../../src/core/orchestrator/pipeline/requirements/gather.js";
import type { Ctx } from "../../../../../../src/core/orchestrator/pipeline/types.js";
import type { AgentRunResult } from "../../../../../../src/schemas/adapters.js";
import { createMockPipeline, fakeAgent } from "../../../../../helpers/test-mock-pipeline.js";

const AGENT_RESULT: AgentRunResult = { content: "", cost_usd: 0, duration_ms: 1, usage: null };

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), "engineer-gather-"));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

/** Build a ctx whose gather agent writes the given session-result, with a spy on updateTaskField. */
function ctxWithGatherResult(result: unknown): { ctx: Ctx; updateTaskField: Mock } {
  const requirementsDir = path.join(worktree, "thoughts", "requirements");
  mkdirSync(requirementsDir, { recursive: true });
  const agent = fakeAgent(() => {
    writeFileSync(path.join(requirementsDir, "session-result.json"), JSON.stringify(result), "utf-8");
    return Promise.resolve(AGENT_RESULT);
  });
  const { ctx } = createMockPipeline({ agent, worktreePath: worktree, thoughtsDir: "thoughts" });
  const updateTaskField = vi.fn();
  (ctx.taskEngine as unknown as { updateTaskField: Mock }).updateTaskField = updateTaskField;
  return { ctx, updateTaskField };
}

describe("gather", () => {
  describe("gatherNext", () => {
    it("advances when requirements are understood", () => {
      expect(gatherNext({ outcome: "ok", summary: "understood" })).toEqual({ go: "advance" });
    });

    it("blocks for a human when a person must answer", () => {
      expect(gatherNext({ outcome: "needs_human", summary: "which auth provider?" })).toMatchObject({
        go: "block",
        category: "awaiting_human",
      });
    });
  });

  describe("acceptance-criteria persistence", () => {
    it("persists the criteria the agent recorded onto task.acceptance_criteria", async () => {
      const { ctx, updateTaskField } = ctxWithGatherResult({
        status: "ok",
        summary: "understood",
        details: {
          complexity: "moderate",
          acceptance_criteria: ["The CLI exits zero", "The dashboard shows the feed"],
        },
      });

      const result = await gather.run(ctx);

      expect(result.outcome).toBe("ok");
      expect(updateTaskField).toHaveBeenCalledWith(ctx.task.id, "acceptance_criteria", [
        "The CLI exits zero",
        "The dashboard shows the feed",
      ]);
    });

    it("persists an empty list when the agent recorded no criteria", async () => {
      const { ctx, updateTaskField } = ctxWithGatherResult({
        status: "ok",
        summary: "trivial",
        details: { complexity: "trivial" },
      });

      await gather.run(ctx);

      expect(updateTaskField).toHaveBeenCalledWith(ctx.task.id, "acceptance_criteria", []);
    });

    it("does not persist criteria when the agent needs a human", async () => {
      const { ctx, updateTaskField } = ctxWithGatherResult({
        status: "needs_human",
        summary: "which auth provider?",
      });

      const result = await gather.run(ctx);

      expect(result.outcome).toBe("needs_human");
      expect(updateTaskField).not.toHaveBeenCalled();
    });
  });
});
