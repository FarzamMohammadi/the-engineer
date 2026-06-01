import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { design, designNext } from "../../../../../../src/core/orchestrator/pipeline/planning/design.js";
import type { Ctx } from "../../../../../../src/core/orchestrator/pipeline/types.js";
import { createMockPipeline } from "../../../../../helpers/test-mock-pipeline.js";

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), "engineer-design-"));
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

describe("design", () => {
  describe("designNext", () => {
    it("advances to execution when the plan is ready", () => {
      expect(designNext({ outcome: "ok", summary: "planned" })).toEqual({ go: "advance" });
    });

    it("blocks for a human when a decision the plan depends on is not the agent's", () => {
      expect(designNext({ outcome: "needs_human", summary: "which datastore?" })).toMatchObject({
        go: "block",
        category: "awaiting_human",
      });
    });
  });

  describe("skip", () => {
    it("skips planning for a trivial task", () => {
      expect(design.skip?.(ctxWithComplexity("trivial"))).toContain("trivial");
    });

    it("runs for a non-trivial task", () => {
      expect(design.skip?.(ctxWithComplexity("complex"))).toBeNull();
    });
  });
});
