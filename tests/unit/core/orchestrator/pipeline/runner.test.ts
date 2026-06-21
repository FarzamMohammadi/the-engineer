import { describe, expect, it, vi } from "vitest";

import { traceScope } from "../../../../../src/core/orchestrator/pipeline/observability.js";
import { InvalidRouteError, runPipeline } from "../../../../../src/core/orchestrator/pipeline/runner.js";
import type { Route, SubPhase, SubPhaseResult } from "../../../../../src/core/orchestrator/pipeline/types.js";
import { createMockPipeline, mockOwner, mockPhase, mockSubPhase } from "../../../../helpers/test-mock-pipeline.js";

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

  describe("resume with the owner's answer (round-trip return)", () => {
    it("seeds the resumed non-requirements sub-phase's run with the carried answer", async () => {
      // The orchestrator's resolveResponse builds a ResumeState whose cursor points at the asking
      // sub-phase and whose carry holds the owner's reply. The runner must hand that carry to the
      // resumed sub-phase's run — this is how the answer reaches a NON-requirements phase on resume.
      let seenCarry: string | undefined;
      const implement = mockSubPhase("implement", {
        run: (ctx) => {
          seenCarry = ctx.carry?.summary;
          return Promise.resolve<SubPhaseResult>({ outcome: "ok", summary: "applied the owner's answer" });
        },
        next: () => ({ go: "done" }) satisfies Route,
      });
      const { ctx } = createMockPipeline();

      await runPipeline([mockPhase("execution", [implement])], ctx, {
        cursor: { phaseIndex: 0, subIndex: 0 },
        phaseIteration: 0,
        totalReworks: 0,
        carry: { summary: "The owner answered: use the existing AuthService" },
      });

      expect(seenCarry).toContain("use the existing AuthService");
    });
  });

  describe("autonomy escalation", () => {
    /** A sub-phase that surfaces one discretionary decision of the given category, then advances. */
    function surfacing(category: string, details?: Record<string, unknown>): SubPhase {
      return mockSubPhase("implement", {
        run: () =>
          Promise.resolve<SubPhaseResult>({
            outcome: "ok",
            summary: "built it",
            data: {
              decisions: [
                {
                  category,
                  summary: "Renamed the public getUser to fetchUser",
                  chosen: "fetchUser",
                  reasoning: "matches the verb convention",
                  ...(details ? { details } : {}),
                },
              ],
            },
          }),
      });
    }

    it("proceeds silently when the policy lets the agent decide every surfaced decision", async () => {
      const next = vi.fn(() => ({ go: "done" }) satisfies Route);
      const sub = { ...surfacing("code_style"), next };
      const { ctx, consultJudgment } = createMockPipeline({
        consultJudgment: () => ({ action: "proceed", reason: "code_style is always_decide" }),
      });

      const outcome = await runPipeline([mockPhase("execution", [sub])], ctx);

      expect(consultJudgment).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalled();
      expect(outcome).toEqual({ kind: "completed" });
    });

    it("blocks and asks the owner when the policy escalates a surfaced decision", async () => {
      const next = vi.fn(() => ({ go: "done" }) satisfies Route);
      const sub = { ...surfacing("architecture"), next };
      const { ctx } = createMockPipeline({
        people: [mockOwner()],
        consultJudgment: () => ({ action: "ask_human", reason: "architecture requires approval" }),
      });

      const outcome = await runPipeline([mockPhase("execution", [sub])], ctx);

      expect(next).not.toHaveBeenCalled();
      // A discretionary decision the owner must confirm is its own category — distinct from a sub-phase's
      // `awaiting_human` (stuck, needs info) — so the daemon never self-unblocks it.
      expect(outcome).toMatchObject({
        kind: "blocked",
        detail: { category: "awaiting_human_decision", sub_phase: "implement" },
      });
      if (outcome.kind === "blocked") {
        expect(outcome.detail.needed).toContain("architecture");
        expect(outcome.detail.needed).toContain("fetchUser");
      }
    });

    it("proceeds and records an autonomy_no_owner decision when the policy escalates but no owner is configured", async () => {
      const next = vi.fn(() => ({ go: "done" }) satisfies Route);
      const sub = { ...surfacing("architecture"), next };
      // No `people` — getOwner() is null. Blocking would strand the task forever, so the runner proceeds.
      const { ctx, observer } = createMockPipeline({
        consultJudgment: () => ({ action: "ask_human", reason: "architecture requires approval" }),
      });

      const outcome = await runPipeline([mockPhase("execution", [sub])], ctx);

      expect(outcome).toEqual({ kind: "completed" });
      expect(next).toHaveBeenCalled();
      const decision = observer.decisions.find((d) => d.name === "autonomy_no_owner");
      expect(decision?.chosen).toBe("proceed_without_owner");
      expect(decision?.reasoning).toContain("fetchUser");
      const ownerlessWarn = observer.logs.find(
        (l) => l.level === "warn" && l.msg === "Proceeding on a discretionary decision with no owner to ask",
      );
      expect(ownerlessWarn).toBeDefined();
    });

    it("passes the decision category, details, and the full dispatch trace into the consult", async () => {
      const sub = surfacing("scope_expansion", { files: 12 });
      const { ctx, consultJudgment } = createMockPipeline({
        task: { id: "task-trace", repo: "owner/repo" },
        consultJudgment: () => ({ action: "proceed", reason: "within threshold" }),
      });

      await runPipeline([mockPhase("execution", [sub])], ctx);

      expect(consultJudgment).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "should_i_ask",
          context: expect.objectContaining({
            task_id: "task-trace",
            repo: "owner/repo",
            decision_category: "scope_expansion",
            details: { files: 12 },
          }),
          trace: expect.objectContaining({ task_id: "task-trace", phase: "execution" }),
        }),
      );
    });

    it("does not gate on decisions in an intent-forming phase — records them instead", async () => {
      // requirements/research set consultsDecisions: false. A decision surfaced there is premature, so the
      // runner records it for the trail and advances, never asking the owner — even when the policy WOULD
      // escalate it. This is the fix for the gather loop: an ask-biased intake cannot re-block on a decision.
      const next = vi.fn(() => ({ go: "done" }) satisfies Route);
      const sub = { ...surfacing("scope_expansion", { files: 12 }), next };
      const { ctx, consultJudgment, observer } = createMockPipeline({
        people: [mockOwner()],
        consultJudgment: () => ({ action: "ask_human", reason: "would escalate if consulted" }),
      });

      const outcome = await runPipeline([mockPhase("requirements", [sub], 1, { consultsDecisions: false })], ctx);

      expect(consultJudgment).not.toHaveBeenCalled();
      expect(outcome).toEqual({ kind: "completed" });
      const noted = observer.decisions.find((d) => d.name === "autonomy_not_gated");
      expect(noted?.chosen).toBe("record_only");
      expect(noted?.reasoning).toContain("fetchUser");
    });

    it("does not consult the policy when no decisions are surfaced", async () => {
      const order: string[] = [];
      const { ctx, consultJudgment } = createMockPipeline();

      await runPipeline([mockPhase("execution", [recording("implement", order)])], ctx);

      expect(consultJudgment).not.toHaveBeenCalled();
    });

    it("asks all escalated decisions together in one block", async () => {
      const sub = mockSubPhase("implement", {
        run: () =>
          Promise.resolve<SubPhaseResult>({
            outcome: "ok",
            summary: "two forks",
            data: {
              decisions: [
                { category: "architecture", summary: "split the module", chosen: "two files", reasoning: "cohesion" },
                { category: "dependencies", summary: "add a parser", chosen: "zod", reasoning: "already used" },
              ],
            },
          }),
      });
      const { ctx, consultJudgment } = createMockPipeline({
        people: [mockOwner()],
        consultJudgment: () => ({ action: "ask_human", reason: "always asks" }),
      });

      const outcome = await runPipeline([mockPhase("execution", [sub])], ctx);

      // Every decision is consulted (no early return), and both land in ONE block — asked together.
      expect(consultJudgment).toHaveBeenCalledTimes(2);
      expect(outcome).toMatchObject({ kind: "blocked", detail: { category: "awaiting_human_decision" } });
      if (outcome.kind === "blocked") {
        expect(outcome.detail.needed).toContain("two files");
        expect(outcome.detail.needed).toContain("zod");
        expect(outcome.detail.needed).toContain("2 decisions");
      }
    });

    it("batches only the escalated decisions, proceeding on the rest", async () => {
      const sub = mockSubPhase("implement", {
        run: () =>
          Promise.resolve<SubPhaseResult>({
            outcome: "ok",
            summary: "one proceeds, one asks",
            data: {
              decisions: [
                { category: "code_style", summary: "naming", chosen: "camelCase", reasoning: "convention" },
                { category: "security", summary: "touched auth", chosen: "jwt", reasoning: "simplest" },
              ],
            },
          }),
      });
      const { ctx, consultJudgment } = createMockPipeline({
        people: [mockOwner()],
        consultJudgment: (query) => {
          const category = (query as { context: { decision_category: string } }).context.decision_category;
          return category === "security"
            ? { action: "ask_human", reason: "security always asks" }
            : { action: "proceed", reason: "ok" };
        },
      });

      const outcome = await runPipeline([mockPhase("execution", [sub])], ctx);

      expect(consultJudgment).toHaveBeenCalledTimes(2);
      expect(outcome).toMatchObject({ kind: "blocked", detail: { category: "awaiting_human_decision" } });
      if (outcome.kind === "blocked") {
        expect(outcome.detail.needed).toContain("jwt"); // the escalated fork
        expect(outcome.detail.needed).not.toContain("camelCase"); // the proceeded one is not asked
      }
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

  describe("per-sub-phase-run correlation", () => {
    // The correlation invariant this fix introduces: each observation a run emits carries that run's id
    // (its sub_phase_started's id) as parent_observation_id, so the dashboard LOOKS UP a run's enrichments by
    // parentage instead of inferring ownership from a (phase, trace, time-window) guess. The spine itself —
    // every sub_phase_started and the bare phase_entered — parents on the dispatch root, not a run.

    /** The parent_observation_id a captured emission was recorded under (the runner's traceScope). */
    function parentOf(opts: Record<string, unknown> | undefined): unknown {
      return opts?.["parent_observation_id"];
    }

    it("parents phase_entered and sub_phase_started on the root, and the run's result/route on the run's id", async () => {
      const order: string[] = [];
      const pipeline = [mockPhase("execution", [recording("implement", order)])];
      // The orchestrator stamps the dispatch root id onto the ctx; the runner threads it as the spine's parent.
      const { ctx, observer } = createMockPipeline({ task: { id: "task-x" }, rootObservationId: "root-1" });

      await runPipeline(pipeline, ctx);

      const phaseEntered = observer.observations.find((o) => o.name === "phase_entered");
      const started = observer.observations.find((o) => o.name === "sub_phase_started");
      const result = observer.observations.find((o) => o.name === "sub_phase_result");
      const route = observer.decisions.find((d) => d.name === "route:implement");
      // The spine hangs off the root.
      expect(parentOf(phaseEntered?.opts)).toBe("root-1");
      expect(parentOf(started?.opts)).toBe("root-1");
      // The run's own emissions hang off that run's sub_phase_started id, not the root.
      expect(started?.id).toBeTruthy();
      expect(parentOf(result?.opts)).toBe(started?.id);
      expect(parentOf(route?.opts)).toBe(started?.id);
    });

    it("parents an agent run's own observations on its run, never on the root or a sibling run", async () => {
      // A sub-phase that records its own observation through the threaded ctx, the way an agent step does.
      const emitting = mockSubPhase("implement", {
        run: (ctx) => {
          // Record through the SAME traceScope an agent step uses, so the run's own observation inherits the
          // run id the runner threaded onto ctx (via the spread copy) — exactly the production path.
          ctx.observer.observe("agent_call", "implement", { step: "implement" }, traceScope(ctx));
          return Promise.resolve<SubPhaseResult>({ outcome: "ok", summary: "built" });
        },
        next: () => ({ go: "done" }) satisfies Route,
      });
      const { ctx, observer } = createMockPipeline({ rootObservationId: "root-1" });

      await runPipeline([mockPhase("execution", [emitting])], ctx);

      const started = observer.observations.find((o) => o.name === "sub_phase_started");
      const agentCall = observer.observations.find((o) => o.type === "agent_call");
      expect(parentOf(agentCall?.opts)).toBe(started?.id);
      expect(parentOf(agentCall?.opts)).not.toBe("root-1");
    });

    it("resets the run id per sub-phase so a later run never inherits an earlier run's id", async () => {
      const order: string[] = [];
      const pipeline = [mockPhase("execution", [recording("implement", order), recording("verify", order)])];
      const { ctx, observer } = createMockPipeline({ rootObservationId: "root-1" });

      await runPipeline(pipeline, ctx);

      const starts = observer.observations.filter((o) => o.name === "sub_phase_started");
      const results = observer.observations.filter((o) => o.name === "sub_phase_result");
      expect(starts).toHaveLength(2);
      // Two distinct run ids; each result parents on its OWN run's start, not the first run's.
      expect(starts[0]?.id).not.toBe(starts[1]?.id);
      expect(parentOf(results[0]?.opts)).toBe(starts[0]?.id);
      expect(parentOf(results[1]?.opts)).toBe(starts[1]?.id);
      // Both sub_phase_started hang off the root, never off the prior run.
      expect(parentOf(starts[0]?.opts)).toBe("root-1");
      expect(parentOf(starts[1]?.opts)).toBe("root-1");
    });

    it("parents the task_blocked state_transition on the run that blocked", async () => {
      const blocking = mockSubPhase("gather", {
        run: () => Promise.resolve<SubPhaseResult>({ outcome: "needs_human", summary: "need scope" }),
        next: () => ({ go: "block", category: "awaiting_human", needed: "answer" }) satisfies Route,
      });
      const { ctx, observer } = createMockPipeline({ rootObservationId: "root-1" });

      await runPipeline([mockPhase("requirements", [blocking])], ctx);

      const started = observer.observations.find((o) => o.name === "sub_phase_started");
      const blocked = observer.observations.find((o) => o.name === "task_blocked");
      expect(parentOf(blocked?.opts)).toBe(started?.id);
    });

    it("parents an orchestrator-throw error observation on the run that threw", async () => {
      const throwing = mockSubPhase("push", { run: () => Promise.reject(new Error("git push rejected")) });
      const { ctx, observer } = createMockPipeline({ rootObservationId: "root-1" });

      await runPipeline([mockPhase("delivery", [throwing])], ctx);

      const started = observer.observations.find((o) => o.name === "sub_phase_started");
      const recordedError = observer.errors.find((e) => e.operation === "sub_phase:push");
      expect(parentOf(recordedError?.opts)).toBe(started?.id);
    });
  });
});
