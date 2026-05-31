import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { gather, gatherNext } from "../../../../../../src/core/orchestrator/pipeline/requirements/gather.js";
import type { AgentRunRequest, AgentRunResult } from "../../../../../../src/schemas/adapters.js";
import { createMockPipeline, fakeAgent } from "../../../../../helpers/test-mock-pipeline.js";

const AGENT_RESULT: AgentRunResult = { content: "", cost_usd: 0, duration_ms: 1, usage: null };

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), "engineer-gather-"));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

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

  describe("prompt", () => {
    it("grounds first, opens with a context summary, batches outreach, and records complexity + verification", async () => {
      let captured: AgentRunRequest | undefined;
      const agent = fakeAgent((request) => {
        captured = request;
        writeFileSync(
          path.join(worktree, "thoughts", "requirements", "session-result.json"),
          JSON.stringify({ status: "ok", summary: "done", details: { complexity: "moderate" } }),
          "utf-8",
        );
        return Promise.resolve(AGENT_RESULT);
      });
      const { ctx } = createMockPipeline({ agent, worktreePath: worktree, thoughtsDir: "thoughts" });

      const result = await gather.run(ctx);

      expect(result).toMatchObject({ outcome: "ok" });
      const prompt = captured?.prompt ?? "";
      expect(prompt).toContain("Ground Yourself First");
      expect(prompt).toContain("Context Summary");
      expect(prompt).toContain("outreach");
      expect(prompt).toContain("complexity");
      expect(prompt).toContain("verification");
      expect(captured?.system_prompt ?? "").toContain("never name");
    });
  });
});
