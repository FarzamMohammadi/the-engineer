import { writeFileSync } from "node:fs";
import path from "node:path";
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

// A gate that passes only once the implementation has created a MARKER file in the worktree.
const MARKER_GATE = {
  name: "marker",
  command: process.execPath,
  args: ["-e", "process.exit(require('node:fs').existsSync('MARKER') ? 0 : 1)"],
};

function groundingResult(complexity: string, gate: object): FakeResult {
  return { status: "ok", summary: "grounded", details: { complexity, verification: { commands: [gate] } } };
}

// This file isolates the upstream phases (requirements through execution) so its assertions stay
// focused and stable. The full pipeline, including review and delivery, is driven end to end by
// pipeline-review-delivery.integration.test.ts.
const UPSTREAM = PIPELINE.slice(0, PIPELINE.findIndex((phase) => phase.phase === "execution") + 1);

let harness: PipelineHarness;

afterEach(() => {
  harness?.cleanup();
});

describe("upstream pipeline (integration)", () => {
  it("drives requirements through execution against a real worktree and session memory", async () => {
    const agent = newShapeAgent((phaseDir) =>
      phaseDir === "requirements"
        ? groundingResult("moderate", PASSING_GATE)
        : { status: "ok", summary: `${phaseDir} done` },
    );
    harness = createPipelineHarness(agent);

    const outcome = await runPipeline(UPSTREAM, harness.ctx);

    expect(outcome).toEqual({ kind: "completed" });
    // gather, investigate, design, implement, verify — every sub-phase ran and checkpointed.
    expect(harness.checkpointCount()).toBe(5);
    expect(harness.observer.decisions.filter((decision) => decision.name.startsWith("skip:"))).toHaveLength(0);
    expect(harness.journalSummaries()).toContain("Pipeline completed");
  });

  it("skips research and planning for a trivial task, emitting the skip trail", async () => {
    const agent = newShapeAgent((phaseDir) =>
      phaseDir === "requirements"
        ? groundingResult("trivial", PASSING_GATE)
        : { status: "ok", summary: `${phaseDir} done` },
    );
    harness = createPipelineHarness(agent);

    const outcome = await runPipeline(UPSTREAM, harness.ctx);

    expect(outcome).toEqual({ kind: "completed" });
    // gather, implement, verify ran; investigate and design were skipped.
    expect(harness.checkpointCount()).toBe(3);
    const skips = harness.observer.decisions.filter((decision) => decision.chosen === "skip").map((d) => d.name);
    expect(skips).toEqual(["skip:investigate", "skip:design"]);
    expect(harness.journalSummaries().some((summary) => summary.includes("Skipped investigate"))).toBe(true);
    expect(harness.journalSummaries().some((summary) => summary.includes("Skipped design"))).toBe(true);
  });

  it("repeats implement carrying the failure when a gate is red, then advances once it passes", async () => {
    let implementCalls = 0;
    const agent = newShapeAgent((phaseDir, request) => {
      if (phaseDir === "requirements") {
        return groundingResult("moderate", MARKER_GATE);
      }
      if (phaseDir === "execution") {
        implementCalls += 1;
        if (implementCalls >= 2 && request.cwd) {
          writeFileSync(path.join(request.cwd, "MARKER"), "done", "utf-8");
        }
        return { status: "ok", summary: `implement pass ${String(implementCalls)}` };
      }
      return { status: "ok", summary: `${phaseDir} done` };
    });
    harness = createPipelineHarness(agent);

    const outcome = await runPipeline(UPSTREAM, harness.ctx);

    expect(outcome).toEqual({ kind: "completed" });
    // First pass leaves the gate red → repeat → second pass writes MARKER → gate green → advance.
    expect(implementCalls).toBe(2);
    expect(harness.observer.observations.some((observation) => observation.name === "loop_repeat")).toBe(true);
  });
});
