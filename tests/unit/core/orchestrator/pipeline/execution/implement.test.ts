import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { implement, implementNext } from "../../../../../../src/core/orchestrator/pipeline/execution/implement.js";
import type { Ctx } from "../../../../../../src/core/orchestrator/pipeline/types.js";
import type { AgentRunRequest, AgentRunResult } from "../../../../../../src/schemas/adapters.js";
import { createMockPipeline, fakeAgent } from "../../../../../helpers/test-mock-pipeline.js";

const AGENT_RESULT: AgentRunResult = { content: "", cost_usd: 0, duration_ms: 1, usage: null };

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), "engineer-implement-"));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

describe("implement", () => {
  describe("implementNext", () => {
    it("advances to verify when the implementation is complete", () => {
      expect(implementNext({ outcome: "ok", summary: "built" })).toEqual({ go: "advance" });
    });

    it("blocks for a human when execution gets stuck", () => {
      expect(implementNext({ outcome: "needs_human", summary: "ambiguous API" })).toMatchObject({
        go: "block",
        category: "awaiting_human",
      });
    });
  });

  describe("prompt", () => {
    it("feeds the verify failures back in when re-run from a repeat", async () => {
      let captured: AgentRunRequest | undefined;
      const agent = fakeAgent((request) => {
        captured = request;
        writeFileSync(
          path.join(worktree, "thoughts", "execution", "session-result.json"),
          JSON.stringify({ status: "ok", summary: "fixed" }),
          "utf-8",
        );
        return Promise.resolve(AGENT_RESULT);
      });
      const base = createMockPipeline({ agent, worktreePath: worktree, thoughtsDir: "thoughts" }).ctx;
      const ctx: Ctx = { ...base, carry: { summary: "Verification failed: typecheck — 3 type errors" } };

      await implement.run(ctx);

      expect(captured?.prompt ?? "").toContain("Verification failed: typecheck — 3 type errors");
    });
  });
});
