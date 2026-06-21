import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PIPELINE } from "../../src/core/orchestrator/pipeline/pipeline.js";
import { runPipeline } from "../../src/core/orchestrator/pipeline/runner.js";
import { mockOwner } from "../helpers/test-mock-pipeline.js";
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

  // The #27→#37 case end-to-end: research's own investigation contradicts the premise (the reported
  // "hidden" step is already visible elsewhere). The full session-result → mapResult → runner path must
  // turn that into an owner reconfirm BEFORE planning, not a silently narrowed build.
  function conflictResult(phaseDir: string): FakeResult {
    if (phaseDir === "requirements") {
      return groundingResult("moderate", PASSING_GATE);
    }
    if (phaseDir === "research") {
      return {
        status: "ok",
        summary: "the reported need is already met elsewhere",
        details: {
          decisions: [
            {
              category: "premise_conflict",
              summary: "verify already shows on the Phases and Timeline tabs",
              chosen: "narrow the goal to a combined feed",
              reasoning: "the bug's 'verify is hidden' premise is contradicted by those tabs",
            },
          ],
        },
      };
    }
    return { status: "ok", summary: `${phaseDir} done` };
  }

  it("reconfirms a research premise_conflict with the owner before planning runs", async () => {
    const ran: string[] = [];
    const agent = newShapeAgent((phaseDir) => {
      ran.push(phaseDir);
      return conflictResult(phaseDir);
    });
    harness = createPipelineHarness(agent, {
      people: [mockOwner()],
      consultJudgment: () => ({ action: "ask_human", reason: "premise_conflict always asks" }),
    });

    const outcome = await runPipeline(UPSTREAM, harness.ctx);

    expect(outcome).toMatchObject({
      kind: "blocked",
      detail: { category: "awaiting_human_decision", sub_phase: "investigate" },
    });
    // Stopped at research — planning and execution never ran.
    expect(ran).toEqual(["requirements", "research"]);
    if (outcome.kind === "blocked") {
      expect(outcome.detail.needed).toContain("premise_conflict");
      expect(outcome.detail.needed).toContain("combined feed");
    }
  });

  it("proceeds past a research premise_conflict with no owner, recording the call loudly", async () => {
    const ran: string[] = [];
    const agent = newShapeAgent((phaseDir) => {
      ran.push(phaseDir);
      return conflictResult(phaseDir);
    });
    // No `people` → getOwner() is null. The consult still escalates, but blocking would strand the task,
    // so the runner proceeds and records an autonomy_no_owner decision (the AC#5 no-owner edge).
    harness = createPipelineHarness(agent, {
      consultJudgment: () => ({ action: "ask_human", reason: "premise_conflict always asks" }),
    });

    const outcome = await runPipeline(UPSTREAM, harness.ctx);

    expect(outcome).toEqual({ kind: "completed" });
    // Advanced through planning and execution despite the conflict.
    expect(ran).toEqual(["requirements", "research", "planning", "execution"]);
    const ownerless = harness.observer.decisions.find((decision) => decision.name === "autonomy_no_owner");
    expect(ownerless?.chosen).toBe("proceed_without_owner");
    expect(ownerless?.reasoning).toContain("combined feed");
  });
});
