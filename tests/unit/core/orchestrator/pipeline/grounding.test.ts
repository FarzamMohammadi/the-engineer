import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acceptanceCriteria,
  isTrivial,
  readGrounding,
  verificationCommands,
} from "../../../../../src/core/orchestrator/pipeline/grounding.js";
import type { Ctx } from "../../../../../src/core/orchestrator/pipeline/types.js";
import { createMockPipeline } from "../../../../helpers/test-mock-pipeline.js";

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), "engineer-grounding-"));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

/** Build a ctx whose worktree holds a requirements/session-result.json with the given details. */
function ctxWithDetails(details: unknown): Ctx {
  const dir = path.join(worktree, "thoughts", "requirements");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "session-result.json"),
    JSON.stringify({ status: "ok", summary: "s", details }),
    "utf-8",
  );
  return createMockPipeline({ worktreePath: worktree, thoughtsDir: "thoughts" }).ctx;
}

describe("grounding", () => {
  describe("readGrounding", () => {
    it("reads the complexity requirements recorded", () => {
      expect(readGrounding(ctxWithDetails({ complexity: "trivial" }))?.complexity).toBe("trivial");
    });

    it("reads the acceptance criteria requirements recorded", () => {
      const ctx = ctxWithDetails({ acceptance_criteria: ["A passes", "B is green"] });
      expect(readGrounding(ctx)?.acceptance_criteria).toEqual(["A passes", "B is green"]);
    });

    it("reads the verification commands requirements recorded", () => {
      const ctx = ctxWithDetails({
        verification: { commands: [{ name: "typecheck", command: "pnpm", args: ["run", "typecheck"] }] },
      });
      expect(readGrounding(ctx)?.verification.commands).toEqual([
        { name: "typecheck", command: "pnpm", args: ["run", "typecheck"] },
      ]);
    });

    it("defaults to moderate with no criteria and no gates when details are empty", () => {
      expect(readGrounding(ctxWithDetails({}))).toEqual({
        complexity: "moderate",
        acceptance_criteria: [],
        verification: { commands: [] },
      });
    });

    it("returns null when there is no workspace", () => {
      expect(readGrounding(createMockPipeline().ctx)).toBeNull();
    });

    it("returns null when no requirements result exists yet", () => {
      expect(readGrounding(createMockPipeline({ worktreePath: worktree, thoughtsDir: "thoughts" }).ctx)).toBeNull();
    });

    it("returns null when the result file is malformed", () => {
      const dir = path.join(worktree, "thoughts", "requirements");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "session-result.json"), "{ not json", "utf-8");
      expect(readGrounding(createMockPipeline({ worktreePath: worktree, thoughtsDir: "thoughts" }).ctx)).toBeNull();
    });
  });

  describe("isTrivial", () => {
    it("is true only when requirements recorded trivial complexity", () => {
      expect(isTrivial(ctxWithDetails({ complexity: "trivial" }))).toBe(true);
      expect(isTrivial(ctxWithDetails({ complexity: "moderate" }))).toBe(false);
      expect(isTrivial(createMockPipeline().ctx)).toBe(false);
    });
  });

  describe("acceptanceCriteria", () => {
    it("returns the recorded criteria, or an empty list when none", () => {
      expect(acceptanceCriteria(ctxWithDetails({ acceptance_criteria: ["A passes"] }))).toEqual(["A passes"]);
      expect(acceptanceCriteria(ctxWithDetails({}))).toEqual([]);
      expect(acceptanceCriteria(createMockPipeline().ctx)).toEqual([]);
    });
  });

  describe("verificationCommands", () => {
    it("returns the recorded gates, or an empty list when none", () => {
      const withGates = ctxWithDetails({
        verification: { commands: [{ name: "test", command: "pnpm", args: ["test"] }] },
      });
      expect(verificationCommands(withGates)).toHaveLength(1);
      expect(verificationCommands(ctxWithDetails({}))).toEqual([]);
    });
  });
});
