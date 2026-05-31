import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verify, verifyNext } from "../../../../../../src/core/orchestrator/pipeline/execution/verify.js";
import { type MockPipeline, createMockPipeline } from "../../../../../helpers/test-mock-pipeline.js";

let worktree: string;

beforeEach(() => {
  worktree = mkdtempSync(path.join(tmpdir(), "engineer-verify-"));
});

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true });
});

/** A mock pipeline whose grounding records the given verification gates. */
function withGates(commands: ReadonlyArray<{ name: string; command: string; args: string[] }>): MockPipeline {
  const dir = path.join(worktree, "thoughts", "requirements");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "session-result.json"),
    JSON.stringify({ status: "ok", summary: "s", details: { verification: { commands } } }),
    "utf-8",
  );
  return createMockPipeline({ worktreePath: worktree, thoughtsDir: "thoughts" });
}

describe("verify", () => {
  describe("verifyNext", () => {
    it("advances when the gates pass", () => {
      expect(verifyNext({ outcome: "ok", summary: "green", data: { passed: true } })).toEqual({ go: "advance" });
    });

    it("repeats execution carrying the failures when the gates are red", () => {
      expect(verifyNext({ outcome: "ok", summary: "2 failures", data: { passed: false } })).toEqual({
        go: "repeat",
        carry: { summary: "2 failures" },
      });
    });

    it("blocks for a human on an ambiguity it cannot decide", () => {
      expect(verifyNext({ outcome: "needs_human", summary: "?" })).toMatchObject({
        go: "block",
        category: "awaiting_human",
      });
    });
  });

  describe("running gates", () => {
    it("passes vacuously and warns when grounding recorded no gates", async () => {
      const { ctx, observer } = createMockPipeline({ worktreePath: worktree, thoughtsDir: "thoughts" });

      const result = await verify.run(ctx);

      expect(result).toMatchObject({ outcome: "ok", data: { passed: true } });
      expect(observer.logs.some((log) => log.level === "warn" && log.msg.includes("No verification gates"))).toBe(true);
    });

    it("passes when every gate exits zero", async () => {
      const { ctx } = withGates([{ name: "typecheck", command: process.execPath, args: ["-e", "process.exit(0)"] }]);

      const result = await verify.run(ctx);

      expect(result).toMatchObject({ outcome: "ok", data: { passed: true } });
    });

    it("fails carrying the gate name and output when a gate exits non-zero", async () => {
      const { ctx } = withGates([
        { name: "test", command: process.execPath, args: ["-e", "console.error('boom'); process.exit(1)"] },
      ]);

      const result = await verify.run(ctx);

      expect(result).toMatchObject({ outcome: "ok", data: { passed: false } });
      expect(result.summary).toContain("test");
      expect(result.summary).toContain("boom");
    });

    it("throws when a gate cannot be run at all (missing tool)", async () => {
      const { ctx } = withGates([{ name: "ghost", command: "engineer-no-such-binary-xyz", args: [] }]);

      await expect(verify.run(ctx)).rejects.toThrow(/Cannot run verification gate/);
    });
  });
});
