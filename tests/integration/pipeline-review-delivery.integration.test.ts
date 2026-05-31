import { afterEach, describe, expect, it } from "vitest";

import { PIPELINE } from "../../src/core/orchestrator/pipeline/pipeline.js";
import { runPipeline } from "../../src/core/orchestrator/pipeline/runner.js";
import {
  type FakeResult,
  type PipelineHarness,
  createPipelineHarness,
  newShapeAgent,
} from "../helpers/test-pipeline-context.js";

// A verification gate that always passes — node exits 0 regardless of the worktree.
const PASSING_GATE = { name: "ok", command: process.execPath, args: ["-e", "process.exit(0)"] };

function grounding(gate: object): FakeResult {
  return { status: "ok", summary: "grounded", details: { complexity: "moderate", verification: { commands: [gate] } } };
}

function refineVerdict(verdict: string): FakeResult {
  return { status: "ok", summary: `refine: ${verdict}`, details: { verdict } };
}

let harness: PipelineHarness;

afterEach(() => {
  harness?.cleanup();
});

describe("review and delivery pipeline (integration)", () => {
  it("drives a PR-mode task through review and delivery to an awaiting_pr_review block", async () => {
    const agent = newShapeAgent((phaseDir) => {
      if (phaseDir === "requirements") {
        return grounding(PASSING_GATE);
      }
      if (phaseDir === "refine") {
        return refineVerdict("ship");
      }
      return { status: "ok", summary: `${phaseDir} done` };
    });
    harness = createPipelineHarness(agent);

    const outcome = await runPipeline(PIPELINE, harness.ctx);

    // review ships → delivery (pr-description → push → create-pr) → await-review parks the task.
    expect(outcome).toMatchObject({
      kind: "blocked",
      detail: { category: "awaiting_pr_review", sub_phase: "await-review" },
    });
    const skipped = harness.observer.decisions.filter((d) => d.chosen === "skip").map((d) => d.name);
    // The opt-in lenses skip by default; nothing in delivery skips in PR mode.
    expect(skipped).toEqual(["skip:security", "skip:code-quality", "skip:architecture"]);
  });

  it("collapses delivery to just push in push-only mode and completes", async () => {
    const agent = newShapeAgent((phaseDir) => {
      if (phaseDir === "requirements") {
        return grounding(PASSING_GATE);
      }
      if (phaseDir === "refine") {
        return refineVerdict("ship");
      }
      return { status: "ok", summary: `${phaseDir} done` };
    });
    harness = createPipelineHarness(agent, { pushOnly: true });

    const outcome = await runPipeline(PIPELINE, harness.ctx);

    expect(outcome).toEqual({ kind: "completed" });
    const skipped = harness.observer.decisions.filter((d) => d.chosen === "skip").map((d) => d.name);
    // Every PR-specific delivery sub-phase skips; push is the lone deliverable and runs.
    for (const name of ["skip:pr-description", "skip:create-pr", "skip:await-review", "skip:auto-merge"]) {
      expect(skipped).toContain(name);
    }
    expect(skipped).not.toContain("skip:push");
  });

  it("loops review to its cap when refine keeps revising, then blocks loudly", async () => {
    const agent = newShapeAgent((phaseDir) => {
      if (phaseDir === "requirements") {
        return grounding(PASSING_GATE);
      }
      if (phaseDir === "refine") {
        return refineVerdict("revise"); // never converges — fixes in place and asks to re-check, forever
      }
      return { status: "ok", summary: `${phaseDir} done` };
    });
    harness = createPipelineHarness(agent);

    const outcome = await runPipeline(PIPELINE, harness.ctx);

    expect(outcome).toMatchObject({ kind: "blocked", detail: { category: "iteration_cap_hit", sub_phase: "refine" } });
    expect(harness.observer.observations.some((o) => o.name === "loop_repeat")).toBe(true);
  });

  it("jumps back to execution when refine escalates, then ships on the next pass", async () => {
    let reviewPasses = 0;
    let implementCalls = 0;
    const agent = newShapeAgent((phaseDir) => {
      if (phaseDir === "requirements") {
        return grounding(PASSING_GATE);
      }
      if (phaseDir === "execution") {
        implementCalls += 1;
        return { status: "ok", summary: `implement ${String(implementCalls)}` };
      }
      if (phaseDir === "refine") {
        reviewPasses += 1;
        return refineVerdict(reviewPasses === 1 ? "rework_execution" : "ship");
      }
      return { status: "ok", summary: `${phaseDir} done` };
    });
    harness = createPipelineHarness(agent);

    const outcome = await runPipeline(PIPELINE, harness.ctx);

    expect(outcome).toMatchObject({ kind: "blocked", detail: { category: "awaiting_pr_review" } });
    expect(implementCalls).toBe(2); // first pass, then the rework_execution jump re-ran execution
    expect(harness.observer.observations.some((o) => o.name === "loop_jump")).toBe(true);
  });

  it("jumps back to planning when refine faults the approach, then ships on the next pass", async () => {
    let reviewPasses = 0;
    let designCalls = 0;
    const agent = newShapeAgent((phaseDir) => {
      if (phaseDir === "requirements") {
        return grounding(PASSING_GATE);
      }
      if (phaseDir === "planning") {
        designCalls += 1;
        return { status: "ok", summary: `design ${String(designCalls)}` };
      }
      if (phaseDir === "refine") {
        reviewPasses += 1;
        return refineVerdict(reviewPasses === 1 ? "rework_planning" : "ship");
      }
      return { status: "ok", summary: `${phaseDir} done` };
    });
    harness = createPipelineHarness(agent);

    const outcome = await runPipeline(PIPELINE, harness.ctx);

    expect(outcome).toMatchObject({ kind: "blocked", detail: { category: "awaiting_pr_review" } });
    expect(designCalls).toBe(2); // the rework_planning jump re-ran planning
  });
});
