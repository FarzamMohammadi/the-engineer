import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { investigate, investigateNext } from "../../../../../../src/core/orchestrator/pipeline/research/investigate.js";
import type { Ctx } from "../../../../../../src/core/orchestrator/pipeline/types.js";
import { createMockPipeline } from "../../../../../helpers/test-mock-pipeline.js";

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), "engineer-investigate-"));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

function ctxWithComplexity(complexity: string): Ctx {
  const dir = path.join(worktree, "thoughts", "requirements");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "session-result.json"),
    JSON.stringify({ status: "ok", summary: "s", details: { complexity } }),
    "utf-8",
  );
  return createMockPipeline({ worktreePath: worktree, thoughtsDir: "thoughts" }).ctx;
}

describe("investigate", () => {
  describe("investigateNext", () => {
    it("advances to planning when research is done", () => {
      expect(investigateNext({ outcome: "ok", summary: "mapped" })).toEqual({ go: "advance" });
    });

    it("blocks for a human when research surfaces a missing answer", () => {
      expect(investigateNext({ outcome: "needs_human", summary: "need the spec" })).toMatchObject({
        go: "block",
        category: "awaiting_human",
      });
    });
  });

  describe("skip", () => {
    it("skips when requirements assessed the task as trivial", () => {
      expect(investigate.skip?.(ctxWithComplexity("trivial"))).toContain("trivial");
    });

    it("runs for a non-trivial task", () => {
      expect(investigate.skip?.(ctxWithComplexity("moderate"))).toBeNull();
    });
  });
});
