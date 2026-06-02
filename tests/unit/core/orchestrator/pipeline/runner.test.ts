import { describe, expect, it, vi } from "vitest";

import { InvalidRouteError, runPipeline } from "../../../../../src/core/orchestrator/pipeline/runner.js";
import type { Route, SubPhase, SubPhaseResult } from "../../../../../src/core/orchestrator/pipeline/types.js";
import { createMockPipeline, mockPhase, mockSubPhase } from "../../../../helpers/test-mock-pipeline.js";

/** A sub-phase whose run records its name into `order` and then succeeds. */
function recording(name: string, order: string[], next?: SubPhase["next"]): SubPhase {
  return mockSubPhase(name, {
    run: () => {
      order.push(name);
      return Promise.resolve<SubPhaseResult>({ outcome: "ok", summary: `${name} ok` });
    },
    ...(next ? { next } : {}),
  });
}

describe("runPipeline", () => {
  describe("ordering", () => {
    it("runs every sub-phase in declared order across phases and completes", async () => {
      const order: string[] = [];
      const pipeline = [
        mockPhase("requirements", [recording("gather", order)]),
        mockPhase("research", [recording("investigate", order)]),
        mockPhase("execution", [recording("implement", order), recording("verify", order)]),
      ];
      const { ctx } = createMockPipeline();

      const outcome = await runPipeline(pipeline, ctx);

      expect(order).toEqual(["gather", "investigate", "implement", "verify"]);
      expect(outcome).toEqual({ kind: "completed" });
    });
  });

  describe("skip", () => {
    it("does not run a skipped sub-phase, advances past it, and records the skip", async () => {
      const order: string[] = [];
      const skipped = mockSubPhase("investigate", {
        skip: () => "trivial complexity",
        run: () => {
          order.push("investigate");
          return Promise.resolve<SubPhaseResult>({ outcome: "ok", summary: "ran" });
        },
      });
      const pipeline = [mockPhase("research", [skipped]), mockPhase("planning", [recording("design", order)])];
      const { ctx, observer } = createMockPipeline();

      const outcome = await runPipeline(pipeline, ctx);

      expect(order).toEqual(["design"]);
      expect(outcome).toEqual({ kind: "completed" });
      expect(observer.decisions.find((d) => d.name === "skip:investigate")?.chosen).toBe("skip");
    });
  });

  describe("repeat", () => {
    it("repeats a phase up to its cap, then blocks with iteration_cap_hit", async () => {
      const run = vi.fn(() => Promise.resolve<SubPhaseResult>({ outcome: "ok", summary: "again" }));
      const looping = mockSubPhase("verify", {
        run,
        next: () => ({ go: "repeat", carry: { summary: "still red" } }) satisfies Route,
      });
      const pipeline = [mockPhase("execution", [looping], 2)];
      const { ctx } = createMockPipeline();

      const outcome = await runPipeline(pipeline, ctx);

      // cap is 2 → runs at iterations 0, 1, 2 (the 3rd repeat trips the cap)
      expect(run).toHaveBeenCalledTimes(3);
      expect(outcome).toEqual({
        kind: "blocked",
        detail: expect.objectContaining({ category: "iteration_cap_hit", sub_phase: "verify" }),
      });
    });

    it("carries context into the re-run", async () => {
      const seen: Array<string | undefined> = [];
      let pass = 0;
      const looping = mockSubPhase("verify", {
        run: (ctx) => {
          seen.push(ctx.carry?.summary);
          return Promise.resolve<SubPhaseResult>({ outcome: "ok", summary: "ran" });
        },
        next: () => {
          pass += 1;
          return pass === 1
            ? ({ go: "repeat", carry: { summary: "fix the tests" } } satisfies Route)
            : ({ go: "done" } satisfies Route);
        },
      });
      const { ctx } = createMockPipeline();

      await runPipeline([mockPhase("execution", [looping])], ctx);

      expect(seen).toEqual([undefined, "fix the tests"]);
    });
  });

  describe("jump", () => {
    it("hands control back to an earlier phase and re-enters it", async () => {
      const order: string[] = [];
      let pass = 0;
      const design = recording("design", order);
      const implement = mockSubPhase("implement", {
        run: () => {
          order.push("implement");
          return Promise.resolve<SubPhaseResult>({ outcome: "ok", summary: "built" });
        },
        next: () => {
          pass += 1;
          return pass === 1
            ? ({ go: "jump", to: "planning", carry: { summary: "plan is wrong" } } satisfies Route)
            : ({ go: "done" } satisfies Route);
        },
      });
      const pipeline = [mockPhase("planning", [design]), mockPhase("execution", [implement])];
      const { ctx, observer } = createMockPipeline();

      const outcome = await runPipeline(pipeline, ctx);

      expect(order).toEqual(["design", "implement", "design", "implement"]);
      expect(outcome).toEqual({ kind: "completed" });
      expect(observer.observations.filter((o) => o.name === "loop_jump")).toHaveLength(1);
    });

    it("rejects a jump to the current phase", async () => {
      const selfJump = mockSubPhase("design", {
        next: () => ({ go: "jump", to: "planning", carry: { summary: "loop" } }) satisfies Route,
      });
      const { ctx } = createMockPipeline();

      await expect(runPipeline([mockPhase("planning", [selfJump])], ctx)).rejects.toBeInstanceOf(InvalidRouteError);
    });
  });

  describe("block and done", () => {
    it("blocks on a block route with the given category and needed", async () => {
      const blocking = mockSubPhase("gather", {
        run: () => Promise.resolve<SubPhaseResult>({ outcome: "needs_human", summary: "need scope" }),
        next: () => ({ go: "block", category: "awaiting_human", needed: "Answer the questions" }) satisfies Route,
      });
      const { ctx } = createMockPipeline();

      const outcome = await runPipeline([mockPhase("requirements", [blocking])], ctx);

      expect(outcome).toEqual({
        kind: "blocked",
        detail: { category: "awaiting_human", sub_phase: "gather", needed: "Answer the questions" },
      });
    });

    it("completes on a done route", async () => {
      const finishing = mockSubPhase("auto-merge", { next: () => ({ go: "done" }) satisfies Route });
      const { ctx } = createMockPipeline();

      const outcome = await runPipeline([mockPhase("delivery", [finishing])], ctx);

      expect(outcome).toEqual({ kind: "completed" });
    });
  });

  describe("failure handling", () => {
    it("auto-blocks on a failed result without consulting next", async () => {
      const next = vi.fn(() => ({ go: "advance" }) satisfies Route);
      const failing = mockSubPhase("implement", {
        run: () =>
          Promise.resolve<SubPhaseResult>({
            outcome: "failed",
            summary: "no result",
            category: "no_result",
            detail: "session-result.json missing",
          }),
        next,
      });
      const { ctx } = createMockPipeline();

      const outcome = await runPipeline([mockPhase("execution", [failing])], ctx);

      expect(next).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        kind: "blocked",
        detail: { category: "no_result", sub_phase: "implement", needed: "session-result.json missing" },
      });
    });

    it("blocks with orchestrator_error when an orchestrator sub-phase throws", async () => {
      const throwing = mockSubPhase("push", {
        run: () => Promise.reject(new Error("git push rejected")),
      });
      const { ctx } = createMockPipeline();

      const outcome = await runPipeline([mockPhase("delivery", [throwing])], ctx);

      expect(outcome).toEqual({
        kind: "blocked",
        detail: { category: "orchestrator_error", sub_phase: "push", needed: "git push rejected" },
      });
    });

    it("re-throws when a sub-phase throws while the dispatch is aborted (preemption)", async () => {
      const controller = new AbortController();
      controller.abort();
      const aborting = mockSubPhase("implement", {
        run: () => Promise.reject(new Error("killed")),
      });
      const { ctx } = createMockPipeline({ signal: controller.signal });

      await expect(runPipeline([mockPhase("execution", [aborting])], ctx)).rejects.toThrow("killed");
    });
  });

  describe("observability by construction", () => {
    it("emits a routing decision, a journal entry, and an observation for each sub-phase", async () => {
      const order: string[] = [];
      const pipeline = [mockPhase("requirements", [recording("gather", order)])];
      const { ctx, observer, sessionMemory } = createMockPipeline();

      await runPipeline(pipeline, ctx);

      expect(observer.decisions.some((d) => d.name === "route:gather" && d.chosen === "advance")).toBe(true);
      expect(observer.observations.some((o) => o.name === "sub_phase_result")).toBe(true);
      expect(observer.observations.some((o) => o.name === "phase_entered")).toBe(true);
      expect(sessionMemory.journal.addEntry).toHaveBeenCalled();
    });

    it("writes a checkpoint after each sub-phase", async () => {
      const order: string[] = [];
      const pipeline = [mockPhase("execution", [recording("implement", order), recording("verify", order)])];
      const { ctx, sessionMemory } = createMockPipeline();

      await runPipeline(pipeline, ctx);

      expect(sessionMemory.checkpoints.create).toHaveBeenCalledTimes(2);
    });
  });

  describe("observability instrumentation", () => {
    it("logs a genuine failure block at error level and an expected wait at info level", async () => {
      const failing = mockSubPhase("implement", {
        run: () =>
          Promise.resolve<SubPhaseResult>({
            outcome: "failed",
            summary: "no result",
            category: "no_result",
            detail: "missing",
          }),
      });
      const waiting = mockSubPhase("await-review", {
        next: () => ({ go: "block", category: "awaiting_pr_review", needed: "waiting" }) satisfies Route,
      });

      const fail = createMockPipeline();
      await runPipeline([mockPhase("execution", [failing])], fail.ctx);
      expect(fail.observer.logs.some((entry) => entry.level === "error" && entry.msg === "Task blocked")).toBe(true);

      const wait = createMockPipeline();
      await runPipeline([mockPhase("delivery", [waiting])], wait.ctx);
      expect(wait.observer.logs.some((entry) => entry.level === "info" && entry.msg === "Task blocked")).toBe(true);
      expect(wait.observer.logs.some((entry) => entry.level === "error" && entry.msg === "Task blocked")).toBe(false);
    });

    it("records an error observation and blocks at error level when a sub-phase throws", async () => {
      const throwing = mockSubPhase("verify", { run: () => Promise.reject(new Error("gate exploded")) });
      const { ctx, observer } = createMockPipeline();

      const outcome = await runPipeline([mockPhase("execution", [throwing])], ctx);

      expect(outcome).toMatchObject({ kind: "blocked", detail: { category: "orchestrator_error" } });
      expect(observer.errors.some((e) => e.operation === "sub_phase:verify" && e.component === "orchestrator")).toBe(
        true,
      );
      expect(observer.logs.some((entry) => entry.level === "error" && entry.msg === "Task blocked")).toBe(true);
    });

    it("carries the sub-phase result data into the sub_phase_result observation", async () => {
      const verdict = mockSubPhase("refine", {
        run: () => Promise.resolve<SubPhaseResult>({ outcome: "ok", summary: "ship it", data: { verdict: "ship" } }),
        next: () => ({ go: "done" }) satisfies Route,
      });
      const { ctx, observer } = createMockPipeline();

      await runPipeline([mockPhase("review", [verdict])], ctx);

      const result = observer.observations.find((o) => o.name === "sub_phase_result");
      expect(result?.data["data"]).toEqual({ verdict: "ship" });
    });
  });
});
